/**
 * Crew on the REAL v2 launch path: orchestrator, thread management and
 * `ThreadLaunchService`, with git and the provider stubbed. The unit tests in this folder
 * drive doubles of these services; this file checks the upstream behaviour those doubles
 * assume — that a failed worktree setup surfaces as a failed run with a failed
 * "Preparing workspace" item, and that a teardown racing provisioning leaves the thread
 * without a worktree.
 *
 * The harness is the one in `orchestration-v2/ThreadLaunchService.test.ts`.
 */
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ServerConfig from "../config.ts";
import { assert, it, vi } from "@effect/vitest";
import {
  CommandId,
  GitCommandError,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import { makeProviderRegistryLayer } from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import type { ProviderAdapterV2Shape } from "../orchestration-v2/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadTitleRegeneration from "../orchestration-v2/ThreadTitleRegenerationService.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { CrewDirectory, CrewDirectoryLive } from "../crew/CrewDirectory.ts";
import { CrewLog, type CrewLogCode } from "../crew/CrewLog.ts";
import { CrewRepository, CrewRepositoryLive } from "../crew/CrewRepository.ts";
import { CrewService, CrewServiceLive } from "../crew/CrewService.ts";
import { CrewSweep, CrewSweepLive } from "../crew/CrewSweep.ts";
import { McpSessionRegistry } from "../mcp/McpSessionRegistry.ts";
import { ProviderSessionManagerV2 } from "../orchestration-v2/ProviderSessionManager.ts";
import { isCrewBranch } from "@t3tools/contracts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as FileSystem from "effect/FileSystem";

const projectId = ProjectId.make("project:launch-test");
const otherProjectId = ProjectId.make("project:launch-other");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} as const;
const project = {
  id: projectId,
  title: "Project",
  workspaceRoot: "/repo",
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: modelSelection,
  defaultThreadEnvMode: null,
  scripts: [],
  members: [],
  createdAt: "2026-06-20T00:00:00.000Z",
  updatedAt: "2026-06-20T00:00:00.000Z",
  deletedAt: null,
} as const;

const otherProject = {
  ...project,
  id: otherProjectId,
  title: "Other",
} as const;

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in launch tests"),
} as ProviderAdapterV2Shape;

interface HarnessOptions {
  readonly managedFolders?: Layer.Layer<ManagedProjectFolders.ManagedProjectFolders>;
  readonly createWorktree?: GitWorkflow.GitWorkflowService["Service"]["createWorktree"];
  readonly fetchRemote?: GitWorkflow.GitWorkflowService["Service"]["fetchRemote"];
  readonly renameBranch?: GitWorkflow.GitWorkflowService["Service"]["renameBranch"];
  readonly runSetup?: ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]["runForThread"];
  readonly generateTitle?: TextGeneration.TextGeneration["Service"]["generateThreadTitle"];
  readonly generateBranchName?: TextGeneration.TextGeneration["Service"]["generateBranchName"];
  readonly serverSettings?: Parameters<typeof ServerSettings.layerTest>[0];
  readonly providers?: ReadonlyArray<ServerProvider>;
}

