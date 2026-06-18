// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off
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

/** Local-model engines are served on loopback; not user-configurable (avoids a 0.0.0.0 footgun). */
const SERVE_HOST = "127.0.0.1";
/** Fixed port window for managed launches — also caps concurrent processes (~35). */
const PORT_MIN = 8765;
const PORT_MAX = 8799;
/** Default RAM budget fraction of total system memory when unset (0) in settings. */
const DEFAULT_BUDGET_FRACTION = 0.8;
/** Cap the per-model dir walk used for the RAM estimate. */
const MAX_DIR_ENTRIES = 64;
/** How long a "load failed / crashed" error row lingers before reverting to offline. */
const ERROR_TTL_MS = 20_000;
/** ds4-server's documented default port when `--port` is omitted (so external ds4 is probeable). */
const DS4_DEFAULT_PORT = 8000;

export type EngineId = "mlx-serve" | "ds4";

// A launch is "loading" from spawn until its HTTP server answers the probe (online is
// then derived from ps + probe), and "stopping" once an unload is in flight. The entry is
// removed when the process exits — whether spontaneously (supervisor) or via unload.
type LaunchState = "loading" | "stopping";

interface ManagedLaunch {
  readonly child: ChildProcessSpawner.ChildProcessHandle;
  readonly scope: Scope.Closeable;
  readonly engineId: EngineId;
  readonly modelId: string;
  readonly modelPath: string;
  readonly port: number;
  readonly estBytes: number;
  readonly state: LaunchState;
}

/** A running engine process parsed from `ps`, tagged with its owning engine. */
export interface ManagedProc {
  readonly engineId: EngineId;
  readonly pid: number;
  readonly port: number | null;
  readonly modelPath: string;
  readonly rssBytes: number;
}

/** A model discovered on disk for an engine, with a cheap RAM-cost estimate. */
interface DiscoveredModel {
  readonly id: string;
  readonly path: string;
  readonly estBytes: number;
}

/** Per-engine view of `localModels`, normalized so the manager treats engines uniformly. */
interface EngineConfig {
  readonly enabled: boolean;
  /** Executable to spawn (PATH name or an absolute/relative, tilde-expanded path). */
  readonly executable: string;
  /** Directory scanned for models (tilde-expanded). */
  readonly modelsDir: string;
  readonly defaultArgs: readonly string[];
  readonly perModel: Record<string, { args?: readonly string[] }>;
}

export interface LlmServeListResult {
  readonly providers: readonly LlmProvider[];
  readonly ramBudgetBytes: number;
  readonly ramUsedBytes: number;
}

