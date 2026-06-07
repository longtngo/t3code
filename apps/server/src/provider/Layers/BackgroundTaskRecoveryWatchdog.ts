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
  "stale": "it went silent for a long time",
};

export interface BackgroundTaskRecoveryWatchdogLiveOptions {
  readonly sweepIntervalMs?: number;
  readonly staleThresholdMs?: number;
  readonly maxRecoveryAttempts?: number;
}

const envNumber = (name: string): number | undefined => {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

const makeBackgroundTaskRecoveryWatchdog = (
  options?: BackgroundTaskRecoveryWatchdogLiveOptions,
) =>
  Effect.gen(function* () {
    const repository = yield* PendingBackgroundTaskRepository;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const analytics = yield* AnalyticsService;
    const { bootId } = yield* RuntimeBootId;

    const sweepIntervalMs = Math.max(
      1,
      options?.sweepIntervalMs ?? envNumber("T3CODE_BG_TASK_RECOVERY_SWEEP_MS") ?? DEFAULT_SWEEP_INTERVAL_MS,
    );
    const staleThresholdMs = Math.max(
      1,
      options?.staleThresholdMs ??
        envNumber("T3CODE_BG_TASK_STALE_THRESHOLD_MS") ??
        DEFAULT_STALE_THRESHOLD_MS,
    );
    const maxRecoveryAttempts = Math.max(
      1,
      options?.maxRecoveryAttempts ??
        envNumber("T3CODE_BG_TASK_RECOVERY_MAX_ATTEMPTS") ??
        DEFAULT_MAX_RECOVERY_ATTEMPTS,
    );

    const dispatchRecovery = (input: {
      readonly taskId: RuntimeTaskId;
      readonly threadId: ThreadId;
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
      readonly reason: RecoveryReason;
      readonly attempt: number;
      readonly createdAt: string;
    }) => {
      const text = [
        `Background task ${input.taskId} was interrupted before it reported completion (${reasonText[input.reason]}).`,
        "Re-check whether the work it was waiting on actually finished, then continue.",
      ].join("\n");

      return orchestrationEngine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(
          `provider:bg-task-recovery:${input.taskId}:${input.attempt}`,
        ),
        threadId: input.threadId,
        message: {
          messageId: MessageId.make(`user:bg-task-recovery:${input.taskId}:${input.attempt}`),
          role: "user",
          text,
          attachments: [],
        },
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        createdAt: input.createdAt,
      });
    };

    const processTask = Effect.fn("backgroundTaskRecovery.processTask")(function* (
      task: {
        readonly taskId: RuntimeTaskId;
        readonly threadId: ThreadId;
        readonly bootId: string;
        readonly lastSeenAt: string;
        readonly recoveryAttempts: number;
      },
      nowMs: number,
    ) {
      const thread = yield* projectionSnapshotQuery
        .getThreadShellById(task.threadId)
        .pipe(Effect.map(Option.getOrUndefined));

      // Orphaned record: the thread is gone or archived. Drop the row.
      if (!thread || thread.archivedAt !== null) {
        yield* repository.deleteByTaskId({ taskId: task.taskId });
        return;
      }

      // Never interrupt real work. Re-evaluate on a later sweep.
      const activeTurnId = thread.session?.activeTurnId ?? null;
      if (activeTurnId !== null || thread.hasPendingApprovals || thread.hasPendingUserInput) {
        return;
      }

      // Silence since the task was last seen (null when the timestamp is
      // unparseable). Carried into trip telemetry so the stale threshold can be
      // tuned from real recoveries.
      const lastSeenMs = Date.parse(task.lastSeenAt);
      const silentMs = Number.isNaN(lastSeenMs) ? null : nowMs - lastSeenMs;

      const sessionStatus = thread.session?.status ?? null;
      const sessionLive = sessionStatus !== null && LIVE_SESSION_STATUSES.has(sessionStatus);

      let reason: RecoveryReason | null = null;
      if (task.bootId !== bootId) {
        reason = "prior-boot";
      } else if (!sessionLive) {
        reason = "dead-session";
      } else {
        if (silentMs === null) {
          yield* Effect.logWarning("background-task-recovery.invalid-last-seen", {
            taskId: task.taskId,
            threadId: task.threadId,
            lastSeenAt: task.lastSeenAt,
          });
          return;
        }
        if (silentMs >= staleThresholdMs) {
          reason = "stale";
        }
      }

      // Healthy / fresh: leave it alone.
      if (reason === null) {
        return;
      }

      if (task.recoveryAttempts >= maxRecoveryAttempts) {
        yield* Effect.logWarning("background-task-recovery.gave-up", {
          taskId: task.taskId,
          threadId: task.threadId,
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
        return;
      }

      const attempt = task.recoveryAttempts + 1;
      yield* repository.incrementAttempts({ taskId: task.taskId });

      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const dispatched = yield* dispatchRecovery({
        taskId: task.taskId,
        threadId: task.threadId,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        reason,
        attempt,
        createdAt,
      }).pipe(
        Effect.timeout(DISPATCH_TIMEOUT),
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logWarning("background-task-recovery.dispatch-failed", {
            taskId: task.taskId,
            threadId: task.threadId,
            reason,
            attempt,
            cause,
          }).pipe(Effect.as(false)),
        ),
      );

      if (dispatched) {
        yield* Effect.logInfo("background-task-recovery.resumed", {
          taskId: task.taskId,
          threadId: task.threadId,
          reason,
          attempt,
          ...(silentMs !== null ? { silentMs } : {}),
        });
        // Anonymous trip telemetry (no thread/task identifiers) — lets the stale
        // threshold be tuned from real recoveries.
        yield* analytics.record("provider.background_task.recovered", {
          reason,
          attempt,
          ...(silentMs !== null ? { silentMs } : {}),
        });
        // Success: drop the row so a successful recovery never accumulates
        // attempts across reboots (the resumed turn re-registers fresh rows).
        yield* repository
          .deleteByTaskId({ taskId: task.taskId })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("background-task-recovery.delete-after-resume-failed", {
                taskId: task.taskId,
                cause,
              }),
            ),
          );
      }
      // On dispatch failure the row remains (attempts already bumped); the next
      // sweep retries until the attempt cap, then gives up.
    });

    const sweep = Effect.gen(function* () {
      const tasks = yield* repository.list();
      if (tasks.length === 0) {
        return;
      }
      const nowMs = yield* Clock.currentTimeMillis;
      for (const task of tasks) {
        yield* processTask(task, nowMs).pipe(
          Effect.catch((error: unknown) =>
            Effect.logWarning("background-task-recovery.process-failed", {
              taskId: task.taskId,
              error,
            }),
          ),
          Effect.catchDefect((defect: unknown) =>
            Effect.logWarning("background-task-recovery.process-defect", {
              taskId: task.taskId,
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
