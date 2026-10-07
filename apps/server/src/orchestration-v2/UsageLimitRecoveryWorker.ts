import {
  CommandId,
  MessageId,
  type OrchestrationV2Command,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CreditSpendGuard } from "../provider/Services/CreditSpendGuard.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

/** The persisted run and reset form the identity of one recovery opportunity. */
export function limitRecoveryCommand(
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
  autoResume: boolean,
  nowMs: number,
  snooze = false,
): OrchestrationV2Command | null {
  if (
    thread.status !== "failed" ||
    thread.lastErrorClass !== "usage_limit" ||
    !thread.latestRunId ||
    !thread.usageLimitResetAt ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.pendingRuntimeRequest !== null
  )
    return null;
  const resetMs = Date.parse(thread.usageLimitResetAt);
  // An already-expired window reported with a fresh failure cannot start a retry loop.
  if (
    !Number.isFinite(resetMs) ||
    resetMs <= DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt)
  )
    return null;
  const identity = `${thread.id}:${thread.latestRunId}:${resetMs}`;
  const recovery = thread.limitRecovery;
  if (recovery?.runId !== thread.latestRunId || recovery.resetAt !== thread.usageLimitResetAt) {
    if (!autoResume && (!snooze || resetMs <= nowMs)) return null;
    return {
      type: "thread.metadata.update",
      commandId: CommandId.make(`limit-arm:${identity}`),
      threadId: thread.id,
      limitRecovery: {
        runId: thread.latestRunId,
        resetAt: thread.usageLimitResetAt,
        autoResume,
        snooze: snooze && resetMs > nowMs,
      },
    };
  }
  if (
    !recovery.autoResume ||
    resetMs > nowMs ||
    (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs)
  )
    return null;
  const deliveryIdentity = `${identity}:${recovery.requestId ?? "legacy"}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`limit-resume:${deliveryIdentity}`),
    messageId: MessageId.make(`limit-resume:${deliveryIdentity}`),
    threadId: thread.id,
    usageLimitContinuationOfRunId: thread.latestRunId,
    ...(recovery.requestId === undefined
      ? {}
      : { usageLimitRecoveryRequestId: recovery.requestId }),
    text: "Continue where you left off.",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  };
}

/** Sweeps in a row a resume waits out an unknown fresh read before it is sent anyway. */
export const MAX_INCONCLUSIVE_SKIPS = 3;

export const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const creditSpendGuard = yield* CreditSpendGuard;
  // "Allow to spend credits" refusing the resume now: skip it instead of sending a turn the
  // start gate would fail as a non-limit error, which would drop the thread out of recovery
  // for good. The thread stays a candidate, so the next sweep (every 5 s) tries again.
  //
  // While blocked, the check reads the published usage only: a 7-day window can stay full
  // for days. When the published reading allows the resume, the full gate runs once more
  // just before the send, so a stale reading cannot let through a resume the start gate
  // would refuse. Its fresh read publishes what it found, so a refusal there returns the
  // following sweeps to the cheap published check. Cost: at most one shared fresh read per
  // instance per sweep, and only while the published reading allows and the fresh one does
  // not.
  //
  // A fresh read that fails or times out leaves the answer unknown, and the start gate's
  // own read could still refuse (a slow read it joins, or the next read succeeding). So
  // wait for a later sweep, up to MAX_INCONCLUSIVE_SKIPS in a row per thread; after that
  // the resume goes out on the published reading, as the start gate itself fails open.
  const refusedThreads = new Set<ThreadId>();
  const inconclusiveSkips = new Map<ThreadId, number>();
  const resumeRefused = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const shell = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
      if (shell === null) return false;
      const cached = yield* creditSpendGuard.cachedRefusalFor(shell.providerInstanceId);
      const check =
        cached === null
          ? yield* creditSpendGuard.resumeCheck(shell.providerInstanceId)
          : { refusal: cached, inconclusive: false };
      if (check.refusal === null && check.inconclusive) {
        const skips = (inconclusiveSkips.get(threadId) ?? 0) + 1;
        if (skips <= MAX_INCONCLUSIVE_SKIPS) {
          inconclusiveSkips.set(threadId, skips);
          yield* Effect.logInfo("orchestration-v2.limit-recovery.credit-unverified", {
            threadId,
            skips,
          });
          return true;
        }
      }
      inconclusiveSkips.delete(threadId);
      if (check.refusal === null) {
        refusedThreads.delete(threadId);
        return false;
      }
      // Once per blocked spell, not every sweep.
      if (!refusedThreads.has(threadId)) {
        refusedThreads.add(threadId);
        yield* Effect.logInfo("orchestration-v2.limit-recovery.credit-refused", {
          threadId,
          reason: check.refusal,
        });
      }
      return true;
    });
  return Effect.fn("UsageLimitRecoveryWorker.sweep")(function* () {
    const preferences = yield* settings.getSettings;
    const now = yield* DateTime.now;
    const candidates = yield* projections.getLimitRecoveryCandidates({
      now,
      autoResume: preferences.autoResumeLimitedThreads,
      snooze: preferences.snoozeLimitedThreads,
    });
    const nowMs = DateTime.toEpochMillis(now);
    for (const threadId of refusedThreads) {
      if (!candidates.some((thread) => thread.id === threadId)) refusedThreads.delete(threadId);
    }
    for (const threadId of inconclusiveSkips.keys()) {
      if (!candidates.some((thread) => thread.id === threadId)) inconclusiveSkips.delete(threadId);
    }
    for (const thread of candidates) {
      const command = limitRecoveryCommand(
        thread,
        preferences.autoResumeLimitedThreads,
        nowMs,
        preferences.snoozeLimitedThreads,
      );
      if (command === null) continue;
      if (command.type === "message.dispatch" && (yield* resumeRefused(thread.id))) continue;
      yield* threads.dispatch(command).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.limit-recovery.dispatch-failed", {
            threadId: thread.id,
            cause,
          }),
        ),
      );
    }
  });
});

// The shared scheduler derives due work from persisted failures and recovery
// choices, so restarts need no timer restoration or connected client.
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("usage-limit-recovery", sweep());
  }),
);
