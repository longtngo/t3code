/**
 * SubagentBackend — the machine-level switch deciding whether coding agents on this
 * host dispatch their subagents through Cursor or fall back to the default route.
 *
 * The state is one small JSON file at a fixed absolute path. It deliberately does
 * NOT live under T3 home: in a worktree that resolves to `<worktree>/.t3`, so a dev
 * server would write the toggle somewhere `~/bin/subagent-dispatch` never looks.
 *
 * Per-thread files DO live under T3 home (`ServerConfig.subagentThreadsDir`): the server
 * itself points each subprocess at its file via `SUBAGENT_BACKEND_STATE`, so the wrapper's
 * fixed default path is irrelevant for them. Every writer here resolves the same
 * `resolveThreadBackend` table and takes the same `backendWriteSemaphore` permit.
 *
 * Everything here fails safe toward "default". Defaulting to Cursor on an unreadable
 * file would silently spend the wrong quota, so an unparseable file, a missing file
 * and an explicit "default" all produce the same dispatch outcome — while still being
 * distinguishable through `degraded`, so a corrupt file can be surfaced rather than
 * looking like a deliberate Off forever.
 *
 * @module SubagentBackend
 */
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  CursorSettings,
  ProviderInstanceId,
  type ServerSettings,
  SUBAGENT_BACKEND_CURSOR,
  SUBAGENT_BACKEND_DEFAULT,
  type SubagentBackendInstance,
  type SubagentBackendModelOption,
  type SubagentBackendSetInput,
  subagentBackendThreadMode,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveCommandPath } from "@t3tools/shared/shell";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ServerConfig } from "../config.ts";
import { ProviderAdapterRegistry } from "../provider/Services/ProviderAdapterRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { listCursorModels, peekCursorModels } from "./cursorModels.ts";
import {
  THREAD_BACKEND_MAX_FILE_NAME_LENGTH,
  threadBackendFileName,
  threadBackendFilePath,
} from "./ThreadBackendPath.ts";

export const SUBAGENT_BACKEND_SCHEMA_VERSION = 1;

export interface PersistedBackend {
  readonly schemaVersion: number;
  readonly backend: string;
  readonly instanceId: string | null;
  readonly model: string | null;
  readonly binaryPath: string | null;
  readonly apiEndpoint: string;
  readonly updatedAt: string | null;
  /** Non-null when the file existed but could not be used as written. */
  readonly degraded: string | null;
}

export const OFF: PersistedBackend = {
  schemaVersion: SUBAGENT_BACKEND_SCHEMA_VERSION,
  backend: SUBAGENT_BACKEND_DEFAULT,
  instanceId: null,
  model: null,
  binaryPath: null,
  apiEndpoint: "",
  updatedAt: null,
  degraded: null,
};

const str = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

export function parsePersistedBackend(contents: string): PersistedBackend {
  const trimmed = contents.trim();
  if (trimmed.length === 0) return OFF;

  let raw: unknown;
  try {
    // Must degrade a corrupt or unknown-shaped file to `OFF`, not fail like `Schema.fromJsonString` would.
    raw = JSON.parse(trimmed);
  } catch {
    return { ...OFF, degraded: "The subagent toggle file could not be parsed as JSON." };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ...OFF, degraded: "The subagent toggle file could not be parsed as JSON." };
  }

  const record = raw as Record<string, unknown>;
  if (record.backend !== SUBAGENT_BACKEND_CURSOR) {
    // Includes both an explicit "default" and any value a newer build might write.
    // `degraded` is read back here too: the reconciler downgrades to "default" with
    // a reason attached, and that reason must survive the round trip so a real
    // downgrade stays distinguishable from a deliberate Off (see the module note).
    return { ...OFF, updatedAt: str(record.updatedAt), degraded: str(record.degraded) };
  }

  const binaryPath = str(record.binaryPath);
  if (binaryPath === null) {
    return {
      ...OFF,
      updatedAt: str(record.updatedAt),
      degraded: "The subagent toggle names Cursor but no binary, so it cannot dispatch.",
    };
  }

  return {
    schemaVersion:
      typeof record.schemaVersion === "number"
        ? record.schemaVersion
        : SUBAGENT_BACKEND_SCHEMA_VERSION,
    backend: SUBAGENT_BACKEND_CURSOR,
    instanceId: str(record.instanceId),
    model: str(record.model),
    binaryPath,
    apiEndpoint: typeof record.apiEndpoint === "string" ? record.apiEndpoint : "",
    updatedAt: str(record.updatedAt),
    // Read back rather than hardcoded null: the reconciler can re-resolve a still-valid
    // instance while leaving it degraded (e.g. an unresolvable binary), and that state
    // must survive the round trip the same way the "default" branch's does above.
    degraded: str(record.degraded),
  };
}