export interface LlmServeManagerShape {
  /** Build the managed local-model provider snapshots (one per enabled engine). Total. */
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

// First char must not be a dash, so a `modelId` can never be read as a launch flag.
const MODEL_ID_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;

/** Defends the spawn against path traversal / arg injection via the client `modelId`. */
export function isValidModelId(modelId: string): boolean {
  if (modelId === "." || modelId === "..") return false;
  return MODEL_ID_RE.test(modelId);
}

/** Sum of top-level regular-file sizes in a dir (cheap RAM-cost estimate for mlx models). */
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

function fileSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

/**
 * Strict mlx-serve matcher: the `mlx-serve` executable, in serve mode, with a model.
 * Returns the model path + port (null if `--port` omitted) or null for a non-match.
 */
export function matchMlxRow(row: ProcessRow): { port: number | null; modelPath: string } | null {
  const cmd = row.command;
  if (!/(^|\/|\s)mlx-serve(\s|$)/.test(cmd)) return null;
  if (!/(^|\s)--serve(\s|$)/.test(cmd)) return null;
  const modelMatch = cmd.match(/--model\s+(\S+)/);
  if (!modelMatch) return null;
  const portMatch = cmd.match(/--port\s+(\d+)/);
  return { port: portMatch ? Number(portMatch[1]) : null, modelPath: modelMatch[1]! };
}

/**
 * Strict ds4-server matcher: the `ds4-server` executable with a `.gguf` model file
 * (`-m`/`--model`). Anchors on the executable + a mandatory `.gguf` token so it never
 * matches an editor/shell sitting in the ds4 repo dir. Defaults the port to ds4-server's
 * documented 8000 when `--port` is omitted, so an externally started ds4 stays probeable.
 */
export function matchDs4Row(row: ProcessRow): { port: number | null; modelPath: string } | null {
  const cmd = row.command;
  if (!/(^|\/|\s)ds4-server(\s|$)/.test(cmd)) return null;
  // Case-insensitive `.gguf` to match `discover`'s `.toLowerCase()` (a `.GGUF` model must
  // be matchable in ps too, else it would load yet never flip from loading → online).
  const modelMatch = cmd.match(/(?:^|\s)(?:-m|--model)\s+(\S+\.gguf)(?:\s|$)/i);
  if (!modelMatch) return null;
  const portMatch = cmd.match(/--port\s+(\d+)/);
  return { port: portMatch ? Number(portMatch[1]) : DS4_DEFAULT_PORT, modelPath: modelMatch[1]! };
}

/** Back-compat helper (used by tests): parse only mlx-serve processes from `ps` rows. */
export function parseMlxProcesses(
  rows: ReadonlyArray<ProcessRow>,
): Array<{ pid: number; port: number | null; modelPath: string; rssBytes: number }> {
  const out: Array<{ pid: number; port: number | null; modelPath: string; rssBytes: number }> = [];
  for (const row of rows) {
    const m = matchMlxRow(row);
    if (m) out.push({ pid: row.pid, port: m.port, modelPath: m.modelPath, rssBytes: row.rssBytes });
  }
  return out;
}

/** Behaviour that differs per engine. The set is closed (no settings-defined executables). */
interface Engine {
  readonly id: EngineId;
  readonly extract: (lm: LocalModelsSettings) => EngineConfig;
  readonly discover: (cfg: EngineConfig) => DiscoveredModel[];
  readonly matchRow: (row: ProcessRow) => { port: number | null; modelPath: string } | null;
  readonly buildArgs: (a: {
    host: string;
    port: number;
    modelPath: string;
    defaultArgs: readonly string[];
    perModelArgs: readonly string[];
  }) => string[];
  /** Working directory for the spawn, when the binary resolves runtime assets relative to
   *  it (ds4-server loads its `metal/` shaders from cwd). `undefined` ⇒ inherit. */
  readonly cwd: (cfg: EngineConfig) => string | undefined;
}

const mlxEngine: Engine = {
  id: "mlx-serve",
  extract: (lm) => ({
    enabled: true,
    executable: "mlx-serve",
    modelsDir: expandTilde(lm.modelsDir),
    defaultArgs: lm.defaultArgs,
    perModel: lm.perModel as Record<string, { args?: readonly string[] }>,
  }),
  // mlx models are model *directories* under modelsDir.
  discover: (cfg) => {
    try {
      return fs
        .readdirSync(cfg.modelsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => {
          const p = path.join(cfg.modelsDir, e.name);
          return { id: e.name, path: p, estBytes: estimateDirBytes(p) };
        });
    } catch {
      return [];
    }
  },
  matchRow: matchMlxRow,
  buildArgs: (a) => [
    "--serve",
    ...a.defaultArgs,
    ...a.perModelArgs,
    "--host",
    a.host,
    "--port",
    String(a.port),
    // `--model` and its value are an atomic pair; the value is never re-split.
    "--model",
    a.modelPath,
  ],
  cwd: () => undefined, // mlx-serve is a PATH tool with no cwd-relative assets.
};

const ds4Engine: Engine = {
  id: "ds4",
  extract: (lm) => ({
    enabled: lm.ds4.enabled,
    executable: expandTilde(lm.ds4.binaryPath),
    modelsDir: expandTilde(lm.ds4.modelsDir),
    defaultArgs: lm.ds4.defaultArgs,
    perModel: lm.ds4.perModel as Record<string, { args?: readonly string[] }>,
  }),
  // ds4 models are single `*.gguf` *files* in modelsDir.
  discover: (cfg) => {
    try {
      return fs
        .readdirSync(cfg.modelsDir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".gguf"))
        .map((e) => {
          const p = path.join(cfg.modelsDir, e.name);
          return { id: e.name, path: p, estBytes: fileSize(p) };
        });
    } catch {
      return [];
    }
  },
  matchRow: matchDs4Row,
  buildArgs: (a) => [
    ...a.defaultArgs,
    ...a.perModelArgs,
    "--host",
    a.host,
    "--port",
    String(a.port),
    // ds4-server takes the GGUF file via `-m`; atomic pair, never re-split.
    "-m",
    a.modelPath,
  ],
  // ds4-server resolves its `metal/` shaders relative to cwd, so run it from the dir that
  // holds the binary (the ds4 repo root). Without this it aborts: "metal backend unavailable".
  // Only meaningful for a path-shaped binary; a bare PATH name (dirname ".") inherits cwd.
  cwd: (cfg) => (cfg.executable.includes("/") ? path.dirname(cfg.executable) : undefined),
};

