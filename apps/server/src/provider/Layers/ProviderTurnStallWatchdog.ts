import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { AnalyticsService } from "../../telemetry/Services/AnalyticsService.ts";
import { parsePositiveIntEnv } from "./parsePositiveIntEnv.ts";
import {
  ProviderRuntimeIngestionService,
  type TurnActivitySnapshot,
} from "../../orchestration/Services/ProviderRuntimeIngestion.ts";
import {
  ProviderTurnStallWatchdog,
  type ProviderTurnStallWatchdogShape,
} from "../Services/ProviderTurnStallWatchdog.ts";

// 15 min of total SDK silence on an active turn whose last event was terminal is
// a near-certain stall: during real work the SDK streams thinking-tokens,
// content, and tool/task lifecycle continuously, and subagents emit periodic
// task.progress. Conservative on purpose — false positives interrupt real work.
const DEFAULT_STALL_THRESHOLD_MS = 15 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000;
// If a forceful stop hasn't cleared the active turn within this window, treat it
// as failed and let detection re-evaluate (rather than wedging awaiting-stop).
const DEFAULT_STOP_GRACE_MS = 2 * 60 * 1000;
// Cap recoveries per thread so a turn that re-stalls on every resume can't loop
// forever burning tokens overnight.
const DEFAULT_MAX_RECOVERY_ATTEMPTS = 3;
// A dispatch into a wedged subprocess (interrupt/stop/start) could itself block;
// bound it so the watchdog fiber can never wedge.
const DISPATCH_TIMEOUT = Duration.seconds(30);

export interface ProviderTurnStallWatchdogLiveOptions {
  readonly stallThresholdMs?: number;
  readonly sweepIntervalMs?: number;
  readonly stopGraceMs?: number;
  readonly maxRecoveryAttempts?: number;
}

interface RecoveryRecord {
  readonly attempts: number;
  readonly gaveUp: boolean;
  // The turn id we last acted on. Lets a genuinely new turn (e.g. the user
  // manually continued after we gave up) be told apart from the turn we're
  // muting, so a give-up never permanently silences the thread.
  readonly lastStalledTurnId: TurnId | null;
  // Set while a forceful stop has been dispatched and we're waiting for the
  // session to go down before issuing the resume turn.start.
  readonly awaitingStopForTurnId: TurnId | null;
  readonly stopIssuedAtMs: number | null;
  // Silence measured at trip time, carried to the resume message (by then the
  // tracker entry is gone, so the gap can't be recomputed).
  readonly lastSilentMs: number | null;
}

const EMPTY_RECORD: RecoveryRecord = {
  attempts: 0,
  gaveUp: false,
  lastStalledTurnId: null,
  awaitingStopForTurnId: null,
  stopIssuedAtMs: null,
  lastSilentMs: null,
};

function sameTurn(left: string | null | undefined, right: string | null | undefined): boolean {
  return left != null && right != null && left === right;
}

