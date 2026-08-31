/**
 * SubagentBackend — the machine-level switch deciding whether coding agents on this
 * host dispatch their subagents through Cursor or fall back to the default route.
 *
 * The state is one small JSON file at a fixed absolute path. It deliberately does
 * NOT live under T3 home: in a worktree that resolves to `<worktree>/.t3`, so a dev
 * server would write the toggle somewhere `~/bin/subagent-dispatch` never looks.
 *
 * Everything here fails safe toward "default". Defaulting to Cursor on an unreadable
 * file would silently spend the wrong quota, so an unparseable file, a missing file
 * and an explicit "default" all produce the same dispatch outcome — while still being
 * distinguishable through `degraded`, so a corrupt file can be surfaced rather than
 * looking like a deliberate Off forever.
 *
 * @module SubagentBackend
 */
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
} from "@t3tools/contracts";
import { resolveCommandPath } from "@t3tools/shared/shell";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { listCursorModels, peekCursorModels } from "./cursorModels.ts";

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

const OFF: PersistedBackend = {
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

export const readBackendFile = Effect.fn("subagentBackend.read")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const filePath = yield* subagentBackendFilePath();
  const exists = yield* fs.exists(filePath);
  if (!exists) return OFF;
  // The file is known to exist at this point, so a read failure here (permissions,
  // a race that deleted it between the check and the read, ...) is damage, not
  // absence - it must surface through `degraded` rather than silently reading as
  // "no toggle" the way `Effect.orElseSucceed(() => "")` would.
  const result = yield* Effect.result(fs.readFileString(filePath));
  if (Result.isFailure(result)) {
    return {
      ...OFF,
      degraded: `The subagent toggle file could not be read: ${result.failure.message}`,
    };
  }
  return parsePersistedBackend(result.success);
});

/**
 * One permit for every mutation of the flag file. `set` and the settings-change
 * reconciler are independent writers, and without ordering a `set` landing after a
 * reconciliation resurrects a backend for an instance that was just disabled —
 * exactly the hole reconciliation exists to close. Atomicity alone does not fix it;
 * the writes are individually atomic and still arrive in the wrong order.
 */
export const backendWriteSemaphore = Effect.runSync(Semaphore.make(1));

