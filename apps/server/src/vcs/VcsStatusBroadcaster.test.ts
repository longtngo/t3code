import { SourceControlProviderKind } from "@t3tools/contracts";
import { assert, it, describe } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Scheduler from "effect/Scheduler";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import type {
  BackgroundScope,
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
  VcsStatusStreamEvent,
} from "@t3tools/contracts";
import { GitCommandError, GitManagerError } from "@t3tools/contracts";

import * as VcsStatusBroadcaster from "./VcsStatusBroadcaster.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");

const baseLocalStatus: VcsStatusLocalResult = {
  isRepo: true,
  sourceControlProvider: {
    kind: SourceControlProviderKind.make("github"),
    name: "GitHub",
    baseUrl: "https://github.com",
  },
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature/status-broadcast",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
};

const baseRemoteStatus: VcsStatusRemoteResult = {
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
};

const remoteStatusWithPr: VcsStatusRemoteResult = {
  ...baseRemoteStatus,
  pr: {
    number: 2978,
    title: "[codex] Rewrite client connection architecture",
    url: "https://github.com/pingdotgg/t3code/pull/2978",
    baseRef: "main",
    headRef: "upstream-topic",
    state: "open",
  },
};

function layerTestFor(state: {
  currentLocalStatus: VcsStatusLocalResult;
  currentRemoteStatus: VcsStatusRemoteResult | null;
  localStatusCalls: number;
  remoteStatusCalls: number;
  localInvalidationCalls: number;
  remoteInvalidationCalls: number;
  remoteStatusRefreshUpstreamValues?: Array<boolean | undefined>;
  remoteStatusError?: GitManagerError;
  backgroundWorkEnabled?: boolean;
  automaticFetchInterval?: Effect.Effect<Duration.Duration>;
  beforeRemoteStatus?: Effect.Effect<void>;
  fileSystem?: FileSystem.FileSystem;
  pullCurrentBranch?: GitWorkflowService.GitWorkflowService["Service"]["pullCurrentBranch"];
}) {
  return VcsStatusBroadcaster.layer.pipe(
    Layer.provideMerge(
      state.fileSystem
        ? Layer.succeed(FileSystem.FileSystem, state.fileSystem)
        : NodeServices.layer,
    ),
    Layer.provide(layerBackgroundPolicy(() => state.backgroundWorkEnabled !== false)),
    Layer.provide(
      Layer.succeed(
        VcsStatusBroadcaster.VcsAutomaticFetchInterval,
        state.automaticFetchInterval ?? Effect.succeed(Duration.seconds(30)),
      ),
    ),
    Layer.provide(
      Layer.mock(GitWorkflowService.GitWorkflowService)({
        localStatus: () =>
          Effect.sync(() => {
            state.localStatusCalls += 1;
            return state.currentLocalStatus;
          }),
        currentBranch: () => Effect.sync(() => state.currentLocalStatus.refName),
        remoteStatus: (_input, options) =>
          Effect.suspend(() => {
            return (state.beforeRemoteStatus ?? Effect.void).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  state.remoteStatusCalls += 1;
                  state.remoteStatusRefreshUpstreamValues?.push(options?.refreshUpstream);
                  return state.currentRemoteStatus;
                }),
              ),
              Effect.tap(() =>
                state.remoteStatusError ? Effect.fail(state.remoteStatusError) : Effect.void,
              ),
            );
          }),
        invalidateLocalStatus: () =>
          Effect.sync(() => {
            state.localInvalidationCalls += 1;
          }),
        invalidateRemoteStatus: () =>
          Effect.sync(() => {
            state.remoteInvalidationCalls += 1;
          }),
        invalidateStatus: () =>
          Effect.sync(() => {
            state.localInvalidationCalls += 1;
            state.remoteInvalidationCalls += 1;
          }),
        ...(state.pullCurrentBranch ? { pullCurrentBranch: state.pullCurrentBranch } : {}),
      }),
    ),
  );
}

function layerBackgroundPolicy(shouldRunScopeWork: (scope: BackgroundScope) => boolean) {
  return Layer.mock(BackgroundPolicy.BackgroundPolicy)({
    reportClientActivity: () => Effect.void,
    removeRpcClient: () => Effect.void,
    snapshot: Effect.succeed({
      hostPower: {
        source: "unknown",
        idle: "unknown",
        idleSeconds: null,
        locked: "unknown",
        suspended: false,
        onBattery: "unknown",
        lowPowerMode: "unknown",
        thermalState: "unknown",
        stale: true,
        updatedAt: TEST_EPOCH,
      },
      leases: [],
      activeForegroundLeaseCount: 0,
      activeScopeKeys: [],
      shouldRunOpportunisticWork: false,
      updatedAt: TEST_EPOCH,
    }),
    shouldRunScopeWork: (scope) => Effect.sync(() => shouldRunScopeWork(scope)),
    shouldRunOpportunisticWork: Effect.succeed(true),
  });
}

