// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

import type { LocalLlmSettings } from "@t3tools/contracts";
import { LlmServeError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { HttpClient } from "effect/unstable/http";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { probeProvider } from "../diagnostics/llmProbe.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  type ProbeResult,
  type RegistryEntry,
  type SampleResult,
  buildSample,
  planLoad,
  probeTarget,
} from "./LlmServeManager.logic.ts";

/** Empty config used when settings can't be read (keeps `list` total). */
const EMPTY_LOCAL_LLM: LocalLlmSettings = { ramBudgetBytes: 0, providers: {}, models: [] };

/**
 * Grace period between SIGTERM and SIGKILL when stopping a model server.
 *
 * Generous on purpose: releasing tens of gigabytes of mapped weights takes a
 * moment, and killing a healthy server mid-release buys nothing. The point is
 * that the wait terminates, not that it is short.
 */
export const MODEL_SERVER_FORCE_KILL_AFTER = Duration.seconds(10);

type LaunchState = "loading" | "stopping";

/** A live managed launch: the registry entry plus the process handle + its scope. */
interface ManagedLaunch extends RegistryEntry {
  readonly child: ChildProcessSpawner.ChildProcessHandle;
  readonly scope: Scope.Closeable;
  readonly state: LaunchState;
}

export type LlmServeListResult = SampleResult;

export interface LlmServeManagerShape {
  /** Build the local-model sample from the user's configs joined with live status. Total. */
  readonly list: Effect.Effect<LlmServeListResult>;
  /** Spawn the managed config identified by `configId`. */
  readonly load: (configId: string) => Effect.Effect<{ pid: number; port: number }, LlmServeError>;
  /** Kill the managed config identified by `configId`. */
  readonly unload: (configId: string) => Effect.Effect<{ ok: true }, LlmServeError>;
}

export class LlmServeManager extends Context.Service<LlmServeManager, LlmServeManagerShape>()(
  "t3/llm/LlmServeManager",
) {}

