// @effect-diagnostics nodeBuiltinImport:off
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { LlmModel, LlmProvider, LocalModelsSettings } from "@t3tools/contracts";
import { LlmServeError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { type ProcessRow, readProcessRows } from "../diagnostics/ProcessDiagnostics.ts";
import { probeProvider } from "../diagnostics/llmProbe.ts";
import { ServerSettingsService } from "../serverSettings.ts";

/** mlx-serve is served on loopback; not user-configurable (avoids a 0.0.0.0 footgun). */
const SERVE_HOST = "127.0.0.1";
/** Fixed port window for managed launches — also caps concurrent processes (~35). */
const PORT_MIN = 8765;
const PORT_MAX = 8799;
/** Default RAM budget fraction of total system memory when unset (0) in settings. */
const DEFAULT_BUDGET_FRACTION = 0.8;
/** Cap the per-model dir walk used for the RAM estimate. */
const MAX_DIR_ENTRIES = 64;

// A launch is "loading" from spawn until it is observed serving (online is then
// derived from ps + probe), and "stopping" once an unload is in flight. The entry is
// removed when the process exits — whether spontaneously (supervisor) or via unload.
type LaunchState = "loading" | "stopping";

interface ManagedLaunch {
  readonly child: ChildProcessSpawner.ChildProcessHandle;
  readonly scope: Scope.Closeable;
  readonly modelId: string;
  readonly modelPath: string;
  readonly port: number;
  readonly estBytes: number;
  readonly state: LaunchState;
}

/** A running mlx-serve process parsed from `ps`. */
export interface MlxProcess {
  readonly pid: number;
  readonly port: number | null;
  readonly modelPath: string;
  readonly rssBytes: number;
}

export interface LlmServeListResult {
  readonly provider: LlmProvider;
  readonly ramBudgetBytes: number;
  readonly ramUsedBytes: number;
}

export interface LlmServeManagerShape {
  /** Build the managed mlx-serve provider snapshot. Total (never fails); opens no scopes. */
  readonly list: Effect.Effect<LlmServeListResult>;
  readonly load: (modelId: string) => Effect.Effect<{ pid: number; port: number }, LlmServeError>;
  readonly unload: (pid: number) => Effect.Effect<{ ok: true }, LlmServeError>;
}

export class LlmServeManager extends Context.Service<LlmServeManager, LlmServeManagerShape>()(
  "t3/llm/LlmServeManager",
) {}

/** `~` / `~/x` → absolute path under the home dir. */
export function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

// First char must not be a dash, so a `modelId` can never be read as an mlx-serve flag.
const MODEL_ID_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;

/** Defends the spawn against path traversal / arg injection via the client `modelId`. */
export function isValidModelId(modelId: string): boolean {
  if (modelId === "." || modelId === "..") return false;
  return MODEL_ID_RE.test(modelId);
}

/** Strict mlx-serve matcher: the `mlx-serve` executable, in serve mode, with a model. */
export function parseMlxProcesses(rows: ReadonlyArray<ProcessRow>): MlxProcess[] {
  const out: MlxProcess[] = [];
  for (const row of rows) {
    const cmd = row.command;
    if (!/(^|\/|\s)mlx-serve(\s|$)/.test(cmd)) continue;
    if (!/(^|\s)--serve(\s|$)/.test(cmd)) continue;
    const modelMatch = cmd.match(/--model\s+(\S+)/);
    if (!modelMatch) continue;
    const portMatch = cmd.match(/--port\s+(\d+)/);
    out.push({
      pid: row.pid,
      port: portMatch ? Number(portMatch[1]) : null,
      modelPath: modelMatch[1]!,
      rssBytes: row.rssBytes,
    });
  }
  return out;
}

interface ModelDir {
  readonly name: string;
  readonly path: string;
}

function listModelDirs(modelsDir: string): ModelDir[] {
  try {
    return fs
      .readdirSync(modelsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name, path: path.join(modelsDir, entry.name) }));
  } catch {
    return [];
  }
}

/** Sum of top-level regular-file sizes in the model dir (cheap RAM-cost estimate). */
function estimateDirBytes(dir: string): number {
  try {
    let total = 0;
    let count = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (++count > MAX_DIR_ENTRIES) break;
      if (!entry.isFile()) continue;
      try {
        total += fs.statSync(path.join(dir, entry.name)).size;
      } catch {
        // ignore unreadable entry
      }
    }
    return total;
  } catch {
    return 0;
  }
}