describe("VcsStatusBroadcaster", () => {
  it.effect("publishes a terminal branch switch without reading remote status", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: remoteStatusWithPr,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo" });
      const subscribed = yield* Deferred.make<void>();
      const events = yield* broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }).pipe(
        Stream.tap((event) =>
          event._tag === "snapshot" ? Deferred.succeed(subscribed, undefined) : Effect.void,
        ),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Deferred.await(subscribed);

      state.currentLocalStatus = { ...baseLocalStatus, refName: "main" };
      const refreshed = yield* broadcaster.refreshStatus("/repo", { localOnly: true });
      assert.equal(refreshed.refName, "main");
      assert.isNull(refreshed.pr);
      assert.equal(state.localInvalidationCalls, 1);
      assert.equal(state.remoteStatusCalls, 1);
      assert.equal(state.remoteInvalidationCalls, 2);
      assert.deepStrictEqual((yield* Fiber.join(events)).slice(1), [
        { _tag: "remoteUpdated", remote: null },
        { _tag: "localUpdated", local: state.currentLocalStatus },
      ]);
      assert.isNull((yield* broadcaster.getStatus({ cwd: "/repo" })).pr);
      const snapshot = yield* broadcaster
        .streamStatus({ cwd: "/repo", includeRemote: false })
        .pipe(Stream.take(1), Stream.runCollect);
      assert.deepStrictEqual(snapshot[0], {
        _tag: "snapshot",
        local: state.currentLocalStatus,
        remote: null,
      });
    }).pipe(Effect.provide(layerTestFor(state)));
  });

  it.effect(
    "preserves cached remote status when a local-only refresh stays on the same branch",
    () => {
      const state = {
        currentLocalStatus: baseLocalStatus,
        currentRemoteStatus: { ...remoteStatusWithPr, aheadCount: 2, behindCount: 3 },
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
      };

      return Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        const initial = yield* broadcaster.getStatus({ cwd: "/repo" });
        const refreshed = yield* broadcaster.refreshStatus("/repo", { localOnly: true });
        assert.deepStrictEqual(refreshed, initial);
        assert.deepStrictEqual(yield* broadcaster.getStatus({ cwd: "/repo" }), refreshed);
        assert.equal(state.localInvalidationCalls, 1);
        assert.equal(state.remoteInvalidationCalls, 1);
        assert.equal(state.remoteStatusCalls, 1);
      }).pipe(Effect.provide(layerTestFor(state)));
    },
  );

  it.effect("clears the previous branch's remote status after an in-flight PR refresh", () => {
    const remoteReadStarted = Deferred.makeUnsafe<void>();
    const releaseRemoteRead = Deferred.makeUnsafe<void>();
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: remoteStatusWithPr,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
      beforeRemoteStatus: Effect.void,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo" });
      state.beforeRemoteStatus = Deferred.succeed(remoteReadStarted, undefined).pipe(
        Effect.andThen(Deferred.await(releaseRemoteRead)),
      );
      const remoteRefresh = yield* broadcaster
        .refreshPullRequestStatus("/repo")
        .pipe(Effect.forkScoped);
      yield* Deferred.await(remoteReadStarted);
      state.currentLocalStatus = { ...baseLocalStatus, refName: "main" };
      const localRefresh = yield* broadcaster
        .refreshStatus("/repo", { localOnly: true })
        .pipe(Effect.forkScoped);
      yield* Deferred.succeed(releaseRemoteRead, undefined);
      yield* Fiber.join(remoteRefresh);
      yield* Fiber.join(localRefresh);

      const status = yield* broadcaster.getStatus({ cwd: "/repo" });
      assert.equal(status.refName, "main");
      assert.isNull(status.pr);
      assert.equal(status.aheadCount, 0);
      assert.equal(status.behindCount, 0);
      assert.equal(state.remoteStatusCalls, 2);
    }).pipe(Effect.provide(layerTestFor(state)));
  });

  it.effect.skipIf(!symlinksSupported)(
    "automatically pulls an enabled clean default branch when status detects it is behind",
    () => {
      let remoteStatus: VcsStatusRemoteResult = { ...baseRemoteStatus, behindCount: 2 };
      let pullCalls = 0;
      let configuredWorkspaceRoot = "";
      const localStatus: VcsStatusLocalResult = {
        ...baseLocalStatus,
        isDefaultRef: true,
        refName: "main",
      };
      const layerTest = VcsStatusBroadcaster.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provide(layerBackgroundPolicy(() => true)),
        Layer.provide(
          Layer.succeed(VcsStatusBroadcaster.VcsAutoPullPolicy, {
            isEnabled: (cwd) => Effect.succeed(cwd === configuredWorkspaceRoot),
            isIdle: () => Effect.succeed(true),
          }),
        ),
        Layer.provide(
          Layer.mock(GitWorkflowService.GitWorkflowService)({
            localStatus: () => Effect.succeed(localStatus),
            currentBranch: () => Effect.succeed(localStatus.refName),
            remoteStatus: () => Effect.succeed(remoteStatus),
            invalidateLocalStatus: () => Effect.void,
            invalidateRemoteStatus: () => Effect.void,
            invalidateStatus: () => Effect.void,
            pullCurrentBranch: () =>
              Effect.sync(() => {
                pullCalls += 1;
                remoteStatus = { ...remoteStatus, behindCount: 0 };
                return {
                  status: "pulled" as const,
                  refName: "main",
                  upstreamRef: "origin/main",
                };
              }),
          }),
        ),
      );

      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const realDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-vcs-auto-pull-real-",
        });
        const linkParent = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-vcs-auto-pull-link-",
        });
        configuredWorkspaceRoot = path.join(linkParent, "repo-link");
        yield* fileSystem.symlink(realDir, configuredWorkspaceRoot);

        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        const status = yield* broadcaster.refreshStatus(configuredWorkspaceRoot);

        assert.equal(pullCalls, 1);
        assert.equal(status.behindCount, 0);
      }).pipe(Effect.provide(layerTest));
    },
  );

  it.effect("refreshes a loaded cwd without reusing a previous branch's PR", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;

      assert.isNull(yield* broadcaster.refreshPullRequestStatus("/repo"));
      assert.equal(state.remoteStatusCalls, 0);

      yield* broadcaster.getStatus({ cwd: "/repo" });
      assert.equal(state.remoteStatusCalls, 1);

      state.currentRemoteStatus = remoteStatusWithPr;
      const refreshed = yield* broadcaster.refreshPullRequestStatus("/repo");
      assert.deepStrictEqual(refreshed, remoteStatusWithPr);
      assert.equal(state.remoteStatusCalls, 2);
      assert.equal(state.remoteInvalidationCalls, 2);

      state.currentLocalStatus = { ...baseLocalStatus, refName: "feature/next" };
      state.currentRemoteStatus = baseRemoteStatus;
      yield* broadcaster.refreshLocalStatus("/repo");
      const refreshedBranch = yield* broadcaster.refreshPullRequestStatus("/repo");
      assert.deepStrictEqual(refreshedBranch, baseRemoteStatus);
      assert.equal(state.remoteStatusCalls, 3);
      const refreshedStatus = yield* broadcaster.getStatus({ cwd: "/repo" });
      assert.equal(refreshedStatus.refName, "feature/next");
      assert.isNull(refreshedStatus.pr);
      assert.equal(state.remoteStatusCalls, 3);
      assert.equal(state.remoteInvalidationCalls, 3);
    }).pipe(Effect.provide(layerTestFor(state)));
  });

  it.effect("a poll that started before the turn-end refresh cannot overwrite its PR", () => {
    const releaseFirstPoll = Deferred.makeUnsafe<void>();
    const firstPollStarted = Deferred.makeUnsafe<void>();
    let remoteReads = 0;
    const layer = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(layerBackgroundPolicy(() => true)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () => Effect.succeed(baseLocalStatus),
          currentBranch: () => Effect.succeed(baseLocalStatus.refName),
          remoteStatus: () =>
            Effect.gen(function* () {
              remoteReads += 1;
              if (remoteReads === 2) {
                yield* Deferred.succeed(firstPollStarted, undefined);
                yield* Deferred.await(releaseFirstPoll);
                return baseRemoteStatus;
              }
              return remoteReads === 1 ? baseRemoteStatus : remoteStatusWithPr;
            }),
          invalidateLocalStatus: () => Effect.void,
          invalidateRemoteStatus: () => Effect.void,
          invalidateStatus: () => Effect.void,
        }),
      ),
    );

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo" });

      const poll = yield* broadcaster.refreshStatus("/repo").pipe(Effect.forkScoped);
      yield* Deferred.await(firstPollStarted);
      const refresh = yield* broadcaster.refreshPullRequestStatus("/repo").pipe(Effect.forkScoped);
      yield* Deferred.succeed(releaseFirstPoll, undefined);
      yield* Fiber.join(poll);
      const refreshed = yield* Fiber.join(refresh);

      assert.deepStrictEqual(refreshed, remoteStatusWithPr);
      const final = yield* broadcaster.getStatus({ cwd: "/repo" });
      assert.deepStrictEqual(final.pr, remoteStatusWithPr.pr);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.effect("an initial status read cannot overwrite an explicit refresh", () => {
    const firstReadStarted = Deferred.makeUnsafe<void>();
    const releaseFirstRead = Deferred.makeUnsafe<void>();
    let remoteReads = 0;
    const layer = VcsStatusBroadcaster.layer.pipe(
      Layer.provide(FileSystem.layerNoop({ realPath: (path) => Effect.succeed(path) })),
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(layerBackgroundPolicy(() => true)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () => Effect.succeed(baseLocalStatus),
          currentBranch: () => Effect.succeed(baseLocalStatus.refName),
          remoteStatus: () =>
            Effect.gen(function* () {
              remoteReads += 1;
              if (remoteReads === 1) {
                yield* Deferred.succeed(firstReadStarted, undefined);
                yield* Deferred.await(releaseFirstRead);
                return baseRemoteStatus;
              }
              return remoteStatusWithPr;
            }),
          invalidateLocalStatus: () => Effect.void,
          invalidateRemoteStatus: () => Effect.void,
          invalidateStatus: () => Effect.void,
        }),
      ),
    );
    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const initial = yield* broadcaster.getStatus({ cwd: "/repo" }).pipe(Effect.forkScoped);
      yield* Deferred.await(firstReadStarted);
      const refresh = yield* broadcaster.refreshStatus("/repo").pipe(Effect.forkScoped);
      yield* TestClock.adjust(Duration.zero);
      yield* Deferred.succeed(releaseFirstRead, undefined);
      yield* Fiber.join(initial);
      yield* Fiber.join(refresh);
      assert.deepStrictEqual(
        (yield* broadcaster.getStatus({ cwd: "/repo" })).pr,
        remoteStatusWithPr.pr,
      );
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.effect("keeps the published local snapshot when a refresh remote read fails", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
      failRemoteStatus: false,
    };
    const layerTest = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(layerBackgroundPolicy(() => true)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () =>
            Effect.sync(() => {
              state.localStatusCalls += 1;
              return state.currentLocalStatus;
            }),
          currentBranch: () => Effect.succeed(state.currentLocalStatus.refName),
          remoteStatus: () =>
            Effect.suspend(() => {
              state.remoteStatusCalls += 1;
              return state.failRemoteStatus
                ? Effect.fail(
                    new GitManagerError({
                      operation: "VcsStatusBroadcaster.test",
                      cwd: "/repo",
                      detail: "remote status failed",
                    }),
                  )
                : Effect.succeed(state.currentRemoteStatus);
            }),
          invalidateLocalStatus: () =>
            Effect.sync(() => {
              state.localInvalidationCalls += 1;
            }),
          invalidateRemoteStatus: () =>
            Effect.sync(() => {
              state.remoteInvalidationCalls += 1;
            }),
          invalidateStatus: () =>
            Effect.sync(() => {
              state.localInvalidationCalls += 1;
              state.remoteInvalidationCalls += 1;
            }),
        }),
      ),
    );

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo" });

      state.currentLocalStatus = {
        ...baseLocalStatus,
        refName: "feature/partial-refresh",
      };
      state.currentRemoteStatus = {
        ...baseRemoteStatus,
        aheadCount: 3,
      };
      state.failRemoteStatus = true;

      const refreshExit = yield* broadcaster.refreshStatus("/repo").pipe(Effect.exit);
      const snapshot = yield* Stream.runHead(
        broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }),
      );

      assert.isTrue(Exit.isFailure(refreshExit));
      assert.isTrue(Option.isSome(snapshot));
      const event = Option.getOrThrow(snapshot);
      assert.equal(event._tag, "snapshot");
      if (event._tag === "snapshot") {
        assert.equal(event.local.refName, "feature/partial-refresh");
        assert.isNull(event.remote);
      }
    }).pipe(Effect.provide(layerTest));
  });

  it.effect.skipIf(!symlinksSupported)(
    "normalizes symlinked CWDs before cache lookup and workflow calls",
    () => {
      const seenCwds: string[] = [];
      const state = {
        currentLocalStatus: baseLocalStatus,
        currentRemoteStatus: baseRemoteStatus,
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
      };
      const layerTest = VcsStatusBroadcaster.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provide(layerBackgroundPolicy(() => true)),
        Layer.provide(
          Layer.mock(GitWorkflowService.GitWorkflowService)({
            localStatus: (input) =>
              Effect.sync(() => {
                seenCwds.push(input.cwd);
                state.localStatusCalls += 1;
                return state.currentLocalStatus;
              }),
            currentBranch: () => Effect.succeed(state.currentLocalStatus.refName),
            remoteStatus: (input) =>
              Effect.sync(() => {
                seenCwds.push(input.cwd);
                state.remoteStatusCalls += 1;
                return state.currentRemoteStatus;
              }),
            invalidateLocalStatus: () =>
              Effect.sync(() => {
                state.localInvalidationCalls += 1;
              }),
            invalidateRemoteStatus: () =>
              Effect.sync(() => {
                state.remoteInvalidationCalls += 1;
              }),
          } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>),
        ),
      );

      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const realDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-vcs-status-real-",
        });
        const linkParent = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-vcs-status-link-",
        });
        const linkDir = path.join(linkParent, "repo-link");
        yield* fileSystem.symlink(realDir, linkDir);
        const realPath = yield* fileSystem.realPath(realDir);

        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        yield* broadcaster.getStatus({ cwd: linkDir });
        yield* broadcaster.getStatus({ cwd: realDir });

        assert.deepStrictEqual(seenCwds, [realPath, realPath]);
        assert.equal(state.localStatusCalls, 1);
        assert.equal(state.remoteStatusCalls, 1);
      }).pipe(Effect.provide(layerTest));
    },
  );

  // A workspace project subscribes to every attached repository at once. If each
  // of those subscriptions started a remote poller, seven repositories would mean
  // seven periodic fetches — the shape of the fetch storm that once pegged the CPU.
  it.effect("never loads remote status for a local-only subscriber", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
      automaticFetchInterval: Effect.succeed(Duration.zero),
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const scope = yield* Scope.make();
      const snapshotDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      yield* Stream.runForEach(
        broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }),
        (event) =>
          event._tag === "snapshot"
            ? Deferred.succeed(snapshotDeferred, event).pipe(Effect.ignore)
            : Effect.void,
      ).pipe(Effect.forkIn(scope));

      const snapshot = yield* Deferred.await(snapshotDeferred);
      assert.deepStrictEqual(snapshot, {
        _tag: "snapshot",
        local: baseLocalStatus,
        remote: null,
      } satisfies VcsStatusStreamEvent);
      assert.equal(state.localStatusCalls, 1);
      assert.equal(state.remoteStatusCalls, 0);

      yield* TestClock.adjust(Duration.minutes(5));
      assert.equal(state.remoteStatusCalls, 0);

      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.provide(Layer.merge(layerTestFor(state), TestClock.layer())));
  });

  // Retain and release must stay symmetric. A local-only subscriber that released
  // a poller it never retained would drop the refcount below what the expanded
  // repository holds and silently stop its polling too.
  it.effect("leaves another subscriber's remote polling running when a local-only one ends", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
      automaticFetchInterval: Effect.succeed(Duration.minutes(1)),
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const pollingScope = yield* Scope.make();
      const localOnlyScope = yield* Scope.make();
      const pollingSnapshot = yield* Deferred.make<VcsStatusStreamEvent>();
      const localOnlySnapshot = yield* Deferred.make<VcsStatusStreamEvent>();

      yield* Stream.runForEach(broadcaster.streamStatus({ cwd: "/repo" }), (event) =>
        event._tag === "snapshot"
          ? Deferred.succeed(pollingSnapshot, event).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkIn(pollingScope));
      yield* Deferred.await(pollingSnapshot);

      yield* Stream.runForEach(
        broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }),
        (event) =>
          event._tag === "snapshot"
            ? Deferred.succeed(localOnlySnapshot, event).pipe(Effect.ignore)
            : Effect.void,
      ).pipe(Effect.forkIn(localOnlyScope));
      yield* Deferred.await(localOnlySnapshot);

      const callsBeforeClose = state.remoteStatusCalls;
      yield* Scope.close(localOnlyScope, Exit.void);
      yield* TestClock.adjust(Duration.minutes(3));

      assert.isAbove(state.remoteStatusCalls, callsBeforeClose);

      yield* Scope.close(pollingScope, Exit.void);
    }).pipe(Effect.provide(Layer.merge(layerTestFor(state), TestClock.layer())));
  });

  it.effect("an explicit refresh reads local totals after the fetch", () => {
    const state: Parameters<typeof layerTestFor>[0] = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const fetchStarted = yield* Deferred.make<void>();
      const finishFetch = yield* Deferred.make<void>();
      state.beforeRemoteStatus = Deferred.succeed(fetchStarted, undefined).pipe(
        Effect.andThen(Deferred.await(finishFetch)),
      );
      const refresh = yield* broadcaster.refreshStatus("/repo").pipe(Effect.forkScoped);
      yield* Deferred.await(fetchStarted);

      const fetchedLocal: VcsStatusLocalResult = {
        ...baseLocalStatus,
        branchChanges: { baseRef: "origin/main", insertions: 0, deletions: 0 },
      };
      state.currentLocalStatus = fetchedLocal;
      yield* Deferred.succeed(finishFetch, undefined);

      const status = yield* Fiber.join(refresh);
      assert.deepStrictEqual(status.branchChanges, fetchedLocal.branchChanges);
    }).pipe(Effect.provide(layerTestFor(state)));
  });

  it.effect("publishes local status while an earlier lookup holds the remote lock", () => {
    const state: Parameters<typeof layerTestFor>[0] = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo" });
      const subscribed = yield* Deferred.make<void>();
      const published = yield* Deferred.make<VcsStatusLocalResult>();
      yield* broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }).pipe(
        Stream.runForEach((event) => {
          if (event._tag === "snapshot") return Deferred.succeed(subscribed, undefined);
          if (event._tag === "localUpdated") return Deferred.succeed(published, event.local);
          return Effect.void;
        }),
        Effect.forkScoped,
      );
      yield* Deferred.await(subscribed);
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      state.beforeRemoteStatus = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      const earlier = yield* broadcaster.refreshPullRequestStatus("/repo").pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      state.currentLocalStatus = { ...baseLocalStatus, hasWorkingTreeChanges: true };
      const completed = yield* Deferred.make<void>();
      const refresh = yield* broadcaster
        .refreshStatus("/repo")
        .pipe(Effect.ensuring(Deferred.succeed(completed, undefined)), Effect.forkScoped);

      assert.deepStrictEqual(yield* Deferred.await(published), state.currentLocalStatus);
      assert.isFalse(yield* Deferred.isDone(completed));
      assert.isFalse(yield* Deferred.isDone(release));
      state.currentRemoteStatus = remoteStatusWithPr;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(earlier);
      const status = yield* Fiber.join(refresh);
      assert.isTrue(status.hasWorkingTreeChanges);
      assert.deepStrictEqual(status.pr, remoteStatusWithPr.pr);
    }).pipe(Effect.provide(layerTestFor(state)), Effect.scoped);
  });

  it.effect("publishes local changes before a remote error and propagates that error", () => {
    const remoteError = new GitManagerError({
      operation: "VcsStatusBroadcaster.remoteStatus",
      cwd: "/repo",
      detail: "The controlled remote lookup failed.",
    });
    const state: Parameters<typeof layerTestFor>[0] = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: remoteStatusWithPr,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo" });
      const subscribed = yield* Deferred.make<void>();
      const published = yield* Deferred.make<VcsStatusLocalResult>();
      yield* broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }).pipe(
        Stream.runForEach((event) => {
          if (event._tag === "snapshot") return Deferred.succeed(subscribed, undefined);
          if (event._tag === "localUpdated") return Deferred.succeed(published, event.local);
          return Effect.void;
        }),
        Effect.forkScoped,
      );
      yield* Deferred.await(subscribed);
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const completed = yield* Deferred.make<void>();
      state.beforeRemoteStatus = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      state.currentLocalStatus = { ...baseLocalStatus, hasWorkingTreeChanges: true };
      state.remoteStatusError = remoteError;
      const refresh = yield* broadcaster
        .refreshStatus("/repo")
        .pipe(
          Effect.result,
          Effect.ensuring(Deferred.succeed(completed, undefined)),
          Effect.forkScoped,
        );
      yield* Deferred.await(started);
      assert.isFalse(yield* Deferred.isDone(completed));
      const pending = Option.getOrThrow(
        yield* Stream.runHead(broadcaster.streamStatus({ cwd: "/repo", includeRemote: false })),
      );
      assert.equal(pending._tag, "snapshot");
      if (pending._tag === "snapshot") assert.isTrue(pending.local.hasWorkingTreeChanges);
      yield* Deferred.succeed(release, undefined);
      const result = yield* Fiber.join(refresh);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.strictEqual(result.failure, remoteError);
      const cached = yield* broadcaster.getStatus({ cwd: "/repo" });
      assert.isTrue(cached.hasWorkingTreeChanges);
      assert.deepStrictEqual(cached.pr, remoteStatusWithPr.pr);
      assert.deepStrictEqual(yield* Deferred.await(published), state.currentLocalStatus);
    }).pipe(Effect.provide(layerTestFor(state)), Effect.scoped);
  });

  it.effect.each(["getStatus", "refreshStatus", "autoPull", "autoPullFailure"] as const)(
    "%s keeps response parts consistent when local state changes after the remote cache write",
    (operation) => {
      const state: Parameters<typeof layerTestFor>[0] = {
        currentLocalStatus: baseLocalStatus,
        currentRemoteStatus: { ...remoteStatusWithPr, aheadCount: 3, behindCount: 5 },
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
        fileSystem: FileSystem.makeNoop({ realPath: (cwd) => Effect.succeed(cwd) }),
      };
      const autoPull = operation === "autoPull" || operation === "autoPullFailure";
      if (autoPull) {
        state.currentLocalStatus = { ...baseLocalStatus, isDefaultRef: true };
        state.currentRemoteStatus = { ...remoteStatusWithPr, aheadCount: 0, behindCount: 5 };
        state.pullCurrentBranch = () =>
          operation === "autoPullFailure"
            ? Effect.fail(
                new GitCommandError({
                  operation: "test.pull",
                  command: "pull",
                  cwd: "/repo",
                  detail: "Pull failed.",
                }),
              )
            : Effect.succeed({
                status: "pulled",
                refName: "feature/status-broadcast",
                upstreamRef: "origin/main",
              });
      }
      const layerTest = layerTestFor(state).pipe(
        Layer.provide(
          Layer.succeed(VcsStatusBroadcaster.VcsAutoPullPolicy, {
            isEnabled: () => Effect.succeed(autoPull),
            isIdle: () => Effect.succeed(true),
          }),
        ),
      );
      return Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        let switched = false;
        let remoteWritten = false;
        const writeCompleted = yield* Deferred.make<void>();
        const localRefresh = yield* Effect.gen(function* () {
          yield* Deferred.await(writeCompleted);
          state.currentLocalStatus = { ...baseLocalStatus, refName: "feature/next-status" };
          yield* broadcaster.refreshLocalStatus("/repo");
          switched = true;
        }).pipe(Effect.forkScoped);
        const scheduler = new Scheduler.MixedScheduler();
        const shouldYield = scheduler.shouldYield.bind(scheduler);
        scheduler.shouldYield = (fiber) => (remoteWritten && !switched) || shouldYield(fiber);
        const tracer = Tracer.make({
          span: (options) => {
            const span = new Tracer.NativeSpan(options);
            const end = span.end.bind(span);
            span.end = (time, exit) => {
              end(time, exit);
              if (
                options.name !== "VcsStatusBroadcaster.updateCachedRemoteStatus" ||
                remoteWritten
              ) {
                return;
              }
              // Yield this reader after its write until the local refresh finishes.
              remoteWritten = true;
              Deferred.doneUnsafe(writeCompleted, Effect.void);
            };
            return span;
          },
        });
        const status = yield* (
          operation === "getStatus"
            ? broadcaster.getStatus({ cwd: "/repo" })
            : broadcaster.refreshStatus("/repo")
        ).pipe(Effect.withTracer(tracer), Effect.provideService(Scheduler.Scheduler, scheduler));
        yield* Fiber.join(localRefresh);
        assert.isTrue(switched);
        assert.equal(status.refName, "feature/next-status");
        assert.isNull(status.pr);
        assert.equal(status.aheadCount, 0);
        assert.equal(status.behindCount, 0);
      }).pipe(Effect.provide(layerTest), Effect.scoped);
    },
  );

  it.effect("recovers a discarded branch lookup on the next permitted turn-end refresh", () => {
    const state: Parameters<typeof layerTestFor>[0] = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: { ...remoteStatusWithPr, aheadCount: 3, behindCount: 5 },
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      state.beforeRemoteStatus = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      const lookup = yield* broadcaster.getStatus({ cwd: "/repo" }).pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      state.currentLocalStatus = { ...baseLocalStatus, refName: "feature/next-status" };
      yield* Deferred.succeed(release, undefined);
      const discarded = yield* Fiber.join(lookup);
      assert.equal(discarded.refName, state.currentLocalStatus.refName);
      assert.isNull(discarded.pr);
      assert.equal(discarded.aheadCount, 0);
      assert.equal(discarded.behindCount, 0);
      const snapshot = Option.getOrThrow(
        yield* Stream.runHead(broadcaster.streamStatus({ cwd: "/repo", includeRemote: false })),
      );
      assert.equal(snapshot._tag, "snapshot");
      if (snapshot._tag === "snapshot") assert.isNull(snapshot.remote);

      state.beforeRemoteStatus = Effect.void;
      state.currentRemoteStatus = {
        ...baseRemoteStatus,
        aheadCount: 2,
        pr: { ...remoteStatusWithPr.pr!, number: 2979, headRef: "feature/next-status" },
      };
      state.backgroundWorkEnabled = false;
      yield* broadcaster.refreshPullRequestStatus("/repo");
      assert.equal(state.remoteStatusCalls, 1);
      state.backgroundWorkEnabled = true;
      const recovered = yield* broadcaster.refreshPullRequestStatus("/repo");
      assert.deepStrictEqual(recovered, state.currentRemoteStatus);
      const cached = yield* broadcaster.getStatus({ cwd: "/repo" });
      assert.equal(cached.refName, state.currentLocalStatus.refName);
      assert.deepStrictEqual(cached.pr, state.currentRemoteStatus.pr);
      assert.equal(cached.aheadCount, 2);
      assert.equal(state.remoteStatusCalls, 2);
    }).pipe(Effect.provide(layerTestFor(state)), Effect.scoped);
  });

  it.effect("releases remote demand while passive observers remain", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };
    let remoteInterruptedDeferred: Deferred.Deferred<void, never> | null = null;
    let remoteStartedDeferred: Deferred.Deferred<void, never> | null = null;
    const layerTest = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(layerBackgroundPolicy(() => true)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () =>
            Effect.sync(() => {
              state.localStatusCalls += 1;
              return state.currentLocalStatus;
            }),
          currentBranch: () => Effect.succeed(state.currentLocalStatus.refName),
          remoteStatus: () =>
            Effect.sync(() => {
              state.remoteStatusCalls += 1;
            }).pipe(
              Effect.andThen(
                remoteStartedDeferred
                  ? Deferred.succeed(remoteStartedDeferred, undefined).pipe(Effect.ignore)
                  : Effect.void,
              ),
              Effect.andThen(Effect.never as Effect.Effect<VcsStatusRemoteResult | null, never>),
              Effect.onInterrupt(() =>
                remoteInterruptedDeferred
                  ? Deferred.succeed(remoteInterruptedDeferred, undefined).pipe(Effect.ignore)
                  : Effect.void,
              ),
            ),
          invalidateLocalStatus: () =>
            Effect.sync(() => {
              state.localInvalidationCalls += 1;
            }),
          invalidateRemoteStatus: () =>
            Effect.sync(() => {
              state.remoteInvalidationCalls += 1;
            }),
        } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>),
      ),
    );

    return Effect.gen(function* () {
      const remoteInterrupted = yield* Deferred.make<void>();
      const remoteStarted = yield* Deferred.make<void>();
      remoteInterruptedDeferred = remoteInterrupted;
      remoteStartedDeferred = remoteStarted;

      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const firstSnapshot = yield* Deferred.make<VcsStatusStreamEvent>();
      const secondSnapshot = yield* Deferred.make<VcsStatusStreamEvent>();
      const firstScope = yield* Scope.make();
      const secondScope = yield* Scope.make();
      const passiveSnapshot = yield* Deferred.make<VcsStatusStreamEvent>();
      yield* Stream.runForEach(
        broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }),
        (event) =>
          event._tag === "snapshot"
            ? Deferred.succeed(passiveSnapshot, event).pipe(Effect.ignore)
            : Effect.void,
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(passiveSnapshot);
      assert.equal(state.remoteStatusCalls, 0);
      yield* Stream.runForEach(broadcaster.streamStatus({ cwd: "/repo" }), (event) =>
        event._tag === "snapshot"
          ? Deferred.succeed(firstSnapshot, event).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkIn(firstScope));
      yield* Stream.runForEach(broadcaster.streamStatus({ cwd: "/repo" }), (event) =>
        event._tag === "snapshot"
          ? Deferred.succeed(secondSnapshot, event).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkIn(secondScope));

      yield* Deferred.await(firstSnapshot);
      yield* Deferred.await(secondSnapshot);
      yield* Deferred.await(remoteStarted);

      assert.equal(state.remoteStatusCalls, 1);

      yield* Scope.close(firstScope, Exit.void);
      assert.isTrue(Option.isNone(yield* Deferred.poll(remoteInterrupted)));

      yield* Scope.close(secondScope, Exit.void).pipe(Effect.forkScoped);
      yield* Deferred.await(remoteInterrupted);
      assert.isTrue(Option.isSome(yield* Deferred.poll(remoteInterrupted)));
    }).pipe(Effect.provide(layerTest));
  });
});

