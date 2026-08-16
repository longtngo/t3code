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
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";

/** Resolved resctl binary. Overridable for non-PATH installs; defaults to the name on PATH. */
const RESCTL_CMD = process.env.T3CODE_RESCTL_CMD?.trim() || "resctl";
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
 * between polls. Throws on malformed JSON — callers map that to an unavailable snapshot.
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

function unavailable(nowMs: number): ResourceQueueSnapshot {
  return {
    ts: nowMs,
    available: false,
    maintenance: false,
    resources: [],
    running: [],
    waiting: [],
  };
}

/** Run `resctl status --json --no-spawn`, returning its stdout, or `null` on any failure. */
const runResctl: Effect.Effect<string | null, never, ChildProcessSpawner.ChildProcessSpawner> =
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      // --no-spawn: read the running broker; never start a daemon as a side effect of a status poll.
      ChildProcess.make(RESCTL_CMD, ["status", "--json", "--no-spawn"], { cwd: process.cwd() }),
    );
    const collected = yield* collectUint8StreamText({
      stream: child.stdout,
      maxBytes: MAX_OUTPUT_BYTES,
    });
    return collected.text;
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(RESCTL_TIMEOUT),
    Effect.map((result) => (Option.isSome(result) ? result.value : null)),
    Effect.catchCause(() => Effect.succeed(null)),
  );

/**
 * One-shot read of the local resource broker. Degrades to `available:false` (never fails)
 * when resctl is missing, times out, or emits unparseable output, so the UI can show a
 * quiet "broker not running" rather than surfacing an error.
 */
export const readResourceQueue: Effect.Effect<
  ResourceQueueSnapshot,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
  const now = yield* DateTime.now;
  const nowMs = DateTime.toEpochMillis(now);
  const text = yield* runResctl;
  if (text == null) return unavailable(nowMs);
  // JSON.parse throws on malformed output; fall back to an unavailable snapshot.
  // (try/catch here is intentional — Effect.try would leave the error channel untyped.)
  try {
    return parseResourceQueue(text, nowMs);
  } catch {
    return unavailable(nowMs);
  }
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
  const read: ResourceQueue["Service"]["read"] = readResourceQueue.pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
  );
  return ResourceQueue.of({ read });
});

export const layer = Layer.effect(ResourceQueue, make);