function makeHarness(
  options: HarnessOptions & { readonly database?: typeof SqlitePersistenceMemory } = {},
) {
  const database = options.database ?? SqlitePersistenceMemory;
  const registry = ProviderAdapterRegistry.makeLayer([adapter]);
  const orchestrator = makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "thread-launch" },
    registry,
    { databaseLayer: database, runEffectWorker: false },
  );
  const threadManagement = ThreadManagement.layer.pipe(Layer.provide(orchestrator));
  const receipts = CommandReceiptStore.layer.pipe(Layer.provide(database));
  const outbox = EffectOutbox.layer.pipe(Layer.provide(database));
  const createWorktree = vi.fn(
    options.createWorktree ??
      ((input) =>
        Effect.succeed({
          worktree: { path: "/repo-worktrees/feature", refName: input.newRefName, headSha: "abc" },
        } as never)),
  );
  const renameBranch = vi.fn(
    options.renameBranch ?? ((input) => Effect.succeed({ branch: input.newBranch })),
  );
  const runSetup = vi.fn(
    options.runSetup ?? (() => Effect.succeed({ status: "no-script" as const })),
  );
  const generateBranchName = vi.fn(
    options.generateBranchName ?? (() => Effect.succeed({ branch: "generated-branch" })),
  );
  const generateThreadTitle = vi.fn(
    options.generateTitle ?? (() => Effect.succeed({ title: "Generated title" })),
  );
  const externalServices = Layer.mergeAll(
    WorktreeSetupTracker.layer,
    Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
    Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
    Layer.succeed(ProjectService.ProjectService, {
      create: () => Effect.die("unused"),
      bootstrap: () => Effect.die("unused"),
      update: () => Effect.die("unused"),
      delete: () => Effect.die("unused"),
      getById: (id) =>
        Effect.succeed(
          id === projectId
            ? Option.some(project)
            : id === otherProjectId
              ? Option.some(otherProject)
              : Option.none(),
        ),
      getByWorkspaceRoot: () => Effect.succeed(Option.some(project)),
      snapshot: Effect.die("unused"),
      getShell: () => Effect.die("unused"),
      listShells: () => Effect.die("unused"),
    }),
    Layer.mock(GitWorkflow.GitWorkflowService)({
      createWorktree,
      renameBranch,
      fetchRemote: options.fetchRemote ?? (() => Effect.void),
      remoteExists: () => Effect.succeed(true),
      remoteBranchExists: () => Effect.succeed(true),
      removeWorktree: () => Effect.void,
      resolveRemoteTrackingCommit: () =>
        Effect.succeed({ commitSha: "remote-main-sha", remoteRefName: "origin/main" }),
    }),
    Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
      runForThread: runSetup,
    }),
    Layer.mock(TextGeneration.TextGeneration)({
      generateThreadTitle,
      generateBranchName,
    }),
    ServerSettings.layerTest(options.serverSettings),
    makeProviderRegistryLayer(options.providers),
    options.managedFolders ??
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        folderForThread: () => Effect.succeed(Option.none()),
      }),
  );
  const launch = ThreadLaunch.layer.pipe(
    Layer.provide(Layer.mergeAll(externalServices, threadManagement, receipts, IdAllocator.layer)),
  );
  const projectedProjects = Layer.mock(ProjectStore.ProjectStoreV2)({
    get: (requestedProjectId) =>
      Effect.succeed(
        requestedProjectId === projectId
          ? Option.some({
              projectId,
              title: project.title,
              workspaceRoot: project.workspaceRoot,
              defaultModelSelection: project.defaultModelSelection,
              defaultThreadEnvMode: null,
              autoPull: false,
              faviconPath: null,
              projectIcon: null,
              scripts: project.scripts,
              members: project.members,
              createdAt: project.createdAt,
              updatedAt: project.updatedAt,
              deletedAt: project.deletedAt,
            })
          : Option.none(),
      ),
  });
  const titleRegeneration = ThreadTitleRegeneration.layer.pipe(
    Layer.provide(Layer.mergeAll(threadManagement, projectedProjects, externalServices)),
  );
  return {
    layer: Layer.mergeAll(
      launch,
      threadManagement,
      titleRegeneration,
      outbox,
      database,
      externalServices,
    ),
    createWorktree,
    renameBranch,
    generateBranchName,
    generateThreadTitle,
    runSetup,
  };
}

function waitUntil<E, R>(predicate: () => Effect.Effect<boolean, E, R>): Effect.Effect<void, E, R> {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (yield* predicate()) return;
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            setImmediate(resolve);
          }),
      );
    }
    assert.fail("Condition was not reached before timeout.");
  });
}

const BRIDGE = ThreadId.make("thread:crew-launch:bridge");