/** The write itself, with no locking. Only ever called from inside a `backendWriteSemaphore` permit. */
const writeBackendFileBody = Effect.fn("subagentBackend.writeBody")(function* (
  next: PersistedBackend,
) {
  const fs = yield* FileSystem.FileSystem;
  const filePath = yield* subagentBackendFilePath();
  const updatedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
  // Writes back the same hand-parsed plain shape `parsePersistedBackend` reads, on purpose, not Schema.
  // @effect-diagnostics-next-line preferSchemaOverJson:off
  const contents = `${JSON.stringify(
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
  yield* writeFileStringAtomically({ filePath, contents });
  // After the rename, not before: `writeFileStringAtomically` renames from a temp
  // directory it owns, so there is no earlier handle to chmod. The window is one
  // effect step at the destination, versus a permanent umask leak without it.
  yield* fs.chmod(filePath, 0o600).pipe(Effect.ignore);
});

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
 * Validates a subagent-backend selection, resolves the Cursor binary, and persists
 * it. See the module notes on `backendWriteSemaphore` for why the write itself is
 * always routed through `writeBackendFile`/`writeBackendFileBody`.
 *
 * No model probe runs here — `ws.ts` already calls
 * `modelsForPersistedBackend(persisted, true)` right after every `set`, so warming
 * the cache in this function would just be a second, redundant probe. Settings are
 * still re-read from `ServerSettingsService` (not the snapshot taken above) and the
 * instance is validated again right where the write happens: `resolveCommandPath`
 * is itself a subprocess-touching step, and only a read taken at the write can see
 * a disable or a reconciliation that landed while it ran — revalidating against the
 * earlier snapshot would always agree with the check already done above and prove
 * nothing.
 */
export const setBackend = Effect.fn("subagentBackend.set")(function* (
  input: SubagentBackendSetInput,
) {
  const serverSettings = yield* ServerSettingsService;

  if (input.backend !== SUBAGENT_BACKEND_CURSOR) {
    const next: PersistedBackend = { ...OFF };
    yield* writeBackendFile(next);
    return next;
  }

  const settings = yield* serverSettings.getRawSettings;
  const validated = validateCursorInstance(settings, input.instanceId);
  if (!validated.ok) {
    const next: PersistedBackend = { ...OFF, degraded: validated.reason };
    yield* writeBackendFile(next);
    return next;
  }

  const { config } = validated;
  const resolution = yield* Effect.result(resolveCommandPath(config.binaryPath));
  const binaryPath = Result.isSuccess(resolution) ? resolution.success : config.binaryPath;
  const resolutionDegraded = Result.isFailure(resolution)
    ? `Could not resolve "${config.binaryPath}" on the server's PATH; wrote it as-is ` +
      `because the wrapper's own shell PATH may still find it.`
    : null;

  const model = input.model ?? "auto";

  return yield* backendWriteSemaphore.withPermits(1)(
    Effect.gen(function* () {
      // Re-read settings here, immediately before writing: the probe above can run
      // for seconds, and only a read taken right here can see an instance the
      // reconciler downgraded (or the user disabled) while it ran. Revalidating
      // against the `settings` snapshot captured before the probe would always
      // agree with the check already done above and prove nothing.
      const freshSettings = yield* serverSettings.getRawSettings;
      const revalidated = validateCursorInstance(freshSettings, input.instanceId);
      const next: PersistedBackend = revalidated.ok
        ? {
            schemaVersion: SUBAGENT_BACKEND_SCHEMA_VERSION,
            backend: SUBAGENT_BACKEND_CURSOR,
            instanceId: revalidated.instanceId,
            model,
            binaryPath,
            apiEndpoint: config.apiEndpoint,
            updatedAt: null,
            degraded: resolutionDegraded,
          }
        : { ...OFF, degraded: revalidated.reason };
      yield* writeBackendFileBody(next);
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
 */
export const reconcileBackend = Effect.fn("subagentBackend.reconcile")(function* (
  settings: ServerSettings,
) {
  const current = yield* readBackendFile();
  if (current.backend !== SUBAGENT_BACKEND_CURSOR) return;

  const validated = validateCursorInstance(settings, current.instanceId ?? undefined);
  let next: PersistedBackend;
  if (!validated.ok) {
    next = { ...OFF, degraded: validated.reason };
  } else {
    const resolution = yield* Effect.result(resolveCommandPath(validated.config.binaryPath));
    const binaryPath = Result.isSuccess(resolution)
      ? resolution.success
      : validated.config.binaryPath;
    const resolutionDegraded = Result.isFailure(resolution)
      ? `Could not resolve "${validated.config.binaryPath}" on the server's PATH; wrote it ` +
        `as-is because the wrapper's own shell PATH may still find it.`
      : null;
    next = {
      ...current,
      instanceId: validated.instanceId,
      binaryPath,
      apiEndpoint: validated.config.apiEndpoint,
      degraded: resolutionDegraded,
    };
  }

  // Nothing dispatch-relevant changed: skip the write rather than bumping
  // `updatedAt` (and taking the write semaphore) on every unrelated settings change.
  if (!haveReconcilableFieldsChanged(next, current)) return;
  yield* writeBackendFile(next);
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

  const reconcileLogged = (settings: ServerSettings) =>
    reconcileBackend(settings).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("subagentBackend.reconcile failed", { cause }),
      ),
    );

  yield* serverSettings.getRawSettings.pipe(
    Effect.flatMap(reconcileLogged),
    // A failed read must not stop the reconciler from moving on to the stream
    // below — the same failure tolerance `reconcileLogged` gives every later
    // reconcile.
    Effect.catchCause((cause) =>
      Effect.logWarning("subagentBackend.reconcile (startup) failed", { cause }),
    ),
  );
  yield* changes.pipe(Stream.runForEach(reconcileLogged));
});
