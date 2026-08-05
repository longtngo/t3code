import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import type * as Scope from "effect/Scope";

import type { GitCommandError } from "@t3tools/contracts";
import { ServerConfig } from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { memberOwnerConfigKey, memberPrBaseConfigKey } from "./MemberBranches.ts";
import * as WorkspaceMemberBranches from "./WorkspaceMemberBranches.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-workspace-member-branches-test-",
});

const TestLayer = WorkspaceMemberBranches.layer.pipe(
  Layer.provideMerge(VcsDriverRegistry.layer),
  Layer.provideMerge(Layer.mergeAll(GitVcsDriver.vcsLayer, GitVcsDriver.layer)),
  Layer.provide(ServerConfigLayer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const THREAD_ID = "thread-abcdef01";
const INTEGRATION_BRANCH = "pickup-v2";

const git = (
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<string, GitCommandError, GitVcsDriver.GitVcsDriver> =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "WorkspaceMemberBranches.test.git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });

const writeFile = (
  cwd: string,
  relativePath: string,
  contents: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    yield* fileSystem.writeFileString(pathService.join(cwd, relativePath), contents);
  });

/**
 * A member repository shaped like the real ones: a default branch that stands
 * in for `main`, plus a long-lived integration branch the effort lives on.
 */
const makeMemberRepo = (): Effect.Effect<
  { readonly cwd: string; readonly defaultBranch: string },
  GitCommandError | PlatformError.PlatformError,
  GitVcsDriver.GitVcsDriver | FileSystem.FileSystem | Path.Path | Scope.Scope
> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "member-repo-" });
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.initRepo({ cwd });
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* writeFile(cwd, "README.md", "# member\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
    const defaultBranch = yield* git(cwd, ["branch", "--show-current"]);

    yield* git(cwd, ["switch", "-c", INTEGRATION_BRANCH]);
    yield* writeFile(cwd, "effort.md", "# effort\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "effort work"]);
    return { cwd, defaultBranch };
  });