/** Fixed, absolute, and outside T3 home — see the module note. */
export const subagentBackendFilePath = Effect.fn("subagentBackend.filePath")(function* () {
  const path = yield* Path.Path;
  const home = process.env.HOME ?? "";
  return path.join(home, ".local", "state", "subagent-dispatch", "backend.json");
});

/**
 * Classified from the read alone, with no `fs.exists` probe in front of it: `exists` only
 * maps NotFound to `false` and fails the effect on anything else (a parent directory the
 * server cannot traverse), which would take down every writer that reads the global record
 * first. Here NotFound is absence and reads as a clean Off (`absentDegraded`), while any
 * other failure is damage and surfaces through `degraded` rather than reading as an empty
 * file, which `parsePersistedBackend` maps to a clean Off, indistinguishable from a
 * deliberate one — the fail-safe this module promises.
 */
const readBackendFileAt = Effect.fn("subagentBackend.readAt")(function* (
  filePath: string,
  absentDegraded: string | null,
  failurePrefix: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const result = yield* Effect.result(fs.readFileString(filePath));
  if (Result.isFailure(result)) {
    if (result.failure.reason._tag === "NotFound") {
      return { ...OFF, degraded: absentDegraded } satisfies PersistedBackend;
    }
    return { ...OFF, degraded: `${failurePrefix}${result.failure.message}` };
  }
  return parsePersistedBackend(result.success);
});

export const readBackendFile = Effect.fn("subagentBackend.read")(function* () {
  const filePath = yield* subagentBackendFilePath();
  return yield* readBackendFileAt(filePath, null, "The subagent toggle file could not be read: ");
});

/**
 * One permit for every mutation of the flag file. `set` and the settings-change
 * reconciler are independent writers, and without ordering a `set` landing after a
 * reconciliation resurrects a backend for an instance that was just disabled —
 * exactly the hole reconciliation exists to close. Atomicity alone does not fix it;
 * the writes are individually atomic and still arrive in the wrong order.
 */
export const backendWriteSemaphore = Effect.runSync(Semaphore.make(1));

/** The exact plain shape `parsePersistedBackend` and the wrapper's jq filter read. Shared by
 * the global file and every per-thread file, so the wrapper needs no second parser. */
function serializePersistedBackend(next: PersistedBackend, updatedAt: string): string {
  return `${JSON.stringify(
    {
      schemaVersion: SUBAGENT_BACKEND_SCHEMA_VERSION,
      backend: next.backend,
      instanceId: next.instanceId,
      model: next.model,
      binaryPath: next.binaryPath,
      apiEndpoint: next.apiEndpoint,
      updatedAt,
      degraded: next.degraded,
    },
    null,
    2,
  )}\n`;
}

/** The write itself, with no locking. Only ever called from inside a `backendWriteSemaphore` permit. */
const writeBackendFileBody = Effect.fn("subagentBackend.writeBody")(function* (
  next: PersistedBackend,
) {
  const fs = yield* FileSystem.FileSystem;
  const filePath = yield* subagentBackendFilePath();
  const updatedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
  yield* writeFileStringAtomically({
    filePath,
    contents: serializePersistedBackend(next, updatedAt),
  });
  // After the rename, not before: `writeFileStringAtomically` renames from a temp
  // directory it owns, so there is no earlier handle to chmod. The window is one
  // effect step at the destination, versus a permanent umask leak without it.
  yield* fs.chmod(filePath, 0o600).pipe(Effect.ignore);
});

