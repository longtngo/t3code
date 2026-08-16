/**
 * BackgroundTaskRecoveryWatchdog — reboot-survivable recovery for background
 * tasks whose completion notification was lost.
 *
 * The existing wake path (`maybeWakeThreadForCompletedTask`) only resumes an
 * idle thread when a `task.completed` event arrives. If the server process is
 * restarted (BE/FE rebuild) while a background task is in flight, the SDK
 * subprocess and the task die with it, that event never fires, and the thread
 * waits forever. This heartbeat reconciles the persisted
 * `pending_background_tasks` table on startup and on a periodic sweep, and
 * auto-resumes idle threads whose background task is provably orphaned.
 *
 * Triggers (a row is recovered only when its thread is idle — no active turn,
 * no pending approval/input — and one of):
 *   1. Dead session — the owning process is gone:
 *      a. boot-id mismatch (a prior process / reboot), or
 *      b. same boot but the thread's session is no longer live (crashed/reaped).
 *   2. Stale-timeout backstop — same boot, session still live, but the task has
 *      been silent past the stale threshold (covers the unconfirmed
 *      "SDK silently dropped a live-session watcher" case). Conservative
 *      threshold; can re-prompt a legitimately long, quiet watcher, so the
 *      recovery message asks the agent to re-verify before acting.
 */
