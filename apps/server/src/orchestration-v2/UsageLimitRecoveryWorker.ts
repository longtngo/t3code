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
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

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
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const creditSpendGuard = yield* CreditSpendGuard;
  // Credit guard refusing: skip rather than send a turn the start gate would fail as a
  // non-limit error (ending recovery); the next 5 s sweep retries. Blocked threads check only
  // published usage; when it allows, the full gate runs once more before the send. An
  // inconclusive fresh read waits up to MAX_INCONCLUSIVE_SKIPS sweeps, then fails open.
  const refusedThreads = new Set<ThreadId>();
  const inconclusiveSkips = new Map<ThreadId, number>();
  const resumeRefused = Effect.fn("UsageLimitRecoveryWorker.resumeRefused")(function* (
    threadId: ThreadId,
  ) {
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
      yield* Effect.gen(function* () {
        if (command.type === "thread.metadata.update" && command.limitRecovery != null) {
          yield* orchestrator.autoArmLimitRecovery({
            commandId: command.commandId,
            threadId: command.threadId,
            limitRecovery: command.limitRecovery,
          });
        } else {
          yield* threads.dispatch(command);
        }
      }).pipe(
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

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("usage-limit-recovery", sweep());
  }),
);