const makeProviderTurnStallWatchdog = (options?: ProviderTurnStallWatchdogLiveOptions) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const ingestion = yield* ProviderRuntimeIngestionService;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const analytics = yield* AnalyticsService;

    const stallThresholdMs = Math.max(
      1,
      options?.stallThresholdMs ?? parsePositiveIntEnv("T3CODE_TURN_STALL_THRESHOLD_MS") ?? DEFAULT_STALL_THRESHOLD_MS,
    );
    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    const stopGraceMs = Math.max(1, options?.stopGraceMs ?? DEFAULT_STOP_GRACE_MS);
    const maxRecoveryAttempts = Math.max(
      1,
      options?.maxRecoveryAttempts ?? DEFAULT_MAX_RECOVERY_ATTEMPTS,
    );

    const recoveryByThread = yield* Ref.make<ReadonlyMap<ThreadId, RecoveryRecord>>(new Map());

    const setRecord = (threadId: ThreadId, record: RecoveryRecord) =>
      Ref.update(recoveryByThread, (map) => {
        const next = new Map(map);
        next.set(threadId, record);
        return next;
      });

    const clearRecord = (threadId: ThreadId) =>
      Ref.update(recoveryByThread, (map) => {
        if (!map.has(threadId)) {
          return map;
        }
        const next = new Map(map);
        next.delete(threadId);
        return next;
      });

    const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

    const commandId = (tag: string) =>
      crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`watchdog:${tag}:${uuid}`)));

    const appendActivity = (input: {
      threadId: ThreadId;
      tone: "info" | "error";
      summary: string;
      message: string;
      turnId: TurnId | null;
    }) =>
      Effect.gen(function* () {
        const createdAt = yield* nowIso;
        const id = EventId.make(`watchdog:${yield* crypto.randomUUIDv4}`);
        const activity: OrchestrationThreadActivity = {
          id,
          createdAt,
          tone: input.tone,
          kind: input.tone === "error" ? "runtime.error" : "runtime.warning",
          summary: input.summary,
          payload: { message: input.message },
          turnId: input.turnId,
        };
        yield* orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId: yield* commandId("activity"),
          threadId: input.threadId,
          activity,
          createdAt,
        });
      }).pipe(
        Effect.timeout(DISPATCH_TIMEOUT),
        Effect.catchCause(() => Effect.void),
      );

    const dispatchStop = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const createdAt = yield* nowIso;
        yield* orchestrationEngine.dispatch({
          type: "thread.session.stop",
          commandId: yield* commandId("stop"),
          threadId,
          createdAt,
        });
      }).pipe(
        Effect.timeout(DISPATCH_TIMEOUT),
        Effect.catchCause((cause) =>
          Effect.logWarning("provider.turn.stall-watchdog.stop-failed", { threadId, cause }),
        ),
      );

    const dispatchResume = (input: {
      shell: OrchestrationThreadShell;
      stalledTurnId: TurnId;
      silentMs: number;
      attempt: number;
    }) =>
      Effect.gen(function* () {
        const createdAt = yield* nowIso;
        const minutes = Math.round(input.silentMs / 60000);
        const message = [
          "The previous turn stalled — the provider produced no activity for about",
          `${minutes} minute${minutes === 1 ? "" : "s"} and was automatically stopped.`,
          "Continue the work that was in progress.",
        ].join(" ");
        yield* orchestrationEngine.dispatch({
          type: "thread.turn.start",
          commandId: yield* commandId("resume"),
          threadId: input.shell.id,
          message: {
            // Attempt-scoped so a re-stall on the same turn id can't collide
            // with a prior recovery's synthetic message id.
            messageId: MessageId.make(
              `user:stall-recovery:${input.stalledTurnId}:${input.attempt}`,
            ),
            role: "user",
            text: message,
            attachments: [],
          },
          runtimeMode: input.shell.runtimeMode,
          interactionMode: input.shell.interactionMode,
          createdAt,
        });
      }).pipe(
        Effect.timeout(DISPATCH_TIMEOUT),
        Effect.catchCause((cause) =>
          Effect.logWarning("provider.turn.stall-watchdog.resume-failed", {
            threadId: input.shell.id,
            cause,
          }),
        ),
      );

    const resolveShell = (threadId: ThreadId) =>
      projectionSnapshotQuery
        .getThreadShellById(threadId)
        .pipe(Effect.map(Option.getOrUndefined));

    const shouldTrip = (
      entry: TurnActivitySnapshot,
      shell: OrchestrationThreadShell,
      nowMs: number,
    ): boolean => {
      const activeTurnId = shell.session?.activeTurnId ?? null;
      return (
        activeTurnId !== null &&
        sameTurn(activeTurnId, entry.turnId) &&
        shell.session?.status === "running" &&
        !entry.synthetic &&
        shell.archivedAt === null &&
        !shell.hasPendingApprovals &&
        !shell.hasPendingUserInput &&
        nowMs - entry.lastEventAt >= stallThresholdMs &&
        // A non-empty open-tool set means the turn is legitimately blocked on an in-flight
        // foreground tool (Bash/Edit/tool call), not a wedged SDK — don't trip. This replaces the
        // old `lastEventType ∈ {item.started,item.updated}` heuristic, which a `token-usage`/
        // `content.delta` event landing just after the tool's `item.updated` would silently defeat.
        entry.openToolItemIds.size === 0
      );
    };

    const processThread = (input: {
      threadId: ThreadId;
      entry: TurnActivitySnapshot | undefined;
      nowMs: number;
    }) =>
      Effect.gen(function* () {
        const { threadId, entry, nowMs } = input;
        const shell = yield* resolveShell(threadId);
        const record =
          (yield* Ref.get(recoveryByThread)).get(threadId) ?? EMPTY_RECORD;
        const activeTurnId = shell?.session?.activeTurnId ?? null;

        // 1) Drive a pending forceful stop towards a resume.
        if (record.awaitingStopForTurnId !== null) {
          if (!shell || activeTurnId === null) {
            // Session went down — resume the conversation.
            if (shell) {
              yield* dispatchResume({
                shell,
                stalledTurnId: record.awaitingStopForTurnId,
                silentMs: record.lastSilentMs ?? stallThresholdMs,
                attempt: record.attempts,
              });
            }
            yield* setRecord(threadId, {
              ...record,
              awaitingStopForTurnId: null,
              stopIssuedAtMs: null,
            });
            return;
          }
          // Stop hasn't landed. If it has exceeded the grace window, give up on
          // this attempt and let detection re-evaluate next sweep.
          if (record.stopIssuedAtMs !== null && nowMs - record.stopIssuedAtMs > stopGraceMs) {
            yield* setRecord(threadId, {
              ...record,
              awaitingStopForTurnId: null,
              stopIssuedAtMs: null,
            });
          }
          return;
        }

        // 2) Clean-state reset: thread finished its turn normally.
        if (activeTurnId === null && entry === undefined) {
          if (record !== EMPTY_RECORD) {
            yield* clearRecord(threadId);
          }
          return;
        }

        if (entry === undefined || !shell) {
          return;
        }

        // Once we've given up on a thread we stay quiet — but only for the turn
        // we gave up on. A *different* active turn means fresh work (e.g. the
        // user manually continued, as the give-up message asked), so resume
        // protecting the thread. The attempt counter otherwise persists across
        // our own stop→resume cycles, because a forceful resume mints a new
        // turnId and resetting on turnId change would let a re-stalling turn
        // loop forever.
        if (record.gaveUp) {
          if (sameTurn(record.lastStalledTurnId, entry.turnId)) {
            return;
          }
          yield* clearRecord(threadId);
        }
        const priorAttempts = record.gaveUp ? 0 : record.attempts;

        // 3) Trip detection.
        if (!shouldTrip(entry, shell, nowMs)) {
          return;
        }

        const silentMs = nowMs - entry.lastEventAt;
        const attempts = priorAttempts + 1;

        if (attempts > maxRecoveryAttempts) {
          yield* appendActivity({
            threadId,
            tone: "error",
            summary: "Turn stall recovery exhausted",
            message: `Automatic recovery failed ${maxRecoveryAttempts} times for a stalled turn; manual continue needed.`,
            turnId: entry.turnId,
          });
          // Anonymous trip telemetry (no thread/turn identifiers).
          yield* analytics.record("provider.turn_stall.recovery_gave_up", {
            silentMs,
            attempts,
          });
          yield* setRecord(threadId, {
            ...EMPTY_RECORD,
            attempts,
            gaveUp: true,
            lastStalledTurnId: entry.turnId,
          });
          return;
        }

        yield* appendActivity({
          threadId,
          tone: "info",
          summary: "Stalled turn — recovering",
          message: `No provider activity for about ${Math.round(silentMs / 60000)} minutes on an active turn; stopping and resuming the session.`,
          turnId: entry.turnId,
        });
        // Anonymous trip telemetry (no thread/turn identifiers) — lets the stall
        // threshold be tuned from real trips.
        yield* analytics.record("provider.turn_stall.recovered", {
          silentMs,
          attempt: attempts,
        });
        yield* dispatchStop(threadId);
        yield* setRecord(threadId, {
          ...EMPTY_RECORD,
          attempts,
          lastStalledTurnId: entry.turnId,
          awaitingStopForTurnId: entry.turnId,
          stopIssuedAtMs: nowMs,
          lastSilentMs: silentMs,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider.turn.stall-watchdog.thread-failed", {
            threadId: input.threadId,
            cause,
          }),
        ),
      );

    const sweep = Effect.gen(function* () {
      const activity = yield* ingestion.listTurnActivity;
      const records = yield* Ref.get(recoveryByThread);
      const nowMs = yield* Clock.currentTimeMillis;

      const entryByThread = new Map<ThreadId, TurnActivitySnapshot>();
      for (const snapshot of activity) {
        entryByThread.set(snapshot.threadId, snapshot);
      }
      const threadIds = new Set<ThreadId>([...entryByThread.keys(), ...records.keys()]);

      for (const threadId of threadIds) {
        yield* processThread({ threadId, entry: entryByThread.get(threadId), nowMs });
      }
    });

    const start: ProviderTurnStallWatchdogShape["start"] = () =>
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          sweep.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("provider.turn.stall-watchdog.sweep-failed", { cause }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
          ),
        );
        yield* Effect.logInfo("provider.turn.stall-watchdog.started", {
          stallThresholdMs,
          sweepIntervalMs,
          stopGraceMs,
          maxRecoveryAttempts,
        });
      });

    return { start } satisfies ProviderTurnStallWatchdogShape;
  });

export const makeProviderTurnStallWatchdogLive = (options?: ProviderTurnStallWatchdogLiveOptions) =>
  Layer.effect(ProviderTurnStallWatchdog, makeProviderTurnStallWatchdog(options));

export const ProviderTurnStallWatchdogLive = makeProviderTurnStallWatchdogLive();