const ENGINES: readonly Engine[] = [mlxEngine, ds4Engine];

/**
 * Resolve a `modelId` to a confined absolute path within an engine's models dir.
 * Allowlists against the engine's discovered models, then re-checks realpath confinement
 * (defends a symlink whose target escapes modelsDir). Returns null when not found/escaping.
 */
function resolveModel(engine: Engine, cfg: EngineConfig, modelId: string): DiscoveredModel | null {
  if (!isValidModelId(modelId)) return null;
  const found = engine.discover(cfg).find((m) => m.id === modelId);
  if (!found) return null;
  const root = realpathOrSelf(cfg.modelsDir);
  const real = realpathOrSelf(found.path);
  if (path.dirname(real) !== root) return null;
  return found;
}

export const make = Effect.fn("makeLlmServeManager")(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const settings = yield* ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;
  const registry = yield* Ref.make<ReadonlyMap<number, ManagedLaunch>>(new Map());
  // Transient "this model's process exited unexpectedly" notices, keyed by modelId,
  // so a crash/failed-load surfaces briefly instead of silently reverting to offline.
  const recentErrors = yield* Ref.make<ReadonlyMap<string, { reason: string; at: number }>>(
    new Map(),
  );
  const loadSemaphore = yield* Semaphore.make(1);

  const recordError = (modelId: string, reason: string) =>
    Ref.update(recentErrors, (m) => new Map(m).set(modelId, { reason, at: Date.now() }));
  const clearError = (modelId: string) =>
    Ref.update(recentErrors, (m) => {
      const next = new Map(m);
      next.delete(modelId);
      return next;
    });

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
        defaultArgs: ["--reasoning-budget", "0"],
        perModel: {},
        ds4: {
          enabled: false,
          binaryPath: "ds4-server",
          modelsDir: "~/ds4/gguf",
          defaultArgs: [],
          perModel: {},
        },
      } satisfies LocalModelsSettings),
    ),
  );

  /** The enabled engines with their normalized per-engine config, in mlx→ds4 order. */
  const enabledEngines = (lm: LocalModelsSettings): Array<{ engine: Engine; cfg: EngineConfig }> =>
    ENGINES.map((engine) => ({ engine, cfg: engine.extract(lm) })).filter((x) => x.cfg.enabled);

  const budgetOf = (lm: LocalModelsSettings): number =>
    lm.ramBudgetBytes > 0 ? lm.ramBudgetBytes : Math.floor(os.totalmem() * DEFAULT_BUDGET_FRACTION);

  const readRows = readProcessRows().pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.catchCause(() => Effect.succeed([] as ProcessRow[])),
  );

  /** Match all `ps` rows against the enabled engines, tagging each match with its engine. */
  const matchProcs = (
    rows: ReadonlyArray<ProcessRow>,
    enabled: ReadonlyArray<{ engine: Engine; cfg: EngineConfig }>,
  ): ManagedProc[] => {
    const out: ManagedProc[] = [];
    for (const row of rows) {
      for (const { engine } of enabled) {
        const m = engine.matchRow(row);
        if (m) {
          out.push({
            engineId: engine.id,
            pid: row.pid,
            port: m.port,
            modelPath: m.modelPath,
            rssBytes: row.rssBytes,
          });
          break; // a row belongs to at most one engine
        }
      }
    }
    return out;
  };

  /** Probe one running process's /v1/models for reachability + metadata (never fails). */
  const probeOne = (port: number): Effect.Effect<{ reachable: boolean; model: LlmModel | null }> =>
    probeProvider({ name: "local", baseUrl: `http://${SERVE_HOST}:${port}` }).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.map((p) => ({ reachable: p.reachable, model: p.models[0] ?? null })),
      Effect.catchCause(() => Effect.succeed({ reachable: false, model: null })),
    );

  // Handle a process that exits on its own (crash / failed load / external kill): record
  // a transient error for the model, then remove the entry. A deliberate unload deletes
  // the entry itself after closing the scope, which INTERRUPTS this forked fiber before
  // its `andThen` runs — so no error is recorded for an intentional stop and there's no
  // double delete. (The `stopping` guard is belt-and-suspenders for the rare race where
  // the process exits naturally just as an unload begins.)
  const supervise = (pid: number, launch: ManagedLaunch) =>
    Effect.result(launch.child.exitCode).pipe(
      Effect.andThen(() =>
        Ref.get(registry).pipe(
          Effect.flatMap((m) => {
            const stopping = m.get(pid)?.state === "stopping";
            return stopping
              ? deleteEntry(pid)
              : recordError(launch.modelId, `${launch.engineId} exited unexpectedly`).pipe(
                  Effect.andThen(deleteEntry(pid)),
                );
          }),
        ),
      ),
      Effect.catchCause(() => Effect.void),
    );

  const list: Effect.Effect<LlmServeListResult> = Effect.gen(function* () {
    const lm = yield* readConfig;
    const enabled = enabledEngines(lm);
    const budget = budgetOf(lm);
    const rows = yield* readRows;
    const procs = matchProcs(rows, enabled);
    const liveReg = yield* Ref.get(registry);
    const errors = yield* Ref.get(recentErrors);
    const nowMs = Date.now();

    let ramUsedBytes = 0;
    const providers: LlmProvider[] = [];

    for (const { engine, cfg } of enabled) {
      const byPath = new Map<string, LlmModel>();

      // 1. Disk models → offline baseline.
      for (const model of engine.discover(cfg)) {
        byPath.set(realpathOrSelf(model.path), {
          id: model.id,
          loaded: false,
          status: "offline",
          modelId: model.id,
          engine: engine.id,
          sizeBytes: model.estBytes,
        });
      }

      // 2. Running processes for this engine → online / loading / stopping (probe-driven).
      for (const proc of procs) {
        if (proc.engineId !== engine.id) continue;
        const key = realpathOrSelf(proc.modelPath);
        const id = path.basename(proc.modelPath);
        const entry = liveReg.get(proc.pid);
        const managed = entry != null;
        const probe = proc.port != null ? yield* probeOne(proc.port) : { reachable: false, model: null };
        const status =
          entry?.state === "stopping" ? "stopping" : probe.reachable ? "online" : "loading";
        if (status === "online" || status === "stopping") ramUsedBytes += proc.rssBytes;
        byPath.set(key, {
          ...probe.model,
          id: probe.model?.id ?? id,
          loaded: status === "online",
          status,
          modelId: id,
          engine: engine.id,
          managed,
          pid: proc.pid,
          ...(proc.port != null ? { port: proc.port } : {}),
          sizeBytes: proc.rssBytes,
        });
      }

      // 3. Registry launches for this engine not yet visible in ps (just spawned, mid-stop).
      for (const [pid, launch] of liveReg) {
        if (launch.engineId !== engine.id) continue;
        if (procs.some((p) => p.pid === pid)) continue;
        byPath.set(realpathOrSelf(launch.modelPath), {
          id: launch.modelId,
          loaded: false,
          status: launch.state === "stopping" ? "stopping" : "loading",
          modelId: launch.modelId,
          engine: engine.id,
          managed: true,
          pid,
          port: launch.port,
          sizeBytes: launch.estBytes,
        });
      }

      // 4. Surface this engine's recent unexpected exits as transient error rows (only
      //    while the model is otherwise offline — a reload supersedes it).
      for (const [modelId, err] of errors) {
        if (nowMs - err.at > ERROR_TTL_MS) continue;
        for (const [key, model] of byPath) {
          if (model.modelId === modelId && model.status === "offline") {
            byPath.set(key, { ...model, status: "error", loadError: err.reason });
          }
        }
      }

      providers.push({
        name: engine.id,
        baseUrl: `http://${SERVE_HOST}`,
        reachable: true,
        models: Array.from(byPath.values()),
      });
    }

    // Prune expired error notices once per tick.
    for (const [modelId, err] of errors) {
      if (nowMs - err.at > ERROR_TTL_MS) yield* clearError(modelId);
    }

    return { providers, ramBudgetBytes: budget, ramUsedBytes };
  });

  const load = (modelId: string): Effect.Effect<{ pid: number; port: number }, LlmServeError> =>
    loadSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const lm = yield* readConfig;
        const enabled = enabledEngines(lm);

        // Resolve the owning engine by scanning each enabled engine's discovered models.
        // mlx ids are dir names, ds4 ids end in `.gguf`, so a basename collision can't
        // happen; mlx→ds4 order makes resolution deterministic.
        let resolved: { engine: Engine; cfg: EngineConfig; model: DiscoveredModel } | null = null;
        for (const { engine, cfg } of enabled) {
          const model = resolveModel(engine, cfg, modelId);
          if (model) {
            resolved = { engine, cfg, model };
            break;
          }
        }
        if (!resolved) {
          return yield* new LlmServeError({ kind: "not_found", reason: `Unknown model: ${modelId}` });
        }
        const { engine, cfg, model } = resolved;
        const modelPath = realpathOrSelf(model.path);

        // A fresh load attempt supersedes any lingering crash notice for this model.
        yield* clearError(modelId);

        const rows = yield* readRows;
        const procs = matchProcs(rows, enabled);
        const reg = yield* Ref.get(registry);
        const alreadyRunning =
          procs.some((p) => realpathOrSelf(p.modelPath) === modelPath) ||
          Array.from(reg.values()).some((l) => l.modelPath === modelPath);
        if (alreadyRunning) {
          return yield* new LlmServeError({ kind: "already_online", reason: `${modelId} is already online` });
        }

        // RAM budget (global across engines): online RSS + in-flight loading estimates (of
        // launches not yet visible in ps, to avoid double-counting their real RSS) + this.
        const budget = budgetOf(lm);
        const procPids = new Set(procs.map((p) => p.pid));
        const onlineRss = procs.reduce((sum, p) => sum + p.rssBytes, 0);
        const inflight = Array.from(reg.entries())
          .filter(([pid, l]) => l.state === "loading" && !procPids.has(pid))
          .reduce((sum, [, l]) => sum + l.estBytes, 0);
        const estBytes = model.estBytes;
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

        // A settings-specified executable given as a path must exist before we spawn it
        // (a bare PATH name like `mlx-serve` is left to the spawner to resolve).
        if (cfg.executable.includes("/") && !fs.existsSync(cfg.executable)) {
          return yield* new LlmServeError({
            kind: "spawn_failed",
            reason: `${engine.id} binary not found: ${cfg.executable}`,
          });
        }

        const args = engine.buildArgs({
          host: SERVE_HOST,
          port,
          modelPath,
          defaultArgs: cfg.defaultArgs,
          perModelArgs: cfg.perModel[modelId]?.args ?? [],
        });

        const cwd = engine.cwd(cfg);
        const childScope = yield* Scope.make();
        const spawned = yield* spawner
          .spawn(
            ChildProcess.make(cfg.executable, args, {
              detached: true,
              env: { ...process.env },
              shell: false,
              stdout: "ignore",
              stderr: "ignore",
              ...(cwd != null ? { cwd } : {}),
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
            reason: `Failed to start ${engine.id} for ${modelId}: ${spawned.cause}`,
          });
        }

        const pid = Number(spawned.child.pid);
        const launch: ManagedLaunch = {
          child: spawned.child,
          scope: childScope,
          engineId: engine.id,
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

      // External pid: re-read ps and re-verify it is a known managed-engine process RIGHT
      // NOW (narrows the pid-reuse window), refuse self, then SIGTERM the single pid only
      // (never an external process group — it could include the user's shell).
      if (pid === process.pid) {
        return yield* new LlmServeError({ kind: "not_managed_process", reason: "Refusing to kill self" });
      }
      const lm = yield* readConfig;
      const enabled = enabledEngines(lm);
      const rows = yield* readRows;
      const procs = matchProcs(rows, enabled);
      if (!procs.some((p) => p.pid === pid)) {
        return yield* new LlmServeError({
          kind: "not_managed_process",
          reason: `PID ${pid} is not a known local-model process`,
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