export const make = Effect.fn("makeLlmServeManager")(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const settings = yield* ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;
  const registry = yield* Ref.make<ReadonlyMap<string, ManagedLaunch>>(new Map());
  const loadSemaphore = yield* Semaphore.make(1);

  const setEntry = (launch: ManagedLaunch) =>
    Ref.update(registry, (m) => new Map(m).set(launch.configId, launch));
  const deleteEntry = (configId: string) =>
    Ref.update(registry, (m) => {
      const next = new Map(m);
      next.delete(configId);
      return next;
    });
  const updateState = (configId: string, state: LaunchState) =>
    Ref.update(registry, (m) => {
      const existing = m.get(configId);
      if (!existing) return m;
      return new Map(m).set(configId, { ...existing, state });
    });

  /** Strip the process handle/scope so the pure logic sees plain registry entries. */
  const snapshot = (live: ReadonlyMap<string, ManagedLaunch>): ReadonlyMap<string, RegistryEntry> =>
    new Map(
      Array.from(live.entries()).map(([id, l]) => [
        id,
        {
          configId: l.configId,
          providerId: l.providerId,
          modelId: l.modelId,
          pid: l.pid,
          port: l.port,
          estBytes: l.estBytes,
          state: l.state,
        },
      ]),
    );

  const readSettings: Effect.Effect<LocalLlmSettings> = settings.getSettings.pipe(
    Effect.map((s) => s.localLlm),
    Effect.catchCause(() => Effect.succeed(EMPTY_LOCAL_LLM)),
  );

  /** Probe one endpoint's /v1/models for reachability + first model (never fails). */
  const probeOne = (host: string, port: number): Effect.Effect<ProbeResult> =>
    probeProvider({ name: "local", baseUrl: `http://${host}:${port}` }).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.map((p) => ({ reachable: p.reachable, model: p.models[0] ?? null })),
      Effect.catchCause(() => Effect.succeed({ reachable: false, model: null })),
    );

  // A process that exits on its own (crash / failed load / external kill) is removed from
  // the registry, reverting the config to offline. A deliberate unload deletes the entry
  // itself after closing the scope, which interrupts this forked fiber before it runs.
  const supervise = (launch: ManagedLaunch) =>
    Effect.result(launch.child.exitCode).pipe(
      Effect.andThen(() => deleteEntry(launch.configId)),
      Effect.catchCause(() => Effect.void),
    );

  const list: Effect.Effect<LlmServeListResult> = Effect.gen(function* () {
    const lm = yield* readSettings;
    const live = yield* Ref.get(registry);
    const reg = snapshot(live);

    // Probe only configs worth checking: visible (shown to the user) or currently managed
    // in the registry. Skips hidden/dead endpoints that would each burn a probe timeout, and
    // runs the rest concurrently so a tick costs ~one probe RTT, not N sequential timeouts.
    const targets = lm.models.flatMap((config) => {
      if (!config.visible && !reg.has(config.id)) return [];
      const target = probeTarget(config.id, lm, reg);
      return target ? ([[config.id, target]] as const) : [];
    });
    const results = yield* Effect.forEach(
      targets,
      ([id, target]) =>
        probeOne(target.host, target.port).pipe(Effect.map((r) => [id, r] as const)),
      { concurrency: 8 },
    );

    return buildSample(lm, reg, new Map(results), NodeOS.totalmem());
  });

  const load = (configId: string): Effect.Effect<{ pid: number; port: number }, LlmServeError> =>
    loadSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const lm = yield* readSettings;
        const live = yield* Ref.get(registry);
        const plan = planLoad(configId, lm, snapshot(live), NodeOS.totalmem());
        if (!plan.ok) {
          return yield* new LlmServeError({ kind: plan.kind, reason: plan.reason });
        }
        const { launch } = plan;

        // A settings-specified executable given as a path must exist before spawn (a bare
        // PATH name like `mlx-serve` is left to the spawner to resolve).
        if (launch.executable.includes("/") && !NodeFS.existsSync(launch.executable)) {
          return yield* new LlmServeError({
            kind: "spawn_failed",
            reason: `${launch.engineId} binary not found: ${launch.executable}`,
          });
        }
        // Fail fast with a friendly message when the model resource (the mlx dir) is
        // missing, instead of spawning a process that crashes or never becomes reachable.
        if (!NodeFS.existsSync(launch.modelPath)) {
          return yield* new LlmServeError({
            kind: "not_found",
            reason: `Model not found on disk: ${launch.modelPath}`,
          });
        }

        const childScope = yield* Scope.make();
        const spawned = yield* spawner
          .spawn(
            ChildProcess.make(launch.executable, launch.args, {
              detached: true,
              extendEnv: true,
              shell: false,
              stdout: "ignore",
              stderr: "ignore",
              // Without this the spawner sends SIGTERM and waits for exit with no
              // bound at all (`forceKillAfter` defaults to undefined, meaning no
              // timeout). A model server that is slow to release its weights, or
              // that ignores SIGTERM outright, therefore hangs `unload` forever -
              // and hangs the shutdown finalizer below with it, because that
              // closes the same scopes.
              //
              // The escalation is what bounds it *without* orphaning anything: a
              // plain timeout on our side would give up waiting and leave a
              // process holding tens of gigabytes of weights with nothing
              // tracking it. SIGKILL after the grace period actually reaps it.
              // 10s is generous for releasing mapped weights and exiting; the
              // point is that the wait terminates, not that it is short.
              forceKillAfter: MODEL_SERVER_FORCE_KILL_AFTER,
            }),
          )
          .pipe(
            Effect.provideService(Scope.Scope, childScope),
            Effect.map((child) => ({ ok: true as const, child })),
            Effect.catchCause((cause) =>
              Scope.close(childScope, Exit.void).pipe(
                Effect.ignore,
                Effect.as({ ok: false as const, cause }),
              ),
            ),
          );
        if (!spawned.ok) {
          return yield* new LlmServeError({
            kind: "spawn_failed",
            reason: `Failed to start ${launch.engineId} for ${configId}: ${spawned.cause}`,
          });
        }

        const config = lm.models.find((m) => m.id === configId)!;
        const managedLaunch: ManagedLaunch = {
          configId,
          providerId: config.providerId,
          modelId: config.modelId,
          pid: Number(spawned.child.pid),
          port: launch.port,
          estBytes: launch.estBytes,
          state: "loading",
          child: spawned.child,
          scope: childScope,
        };
        yield* setEntry(managedLaunch);
        yield* Effect.forkIn(supervise(managedLaunch), childScope);
        return { pid: managedLaunch.pid, port: managedLaunch.port };
      }),
    );

  const unload = (configId: string): Effect.Effect<{ ok: true }, LlmServeError> =>
    Effect.gen(function* () {
      const live = yield* Ref.get(registry);
      const managed = live.get(configId);
      if (!managed) {
        return yield* new LlmServeError({
          kind: "not_managed_process",
          reason: `Config ${configId} is not loaded by t3code`,
        });
      }
      // Mark stopping (so list() shows it stopping), close the service-owned scope (the
      // spawner's release reaps the whole detached group and awaits exit), then remove the
      // entry. Closing the scope interrupts the supervisor, so we delete here.
      yield* updateState(configId, "stopping");
      yield* Scope.close(managed.scope, Exit.void).pipe(Effect.ignore);
      yield* deleteEntry(configId);
      return { ok: true as const };
    });

  // On server shutdown, stop every managed launch (closing scopes reaps their groups).
  //
  // Concurrently, because each close can burn the whole `MODEL_SERVER_FORCE_KILL_AFTER`
  // grace period before its SIGKILL lands. Sequentially the shutdown bound is N x 10s,
  // which for two or three resident models exceeds launchd's 20s ExitTimeOut - past
  // which the server is killed mid-chain and the servers it had not reached yet are
  // orphaned holding their weights, the exact leak the grace period exists to prevent.
  yield* Effect.addFinalizer(() =>
    Ref.get(registry).pipe(
      Effect.flatMap((reg) =>
        Effect.forEach(
          Array.from(reg.values()),
          (launch) => Scope.close(launch.scope, Exit.void).pipe(Effect.ignore),
          { discard: true, concurrency: "unbounded" },
        ),
      ),
      Effect.ignore,
    ),
  );

  return LlmServeManager.of({ list, load, unload });
});

export const layer = Layer.effect(LlmServeManager, make());