/**
 * Test seeding only; production writes go through `setBackend` and `reconcileAllBackends`,
 * which take the permit themselves — never call this from inside a permit.
 */
export const writeBackendFile = Effect.fn("subagentBackend.write")(function* (
  next: PersistedBackend,
) {
  yield* backendWriteSemaphore.withPermits(1)(writeBackendFileBody(next));
});

const decodeCursorSettings = Schema.decodeUnknownSync(CursorSettings);

/** Best-effort decode: an instance already gated on `driver === "cursor"` should always
 * conform, but a hand-edited settings file should degrade rather than throw. Returns null
 * on a config that will not decode, because the alternative — Cursor's schema defaults —
 * silently yields `binaryPath: "cursor-agent"`, a binary the user never configured and
 * which need not be the one they run. Refusing to dispatch beats dispatching to a guess. */
function decodeCursorInstanceConfig(config: unknown): CursorSettings | null {
  try {
    return decodeCursorSettings(config ?? {});
  } catch {
    return null;
  }
}

/** Narrows a flag-file instance id to the branded slug, or null when it does not conform. */
function validInstanceIdOrNull(value: string | null): ProviderInstanceId | null {
  if (value === null) return null;
  return Schema.is(ProviderInstanceId)(value) ? value : null;
}

/** Enabled Cursor instances this machine can dispatch subagents to. */
export function cursorInstances(settings: ServerSettings): readonly SubagentBackendInstance[] {
  const instances: SubagentBackendInstance[] = [];
  for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
    if (instance.driver !== SUBAGENT_BACKEND_CURSOR || instance.enabled !== true) continue;
    instances.push({
      instanceId: instanceId as ProviderInstanceId,
      displayName: instance.displayName ?? instanceId,
      ...(instance.accentColor ? { accentColor: instance.accentColor } : {}),
    });
  }
  return instances;
}

interface ValidCursorInstance {
  readonly ok: true;
  readonly instanceId: ProviderInstanceId;
  readonly config: CursorSettings;
}
interface InvalidCursorInstance {
  readonly ok: false;
  readonly reason: string;
}

/** The file must never name a provider this machine cannot dispatch to: absent,
 * disabled, and wrong-driver instances are all rejected the same way. */
export function validateCursorInstance(
  settings: ServerSettings,
  instanceId: string | undefined,
): ValidCursorInstance | InvalidCursorInstance {
  const reason =
    instanceId === undefined
      ? "No instance was named, and none is an enabled Cursor instance."
      : `Instance "${instanceId}" is not an enabled Cursor instance.`;
  if (instanceId === undefined) return { ok: false, reason };
  const instance = settings.providerInstances[instanceId as ProviderInstanceId];
  if (instance === undefined) return { ok: false, reason };
  if (instance.enabled !== true) return { ok: false, reason };
  if (instance.driver !== SUBAGENT_BACKEND_CURSOR) return { ok: false, reason };
  const config = decodeCursorInstanceConfig(instance.config);
  if (config === null) {
    return {
      ok: false,
      reason: `Instance "${instanceId}" has a Cursor config that could not be read.`,
    };
  }
  return { ok: true, instanceId: instanceId as ProviderInstanceId, config };
}

/**
 * Turns a validated Cursor instance into the record the flag file stores. Resolves the
 * binary on the server's PATH (`resolveCommandPath` never spawns a subprocess: it stats
 * an explicit path on every call, and memoises only bare command names, for 30s) and
 * degrades — writes the configured string as-is with a reason — when that fails, because
 * the wrapper's own shell PATH may still find it.
 */
const resolveCursorTarget = Effect.fn("subagentBackend.resolveCursorTarget")(function* (
  validated: ValidCursorInstance,
  model: string,
) {
  const { config } = validated;
  const resolution = yield* Effect.result(resolveCommandPath(config.binaryPath));
  const binaryPath = Result.isSuccess(resolution) ? resolution.success : config.binaryPath;
  const degraded = Result.isFailure(resolution)
    ? `Could not resolve "${config.binaryPath}" on the server's PATH; wrote it as-is ` +
      `because the wrapper's own shell PATH may still find it.`
    : null;
  return {
    schemaVersion: SUBAGENT_BACKEND_SCHEMA_VERSION,
    backend: SUBAGENT_BACKEND_CURSOR,
    instanceId: validated.instanceId,
    model,
    binaryPath,
    apiEndpoint: config.apiEndpoint,
    updatedAt: null,
    degraded,
  } satisfies PersistedBackend;
});

