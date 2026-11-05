// @effect-diagnostics-next-line nodeBuiltinImport:off -- resolved once at module load, outside any Effect.
import * as NodePath from "node:path";

import type {
  ResourceQueueItem,
  ResourceQueueResource,
  ResourceQueueSnapshot,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";

/**
 * A command with a path separator (`/`; also `\` on Windows) is resolved against `cwd` (an
 * absolute one stays as is); a bare name stays a PATH lookup.
 */
export const resolveCommand = (raw: string, cwd: string): string =>
  raw.includes("/") || (NodePath.sep === "\\" && raw.includes("\\"))
    ? NodePath.resolve(cwd, raw)
    : raw;

/**
 * Resolved resctl binary. Overridable for non-PATH installs; defaults to the name on PATH. A
 * relative override is resolved once, against the startup cwd: the spawn passes no cwd, so the
 * child would otherwise resolve it against whatever the server's cwd has become.
 */
const RESCTL_CMD = resolveCommand(process.env.T3CODE_RESCTL_CMD?.trim() || "resctl", process.cwd());
/** A status read is cheap; bound it so a wedged broker never stalls the RPC. */
const RESCTL_TIMEOUT = Duration.millis(2000);
const MAX_OUTPUT_BYTES = 2_000_000;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}
function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}
function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
function optNum(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function optStr(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toItem(
  resource: string,
  state: "running" | "waiting",
  raw: unknown,
  sinceMs: number,
): ResourceQueueItem {
  const job = asRecord(raw);
  return {
    resource,
    state,
    priority: str(job.priority, "normal"),
    reason: str(job.reason),
    project: str(job.project),
    agent: optStr(job.agent),
    pid: optNum(job.pid),
    amount: num(job.amount, 1),
    sinceMs,
    etaSec: optNum(job.eta_sec),
  };
}

/**
 * Normalize one `resctl status --json` document into the client DTO: a flat list of
 * holders (`running`) and queued jobs (`waiting`) plus per-pool capacity. Absolute
 * `sinceMs` timestamps are carried through so the client can tick a live "elapsed"
 * between polls. Callers pass JSON text they have already parsed and validated.
 */
export function parseResourceQueue(text: string, nowMs: number): ResourceQueueSnapshot {
  const root = asRecord(JSON.parse(text));
  const pools = asRecord(root.resources);
  const resources: ResourceQueueResource[] = [];
  const running: ResourceQueueItem[] = [];
  const waiting: ResourceQueueItem[] = [];

  for (const [name, value] of Object.entries(pools)) {
    const pool = asRecord(value);
    const capacity = num(pool.capacity);
    const inUse = num(pool.in_use);
    const leases = asArray(pool.leases);
    const queue = asArray(pool.queue);
    // Skip pools that are both empty and idle — the client only cares about contention.
    if (capacity > 0 || inUse > 0 || leases.length > 0 || queue.length > 0) {
      resources.push({
        name,
        capacity,
        inUse,
        advisory: pool.advisory === true ? true : undefined,
      });
    }
    for (const lease of leases) {
      running.push(toItem(name, "running", lease, num(asRecord(lease).granted_at) * 1000));
    }
    queue.forEach((entry, index) => {
      waiting.push({
        ...toItem(name, "waiting", entry, num(asRecord(entry).enqueued_at) * 1000),
        pos: index + 1,
      });
    });
  }

  return {
    ts: nowMs,
    available: true,
    maintenance: root.maintenance === true,
    resources,
    running,
    waiting,
  };
}

function unavailable(nowMs: number, unavailableReason: string): ResourceQueueSnapshot {
  return {
    ts: nowMs,
    available: false,
    maintenance: false,
    resources: [],
    running: [],
    waiting: [],
    unavailableReason,
  };
}

/** What one `resctl status` attempt produced: a finished process, or why none finished. */
export type ResctlRun =
  | { readonly stdout: string; readonly stderrTail: string; readonly exitCode: number }
  /** It started, then a signal ended it (e.g. the OOM killer's SIGKILL). */
  | { readonly signal: string }
  | { readonly spawnError: "not-found" | "permission-denied" | "timeout" | "spawn-failed" };

const STDERR_TAIL_BYTES = 200;
const MAX_ERROR_CHARS = 120;

/** Collapse whitespace runs to one line, then drop the remaining control characters. */
const oneLine = (text: string): string =>
  text
    .replace(/\s+/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Turn one resctl attempt into a snapshot. Order matters: the error document (`error` key) is
 * read before the exit code, because resctl prints it with a non-zero exit. Available only when
 * exit 0 and `resources` is an object; every other outcome is unavailable with a named reason.
 * The reason goes to clients, so it never carries stderr or the command path (the log does).
 */
export function classifyResctl(run: ResctlRun, nowMs: number): ResourceQueueSnapshot {
  if ("signal" in run) return unavailable(nowMs, `resctl was killed (${run.signal})`);
  if ("spawnError" in run) {
    switch (run.spawnError) {
      case "not-found":
        return unavailable(nowMs, "resctl not found");
      case "permission-denied":
        return unavailable(nowMs, "resctl is not executable");
      case "timeout":
        return unavailable(nowMs, "resctl timed out after 2 s");
      case "spawn-failed":
        return unavailable(nowMs, "resctl could not be started");
    }
  }
  let doc: unknown;
  try {
    doc = JSON.parse(run.stdout);
  } catch {
    doc = undefined;
  }
  if (isJsonObject(doc) && typeof doc.error === "string" && oneLine(doc.error) !== "") {
    const error = oneLine(doc.error);
    if (error === "daemon_unreachable") {
      return unavailable(nowMs, "broker not running (daemon_unreachable)");
    }
    const shown = error.length > MAX_ERROR_CHARS ? `${error.slice(0, MAX_ERROR_CHARS)}…` : error;
    return unavailable(nowMs, `resctl error (${shown})`);
  }
  if (run.exitCode !== 0) return unavailable(nowMs, `resctl exited ${run.exitCode}`);
  if (isJsonObject(doc) && isJsonObject(doc.resources)) {
    return parseResourceQueue(run.stdout, nowMs);
  }
  return unavailable(nowMs, "unexpected resctl output");
}

const keepTail = (tail: Uint8Array, chunk: Uint8Array): Uint8Array => {
  const joined = new Uint8Array(tail.byteLength + chunk.byteLength);
  joined.set(tail);
  joined.set(chunk, tail.byteLength);
  return joined.byteLength > STDERR_TAIL_BYTES
    ? joined.slice(joined.byteLength - STDERR_TAIL_BYTES)
    : joined;
};

/**
 * The signal that ended a started process: the spawner fails its exit code with
 * "Process interrupted due to receipt of signal: 'SIGKILL'". Anything else is undefined.
 */
const exitSignal = (error: PlatformError.PlatformError): string | undefined => {
  const cause = error.reason.cause;
  const match =
    cause instanceof Error ? /receipt of signal: '(SIG[A-Z0-9]+)'/.exec(cause.message) : null;
  return match?.[1];
};

/** Run `resctl status --json --no-spawn`. Never fails; every outcome is a `ResctlRun`. */
const runResctl: Effect.Effect<ResctlRun, never, ChildProcessSpawner.ChildProcessSpawner> =
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const spawned = yield* spawner
      .spawn(
        // --no-spawn: read the running broker; never start a daemon as a side effect of a status poll.
        // No cwd: the spawner checks a given cwd with fs.access, which fails once the server's
        // working directory is deleted; without one the child inherits it and still runs.
        ChildProcess.make(RESCTL_CMD, ["status", "--json", "--no-spawn"]),
      )
      .pipe(
        Effect.map((child) => ({ child }) as const),
        Effect.catch((error) =>
          Effect.succeed({
            run: {
              spawnError:
                error.reason._tag === "NotFound"
                  ? "not-found"
                  : error.reason._tag === "PermissionDenied"
                    ? "permission-denied"
                    : "spawn-failed",
            } satisfies ResctlRun,
          } as const),
        ),
      );
    if ("run" in spawned) return spawned.run;
    const { child } = spawned;
    // Drain stderr too: an unread pipe can fill and wedge the child.
    const [collected, stderr, exited] = yield* Effect.all(
      [
        collectUint8StreamText({ stream: child.stdout, maxBytes: MAX_OUTPUT_BYTES }),
        child.stderr.pipe(Stream.runFold(() => new Uint8Array(0), keepTail)),
        child.exitCode.pipe(
          Effect.map((code) => ({ code })),
          Effect.catch((error) => {
            const signal = exitSignal(error);
            return signal === undefined ? Effect.fail(error) : Effect.succeed({ signal });
          }),
        ),
      ],
      { concurrency: "unbounded" },
    );
    if ("signal" in exited) return { signal: exited.signal } satisfies ResctlRun;
    const exitCode = exited.code;
    return {
      stdout: collected.text,
      stderrTail: Buffer.from(stderr).toString("utf8"),
      exitCode: Number(exitCode),
    } satisfies ResctlRun;
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(RESCTL_TIMEOUT),
    Effect.map((result): ResctlRun =>
      Option.isSome(result) ? result.value : { spawnError: "timeout" },
    ),
    Effect.catchCause(() => Effect.succeed<ResctlRun>({ spawnError: "spawn-failed" })),
  );

/** Every RPC caller within this window gets the same snapshot; one resctl run serves them all. */
const READ_TTL = Duration.seconds(2);

const readDetailed = Effect.gen(function* () {
  const now = yield* DateTime.now;
  const run = yield* runResctl;
  return { run, snapshot: classifyResctl(run, DateTime.toEpochMillis(now)) };
});

/**
 * Service wrapper mirroring the sibling diagnostics services (e.g. ProcessDiagnostics):
 * it captures the process spawner from the layer context so the WS handler can call
 * `read` as a dependency-free effect. Provided via `layer` in the server DI composition.
 */
export class ResourceQueue extends Context.Service<
  ResourceQueue,
  {
    readonly read: Effect.Effect<ResourceQueueSnapshot>;
  }
>()("t3/diagnostics/ResourceQueue") {}

export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // Log only when the reason text changes (a poll runs every few seconds), plus recovery.
  let lastReason: { readonly text: string; readonly sinceMs: number } | undefined;
  // Never fails: degrades to `available:false` with a named `unavailableReason`. Concurrent
  // callers share the in-flight run, and its result is reused for READ_TTL after it arrives.
  const read: ResourceQueue["Service"]["read"] = yield* readDetailed.pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.tap(({ run, snapshot }) => {
      const text = snapshot.unavailableReason;
      if (text === undefined) {
        const previous = lastReason;
        lastReason = undefined;
        return previous === undefined
          ? Effect.void
          : Effect.logInfo(
              `resctl available again after ${Math.round((snapshot.ts - previous.sinceMs) / 1000)}s`,
            );
      }
      if (lastReason?.text === text) return Effect.void;
      lastReason = { text, sinceMs: lastReason?.sinceMs ?? snapshot.ts };
      const detail =
        "exitCode" in run ? `, exit ${run.exitCode}, stderr: ${oneLine(run.stderrTail)}` : "";
      return Effect.logWarning(`resctl unavailable: ${text} (cmd: ${RESCTL_CMD}${detail})`);
    }),
    Effect.map(({ snapshot }) => snapshot),
    Effect.cachedWithTTL(READ_TTL),
  );
  return ResourceQueue.of({ read });
});

export const layer = Layer.effect(ResourceQueue, make);