function crewOn<ROut, E>(harness: { readonly layer: Layer.Layer<ROut, E> }) {
  const codes: Array<CrewLogCode> = [];
  const detaches: Array<string> = [];
  const crewLog = Layer.succeed(CrewLog, {
    record: (code) => Effect.sync(() => void codes.push(code)),
  });
  const crew = Layer.mergeAll(CrewServiceLive(), CrewDirectoryLive, CrewSweepLive).pipe(
    Layer.provideMerge(CrewRepositoryLive),
    Layer.provideMerge(crewLog),
    Layer.provideMerge(Layer.mock(McpSessionRegistry)({ revokeThread: () => Effect.void })),
    Layer.provideMerge(
      Layer.mock(ProviderSessionManagerV2)({
        detach: (input) => Effect.sync(() => void detaches.push(input.providerSessionId)),
      }),
    ),
    Layer.provideMerge(ServerConfig.layerTest("/tmp", { prefix: "crew-launch-" })),
    Layer.provideMerge(harness.layer),
    Layer.provide(NodeServices.layer),
  );
  return { crew, codes, detaches };
}

const createBridge = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  yield* threads.dispatch({
    type: "thread.create",
    commandId: CommandId.make("command:crew-launch:bridge"),
    threadId: BRIDGE,
    projectId,
    title: "bridge",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
});

const crewSettings = { enableCrew: true, enableAgentBrowserAccess: true } as never;

const failingWorktree = () =>
  Effect.fail(
    new GitCommandError({
      operation: "GitVcsDriver.createWorktree",
      command: "git",
      cwd: "/repo",
      detail: "fatal: invalid reference: no-such-ref",
      exitCode: 128,
    }),
  );

it.effect(
  "a dispatch whose worktree setup fails is closed, frees its slot, and tells the bridge",
  () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        serverSettings: crewSettings,
        createWorktree: failingWorktree,
      });
      const { crew, codes } = crewOn(harness);
      yield* Effect.gen(function* () {
        yield* createBridge;
        const service = yield* CrewService;
        const repository = yield* CrewRepository;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const dispatched = yield* service.dispatch(
          { prompt: "do it", baseRef: "no-such-ref" },
          BRIDGE,
        );
        yield* waitUntil(() =>
          threads
            .getThreadProjection(dispatched.crewThreadId)
            .pipe(Effect.map((projection) => projection.runs[0]?.status === "failed")),
        );
        assert.equal(yield* repository.countOpenTasks(), 1);

        yield* (yield* CrewSweep).runOnce();

        assert.equal(yield* repository.countOpenTasks(), 0);
        assert.include(codes, "crew.dispatch.compensate.skipped");
        const bridge = yield* threads.getThreadProjection(BRIDGE);
        const delivered = bridge.messages.map((message) => message.text).join("\n");
        assert.include(delivered, "Worktree setup failed");
        assert.include(delivered, "invalid reference");
      }).pipe(Effect.provide(crew));
    }),
);

it.effect("a healthy dispatch is not settled as a setup failure", () =>
  Effect.gen(function* () {
    const harness = makeHarness({ serverSettings: crewSettings });
    const { crew, codes } = crewOn(harness);
    yield* Effect.gen(function* () {
      yield* createBridge;
      const service = yield* CrewService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const dispatched = yield* service.dispatch({ prompt: "do it" }, BRIDGE);
      yield* waitUntil(() =>
        threads
          .getThreadProjection(dispatched.crewThreadId)
          .pipe(Effect.map((projection) => projection.runs[0]?.status !== "preparing")),
      );
      yield* (yield* CrewSweep).runOnce();
      assert.equal(yield* (yield* CrewRepository).countOpenTasks(), 1);
      assert.notInclude(codes, "crew.dispatch.compensate.skipped");
    }).pipe(Effect.provide(crew));
  }),
);