export const MASTER_OFF_REASON = "Subagent offload is switched off in Settings.";

/**
 * The one truth table every per-thread writer uses. Master off beats everything;
 * `"inherit"` and an absent entry are the same thing; `"on"` reuses the global Cursor
 * target when there is one and otherwise resolves the first enabled Cursor instance,
 * so a thread can offload without the user first flipping the machine-wide toggle.
 *
 * Only an explicit `"on"` may enable offload — see `subagentBackendThreadMode` for why the
 * lookup cannot be a plain `?? "inherit"`.
 */
export const resolveThreadBackend = Effect.fn("subagentBackend.resolveThread")(function* (input: {
  readonly settings: ServerSettings;
  readonly threadId: ThreadId;
  readonly global: PersistedBackend;
}) {
  const { settings, threadId, global } = input;
  if (settings.subagentBackendEnabled === false) {
    return { ...OFF, degraded: MASTER_OFF_REASON } satisfies PersistedBackend;
  }
  const mode = subagentBackendThreadMode(settings.subagentBackendThreadModes, threadId);
  if (mode === "off") return OFF;
  if (mode !== "on") return global;
  if (global.backend === SUBAGENT_BACKEND_CURSOR) return global;
  const first = cursorInstances(settings)[0]?.instanceId;
  const validated = validateCursorInstance(settings, first);
  if (!validated.ok) return { ...OFF, degraded: validated.reason } satisfies PersistedBackend;
  return yield* resolveCursorTarget(validated, "auto");
});

class ThreadBackendNameTooLongError extends Data.TaggedError("ThreadBackendNameTooLongError")<{
  readonly threadId: ThreadId;
  readonly length: number;
}> {}

/**
 * Creates the threads directory 0700, once per batch of writes rather than per file:
 * the record names a binary path and an API endpoint, the same reason the global file
 * is 0600. `writeFileStringAtomically` creates the directory itself, so this is only
 * about the mode.
 */
const ensureThreadsDir = Effect.fn("subagentBackend.ensureThreadsDir")(function* (
  threadsDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(threadsDir, { recursive: true });
  yield* fs.chmod(threadsDir, 0o700).pipe(Effect.ignore);
});

/**
 * Writes one thread's flag file. No locking here — callers hold `backendWriteSemaphore`,
 * and call `ensureThreadsDir` once before their batch.
 */
export const writeThreadBackendFile = Effect.fn("subagentBackend.writeThread")(function* (
  threadsDir: string,
  threadId: ThreadId,
  next: PersistedBackend,
) {
  const fs = yield* FileSystem.FileSystem;
  const fileName = threadBackendFileName(threadId);
  if (fileName.length > THREAD_BACKEND_MAX_FILE_NAME_LENGTH) {
    return yield* new ThreadBackendNameTooLongError({ threadId, length: fileName.length });
  }
  const filePath = threadBackendFilePath(threadsDir, threadId);
  const updatedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
  yield* writeFileStringAtomically({
    filePath,
    contents: serializePersistedBackend(next, updatedAt),
  });
  yield* fs.chmod(filePath, 0o600).pipe(Effect.ignore);
});

/** Reads a thread's file with the same fail-safe parse as the global one: missing or
 * malformed yields `default` with a `degraded` reason.
 *
 * Test-facing reader; production never reads a thread file — only the wrapper does. */
export const readThreadBackendFile = Effect.fn("subagentBackend.readThread")(function* (
  threadsDir: string,
  threadId: ThreadId,
) {
  return yield* readBackendFileAt(
    threadBackendFilePath(threadsDir, threadId),
    "No thread flag file.",
    "The thread flag file could not be read: ",
  );
});