describe("WorkspaceMemberBranches", () => {
  it.effect("leaves a clean member on its integration branch alone", () =>
    Effect.gen(function* () {
      const service = yield* WorkspaceMemberBranches.WorkspaceMemberBranches;
      const { cwd } = yield* makeMemberRepo();

      const report = yield* service.ensureFeatureBranch({
        cwd,
        integrationBranch: INTEGRATION_BRANCH,
        threadId: THREAD_ID,
        threadTitle: "Add demo suite",
      });

      assert.strictEqual(report.state, "idle");
      assert.strictEqual(yield* git(cwd, ["branch", "--show-current"]), INTEGRATION_BRANCH);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("reports a path that is not a repository as unavailable", () =>
    Effect.gen(function* () {
      const service = yield* WorkspaceMemberBranches.WorkspaceMemberBranches;
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "not-a-repo-" });

      const report = yield* service.inspect({
        cwd,
        integrationBranch: INTEGRATION_BRANCH,
        threadId: THREAD_ID,
      });

      assert.strictEqual(report.state, "unavailable");
    }).pipe(Effect.provide(TestLayer)),
  );

  // The design's first load-bearing case: T3 Code cut the branch, so both keys
  // must be written and the base must resolve to the integration branch.
  it.effect("cuts a feature branch and records the base and the owner", () =>
    Effect.gen(function* () {
      const service = yield* WorkspaceMemberBranches.WorkspaceMemberBranches;
      const { cwd } = yield* makeMemberRepo();
      yield* writeFile(cwd, "changed.md", "uncommitted\n");

      const report = yield* service.ensureFeatureBranch({
        cwd,
        integrationBranch: INTEGRATION_BRANCH,
        threadId: THREAD_ID,
        threadTitle: "Add demo suite",
      });

      assert.strictEqual(report.state, "owned-by-self");
      assert.strictEqual(report.branch, "t3code/add-demo-suite-threadab");
      assert.strictEqual(yield* git(cwd, ["branch", "--show-current"]), report.branch);
      assert.strictEqual(
        yield* git(cwd, ["config", "--get", memberPrBaseConfigKey(report.branch ?? "")]),
        INTEGRATION_BRANCH,
      );
      assert.strictEqual(
        yield* git(cwd, ["config", "--get", memberOwnerConfigKey(report.branch ?? "")]),
        THREAD_ID,
      );
      // The uncommitted work must still be there: creating a branch at HEAD and
      // switching to it does not check anything out.
      assert.include(yield* git(cwd, ["status", "--porcelain"]), "changed.md");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("is a no-op the second time it runs", () =>
    Effect.gen(function* () {
      const service = yield* WorkspaceMemberBranches.WorkspaceMemberBranches;
      const { cwd } = yield* makeMemberRepo();
      yield* writeFile(cwd, "changed.md", "uncommitted\n");
      const target = {
        cwd,
        integrationBranch: INTEGRATION_BRANCH,
        threadId: THREAD_ID,
        threadTitle: "Add demo suite",
      };

      const first = yield* service.ensureFeatureBranch(target);
      const second = yield* service.ensureFeatureBranch(target);

      assert.strictEqual(second.state, "owned-by-self");
      assert.strictEqual(second.branch, first.branch);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("takes no action on a branch another thread owns", () =>
    Effect.gen(function* () {
      const service = yield* WorkspaceMemberBranches.WorkspaceMemberBranches;
      const { cwd } = yield* makeMemberRepo();
      yield* writeFile(cwd, "changed.md", "uncommitted\n");
      yield* service.ensureFeatureBranch({
        cwd,
        integrationBranch: INTEGRATION_BRANCH,
        threadId: "thread-other",
        threadTitle: "Other work",
      });

      const report = yield* service.inspect({
        cwd,
        integrationBranch: INTEGRATION_BRANCH,
        threadId: THREAD_ID,
      });

      assert.strictEqual(report.state, "owned-by-other");
      assert.strictEqual(report.ownerThreadId, "thread-other");
    }).pipe(Effect.provide(TestLayer)),
  );

  // Second load-bearing case: the user cut the branch from the integration
  // branch by hand, so there is no config at all and the base must still be the
  // integration branch rather than the repository default.
  it.effect("resolves a hand-cut branch to the integration branch", () =>
    Effect.gen(function* () {
      const service = yield* WorkspaceMemberBranches.WorkspaceMemberBranches;
      const { cwd, defaultBranch } = yield* makeMemberRepo();
      yield* git(cwd, ["switch", "-c", "feat/by-hand"]);

      const resolved = yield* service.resolvePrBase({ cwd, integrationBranch: INTEGRATION_BRANCH });

      assert.strictEqual(resolved?.base, INTEGRATION_BRANCH);
      assert.notStrictEqual(resolved?.base, defaultBranch);
      assert.strictEqual(resolved?.source, "reflog");
    }).pipe(Effect.provide(TestLayer)),
  );

  // Third load-bearing case, and the one the ladder's ordering exists for: a
  // hotfix cut from the default branch in a repository pinned to the effort
  // branch must compare against the default branch, not the effort branch.
  it.effect("lets the reflog outrank the declared integration branch", () =>
    Effect.gen(function* () {
      const service = yield* WorkspaceMemberBranches.WorkspaceMemberBranches;
      const { cwd, defaultBranch } = yield* makeMemberRepo();
      yield* git(cwd, ["switch", defaultBranch]);
      yield* git(cwd, ["switch", "-c", "hotfix/urgent"]);

      const resolved = yield* service.resolvePrBase({ cwd, integrationBranch: INTEGRATION_BRANCH });

      assert.strictEqual(resolved?.base, defaultBranch);
      assert.strictEqual(resolved?.source, "reflog");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("resolves a branch the reflog records as created from HEAD", () =>
    Effect.gen(function* () {
      const service = yield* WorkspaceMemberBranches.WorkspaceMemberBranches;
      const { cwd } = yield* makeMemberRepo();
      // `git branch` from a detached-free checkout records `Created from HEAD`
      // rather than a branch name.
      yield* git(cwd, ["branch", "feat/from-head"]);
      yield* git(cwd, ["switch", "feat/from-head"]);

      const resolved = yield* service.resolvePrBase({ cwd, integrationBranch: INTEGRATION_BRANCH });

      assert.strictEqual(resolved?.base, INTEGRATION_BRANCH);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("falls through to the integration branch when the reflog is gone", () =>
    Effect.gen(function* () {
      const service = yield* WorkspaceMemberBranches.WorkspaceMemberBranches;
      const { cwd, defaultBranch } = yield* makeMemberRepo();
      yield* git(cwd, ["switch", defaultBranch]);
      yield* git(cwd, ["switch", "-c", "feat/expired-reflog"]);
      // Expiring every reflog entry is what a fresh clone or a `gc` looks like.
      yield* git(cwd, ["reflog", "expire", "--expire=now", "--all"]);
      yield* git(cwd, ["reflog", "delete", "--rewrite", "feat/expired-reflog@{0}"]).pipe(
        Effect.ignore,
      );

      const resolved = yield* service.resolvePrBase({ cwd, integrationBranch: INTEGRATION_BRANCH });

      assert.strictEqual(resolved?.base, INTEGRATION_BRANCH);
      assert.strictEqual(resolved?.source, "integration");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("prefers a written base over everything the ladder can infer", () =>
    Effect.gen(function* () {
      const service = yield* WorkspaceMemberBranches.WorkspaceMemberBranches;
      const { cwd, defaultBranch } = yield* makeMemberRepo();
      yield* git(cwd, ["switch", defaultBranch]);
      yield* git(cwd, ["switch", "-c", "feat/confirmed"]);

      const wrote = yield* service.writePrBase({
        cwd,
        branch: "feat/confirmed",
        base: INTEGRATION_BRANCH,
      });
      const resolved = yield* service.resolvePrBase({ cwd, integrationBranch: INTEGRATION_BRANCH });

      assert.isTrue(wrote);
      assert.strictEqual(resolved?.base, INTEGRATION_BRANCH);
      assert.strictEqual(resolved?.source, "configured");
    }).pipe(Effect.provide(TestLayer)),
  );
});

// The whole pull request story rests on the base resolving to the integration
// branch. `resolveBaseBranch` reads exactly one thing before anything else
// (GitManager.ts:1341):
//
//   const configured = yield* gitCore.readConfigValue(cwd, `branch.${branch}.gh-merge-base`);
//   if (configured) return configured;
//
// It is only reachable from inside a pull request step that needs a remote and
// the `gh` CLI, so these assert the exact read it performs, through the same
// driver call, rather than mocking a network round trip.
describe("the base GitManager will read", () => {
  it.effect("is the integration branch for a branch this cut", () =>
    Effect.gen(function* () {
      const service = yield* WorkspaceMemberBranches.WorkspaceMemberBranches;
      const gitCore = yield* GitVcsDriver.GitVcsDriver;
      const { cwd } = yield* makeMemberRepo();
      yield* writeFile(cwd, "changed.md", "uncommitted\n");

      const report = yield* service.ensureFeatureBranch({
        cwd,
        integrationBranch: INTEGRATION_BRANCH,
        threadId: THREAD_ID,
        threadTitle: "Add demo suite",
      });
      const configured = yield* gitCore.readConfigValue(
        cwd,
        memberPrBaseConfigKey(report.branch ?? ""),
      );

      assert.strictEqual(configured, INTEGRATION_BRANCH);
    }).pipe(Effect.provide(TestLayer)),
  );

  // The guard: with the key gone the read returns nothing, so a passing test
  // above cannot be passing for some unrelated reason.
  it.effect("is absent once the key is removed", () =>
    Effect.gen(function* () {
      const service = yield* WorkspaceMemberBranches.WorkspaceMemberBranches;
      const gitCore = yield* GitVcsDriver.GitVcsDriver;
      const { cwd } = yield* makeMemberRepo();
      yield* writeFile(cwd, "changed.md", "uncommitted\n");
      const report = yield* service.ensureFeatureBranch({
        cwd,
        integrationBranch: INTEGRATION_BRANCH,
        threadId: THREAD_ID,
        threadTitle: "Add demo suite",
      });

      yield* git(cwd, ["config", "--unset", memberPrBaseConfigKey(report.branch ?? "")]);
      const configured = yield* gitCore.readConfigValue(
        cwd,
        memberPrBaseConfigKey(report.branch ?? ""),
      );

      assert.strictEqual(configured, null);
    }).pipe(Effect.provide(TestLayer)),
  );
});