it.effect("a teardown during worktree setup leaves the archived thread without a worktree", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const allow = yield* Deferred.make<void>();
    const harness = makeHarness({
      serverSettings: crewSettings,
      createWorktree: (input) =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(allow)),
          Effect.as({
            worktree: { path: input.path ?? "/derived", refName: input.newRefName, headSha: "abc" },
          } as never),
        ),
    });
    const { crew } = crewOn(harness);
    yield* Effect.gen(function* () {
      yield* createBridge;
      const service = yield* CrewService;
      const directory = yield* CrewDirectory;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const dispatched = yield* service.dispatch({ prompt: "do it" }, BRIDGE);
      yield* Deferred.await(entered);
      yield* directory.teardown({ taskId: dispatched.taskId });
      yield* Deferred.succeed(allow, undefined);
      yield* waitUntil(() =>
        threads
          .getThreadProjection(dispatched.crewThreadId)
          .pipe(Effect.map((projection) => projection.runs[0]?.status !== "preparing")),
      );
      const after = yield* threads.getThreadProjection(dispatched.crewThreadId);
      assert.notEqual(after.thread.archivedAt, null);
      assert.equal(after.thread.worktreePath, null);
      // The `crew/` branch is kept as the crewmate's marker; only the worktree is forgotten.
      assert.isTrue(isCrewBranch(after.thread.branch));
      assert.equal(harness.runSetup.mock.calls.length, 0);
    }).pipe(Effect.provide(crew));
  }),
);

it.effect("a server that dies during worktree setup settles the task after it restarts", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const scratch = yield* fileSystem.makeTempDirectoryScoped({ prefix: "crew-launch-crash-" });
    const live = `${scratch}/live.sqlite`;
    const crashed = `${scratch}/crashed.sqlite`;
    const fileDb = (path: string) =>
      makeSqlitePersistenceLive(path).pipe(
        Layer.provide(NodeServices.layer),
      ) as never as typeof SqlitePersistenceMemory;
    const entered = yield* Deferred.make<void>();
    const harness = makeHarness({
      serverSettings: crewSettings,
      database: fileDb(live),
      createWorktree: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
    });
    // Boot 1: dispatch, then snapshot the database mid-provisioning — a crash, with no
    // shutdown handlers run.
    const taskId = yield* Effect.gen(function* () {
      yield* createBridge;
      const dispatched = yield* (yield* CrewService).dispatch({ prompt: "x" }, BRIDGE);
      yield* Deferred.await(entered);
      yield* (yield* SqlClient.SqlClient).unsafe(`VACUUM INTO '${crashed}'`);
      return dispatched.taskId;
    }).pipe(Effect.provide(crewOn(harness).crew), Effect.scoped);

    // Boot 2: upstream's startup recovery on the crashed copy, then crew's sweep.
    const registry = ProviderAdapterRegistry.makeLayer([adapter]);
    const recovered = makeOrchestratorV2ReplayLayerWithRegistry({ name: "crew-crash" }, registry, {
      databaseLayer: fileDb(crashed),
      recoverOnStartup: true,
    });
    const boot2 = crewOn({
      layer: Layer.mergeAll(
        ThreadManagement.layer.pipe(Layer.provideMerge(recovered)),
        fileDb(crashed),
        ServerSettings.layerTest(crewSettings),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
        Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
      ),
    });
    yield* Effect.gen(function* () {
      const repository = yield* CrewRepository;
      const sweep = yield* CrewSweep;
      yield* sweep.reapOrphans();
      yield* sweep.runOnce();
      yield* sweep.runOnce();
      const task = (yield* repository.listAllTasks()).find((row) => row.taskId === taskId);
      assert.equal(task?.status, "closed");
      const reports = yield* repository.listReportsByTaskId({ taskId });
      assert.deepStrictEqual(
        reports.map((report) => report.state),
        ["failed"],
      );
      assert.include(boot2.codes, "crew.dispatch.compensate.skipped");
    }).pipe(Effect.provide(boot2.crew), Effect.scoped);
  }).pipe(Effect.provide(NodeServices.layer)),
);