/**
 * Rewrites every live thread's file from `settings` and the global record. No locking —
 * callers hold the permit. Sessions are enumerated per adapter, each under `Effect.catchCause`,
 * because `registry.getByInstance` fails with `ProviderUnsupportedError` for an instance
 * removed between `listInstances()` and this lookup, and one such instance must not stop the
 * other providers' threads from being reconciled. Each write is likewise isolated: one
 * over-long or unwritable thread id is logged, not fatal.
 *
 * The cost of that isolation is a fail-open: a skipped adapter's threads are not rewritten
 * in this pass, so a live session under it keeps whatever its flag file last said — including
 * a Cursor target after the master switch was turned off. Such a thread only catches up at
 * its next session start, when `writeThreadBackendForSession` rewrites the file.
 */
const reconcileThreadBackendsBody = Effect.fn("subagentBackend.reconcileThreads")(function* (
  settings: ServerSettings,
  global: PersistedBackend,
) {
  const registry = yield* ProviderAdapterRegistry;
  const { subagentThreadsDir } = yield* ServerConfig;
  const threadIds = new Set<ThreadId>();
  for (const instanceId of yield* registry.listInstances()) {
    const sessions = yield* registry.getByInstance(instanceId).pipe(
      Effect.flatMap((adapter) => adapter.listSessions()),
      Effect.catchCause((cause) =>
        Effect.logWarning("subagentBackend.reconcileThreads: listSessions failed", {
          instanceId,
          cause,
        }).pipe(Effect.as([])),
      ),
    );
    for (const session of sessions) threadIds.add(session.threadId);
  }
  yield* ensureThreadsDir(subagentThreadsDir);
  yield* Effect.forEach(
    threadIds,
    (threadId) =>
      resolveThreadBackend({ settings, threadId, global }).pipe(
        Effect.flatMap((next) => writeThreadBackendFile(subagentThreadsDir, threadId, next)),
        Effect.catchCause((cause) =>
          Effect.logWarning("subagentBackend.reconcileThreads: write failed", { threadId, cause }),
        ),
      ),
    { concurrency: 8, discard: true },
  );
});

/**
 * Global + every thread, under one permit, from one settings read taken inside the permit
 * so a settings write racing this call cannot leave the thread files reflecting an older
 * snapshot than the global file.
 */
export const reconcileAllBackends = Effect.fn("subagentBackend.reconcileAll")(function* () {
  const serverSettings = yield* ServerSettingsService;
  yield* backendWriteSemaphore.withPermits(1)(
    Effect.gen(function* () {
      const settings = yield* serverSettings.getRawSettings;
      const global = yield* reconcileBackendBody(settings);
      yield* reconcileThreadBackendsBody(settings, global);
    }),
  );
});

/**
 * Called by `ProviderService` around every `adapter.startSession` — once immediately
 * before it, so the file the new subprocess's `SUBAGENT_BACKEND_STATE` points at exists
 * before the first subagent could be dispatched, and once immediately after, because a
 * settings change landing while the adapter starts up enumerates only sessions already
 * registered and so cannot see this one.
 *
 * `removeOnFailure` (default true) is for the PRE-start call: a failure there is logged
 * and the thread's file REMOVED rather than left alone, because nothing else ever deletes
 * one, so the previous session's record — possibly a Cursor target this call could no
 * longer confirm — would otherwise be what the new subprocess dispatches on. An absent
 * file makes the wrapper refuse, which is the safe direction, and a session must never be
 * blocked from starting over this.
 *
 * The POST-start call passes `false`: by then the pre-start write has already put a file
 * this same session resolved for the current settings, and deleting it on a transient
 * failure would strand a live subprocess with no file at all — strictly worse than the
 * one it is holding.
 */
