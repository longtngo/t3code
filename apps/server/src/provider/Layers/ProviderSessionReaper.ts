import { CommandId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Crypto from "effect/Crypto";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PendingBackgroundTaskRepository } from "../../persistence/Services/PendingBackgroundTask.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import {
  ProviderSessionReaper,
  type ProviderSessionReaperShape,
} from "../Services/ProviderSessionReaper.ts";
import { forkParked } from "../../serverActivation.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";

const DEFAULT_INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const DISPATCH_TIMEOUT = Duration.seconds(30);

export interface ProviderSessionReaperLiveOptions {
  readonly inactivityThresholdMs?: number;
  readonly sweepIntervalMs?: number;
}

const makeProviderSessionReaper = (options?: ProviderSessionReaperLiveOptions) =>
  Effect.gen(function* () {
    const orchestrationEngine = yield* OrchestrationEngineService;
    const crypto = yield* Crypto.Crypto;
    const directory = yield* ProviderSessionDirectory;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const pendingBackgroundTaskRepository = yield* PendingBackgroundTaskRepository;

    const inactivityThresholdMs = Math.max(
      1,
      options?.inactivityThresholdMs ?? DEFAULT_INACTIVITY_THRESHOLD_MS,
    );
    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);

    const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

    const commandId = (tag: string) =>
      crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`reaper:${tag}:${uuid}`)));

    const sweep = Effect.gen(function* () {
      const bindings = yield* directory.listBindings();
      const now = yield* Clock.currentTimeMillis;
      let reapedCount = 0;

      for (const binding of bindings) {
        if (binding.status === "stopped") {
          continue;
        }

        const lastSeenMs = Date.parse(binding.lastSeenAt);
        if (Number.isNaN(lastSeenMs)) {
          yield* Effect.logWarning("provider.session.reaper.invalid-last-seen", {
            threadId: binding.threadId,
            provider: binding.provider,
            lastSeenAt: binding.lastSeenAt,
          });
          continue;
        }

        const idleDurationMs = now - lastSeenMs;
        if (idleDurationMs < inactivityThresholdMs) {
          continue;
        }

        const thread = yield* projectionSnapshotQuery
          .getThreadShellById(binding.threadId)
          .pipe(Effect.map(Option.getOrUndefined));
        if (thread?.session?.activeTurnId != null) {
          yield* Effect.logDebug("provider.session.reaper.skipped-active-turn", {
            threadId: binding.threadId,
            activeTurnId: thread.session.activeTurnId,
            idleDurationMs,
          });
          continue;
        }

        // A thread parked on a pending user-input/approval request is waiting on
        // the human, not idle — reaping it would strand the answer with
        // "No active provider session is bound to this thread." `activeTurnId`
        // usually still guards this (the turn stays open), but not for every
        // provider/flow, so guard explicitly here too — mirroring
        // ProviderTurnStallWatchdog.shouldTrip.
        if (thread?.hasPendingUserInput === true || thread?.hasPendingApprovals === true) {
          yield* Effect.logDebug("provider.session.reaper.skipped-pending-user-input", {
            threadId: binding.threadId,
            hasPendingUserInput: thread?.hasPendingUserInput ?? false,
            hasPendingApprovals: thread?.hasPendingApprovals ?? false,
            idleDurationMs,
          });
          continue;
        }

        // The turn can settle while background work runs on (subagent
        // fleets, workflow runs, Monitor watch loops). Those live inside the
        // provider process, so stopping the session would kill them silently,
        // and nothing bumps lastSeenAt between turns.
        if (thread?.backgroundLiveness != null) {
          yield* Effect.logDebug("provider.session.reaper.skipped-background-work", {
            threadId: binding.threadId,
            backgroundLiveness: thread.backgroundLiveness,
            idleDurationMs,
          });
          continue;
        }

        // The projection's `backgroundLiveness` above covers work the provider
        // process reports; this covers the fork's own registered background
        // tasks, which are tracked in SQLite and outlive a provider restart. The
        // two signals are independent, so both guards stay.
        //
        // A thread with an in-flight background task is not truly idle —
        // reaping its session would kill the live watcher. Leave it alone; the
        // BackgroundTaskRecoveryWatchdog owns recovery if the task is orphaned.
        // Fail closed: if the lookup errors, skip reaping this sweep rather than
        // risk killing a live watcher on a transient persistence hiccup.
        const pendingTasks = yield* pendingBackgroundTaskRepository
          .listByThreadId({ threadId: binding.threadId })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("provider.session.reaper.pending-task-lookup-failed", {
                threadId: binding.threadId,
                cause,
              }).pipe(Effect.as(null)),
            ),
          );
        if (pendingTasks === null || pendingTasks.length > 0) {
          yield* Effect.logDebug("provider.session.reaper.skipped-pending-background-task", {
            threadId: binding.threadId,
            pendingTaskCount: pendingTasks?.length ?? "lookup-failed",
            idleDurationMs,
          });
          continue;
        }

        // Dispatch rather than calling the provider directly. The command
        // handler stops the provider AND writes the session projection; a bare
        // `stopSession` stopped the subprocess and left the projection saying
        // the session was still live, which every client then reads as truth.
        // `ProviderService.stopSession` marks the binding stopped only after
        // the adapter stop succeeds, so a failed stop leaves a live binding
        // whose session projection already reads "stopped". Dispatching for it
        // cannot help - the command handler skips the provider for exactly
        // that reason - and the session write below it would still land, so
        // every sweep would burn two durable events on a thread nothing here
        // can fix. Skip it, and say so once per sweep so it is diagnosable.
        const projectedSession = Option.getOrNull(
          yield* projectionSnapshotQuery
            .getThreadSessionById(binding.threadId)
            .pipe(Effect.catchCause(() => Effect.succeedNone)),
        );
        if (projectedSession?.status === "stopped") {
          yield* Effect.logWarning("provider.session.reaper.binding-outlived-session", {
            threadId: binding.threadId,
            provider: binding.provider,
            bindingStatus: binding.status,
            idleDurationMs,
          });
          continue;
        }

        const reaped = yield* Effect.gen(function* () {
          const createdAt = yield* nowIso;
          yield* orchestrationEngine.dispatch({
            type: "thread.session.stop",
            commandId: yield* commandId("reap"),
            threadId: binding.threadId,
            createdAt,
          });
        }).pipe(
          Effect.tap(() =>
            Effect.logInfo("provider.session.reaped", {
              threadId: binding.threadId,
              provider: binding.provider,
              idleDurationMs,
              reason: "inactivity_threshold",
            }),
          ),
          Effect.as(true),
          Effect.timeout(DISPATCH_TIMEOUT),
          Effect.catchCause((cause) =>
            Effect.logWarning("provider.session.reaper.stop-failed", {
              threadId: binding.threadId,
              provider: binding.provider,
              idleDurationMs,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );

        if (reaped) {
          reapedCount += 1;
        }
      }

      if (reapedCount > 0) {
        yield* Effect.logInfo("provider.session.reaper.sweep-complete", {
          reapedCount,
          totalBindings: bindings.length,
        });
      }
    });

    const start: ProviderSessionReaperShape["start"] = () =>
      Effect.gen(function* () {
        yield* forkParked(
          sweep.pipe(
            Effect.catch((error: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-failed", {
                error,
              }),
            ),
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-defect", {
                defect,
              }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
          ),
        );

        yield* Effect.logInfo("provider.session.reaper.started", {
          inactivityThresholdMs,
          sweepIntervalMs,
        });
      });

    return {
      start,
    } satisfies ProviderSessionReaperShape;
  });

export const makeProviderSessionReaperLive = (options?: ProviderSessionReaperLiveOptions) =>
  Layer.effect(ProviderSessionReaper, makeProviderSessionReaper(options));

export const ProviderSessionReaperLive = makeProviderSessionReaperLive();
