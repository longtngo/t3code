import { CommandId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as GitManager from "../git/GitManager.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import { describeSettlementFailure, makeSettlementFailureLogGate } from "./settlementFailureLog.ts";
import {
  isAutoSettlementCandidate,
  resolveAutoSettlementAt,
  type SettlementPullRequest,
} from "./ThreadSettlementPolicy.ts";

export class ThreadSettlementReactor extends Context.Service<
  ThreadSettlementReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/ThreadSettlementReactor") {}

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const git = yield* GitManager.GitManager;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;

  // Lives here, in `make`'s closure, deliberately: declared inside `sweep` it
  // would be rebuilt every 60 seconds and the dedupe would be a silent no-op.
  const failureLog = makeSettlementFailureLogGate();

  const sweep = Effect.fn("ThreadSettlementReactor.sweep")(function* (
    mergedPullRequest: PullRequestService.PullRequestMergeEvent | null,
  ) {
    const snapshot = yield* snapshots.getShellSnapshot();
    const now = DateTime.formatIso(yield* DateTime.now);
    const projects = new Map(snapshot.projects.map((project) => [project.id, project]));
    const candidates = snapshot.threads.filter(
      (thread) =>
        isAutoSettlementCandidate(thread, now) &&
        (mergedPullRequest === null ||
          (thread.linkedPullRequest != null &&
            thread.linkedPullRequest.projectId === mergedPullRequest.projectId &&
            thread.linkedPullRequest.repository.toLowerCase() ===
              mergedPullRequest.repository.toLowerCase() &&
            thread.linkedPullRequest.number === mergedPullRequest.number)),
    );
    // Use the same cwd as the sidebar so both paths share GitManager's PR cache.
    const lookupCwdByThreadId = new Map<string, string>();
    yield* Effect.forEach(
      candidates,
      (thread) =>
        Effect.gen(function* () {
          const project = projects.get(thread.projectId);
          if (project === undefined || thread.linkedPullRequest != null) return;
          const worktreeExists =
            thread.worktreePath !== null &&
            (yield* fileSystem.exists(thread.worktreePath).pipe(Effect.orElseSucceed(() => false)));
          lookupCwdByThreadId.set(
            thread.id,
            worktreeExists && thread.worktreePath !== null
              ? thread.worktreePath
              : project.workspaceRoot,
          );
        }),
      { concurrency: 8, discard: true },
    );
    const lookupKey = (thread: (typeof candidates)[number]) => {
      if (thread.linkedPullRequest != null) {
        return JSON.stringify([
          "linked",
          thread.linkedPullRequest.projectId,
          thread.linkedPullRequest.repository,
          thread.linkedPullRequest.number,
        ]);
      }
      if (thread.branch === null) return JSON.stringify(["none", thread.id]);
      const cwd = lookupCwdByThreadId.get(thread.id);
      return JSON.stringify(
        cwd === undefined ? ["missing-project", thread.id] : ["branch", cwd, thread.branch],
      );
    };
    const groups = Map.groupBy(candidates, lookupKey);

    const pullRequestFor = Effect.fn("ThreadSettlementReactor.pullRequestFor")(function* (
      thread: (typeof candidates)[number],
    ) {
      if (thread.linkedPullRequest != null) {
        if (mergedPullRequest !== null) {
          return {
            state: "merged",
            updatedAt: mergedPullRequest.mergedAt,
          } satisfies SettlementPullRequest;
        }
        if (!projects.has(thread.linkedPullRequest.projectId)) {
          return yield* Effect.die(new Error("linked pull request project not found"));
        }
        const summary = yield* pullRequests.summary(
          {
            projectId: thread.linkedPullRequest.projectId,
            repository: thread.linkedPullRequest.repository,
            number: thread.linkedPullRequest.number,
          },
          { recoverTransientFailure: false },
        );
        return {
          state: summary.state,
          updatedAt: summary.updatedAt,
        } satisfies SettlementPullRequest;
      }
      if (thread.branch === null) return null;
      const cwd = lookupCwdByThreadId.get(thread.id);
      if (cwd === undefined) {
        return yield* Effect.die(new Error("thread project not found"));
      }
      return yield* git.branchPullRequest({ cwd, branch: thread.branch });
    });

    yield* Effect.forEach(
      groups.entries(),
      ([lookupGroupKey, group]) =>
        Effect.gen(function* () {
          const pullRequest = yield* pullRequestFor(group[0]!);
          // A group that answered again may report its next failure. Placed on
          // the success of the lookup itself, which is the only thing this
          // catch can be reporting on.
          failureLog.forget(lookupGroupKey);
          yield* Effect.forEach(
            group,
            (thread) =>
              Effect.gen(function* () {
                const settings = yield* settingsService.getSettings;
                const decisionNow = DateTime.formatIso(yield* DateTime.now);
                const settledAt = resolveAutoSettlementAt({
                  thread,
                  pullRequest,
                  now: decisionNow,
                  autoSettleAfterDays: settings.sidebarAutoSettleAfterDays,
                  autoSettleOnMerge: settings.sidebarAutoSettleOnMerge,
                });
                if (settledAt === null) {
                  return;
                }
                const uuid = yield* crypto.randomUUIDv4;
                yield* engine.dispatch({
                  type: "thread.auto-settle",
                  commandId: CommandId.make(`server:auto-settle:${thread.id}:${uuid}`),
                  threadId: thread.id,
                  snapshotSequence: snapshot.snapshotSequence,
                  settledAt,
                });
              }).pipe(
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.failCause(cause)
                    : Effect.logWarning("automatic thread settlement skipped", {
                        threadId: thread.id,
                        cause: Cause.pretty(cause),
                      }),
                ),
              ),
            { discard: true },
          );
        }).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
            const failure = describeSettlementFailure(Cause.squash(cause));
            // For a linked-pull-request group this is the thread's own project,
            // not the linked repository — still the right place to look, but it
            // is not the repo named in the lookup.
            const project = projects.get(group[0]!.projectId);
            // Unconditional, and outside the dedupe: the full cause is what an
            // operator falls back to, and deleting it outright would make
            // recovering it a redeploy. `T3CODE_LOG_LEVEL=Debug` is the way in.
            const detailed = Effect.logDebug("automatic thread settlement skipped", {
              threadIds: group.map((thread) => thread.id),
              cause: Cause.pretty(cause),
            });
            if (!failureLog.shouldLog(lookupGroupKey, failure.failureKey)) return detailed;
            return detailed.pipe(
              Effect.andThen(
                Effect.logWarning(
                  "automatic thread settlement skipped; the same failure stays silent until it changes",
                ).pipe(
                  Effect.annotateLogs({
                    threadCount: group.length,
                    workspaceRoot: project?.workspaceRoot ?? "unknown",
                    branch: group[0]!.branch ?? "unknown",
                    errorTag: failure.errorTag,
                    error: failure.message,
                    ...(failure.detail === undefined ? {} : { errorDetail: failure.detail }),
                  }),
                ),
              ),
            );
          }),
        ),
      { concurrency: 8, discard: true },
    );
  });

  const runSweep = (mergedPullRequest: PullRequestService.PullRequestMergeEvent | null) =>
    sweep(mergedPullRequest).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("automatic thread settlement sweep failed", {
              cause: Cause.pretty(cause),
            }),
      ),
    );
  const worker = yield* makeDrainableWorker(() => runSweep(null));

  const start: ThreadSettlementReactor["Service"]["start"] = Effect.fn(
    "ThreadSettlementReactor.start",
  )(function* () {
    const settingsChanges = yield* settingsService.subscribeChanges;
    const mergedPullRequests = yield* pullRequests.subscribeMerges;
    const initialSettings = yield* settingsService.getSettings.pipe(Effect.orDie);
    let lastAfterDays = initialSettings.sidebarAutoSettleAfterDays;
    let lastOnMerge = initialSettings.sidebarAutoSettleOnMerge;
    yield* forkParked(
      Effect.gen(function* () {
        yield* worker.enqueue(undefined);
        yield* worker.drain;
      }).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid),
    );
    yield* forkParked(
      Stream.runForEach(settingsChanges, (settings) => {
        if (
          settings.sidebarAutoSettleAfterDays === lastAfterDays &&
          settings.sidebarAutoSettleOnMerge === lastOnMerge
        ) {
          return Effect.void;
        }
        lastAfterDays = settings.sidebarAutoSettleAfterDays;
        lastOnMerge = settings.sidebarAutoSettleOnMerge;
        return worker.enqueue(undefined);
      }),
    );
    yield* forkParked(Stream.runForEach(mergedPullRequests, runSweep));
  });

  return { start, drain: worker.drain } satisfies ThreadSettlementReactor["Service"];
});

export const layer = Layer.effect(ThreadSettlementReactor, make);