export const writeThreadBackendForSession = Effect.fn("subagentBackend.writeForSession")(function* (
  threadId: ThreadId,
  options?: { readonly removeOnFailure: boolean },
) {
  const removeOnFailure = options?.removeOnFailure ?? true;
  const fs = yield* FileSystem.FileSystem;
  const serverSettings = yield* ServerSettingsService;
  const { subagentThreadsDir } = yield* ServerConfig;
  // The failure handler (including the removal below) runs inside this same permit, not
  // after it: outside the permit a concurrent writer could land its own file for this
  // thread between our failure and the removal, and we would delete a file we never wrote.
  yield* backendWriteSemaphore.withPermits(1)(
    Effect.gen(function* () {
      const settings = yield* serverSettings.getRawSettings;
      const global = yield* readBackendFile();
      const next = yield* resolveThreadBackend({ settings, threadId, global });
      yield* ensureThreadsDir(subagentThreadsDir);
      yield* writeThreadBackendFile(subagentThreadsDir, threadId, next);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          if (removeOnFailure) {
            yield* fs
              .remove(threadBackendFilePath(subagentThreadsDir, threadId), { force: true })
              .pipe(
                Effect.catchCause((cause) =>
                  // Louder than the write failure itself: a stale enabling file that survived
                  // both the write and its removal is the one state that dispatches wrongly.
                  Effect.logError("subagentBackend.writeForSession: stale file left behind", {
                    threadId,
                    cause,
                  }),
                ),
              );
          }
          yield* Effect.logWarning("subagentBackend.writeForSession failed", { threadId, cause });
        }),
      ),
    ),
  );
});

/**
 * Validates a subagent-backend selection, resolves the Cursor binary, persists it, and
 * fans the result out to every live thread's file — all under one permit, from one
 * settings read, so a disable or a master-off that lands mid-call is seen by every write
 * or by none.
 *
 * Under master-off only a selection of Cursor is refused, without writing: the file the
 * user set last stays as it was and the returned `degraded` says why nothing changed. A
 * selection of "default" is still admitted, so the master switch is not a one-way door
 * that strands the global file on a Cursor target with no way to clear it.
 */
export const setBackend = Effect.fn("subagentBackend.set")(function* (
  input: SubagentBackendSetInput,
) {
  const serverSettings = yield* ServerSettingsService;
  return yield* backendWriteSemaphore.withPermits(1)(
    Effect.gen(function* () {
      const settings = yield* serverSettings.getRawSettings;
      if (settings.subagentBackendEnabled === false && input.backend === SUBAGENT_BACKEND_CURSOR) {
        const current = yield* readBackendFile();
        return { ...current, degraded: MASTER_OFF_REASON } satisfies PersistedBackend;
      }
      let next: PersistedBackend;
      if (input.backend !== SUBAGENT_BACKEND_CURSOR) {
        next = OFF;
      } else {
        const validated = validateCursorInstance(settings, input.instanceId);
        next = validated.ok
          ? yield* resolveCursorTarget(validated, input.model ?? "auto")
          : { ...OFF, degraded: validated.reason };
      }
      yield* writeBackendFileBody(next);
      // The global file is already on disk, so a crashing fan-out must not turn a saved
      // selection into a "could not be saved" at the RPC boundary. The threads it missed
      // catch up at their next session start.
      yield* reconcileThreadBackendsBody(settings, next).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("subagentBackend.set: thread fan-out failed", { cause }),
        ),
      );
      return next;
    }),
  );
});

/** Assembles the wire-shaped state from a persisted record, the instance picker
 * list, and an already-fetched model list (see `listCursorModels`). */
export function buildState(
  persisted: PersistedBackend,
  settings: ServerSettings,
  models: readonly SubagentBackendModelOption[],
) {
  return {
    backend: persisted.backend,
    // Validated, not cast: unlike the other `ProviderInstanceId` sites in this module —
    // which read keys of `settings.providerInstances`, already checked on settings decode —
    // this value comes from the flag FILE, which is hand-editable. An id that does not match
    // the branded slug pattern would otherwise fail success-encoding at the RPC boundary
    // instead of degrading, taking the whole panel down over one bad character.
    instanceId: validInstanceIdOrNull(persisted.instanceId),
    model: persisted.model,
    instances: cursorInstances(settings),
    models,
    degraded: persisted.degraded,
  };
}

/**
 * Resolves the Cursor CLI model list for a persisted backend state.
 * `refresh: false` — the `subagentBackend.get` default, see
 * `WsSubagentBackendGetRpc`'s payload doc — never spawns a probe, only
 * reporting whatever `listCursorModels` already has cached (via
 * `peekCursorModels`), because `get` runs on every client mount and must stay
 * cheap. `refresh: true` (`set`, or `get` once the panel opens and asks) probes.
 */
