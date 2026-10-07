import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  type GitCommandError,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ThreadId,
  type WorkspaceMember,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { ServerConfig } from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceMemberBranches from "../workspace/WorkspaceMemberBranches.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as WorkspaceMemberHooks from "./WorkspaceMemberHooks.ts";

const projectId = ProjectId.make("project-members");
const threadId = ThreadId.make("thread-abcdef01");
const INTEGRATION_BRANCH = "pickup-v2";

/** Swapped per test: the project's live members and the paths a sweep refreshed. */
let members: ReadonlyArray<WorkspaceMember> = [];
const refreshedPaths: Array<string> = [];

const TestLayer = WorkspaceMemberHooks.live.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(ProjectStore.ProjectStoreV2)({
        get: () =>
          Effect.succeed(
            Option.some({
              projectId,
              title: "Workspace",
              workspaceRoot: "/workspace",
              defaultModelSelection: null,
              defaultThreadEnvMode: null,
              autoPull: false,
              faviconPath: null,
              projectIcon: null,
              scripts: [],
              members,
              createdAt: "2026-06-21T00:00:00.000Z",
              updatedAt: "2026-06-21T00:00:00.000Z",
              deletedAt: null,
            }),
          ),
      }),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getThreadShell: () =>
          Effect.succeed({
            id: threadId,
            projectId,
            title: "Add demo suite",
          } as OrchestrationV2ThreadShell),
      }),
      Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
        refreshLocalStatus: (cwd) =>
          Effect.sync(() => {
            refreshedPaths.push(cwd);
          }).pipe(Effect.andThen(Effect.die("status not needed"))),
      }),
    ),
  ),
  Layer.provideMerge(WorkspaceMemberBranches.layer),
  Layer.provideMerge(VcsDriverRegistry.layer),
  Layer.provideMerge(Layer.mergeAll(GitVcsDriver.layerVcs, GitVcsDriver.layer)),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-member-hooks-test-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "WorkspaceMemberHooks.test.git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });

const writeFile = (cwd: string, relativePath: string, contents: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.writeFileString(path.join(cwd, relativePath), contents);
  });

/** A member repository sitting on its long-lived integration branch. */
const makeMember = (id: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: `member-${id}-` });
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.initRepo({ cwd });
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* writeFile(cwd, "README.md", "# member\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
    yield* git(cwd, ["switch", "-c", INTEGRATION_BRANCH]);
    return {
      id,
      path: cwd,
      title: id,
      integrationBranch: INTEGRATION_BRANCH,
    } satisfies WorkspaceMember;
  });

/** A member whose path is not a repository, e.g. a checkout that was moved. */
const makeBrokenMember = (id: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: `broken-${id}-` });
    return {
      id,
      path: cwd,
      title: id,
      integrationBranch: INTEGRATION_BRANCH,
    } satisfies WorkspaceMember;
  });

const withMembers = (next: ReadonlyArray<WorkspaceMember>) =>
  Effect.sync(() => {
    members = next;
    refreshedPaths.length = 0;
  });

describe("WorkspaceMemberHooks", () => {
  it.effect("records nothing for a project without members", () =>
    Effect.gen(function* () {
      const hooks = yield* WorkspaceMemberHooks.WorkspaceMemberHooks;
      yield* withMembers([]);
      assert.isUndefined(yield* hooks.checkpointStates({ threadId }));
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("records every member at capture, keeping an unreadable one without a head", () =>
    Effect.gen(function* () {
      const hooks = yield* WorkspaceMemberHooks.WorkspaceMemberHooks;
      const warehouse = yield* makeMember("warehouse");
      const broken = yield* makeBrokenMember("broken");
      const api = yield* makeMember("api");
      yield* withMembers([warehouse, broken, api]);

      const states = yield* hooks.checkpointStates({ threadId });

      assert.deepEqual(
        states?.map((state) => [state.memberId, state.headSha === undefined]),
        [
          ["warehouse", false],
          ["broken", true],
          ["api", false],
        ],
      );
      assert.strictEqual(states?.[2]?.headSha, yield* git(api.path, ["rev-parse", "HEAD"]));
    }).pipe(Effect.provide(TestLayer)),
  );

  // Failure handling over several members: a broken member in the middle must
  // neither fail the sweep nor stop the members after it.
  it.effect("sweeps every member it can, past a broken one, and never fails", () =>
    Effect.gen(function* () {
      const hooks = yield* WorkspaceMemberHooks.WorkspaceMemberHooks;
      const warehouse = yield* makeMember("warehouse");
      const broken = yield* makeBrokenMember("broken");
      const api = yield* makeMember("api");
      const idle = yield* makeMember("idle");
      yield* writeFile(warehouse.path, "README.md", "# member, edited by a run\n");
      yield* writeFile(api.path, "README.md", "# member, edited by a run\n");
      yield* withMembers([warehouse, broken, api, idle]);

      yield* hooks.sweep({ threadId });

      for (const member of [warehouse, api]) {
        const branch = yield* git(member.path, ["branch", "--show-current"]);
        assert.notStrictEqual(branch, INTEGRATION_BRANCH, `${member.id} should be cut`);
      }
      assert.strictEqual(yield* git(idle.path, ["branch", "--show-current"]), INTEGRATION_BRANCH);
      // The status refresh dies in this fixture, and that must not stop the sweep either.
      assert.deepEqual(refreshedPaths, [warehouse.path, api.path, idle.path]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("refuses a rollback only for the members that moved, naming them", () =>
    Effect.gen(function* () {
      const hooks = yield* WorkspaceMemberHooks.WorkspaceMemberHooks;
      const warehouse = yield* makeMember("warehouse");
      const api = yield* makeMember("api");
      yield* withMembers([warehouse, api]);
      const memberStates = yield* hooks.checkpointStates({ threadId });
      const checkpoint = { appRunOrdinal: 2, memberStates };

      assert.isNull(yield* hooks.rollbackRefusal({ threadId, projectId, checkpoint }));

      yield* writeFile(api.path, "README.md", "# moved after the checkpoint\n");
      const refusal = yield* hooks.rollbackRefusal({ threadId, projectId, checkpoint });
      assert.include(refusal ?? "", "api has changed since this checkpoint");
      assert.notInclude(refusal ?? "", "warehouse");

      // Detaching every member must not wave the rollback through: the
      // checkpoint still claims a state the workspace can no longer deliver.
      yield* withMembers([]);
      assert.isNotNull(yield* hooks.rollbackRefusal({ threadId, projectId, checkpoint }));

      // A checkpoint captured without members makes no claim.
      assert.isNull(
        yield* hooks.rollbackRefusal({
          threadId,
          projectId,
          checkpoint: { appRunOrdinal: 2 },
        }),
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "refuses a rollback to the thread start while a member carries this thread's work",
    () =>
      Effect.gen(function* () {
        const hooks = yield* WorkspaceMemberHooks.WorkspaceMemberHooks;
        const warehouse = yield* makeMember("warehouse");
        const api = yield* makeMember("api");
        yield* withMembers([warehouse, api]);
        const threadStart = { appRunOrdinal: null };

        assert.isNull(
          yield* hooks.rollbackRefusal({ threadId, projectId, checkpoint: threadStart }),
        );

        yield* writeFile(warehouse.path, "README.md", "# edited by this thread\n");
        yield* hooks.sweep({ threadId });
        const refusal = yield* hooks.rollbackRefusal({
          threadId,
          projectId,
          checkpoint: threadStart,
        });
        assert.include(refusal ?? "", "warehouse");
        assert.notInclude(refusal ?? "", "api");
      }).pipe(Effect.provide(TestLayer)),
  );
});