export const make = Effect.fn("makeLlmServeManager")(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const settings = yield* ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;
  const registry = yield* Ref.make<ReadonlyMap<number, ManagedLaunch>>(new Map());
  const loadSemaphore = yield* Semaphore.make(1);

  const setEntry = (pid: number, launch: ManagedLaunch) =>
    Ref.update(registry, (m) => new Map(m).set(pid, launch));
  const deleteEntry = (pid: number) =>
    Ref.update(registry, (m) => {
      const next = new Map(m);
      next.delete(pid);
      return next;
    });
  const updateState = (pid: number, state: LaunchState) =>
    Ref.update(registry, (m) => {
      const existing = m.get(pid);
      if (!existing) return m;
      const next = new Map(m);
      next.set(pid, { ...existing, state });
      return next;
    });

  const readConfig = settings.getSettings.pipe(
    Effect.map((s) => s.localModels),
    Effect.catchCause(() =>
      Effect.succeed({
        modelsDir: "~/llm/models",
        ramBudgetBytes: 0,
        defaultArgs: ["--reasoning-budget", "0", "--no-pld"],
        perModel: {},
      } satisfies LocalModelsSettings),
    ),
  );

  const budgetOf = (cfg: LocalModelsSettings): number =>
    cfg.ramBudgetBytes > 0 ? cfg.ramBudgetBytes : Math.floor(os.totalmem() * DEFAULT_BUDGET_FRACTION);

  const readMlxProcesses = readProcessRows().pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.map(parseMlxProcesses),
    Effect.catchCause(() => Effect.succeed([] as MlxProcess[])),
  );

  /** Probe one running process's /v1/models for metadata (never fails). */
  const probeMeta = (port: number): Effect.Effect<LlmModel | null> =>
    probeProvider({ name: "mlx-serve", baseUrl: `http://${SERVE_HOST}:${port}` }).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.map((p) => p.models[0] ?? null),
      Effect.catchCause(() => Effect.succeed(null)),
    );

  // Remove the registry entry when the process exits on its own (crash / external
  // kill). A deliberate unload deletes the entry itself after closing the scope; this
  // handler covers the spontaneous-exit path (the forked fiber is interrupted by that
  // scope close, so its `andThen` is skipped — no double delete).
  const supervise = (pid: number, launch: ManagedLaunch) =>
    Effect.result(launch.child.exitCode).pipe(
      Effect.andThen(() => deleteEntry(pid)),
      Effect.catchCause(() => Effect.void),
    );

  const list: Effect.Effect<LlmServeListResult> = Effect.gen(function* () {
    const cfg = yield* readConfig;
    const modelsDir = expandTilde(cfg.modelsDir);
    const budget = budgetOf(cfg);
    const procs = yield* readMlxProcesses;
    const dirs = listModelDirs(modelsDir);
    const liveReg = yield* Ref.get(registry);

    const byPath = new Map<string, LlmModel>();
    let ramUsedBytes = 0;

    // 1. Disk dirs → offline baseline.
    for (const dir of dirs) {
      const key = realpathOrSelf(dir.path);
      byPath.set(key, {
        id: dir.name,
        loaded: false,
        status: "offline",
        modelId: dir.name,
        sizeBytes: estimateDirBytes(dir.path),
      });
    }

    // 2. Running processes → online / loading / stopping (authoritative over disk row).
    for (const proc of procs) {
      const key = realpathOrSelf(proc.modelPath);
      const id = path.basename(proc.modelPath);
      const entry = liveReg.get(proc.pid);
      const managed = entry != null;
      const meta = proc.port != null ? yield* probeMeta(proc.port) : null;
      const status =
        entry?.state === "stopping" ? "stopping" : entry?.state === "loading" ? "loading" : "online";
      if (status === "online" || status === "stopping") ramUsedBytes += proc.rssBytes;
      byPath.set(key, {
        ...meta,
        id: meta?.id ?? id,
        loaded: status === "online",
        status,
        modelId: id,
        managed,
        pid: proc.pid,
        ...(proc.port != null ? { port: proc.port } : {}),
        sizeBytes: proc.rssBytes,
      });
    }

    // 3. Registry launches not yet visible in ps (just spawned, or mid-stop).
    for (const [pid, launch] of liveReg) {
      if (procs.some((p) => p.pid === pid)) continue;
      const key = realpathOrSelf(launch.modelPath);
      byPath.set(key, {
        id: launch.modelId,
        loaded: false,
        status: launch.state === "stopping" ? "stopping" : "loading",
        modelId: launch.modelId,
        managed: true,
        pid,
        port: launch.port,
        sizeBytes: launch.estBytes,
      });
    }

    const models = Array.from(byPath.values());
    const provider: LlmProvider = {
      name: "mlx-serve",
      baseUrl: `http://${SERVE_HOST}`,
      reachable: true,
      models,
    };
    return { provider, ramBudgetBytes: budget, ramUsedBytes };
  });

  const load = (modelId: string): Effect.Effect<{ pid: number; port: number }, LlmServeError> =>
    loadSemaphore.withPermits(1)(
      Effect.gen(function* () {
        // Validate id shape, then allowlist against a real direct subdir of modelsDir.
        if (!isValidModelId(modelId)) {
          return yield* new LlmServeError({ kind: "not_found", reason: `Invalid model id: ${modelId}` });
        }
        const cfg = yield* readConfig;
        const modelsDir = expandTilde(cfg.modelsDir);
        const dirs = listModelDirs(modelsDir);
        if (!dirs.some((d) => d.name === modelId)) {
          return yield* new LlmServeError({ kind: "not_found", reason: `Unknown model: ${modelId}` });
        }
        const modelsRoot = realpathOrSelf(modelsDir);
        const modelPath = realpathOrSelf(path.join(modelsDir, modelId));
        if (path.dirname(modelPath) !== modelsRoot) {
          return yield* new LlmServeError({
            kind: "not_found",
            reason: `Model path escapes models dir: ${modelId}`,
          });
        }

        const procs = yield* readMlxProcesses;
        const reg = yield* Ref.get(registry);
        const alreadyRunning =
          procs.some((p) => realpathOrSelf(p.modelPath) === modelPath) ||
          Array.from(reg.values()).some((l) => l.modelPath === modelPath);
        if (alreadyRunning) {
          return yield* new LlmServeError({ kind: "already_online", reason: `${modelId} is already online` });
        }

        // RAM budget: online RSS + in-flight loading estimates + this estimate ≤ budget.
        const budget = budgetOf(cfg);
        const onlineRss = procs.reduce((sum, p) => sum + p.rssBytes, 0);
        const inflight = Array.from(reg.values())
          .filter((l) => l.state === "loading")
          .reduce((sum, l) => sum + l.estBytes, 0);
        const estBytes = estimateDirBytes(modelPath);
        if (onlineRss + inflight + estBytes > budget) {
          return yield* new LlmServeError({
            kind: "budget_exceeded",
            reason: `Loading ${modelId} (~${Math.round(estBytes / 1e9)} GB) would exceed the RAM budget`,
          });
        }

        // Pick a free port in range, skipping any used by a process or a registry entry.
        const usedPorts = new Set<number>([
          ...procs.map((p) => p.port).filter((p): p is number => p != null),
          ...Array.from(reg.values()).map((l) => l.port),
        ]);
        let port: number | null = null;
        for (let candidate = PORT_MIN; candidate <= PORT_MAX; candidate++) {
          if (!usedPorts.has(candidate)) {
            port = candidate;
            break;
          }
        }
        if (port == null) {
          return yield* new LlmServeError({ kind: "no_free_port", reason: "No free port in range" });
        }

        const args = [
          "--serve",
          ...cfg.defaultArgs,
          ...((cfg.perModel as Record<string, { args?: readonly string[] }>)[modelId]?.args ?? []),
          "--host",
          SERVE_HOST,
          "--port",
          String(port),
          // `--model` and its value are an atomic pair; the value is never re-split.
          "--model",
          modelPath,
        ];

        const childScope = yield* Scope.make();
        const spawned = yield* spawner
          .spawn(
            ChildProcess.make("mlx-serve", args, {
              detached: true,
              env: { ...process.env },
              shell: false,
              stdout: "ignore",
              stderr: "ignore",
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
            reason: `Failed to start mlx-serve for ${modelId}: ${spawned.cause}`,
          });
        }

        const pid = Number(spawned.child.pid);
        const launch: ManagedLaunch = {
          child: spawned.child,
          scope: childScope,
          modelId,
          modelPath,
          port,
          estBytes,
          state: "loading",
        };
        yield* setEntry(pid, launch);
        yield* Effect.forkIn(supervise(pid, launch), childScope);
        return { pid, port };
      }),
    );

  const unload = (pid: number): Effect.Effect<{ ok: true }, LlmServeError> =>
    Effect.gen(function* () {
      const reg = yield* Ref.get(registry);
      const managed = reg.get(pid);
      if (managed) {
        // Mark stopping (so list() shows it stopping, not flipped to external/online),
        // close the service-owned scope (the spawner's release reaps the whole detached
        // group and awaits exit), then remove the entry. Closing the scope interrupts
        // the supervisor fiber, so we delete here rather than relying on it.
        yield* updateState(pid, "stopping");
        yield* Scope.close(managed.scope, Exit.void).pipe(Effect.ignore);
        yield* deleteEntry(pid);
        return { ok: true as const };
      }

      // External pid: re-read ps and re-verify it is an mlx-serve process RIGHT NOW
      // (narrows the pid-reuse window), refuse self, then SIGTERM the single pid only
      // (never an external process group — it could include the user's shell).
      if (pid === process.pid) {
        return yield* new LlmServeError({ kind: "not_mlx_process", reason: "Refusing to kill self" });
      }
      const procs = yield* readMlxProcesses;
      if (!procs.some((p) => p.pid === pid)) {
        return yield* new LlmServeError({
          kind: "not_mlx_process",
          reason: `PID ${pid} is not a known mlx-serve process`,
        });
      }
      yield* Effect.sync(() => {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // already gone
        }
      });
      return { ok: true as const };
    });

  // On server shutdown, stop every managed launch (closing scopes reaps their groups).
  yield* Effect.addFinalizer(() =>
    Ref.get(registry).pipe(
      Effect.flatMap((reg) =>
        Effect.forEach(
          Array.from(reg.values()),
          (launch) => Scope.close(launch.scope, Exit.void).pipe(Effect.ignore),
          { discard: true },
        ),
      ),
      Effect.ignore,
    ),
  );

  return LlmServeManager.of({ list, load, unload });
});

export const layer = Layer.effect(LlmServeManager, make());