export const modelsForPersistedBackend = (persisted: PersistedBackend, refresh: boolean) => {
  if (persisted.backend !== SUBAGENT_BACKEND_CURSOR || persisted.binaryPath === null) {
    return Effect.succeed<readonly SubagentBackendModelOption[]>([]);
  }
  return refresh
    ? listCursorModels(persisted.binaryPath)
    : Effect.succeed(peekCursorModels(persisted.binaryPath));
};

/** Compares everything but `schemaVersion`/`updatedAt` — the fields that determine
 * dispatch behavior, versus the write bookkeeping that always changes. */
function haveReconcilableFieldsChanged(next: PersistedBackend, current: PersistedBackend): boolean {
  return (
    next.backend !== current.backend ||
    next.instanceId !== current.instanceId ||
    next.model !== current.model ||
    next.binaryPath !== current.binaryPath ||
    next.apiEndpoint !== current.apiEndpoint ||
    next.degraded !== current.degraded
  );
}

/**
 * Re-checks the currently flagged Cursor instance against fresh settings and
 * rewrites the file when it drifts: gone/disabled/wrong-driver downgrades to
 * `default`, and a still-valid instance gets its `binaryPath`/`apiEndpoint`
 * re-resolved, because a reconciler that only downgrades would otherwise leave
 * the file pointing at a binary the user has since moved or reconfigured.
 *
 * A no-op when the file is already `default`: with no flagged instance there is
 * nothing here to check against `settings`, and a lazy check inside `read`/`set`
 * was considered and rejected — the wrapper reads the file directly, never
 * `read`, so a lazy path would never run where it matters.
 *
 * The reconcile itself, no locking; returns the global record now on disk (rewritten or not).
 */
export const reconcileBackendBody = Effect.fn("subagentBackend.reconcileBody")(function* (
  settings: ServerSettings,
) {
  const current = yield* readBackendFile();
  if (current.backend !== SUBAGENT_BACKEND_CURSOR) return current;

  const validated = validateCursorInstance(settings, current.instanceId ?? undefined);
  let next: PersistedBackend;
  if (!validated.ok) {
    next = { ...OFF, degraded: validated.reason };
  } else {
    const resolved = yield* resolveCursorTarget(validated, current.model ?? "auto");
    next = { ...resolved, model: current.model };
  }

  // Nothing dispatch-relevant changed: skip the write rather than bumping
  // `updatedAt` on every unrelated settings change.
  if (!haveReconcilableFieldsChanged(next, current)) return current;
  yield* writeBackendFileBody(next);
  return next;
});

/**
 * Subscriber body meant to be forked once at server startup: reconciles the flag
 * file once against whatever settings are current, then keeps reconciling for the
 * process lifetime as they change. A subscriber rather than a hook inside
 * `updateSettings` — `serverSettings.ts` stays unaware of this feature, and any
 * other writer of `ServerSettings` is covered too. Reconcile failures are logged
 * and swallowed so one bad settings snapshot cannot take the subscription down.
 *
 * Uses `subscribeChanges`, not `streamChanges`: the latter is a bare
 * `Stream.fromPubSub` with no initial emission and no subscriber until the stream
 * is run, so a settings change between server start and the first emission would
 * be lost, and — with nothing to reconcile against at startup — an instance
 * disabled or deleted, or a settings.json hand-edited, while the server was down
 * would leave the flag file dispatching to Cursor indefinitely, until some
 * unrelated settings write happened to occur. `subscribeChanges` acquires the
 * subscription synchronously in this fiber before the explicit startup reconcile
 * below reads a snapshot, so nothing in between can be missed either.
 */
export const subagentBackendReconciler = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService;
  const changes = yield* serverSettings.subscribeChanges;

  // The stream payload is ignored on purpose: `reconcileAllBackends` re-reads settings
  // inside the write permit, so the global file and every thread file come from one
  // snapshot no concurrent settings write can split.
  const reconcileLogged = reconcileAllBackends().pipe(
    Effect.catchCause((cause) => Effect.logWarning("subagentBackend.reconcile failed", { cause })),
  );

  yield* reconcileLogged;
  yield* changes.pipe(Stream.runForEach(() => reconcileLogged));
});