describe("auto-pull idle guard", () => {
  /**
   * A broadcaster whose pull is enabled, behind, and clean by default - so the
   * idle check is the only thing standing between a refresh and a pull.
   */
  const makeHarness = (input: {
    readonly idle: boolean;
    readonly enabled?: boolean;
    readonly behindCount?: number;
    readonly hasWorkingTreeChanges?: boolean;
  }) => {
    const state = {
      pullCalls: 0,
      isIdleCalls: [] as Array<ReadonlyArray<string>>,
      remoteStatus: { ...baseRemoteStatus, behindCount: input.behindCount ?? 2 },
    };
    const localStatus: VcsStatusLocalResult = {
      ...baseLocalStatus,
      isDefaultRef: true,
      refName: "main",
      hasWorkingTreeChanges: input.hasWorkingTreeChanges ?? false,
    };
    const layer = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(layerBackgroundPolicy(() => true)),
      Layer.provide(
        Layer.succeed(VcsStatusBroadcaster.VcsAutoPullPolicy, {
          isEnabled: () => Effect.succeed(input.enabled ?? true),
          isIdle: (cwds) =>
            Effect.sync(() => {
              state.isIdleCalls.push(cwds);
              return input.idle;
            }),
        }),
      ),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () => Effect.succeed(localStatus),
          currentBranch: () => Effect.succeed(localStatus.refName),
          remoteStatus: () => Effect.succeed(state.remoteStatus),
          invalidateLocalStatus: () => Effect.void,
          invalidateRemoteStatus: () => Effect.void,
          invalidateStatus: () => Effect.void,
          pullCurrentBranch: () =>
            Effect.sync(() => {
              state.pullCalls += 1;
              state.remoteStatus = { ...state.remoteStatus, behindCount: 0 };
              return { status: "pulled" as const, refName: "main", upstreamRef: "origin/main" };
            }),
        }),
      ),
    );
    return { state, layer };
  };

  const refresh = (harness: ReturnType<typeof makeHarness>) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-vcs-idle-guard-" });
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const status = yield* broadcaster.refreshStatus(cwd);
      return { cwd, status };
    }).pipe(Effect.provide(harness.layer));

  it.effect("pulls when nothing is working in the checkout", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ idle: true });
      const { status } = yield* refresh(harness);
      assert.equal(harness.state.pullCalls, 1);
      assert.equal(status.behindCount, 0);
    }),
  );

  it.effect("skips the pull while something is working there, and still reports status", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ idle: false });
      const { status } = yield* refresh(harness);
      assert.equal(harness.state.pullCalls, 0);
      // Still behind: the refresh reported the real state rather than pretending.
      assert.equal(status.behindCount, 2);
    }),
  );

  // The broadcaster works in realpath space while `isEnabled` was asked about the
  // raw path the client gave. A thread's checkout is recorded in the raw space,
  // so the guard has to ask about both or it silently misses under a symlink.
  it.effect.skipIf(!symlinksSupported)(
    "asks about every name the checkout goes by, not just the realpath",
    () => {
      const harness = makeHarness({ idle: true });
      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const realDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-vcs-idle-real-" });
        const linkParent = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-vcs-idle-link-",
        });
        const linked = path.join(linkParent, "repo-link");
        yield* fileSystem.symlink(realDir, linked);
        const realPath = yield* fileSystem.realPath(realDir);

        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        yield* broadcaster.refreshStatus(linked);

        assert.equal(harness.state.isIdleCalls.length, 1);
        const asked = new Set(harness.state.isIdleCalls[0]);
        assert.isTrue(asked.has(linked), "the raw path the client gave was not asked about");
        assert.isTrue(
          asked.has(realPath),
          "the realpath the broadcaster works in was not asked about",
        );
      }).pipe(Effect.provide(harness.layer));
    },
  );

  // The check reads the whole shell projection, so it must be the LAST gate:
  // a refresh that is not going to pull anyway must never pay for it.
  it.effect.each([
    { name: "not enabled", enabled: false },
    { name: "not behind", behindCount: 0 },
    { name: "dirty tree", hasWorkingTreeChanges: true },
  ])("does not consult the idle check when the pull is already gated out ($name)", (input) =>
    Effect.gen(function* () {
      const harness = makeHarness({ idle: true, ...input });
      yield* refresh(harness);
      assert.equal(harness.state.pullCalls, 0);
      assert.equal(harness.state.isIdleCalls.length, 0);
    }),
  );
});

