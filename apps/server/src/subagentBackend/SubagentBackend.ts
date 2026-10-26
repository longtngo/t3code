/**
 * SubagentBackend - the machine switch for Cursor subagent dispatch. The global file is at a
 * fixed path, NOT under T3 home (the wrapper cannot see a worktree's `.t3`). Fails safe toward
 * "default"; `degraded` keeps a corrupt file distinguishable from a deliberate Off.
 *
 * @module SubagentBackend
 */
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
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
import { CursorSettings } from "@t3tools/provider-cursor/settings";
import { resolveCommandPath } from "@t3tools/shared/shell";
import { cursorOffloadBlockedReason, cursorTotalUsageLimits } from "@t3tools/shared/usageLimits";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { ServerConfig } from "../config.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { listCursorModels, peekCursorModels } from "./cursorModels.ts";
import {
  layer as SubagentLiveThreadsLayer,
  registerActiveSubagentThreadBackend,
  SubagentLiveThreads,
} from "./SubagentLiveThreads.ts";
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
  // A non-dispatching file still remembers the last Cursor target, so threads switched to
  // Cursor (and a later flip back to Cursor) reuse the user's pick. `binaryPath` stays null,
  // so neither the wrapper nor any reader can dispatch from it.
  const remembered = {
    ...OFF,
    instanceId: str(record.instanceId),
    model: str(record.model),
    updatedAt: str(record.updatedAt),
  };
  if (record.backend !== SUBAGENT_BACKEND_CURSOR) {
    // Includes both an explicit "default" and any value a newer build might write.
    // `degraded` is read back here too: the reconciler downgrades to "default" with
    // a reason attached, and that reason must survive the round trip so a real
    // downgrade stays distinguishable from a deliberate Off (see the module note).
    return { ...remembered, degraded: str(record.degraded) };
  }

  const binaryPath = str(record.binaryPath);
  if (binaryPath === null) {
    return {
      ...remembered,
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
 * Classified from the read alone: `fs.exists` fails on anything but NotFound (e.g. an
 * untraversable parent) and would take down every writer. NotFound is a clean Off; any other
 * failure surfaces through `degraded` instead of reading as a deliberate Off.
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
 * One permit for every flag-file mutation. `set` and the reconciler are independent writers,
 * and a `set` landing after a reconciliation would resurrect a just-disabled instance; atomic
 * writes alone do not fix ordering.
 */
export const backendWriteSemaphore = Semaphore.makeUnsafe(1);

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

/** Best-effort decode: a hand-edited settings file degrades rather than throws. Null on
 * failure, because Cursor's schema defaults would yield `binaryPath: "cursor-agent"`, a binary
 * the user never configured. Refusing to dispatch beats dispatching to a guess. */
function decodeCursorInstanceConfig(config: unknown): CursorSettings | null {
  try {
    return decodeCursorSettings(config ?? {});
  } catch {
    return null;
  }
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
 * The Cursor CLI the wrapper execs. V2's Cursor provider runs on the Cursor SDK, so its
 * settings keep `binaryPath` only as an optional, hidden V1 carry-over with no default; the
 * wrapper still needs a CLI, and `cursor-agent` is the name the CLI installs under.
 */
export const CURSOR_CLI_DEFAULT_BINARY = "cursor-agent";

export const cursorCliBinaryPath = (config: CursorSettings): string =>
  config.binaryPath !== undefined && config.binaryPath.length > 0
    ? config.binaryPath
    : CURSOR_CLI_DEFAULT_BINARY;

/**
 * A validated Cursor instance as the flag-file record. Resolves the binary on the server's
 * PATH (no subprocess); on failure stores the configured string with a `degraded` reason,
 * since the wrapper's own PATH may still find it.
 */
const resolveCursorTarget = Effect.fn("subagentBackend.resolveCursorTarget")(function* (
  validated: ValidCursorInstance,
  model: string,
) {
  const { config } = validated;
  const configured = cursorCliBinaryPath(config);
  // `null` is "not found": the resolver no longer fails for it.
  const resolved = yield* resolveCommandPath(configured);
  const binaryPath = resolved ?? configured;
  const degraded =
    resolved === null
      ? `Could not resolve "${configured}" on the server's PATH; wrote it as-is ` +
        `because the wrapper's own shell PATH may still find it.`
      : null;
  return {
    schemaVersion: SUBAGENT_BACKEND_SCHEMA_VERSION,
    backend: SUBAGENT_BACKEND_CURSOR,
    instanceId: validated.instanceId,
    model,
    binaryPath,
    apiEndpoint: config.apiEndpoint ?? "",
    updatedAt: null,
    degraded,
  } satisfies PersistedBackend;
});

export const MASTER_OFF_REASON = "Subagent offload is switched off in Settings.";

/**
 * Why Cursor offload is withheld for spending (credits off and Cursor's window at 100% before
 * reset), or `null`. Read live from the registry; no layer edge, since Claude adapters reach
 * `prepareThreadBackend` through `SubagentLiveThreads`' module-level registration.
 */
const readCreditsBlockedReason = Effect.fn("subagentBackend.creditsBlocked")(function* (
  settings: ServerSettings,
) {
  const registry = yield* ProviderRegistry;
  return cursorOffloadBlockedReason({
    allowSpendingCredits: settings.allowSpendingCredits,
    cursorLimits: cursorTotalUsageLimits(yield* registry.getProviders),
    nowMs: yield* Clock.currentTimeMillis,
  });
});

/**
 * The truth table every per-thread writer uses. Master off beats everything; `"inherit"` and
 * absent are equal; `"on"` reuses the global Cursor target, else the remembered or first
 * enabled instance. Only an explicit `"on"` enables (see `subagentBackendThreadMode`).
 */
export const resolveThreadBackend = Effect.fn("subagentBackend.resolveThread")(function* (input: {
  readonly settings: ServerSettings;
  readonly threadId: ThreadId;
  readonly global: PersistedBackend;
  readonly creditsBlockedReason: string | null;
}) {
  const { settings, threadId, global } = input;
  if (settings.subagentBackendEnabled === false) {
    return { ...OFF, degraded: MASTER_OFF_REASON } satisfies PersistedBackend;
  }
  if (input.creditsBlockedReason !== null) {
    return { ...OFF, degraded: input.creditsBlockedReason } satisfies PersistedBackend;
  }
  const mode = subagentBackendThreadMode(settings.subagentBackendThreadModes, threadId);
  if (mode === "off") return OFF;
  if (mode !== "on") return global;
  if (global.backend === SUBAGENT_BACKEND_CURSOR) return global;
  const remembered = validateCursorInstance(settings, global.instanceId ?? undefined);
  const validated = remembered.ok
    ? remembered
    : validateCursorInstance(settings, cursorInstances(settings)[0]?.instanceId);
  if (!validated.ok) return { ...OFF, degraded: validated.reason } satisfies PersistedBackend;
  return yield* resolveCursorTarget(validated, global.model ?? "auto");
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

/** Reads a thread's file with the global file's fail-safe parse: missing or malformed is
 * `default` with a `degraded` reason, never a failed session start. `ClaudeAdapter` also reads
 * it at session start to decide whether to append the dispatch instruction. */
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
 * Rewrites every live thread's file (`SubagentLiveThreads`: the only subprocesses pointed into
 * this directory). Callers hold the permit. Each write is isolated, so one bad thread id is
 * logged and cannot stop the rest.
 */
const reconcileThreadBackendsBody = Effect.fn("subagentBackend.reconcileThreads")(function* (
  settings: ServerSettings,
  global: PersistedBackend,
) {
  const liveThreads = yield* SubagentLiveThreads;
  const { subagentThreadsDir } = yield* ServerConfig;
  const threadIds = new Set<ThreadId>(yield* liveThreads.list);
  yield* ensureThreadsDir(subagentThreadsDir);
  const creditsBlockedReason = yield* readCreditsBlockedReason(settings);
  yield* Effect.forEach(
    threadIds,
    (threadId) =>
      resolveThreadBackend({ settings, threadId, global, creditsBlockedReason }).pipe(
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
 * Writes one thread's flag file just before its Claude process spawns. `removeOnFailure`
 * (default true) deletes the file on failure, since nothing else does and a stale Cursor
 * target would be dispatched on; absent makes the wrapper refuse. `false` keeps a prior good
 * file for a process already running on it. Never blocks a session start.
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
      const creditsBlockedReason = yield* readCreditsBlockedReason(settings);
      const next = yield* resolveThreadBackend({
        settings,
        threadId,
        global,
        creditsBlockedReason,
      });
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

/** What a Claude process is told about subagent offload when it is spawned. */
export interface PreparedThreadBackend {
  /** Absolute path the process's `SUBAGENT_BACKEND_STATE` points at. */
  readonly statePath: string;
  /** The resolved backend written there: `cursor` or `default`. */
  readonly backend: string;
}

/**
 * Called by a Claude adapter before spawning for `threadId`: registers it live, writes its file,
 * and reads it back. Never fails (failures read as `default`). Registering before the spawn
 * means any later reconcile already sees the thread, so no post-start write is needed.
 */
export const prepareThreadBackend = Effect.fn("subagentBackend.prepareThread")(function* (
  threadId: ThreadId,
) {
  const liveThreads = yield* SubagentLiveThreads;
  const { subagentThreadsDir } = yield* ServerConfig;
  yield* liveThreads.register(threadId);
  yield* writeThreadBackendForSession(threadId);
  const written = yield* readThreadBackendFile(subagentThreadsDir, threadId);
  return {
    statePath: threadBackendFilePath(subagentThreadsDir, threadId),
    backend: written.backend,
  } satisfies PreparedThreadBackend;
});

/**
 * Validates, resolves, persists and fans out a selection under one permit and one settings
 * read. Under master-off only a Cursor pick is refused (unwritten); "default" is admitted so
 * the switch is not a one-way door. Omitted instance or model reuse the remembered ones; a
 * different instance without a model drops the old model. `targetOnly`: see the input type.
 */
/** What `setBackend` returns: the record now on disk, plus `refused` when nothing was written. */
export type SetBackendResult = PersistedBackend & { readonly refused?: string };

export const setBackend = Effect.fn("subagentBackend.set")(function* (
  input: SubagentBackendSetInput,
) {
  const serverSettings = yield* ServerSettingsService;
  return yield* backendWriteSemaphore.withPermits(1)(
    Effect.gen(function* () {
      const settings = yield* serverSettings.getRawSettings;
      const current = yield* readBackendFile();
      const backend = input.targetOnly === true ? current.backend : input.backend;
      // Refusals write nothing and return the stored record with the reason beside it.
      const refuse = (refused: string): SetBackendResult => ({ ...current, refused });
      if (settings.subagentBackendEnabled === false && backend === SUBAGENT_BACKEND_CURSOR) {
        return refuse(MASTER_OFF_REASON);
      }
      // A bare selection (an old cached web bundle sends none) keeps the remembered pick.
      const instanceId = input.instanceId ?? current.instanceId;
      const model = input.model ?? (instanceId === current.instanceId ? current.model : null);
      let next: SetBackendResult;
      if (backend !== SUBAGENT_BACKEND_CURSOR) {
        // A picker naming an instance is validated even on Default, so a stale panel cannot
        // replace the remembered target with one that could never dispatch.
        if (input.targetOnly === true && input.instanceId !== undefined) {
          const validated = validateCursorInstance(settings, input.instanceId);
          if (!validated.ok) return refuse(validated.reason);
        }
        next = { ...OFF, instanceId, model };
      } else {
        const validated = validateCursorInstance(settings, instanceId ?? undefined);
        if (!validated.ok && input.targetOnly === true) return refuse(validated.reason);
        next = validated.ok
          ? yield* resolveCursorTarget(validated, model ?? "auto")
          : // A refused pick must not overwrite a remembered instance that may still be
            // valid, and the model stays with whichever instance is kept.
            {
              ...OFF,
              instanceId: current.instanceId ?? input.instanceId ?? null,
              model: current.instanceId !== null ? current.model : model,
              degraded: validated.reason,
            };
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
  persisted: SetBackendResult,
  settings: ServerSettings,
  models: readonly SubagentBackendModelOption[],
) {
  const instances = cursorInstances(settings);
  return {
    backend: persisted.backend,
    // Hidden unless it is an enabled Cursor instance, on Default and Cursor files alike.
    instanceId: instances.find((i) => i.instanceId === persisted.instanceId)?.instanceId ?? null,
    model: persisted.model,
    instances,
    models,
    degraded: persisted.degraded,
    ...(persisted.refused === undefined ? {} : { refused: persisted.refused }),
  };
}

/**
 * Cursor model list for a persisted backend. `refresh: false` (the `get` default, and always
 * on `set`) only peeks the cache: `get` runs on every mount and `set` is on the toggle's
 * critical path. `refresh: true` probes, reached only by `get` once the panel opens.
 */
export const modelsForPersistedBackend = (persisted: PersistedBackend, refresh: boolean) => {
  if (persisted.backend !== SUBAGENT_BACKEND_CURSOR || persisted.binaryPath === null) {
    return Effect.succeed<readonly SubagentBackendModelOption[]>([]);
  }
  return refresh
    ? listCursorModels(persisted.binaryPath)
    : Effect.succeed(peekCursorModels(persisted.binaryPath));
};

/**
 * The whole `subagentBackend.set` RPC, here rather than in `ws.ts` so no-probe is structural:
 * no `refresh` flag at the boundary to get wrong (the probe is 0.7-3.8 s with a stale label),
 * and `SubagentBackend.set.test.ts`'s dying mock reaches it. `get` keeps `refresh` on purpose.
 */
export const setBackendState = Effect.fn("subagentBackend.setState")(function* (
  input: SubagentBackendSetInput,
) {
  const serverSettings = yield* ServerSettingsService;
  const persisted = yield* setBackend(input);
  const settings = yield* serverSettings.getRawSettings;
  const models = yield* modelsForPersistedBackend(persisted, false);
  return buildState(persisted, settings, models);
});

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
 * Re-checks the flagged Cursor instance against settings: gone/disabled/wrong-driver
 * downgrades to `default`, a valid one gets its binary and endpoint re-resolved. No-op when
 * already `default`. Not lazy in `read`/`set`: the wrapper reads the file directly. No locking;
 * returns the global record now on disk.
 */
export const reconcileBackendBody = Effect.fn("subagentBackend.reconcileBody")(function* (
  settings: ServerSettings,
) {
  const current = yield* readBackendFile();
  if (current.backend !== SUBAGENT_BACKEND_CURSOR) return current;

  const validated = validateCursorInstance(settings, current.instanceId ?? undefined);
  let next: PersistedBackend;
  if (!validated.ok) {
    next = {
      ...OFF,
      instanceId: current.instanceId,
      model: current.model,
      degraded: validated.reason,
    };
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

/** Logged once the files are rewritten for a changed credit block, startup included. */
export const CREDIT_BLOCK_RECONCILED = "subagentBackend.credit-block-reconciled";

/**
 * Forked once at startup: reconciles now, then on every settings change (logging failures).
 * `subscribeChanges`, not `streamChanges`, so the subscription exists before the startup read
 * and no change is lost. Provider changes are watched for the credit block, via the registry's
 * `streamChanges`, so a flip right after startup waits for the next provider change.
 */
export const subagentBackendReconciler = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService;
  const registry = yield* ProviderRegistry;
  const changes = yield* serverSettings.subscribeChanges;

  // Whether Cursor offload was withheld for spending at the last reconcile. `undefined`
  // when that could not be read, so the next provider change reconciles.
  let creditsBlocked: boolean | undefined;
  const readCreditsBlocked = serverSettings.getRawSettings.pipe(
    Effect.flatMap(readCreditsBlockedReason),
    Effect.map((reason) => reason !== null),
    // Defects too: this runs outside the reconcile's own catch, so anything escaping here
    // would end the reconciler for the life of the process.
    Effect.catchCause((cause) =>
      Effect.logWarning("subagentBackend.creditsBlocked read failed", { cause }).pipe(
        Effect.as(undefined),
      ),
    ),
  );

  // The stream payload is ignored on purpose: `reconcileAllBackends` re-reads settings
  // inside the write permit, so the global file and every thread file come from one
  // snapshot no concurrent settings write can split.
  const reconcileLogged = Effect.gen(function* () {
    const previous = creditsBlocked;
    creditsBlocked = yield* readCreditsBlocked;
    yield* reconcileAllBackends().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("subagentBackend.reconcile failed", { cause }),
      ),
    );
    if (creditsBlocked !== previous) {
      yield* Effect.logInfo(CREDIT_BLOCK_RECONCILED, { blocked: creditsBlocked ?? "unknown" });
    }
  });

  // A provider change reconciles only when it flips the credit block, as the fork's
  // credit guard did: Cursor reaching 100% (or resetting) must rewrite live threads'
  // files without a settings change, and every other probe must not.
  const onProvidersChanged = Effect.gen(function* () {
    const next = yield* readCreditsBlocked;
    if (next === undefined || next !== creditsBlocked) yield* reconcileLogged;
  });

  yield* reconcileLogged;
  yield* Stream.merge(
    changes.pipe(Stream.map(() => reconcileLogged)),
    registry.streamChanges.pipe(Stream.map(() => onProvidersChanged)),
  ).pipe(Stream.runForEach((run) => run));
});

/**
 * The production wiring: the live-thread set, plus the preparer Claude adapters reach
 * through `prepareActiveSubagentThreadBackend`. The preparer is closed over this layer's
 * context because an adapter calls it with none (see `SubagentLiveThreads`).
 */
export const SubagentBackendLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const context =
      yield* Effect.context<Effect.Services<ReturnType<typeof prepareThreadBackend>>>();
    yield* registerActiveSubagentThreadBackend((threadId) =>
      prepareThreadBackend(threadId).pipe(Effect.provide(context)),
    );
  }),
).pipe(Layer.provideMerge(SubagentLiveThreadsLayer));