import {
  CommandId,
  MessageId,
  type OrchestrationSessionStatus,
  type ProviderInteractionMode,
  type RuntimeMode,
  type RuntimeTaskId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import { RuntimeBootId } from "../../environment/Services/RuntimeBootId.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PendingBackgroundTaskRepository } from "../../persistence/Services/PendingBackgroundTask.ts";
import { AnalyticsService } from "../../telemetry/Services/AnalyticsService.ts";
import {
  BackgroundTaskRecoveryWatchdog,
  type BackgroundTaskRecoveryWatchdogShape,
} from "../Services/BackgroundTaskRecoveryWatchdog.ts";
import { parsePositiveIntEnv } from "./parsePositiveIntEnv.ts";

const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000;
const DEFAULT_STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000;
const DEFAULT_MAX_RECOVERY_ATTEMPTS = 5;
const DISPATCH_TIMEOUT = Duration.seconds(30);

// Session statuses that mean "the SDK session is alive and could still be
// driving the task". Anything else (stopped/error/interrupted/null) means the
// owning session is gone, so a pending task under it is orphaned.
const LIVE_SESSION_STATUSES = new Set<OrchestrationSessionStatus>([
  "idle",
  "starting",
  "running",
  "ready",
]);

type RecoveryReason = "prior-boot" | "dead-session" | "stale";

const reasonText: Record<RecoveryReason, string> = {
  "prior-boot": "the server restarted",
  "dead-session": "its session ended",
  stale: "it went silent for a long time",
};

export interface BackgroundTaskRecoveryWatchdogLiveOptions {
  readonly sweepIntervalMs?: number;
  readonly staleThresholdMs?: number;
  readonly maxRecoveryAttempts?: number;
}

const makeBackgroundTaskRecoveryWatchdog = (options?: BackgroundTaskRecoveryWatchdogLiveOptions) =>
  Effect.gen(function* () {
    const repository = yield* PendingBackgroundTaskRepository;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const analytics = yield* AnalyticsService;
    const { bootId } = yield* RuntimeBootId;

    const sweepIntervalMs = Math.max(
      1,
      options?.sweepIntervalMs ??
        parsePositiveIntEnv("T3CODE_BG_TASK_RECOVERY_SWEEP_MS") ??
        DEFAULT_SWEEP_INTERVAL_MS,
    );
    const staleThresholdMs = Math.max(
      1,
      options?.staleThresholdMs ??
        parsePositiveIntEnv("T3CODE_BG_TASK_STALE_THRESHOLD_MS") ??
        DEFAULT_STALE_THRESHOLD_MS,
    );
    const maxRecoveryAttempts = Math.max(
      1,
      options?.maxRecoveryAttempts ??
        parsePositiveIntEnv("T3CODE_BG_TASK_RECOVERY_MAX_ATTEMPTS") ??
        DEFAULT_MAX_RECOVERY_ATTEMPTS,
    );

    const dispatchRecovery = (input: {
      // Every orphaned task on this thread, recovered by ONE turn. Recovering
      // them one per sweep instead would re-open the race this watchdog caused:
      // a second dispatch can slip out while the first turn is still starting
      // (the reactor writes `status:"starting"` with `activeTurnId:null`), and
      // it would also cost the user N turns and N prompts for one interruption.
      readonly tasks: ReadonlyArray<{
        readonly taskId: RuntimeTaskId;
        readonly reason: RecoveryReason;
      }>;
      readonly threadId: ThreadId;
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
      readonly attempt: number;
      readonly createdAt: string;
    }) => {
      // Identity comes from the first task; the set is stably ordered by the
      // repository, so a retry after a failed dispatch reuses it at a bumped
      // attempt rather than colliding with the previous command id.
      const primary = input.tasks[0]!;
      const text = [
        ...(input.tasks.length === 1
          ? [
              `Background task ${primary.taskId} was interrupted before it reported completion (${reasonText[primary.reason]}).`,
            ]
          : [
              `${input.tasks.length} background tasks were interrupted before they reported completion:`,
              ...input.tasks.map((t) => `- ${t.taskId} (${reasonText[t.reason]})`),
            ]),
        "Re-check whether the work it was waiting on actually finished, then continue.",
      ].join("\n");

      return orchestrationEngine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`provider:bg-task-recovery:${primary.taskId}:${input.attempt}`),
        threadId: input.threadId,
        message: {
          messageId: MessageId.make(`user:bg-task-recovery:${primary.taskId}:${input.attempt}`),
          role: "user",
          text,
          attachments: [],
        },
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        createdAt: input.createdAt,
      });
    };

    // Processes EVERY pending row for one thread together.
    //
    // This used to be per-row, which is what caused the incident this watchdog
    // is now shaped around. The idle guard below reads `activeTurnId` from the
    // projection, but `orchestrationEngine.dispatch` returns as soon as the
    // command is accepted, and the reactor's first write is
    // `status:"starting"` with `activeTurnId:null`
    // (`ProviderCommandReactor.ts:635-648`) — the non-null id only lands when
    // the provider emits its turn-started event. So a second row reads "idle"
    // for the whole dispatch → subprocess-spawn window and starts its own turn.
    //
    // On 2026-08-08 boot reconciliation cleared a latched session at
    // 14:18:44.842Z; three pending rows on one thread then dispatched three
    // turn-starts within 86ms (event sequences 1539224 / 1539226 / 1539228),
    // all landing BEFORE the first session-set (1539229). Those concurrent
    // starts raced in the Claude adapter, orphaned a turn, and re-latched the
    // session the reconciler had just cleaned — which is why the thread stayed
    // pinned to `running` across two boots with no in-flight turn for Stop to
    // interrupt.
    //
    // Recovering the whole group in one turn closes that window by
    // construction: there are no sibling rows left to dispatch on a later
    // sweep. Rate-limiting to one row per sweep would NOT have — it only moves
    // the second dispatch 60s later, still inside the window whenever a start
    // is slow, which at boot is exactly when it is slowest.
    const processThread = Effect.fn("backgroundTaskRecovery.processThread")(function* (
      threadId: ThreadId,
      tasks: ReadonlyArray<{
        readonly taskId: RuntimeTaskId;
        readonly threadId: ThreadId;
        readonly bootId: string;
        readonly lastSeenAt: string;
        readonly recoveryAttempts: number;
      }>,
      nowMs: number,
    ) {
      const thread = yield* projectionSnapshotQuery
        .getThreadShellById(threadId)
        .pipe(Effect.map(Option.getOrUndefined));

      // Orphaned records: the thread is gone or archived. Drop them all.
      if (!thread || thread.archivedAt !== null) {
        yield* repository.deleteByThreadId({ threadId });
        return;
      }

      // Never interrupt real work. Re-evaluate on a later sweep.
      //
      // `starting` counts as busy even though `activeTurnId` is still null:
      // that is precisely the window described above, and treating it as idle
      // is what let a second turn start. A prior-boot `starting` row cannot
      // wedge here — `BootTurnReconciler` settles every live session to
      // `stopped` before the reactors run.
      const sessionStatus = thread.session?.status ?? null;
      const activeTurnId = thread.session?.activeTurnId ?? null;
      if (
        activeTurnId !== null ||
        sessionStatus === "starting" ||
        thread.hasPendingApprovals ||
        thread.hasPendingUserInput
      ) {
        return;
      }

      const sessionLive = sessionStatus !== null && LIVE_SESSION_STATUSES.has(sessionStatus);

      // Partition the thread's rows: which are recoverable, and which have
      // exhausted their attempts. Give-up runs regardless of whether anything
      // else on this thread recovers, so a dead row's lifetime stays bounded by
      // the attempt cap alone.
      const recoverable: Array<{
        readonly taskId: RuntimeTaskId;
        readonly reason: RecoveryReason;
        readonly recoveryAttempts: number;
        readonly silentMs: number | null;
      }> = [];

      for (const task of tasks) {
        // Silence since the task was last seen (null when the timestamp is
        // unparseable). Carried into trip telemetry so the stale threshold can
        // be tuned from real recoveries.
        const lastSeenMs = Date.parse(task.lastSeenAt);
        const silentMs = Number.isNaN(lastSeenMs) ? null : nowMs - lastSeenMs;

        let reason: RecoveryReason | null = null;
        if (task.bootId !== bootId) {
          reason = "prior-boot";
        } else if (!sessionLive) {
          reason = "dead-session";
        } else {
          if (silentMs === null) {
            yield* Effect.logWarning("background-task-recovery.invalid-last-seen", {
              taskId: task.taskId,
              threadId,
              lastSeenAt: task.lastSeenAt,
            });
            continue;
          }
          if (silentMs >= staleThresholdMs) {
            reason = "stale";
          }
        }

        // Healthy / fresh: leave it alone.
        if (reason === null) {
          continue;
        }

        if (task.recoveryAttempts >= maxRecoveryAttempts) {
          yield* Effect.logWarning("background-task-recovery.gave-up", {
            taskId: task.taskId,
            threadId,
            reason,
            recoveryAttempts: task.recoveryAttempts,
            ...(silentMs !== null ? { silentMs } : {}),
          });
          // Anonymous trip telemetry (no thread/task identifiers).
          yield* analytics.record("provider.background_task.recovery_gave_up", {
            reason,
            recoveryAttempts: task.recoveryAttempts,
            ...(silentMs !== null ? { silentMs } : {}),
          });
          yield* repository.deleteByTaskId({ taskId: task.taskId });
          continue;
        }

        recoverable.push({
          taskId: task.taskId,
          reason,
          recoveryAttempts: task.recoveryAttempts,
          silentMs,
        });
      }

      if (recoverable.length === 0) {
        return;
      }

      const primary = recoverable[0]!;
      const attempt = primary.recoveryAttempts + 1;
      for (const task of recoverable) {
        yield* repository.incrementAttempts({ taskId: task.taskId });
      }

      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const dispatched = yield* dispatchRecovery({
        tasks: recoverable.map((t) => ({ taskId: t.taskId, reason: t.reason })),
        threadId,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        attempt,
        createdAt,
      }).pipe(
        Effect.timeout(DISPATCH_TIMEOUT),
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logWarning("background-task-recovery.dispatch-failed", {
            taskId: primary.taskId,
            threadId,
            taskCount: recoverable.length,
            reason: primary.reason,
            attempt,
            cause,
          }).pipe(Effect.as(false)),
        ),
      );

      if (dispatched) {
        yield* Effect.logInfo("background-task-recovery.resumed", {
          taskId: primary.taskId,
          threadId,
          taskCount: recoverable.length,
          reason: primary.reason,
          attempt,
          ...(primary.silentMs !== null ? { silentMs: primary.silentMs } : {}),
        });
        // Anonymous trip telemetry (no thread/task identifiers) — lets the stale
        // threshold be tuned from real recoveries.
        yield* analytics.record("provider.background_task.recovered", {
          reason: primary.reason,
          attempt,
          ...(primary.silentMs !== null ? { silentMs: primary.silentMs } : {}),
        });
        // Success: drop the rows so a successful recovery never accumulates
        // attempts across reboots (the resumed turn re-registers fresh rows).
        for (const task of recoverable) {
          yield* repository.deleteByTaskId({ taskId: task.taskId }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("background-task-recovery.delete-after-resume-failed", {
                taskId: task.taskId,
                cause,
              }),
            ),
          );
        }
      }
      // On dispatch failure the rows remain (attempts already bumped); the next
      // sweep retries until the attempt cap, then gives up.
    });

    const sweep = Effect.gen(function* () {
      const tasks = yield* repository.list();
      if (tasks.length === 0) {
        return;
      }
      const nowMs = yield* Clock.currentTimeMillis;
      // Group by thread so each thread is decided once, from one read of its
      // shell, and recovers in one turn. Iterating rows individually is what
      // produced the concurrent turn-starts described on `processThread`.
      // `Map` preserves insertion order, so the repository's stable ordering
      // carries through to which task becomes the group's primary.
      const byThread = new Map<ThreadId, Array<(typeof tasks)[number]>>();
      for (const task of tasks) {
        const existing = byThread.get(task.threadId);
        if (existing) {
          existing.push(task);
        } else {
          byThread.set(task.threadId, [task]);
        }
      }
      for (const [threadId, threadTasks] of byThread) {
        yield* processThread(threadId, threadTasks, nowMs).pipe(
          Effect.catch((error: unknown) =>
            Effect.logWarning("background-task-recovery.process-failed", {
              threadId,
              error,
            }),
          ),
          Effect.catchDefect((defect: unknown) =>
            Effect.logWarning("background-task-recovery.process-defect", {
              threadId,
              defect,
            }),
          ),
        );
      }
    });

    const start: BackgroundTaskRecoveryWatchdogShape["start"] = () =>
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          sweep.pipe(
            Effect.catch((error: unknown) =>
              Effect.logWarning("background-task-recovery.sweep-failed", { error }),
            ),
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("background-task-recovery.sweep-defect", { defect }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
          ),
        );

        yield* Effect.logInfo("background-task-recovery.started", {
          bootId,
          sweepIntervalMs,
          staleThresholdMs,
          maxRecoveryAttempts,
        });
      });

    return { start } satisfies BackgroundTaskRecoveryWatchdogShape;
  });

export const makeBackgroundTaskRecoveryWatchdogLive = (
  options?: BackgroundTaskRecoveryWatchdogLiveOptions,
) => Layer.effect(BackgroundTaskRecoveryWatchdog, makeBackgroundTaskRecoveryWatchdog(options));

export const BackgroundTaskRecoveryWatchdogLive = makeBackgroundTaskRecoveryWatchdogLive();