describe("layerAutoPullPolicy.isIdle", () => {
  const ROOT = "/repo";
  const OTHER_ROOT = "/other";
  const projects = [
    { id: "project-1", workspaceRoot: ROOT },
    { id: "project-2", workspaceRoot: OTHER_ROOT },
  ] as never;
  const quietThread = {
    id: "thread-1",
    projectId: "project-1",
    archivedAt: null,
    worktreePath: null,
    status: "completed",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestUserMessageAt: null,
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
  };

  const policyLayer = (
    getShellSnapshot: ProjectionStore.ProjectionStoreV2["Service"]["getShellSnapshot"],
  ) =>
    VcsStatusBroadcaster.layerAutoPullPolicy.pipe(
      Layer.provide(
        Layer.mock(ProjectStore.ProjectStoreV2)({ listShells: () => Effect.succeed(projects) }),
      ),
      Layer.provide(Layer.mock(ProjectionStore.ProjectionStoreV2)({ getShellSnapshot })),
      Layer.provide(Layer.succeed(ServerSettings.ServerSettingsService, {} as never)),
    );

  const isIdle = (threads: ReadonlyArray<unknown>, cwds: ReadonlyArray<string> = [ROOT]) =>
    Effect.gen(function* () {
      const policy = yield* VcsStatusBroadcaster.VcsAutoPullPolicy;
      return yield* policy.isIdle(cwds);
    }).pipe(Effect.provide(policyLayer(() => Effect.succeed({ threads } as never))));

  it.effect("is idle when no thread in the checkout is doing anything", () =>
    Effect.gen(function* () {
      assert.isTrue(yield* isIdle([quietThread]));
    }),
  );

  it.effect.each([
    { name: "a running run", patch: { status: "running", activityRunStatus: "running" } },
    { name: "a starting run", patch: { status: "starting", activityRunStatus: "starting" } },
    { name: "a run being prepared", patch: { status: "preparing" } },
    // No run is active yet, but one is next in line and will start here.
    { name: "a queued run", patch: { status: "queued" } },
    { name: "a run waiting on the user", patch: { status: "waiting" } },
    // The shell's status already reads terminal while the active run is still
    // live; only activityRunStatus sees it.
    {
      name: "an active run behind a completed status",
      patch: { status: "completed", activityRunStatus: "running" },
    },
    {
      name: "a pending runtime request",
      patch: { pendingRuntimeRequest: { id: "request-1", kind: "approval" } },
    },
    // The case the run status alone misses: the run is over, and a background
    // task is still running git in this checkout.
    {
      name: "background work after the run completed",
      patch: { pendingBackgroundTasks: [{ id: "task-1" }] },
    },
  ])("is busy while a thread in the checkout has $name", ({ patch }) =>
    Effect.gen(function* () {
      assert.isFalse(yield* isIdle([{ ...quietThread, ...patch }]));
    }),
  );

  it.effect("is busy while a just-sent message has not been adopted by a run", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      assert.isFalse(yield* isIdle([{ ...quietThread, latestUserMessageAt: now }]));
    }),
  );

  it.effect("ignores a busy thread whose checkout is a worktree, not the root", () =>
    Effect.gen(function* () {
      const inWorktree = {
        ...quietThread,
        worktreePath: "/repo/.worktrees/feature",
        status: "running",
        activityRunStatus: "running",
      };
      assert.isTrue(yield* isIdle([inWorktree]));
    }),
  );

  it.effect("ignores a busy thread rooted in another project", () =>
    Effect.gen(function* () {
      const elsewhere = {
        ...quietThread,
        projectId: "project-2",
        status: "running",
        activityRunStatus: "running",
      };
      assert.isTrue(yield* isIdle([elsewhere]));
    }),
  );

  it.effect("ignores an archived thread, whatever it was doing", () =>
    Effect.gen(function* () {
      const archived = {
        ...quietThread,
        archivedAt: DateTime.makeUnsafe("2026-09-01T00:00:00.000Z"),
        status: "running",
        activityRunStatus: "running",
      };
      assert.isTrue(yield* isIdle([archived]));
    }),
  );

  it.effect("finds one busy thread among several quiet ones", () =>
    Effect.gen(function* () {
      const busy = { ...quietThread, id: "thread-3", status: "running" };
      assert.isFalse(
        yield* isIdle([
          quietThread,
          { ...quietThread, id: "thread-2", projectId: "project-2" },
          busy,
        ]),
      );
    }),
  );

  it.effect("matches on any of the names it is asked about", () =>
    Effect.gen(function* () {
      const busy = { ...quietThread, status: "running", activityRunStatus: "running" };
      // Asked in realpath space alone, the raw-recorded root is missed...
      assert.isTrue(yield* isIdle([busy], ["/private/repo"]));
      // ...asked about both, the thread is found.
      assert.isFalse(yield* isIdle([busy], ["/private/repo", ROOT]));
    }),
  );

  it.effect("reads as busy when the projection cannot be read", () =>
    Effect.gen(function* () {
      const policy = yield* VcsStatusBroadcaster.VcsAutoPullPolicy;
      assert.isFalse(yield* policy.isIdle([ROOT]));
    }).pipe(
      Effect.provide(
        policyLayer(() =>
          Effect.fail(new ProjectionStore.ProjectionStoreSetupError({ cause: "locked" })),
        ),
      ),
    ),
  );
});
