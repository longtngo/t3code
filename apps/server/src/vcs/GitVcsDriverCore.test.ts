import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, describe } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";

import { CheckpointRef, GitCommandError } from "@t3tools/contracts";
import { ServerConfig } from "../config.ts";
import {
  splitNullSeparatedGitStdoutPaths,
  statusUpstreamRefreshBackoff,
} from "./GitVcsDriverCore.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsDriver from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-git-vcs-driver-test-",
});
// Provide both services: GitVcsDriver.GitVcsDriver (raw git via `git()` helper) and
// VcsDriver.VcsDriver (which carries the checkpoint ops under test).
const TestLayer = Layer.mergeAll(GitVcsDriver.vcsLayer, GitVcsDriver.layer).pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const makeTmpDir = (
  prefix = "git-vcs-driver-test-",
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });

const writeTextFile = (
  cwd: string,
  relativePath: string,
  contents: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const filePath = pathService.join(cwd, relativePath);
    yield* fileSystem.makeDirectory(pathService.dirname(filePath), { recursive: true });
    yield* fileSystem.writeFileString(filePath, contents);
  });

const writeSizedFile = (
  cwd: string,
  relativePath: string,
  bytes: number,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const filePath = pathService.join(cwd, relativePath);
    yield* fileSystem.makeDirectory(pathService.dirname(filePath), { recursive: true });
    yield* fileSystem.writeFile(filePath, new Uint8Array(bytes));
  });

const git = (
  cwd: string,
  args: ReadonlyArray<string>,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<string, GitCommandError, GitVcsDriver.GitVcsDriver> =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "GitVcsDriver.test.git",
      cwd,
      args,
      ...(env ? { env } : {}),
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });

const initRepoWithCommit = (
  cwd: string,
): Effect.Effect<
  { readonly initialBranch: string },
  GitCommandError | PlatformError.PlatformError,
  GitVcsDriver.GitVcsDriver | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.initRepo({ cwd });
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* writeTextFile(cwd, "README.md", "# test\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
    const initialBranch = yield* git(cwd, ["branch", "--show-current"]);
    return { initialBranch };
  });

it.layer(TestLayer)("GitVcsDriver core integration", (it) => {
  describe("review diff previews", () => {
    it.effect("drops an unterminated path from truncated NUL-separated git output", () =>
      Effect.sync(() => {
        const paths = splitNullSeparatedGitStdoutPaths({
          stdout: "complete.txt\0partial",
          stdoutTruncated: true,
        });

        assert.deepStrictEqual(paths, ["complete.txt"]);
      }),
    );

    it.effect("keeps the final path when NUL-separated git output is complete", () =>
      Effect.sync(() => {
        const paths = splitNullSeparatedGitStdoutPaths({
          stdout: "complete.txt\0final.txt",
          stdoutTruncated: false,
        });

        assert.deepStrictEqual(paths, ["complete.txt", "final.txt"]);
      }),
    );
  });

  describe("repository status", () => {
    it.effect("reports non-repository directories without failing", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const refs = yield* driver.listRefs({ cwd });
        assert.equal(refs.isRepo, false);
        assert.deepStrictEqual(refs.refs, []);
      }),
    );

    it.effect("reports refName and dirty state for a repository", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, "feature.ts", "export const value = 1;\n");

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

        assert.equal(status.isRepo, true);
        assert.equal(status.branch, initialBranch);
        assert.equal(status.hasWorkingTreeChanges, true);
        assert.include(
          status.workingTree.files.map((file) => file.path),
          "feature.ts",
        );
      }),
    );

    it.effect("reports default-branch delta separately from upstream delta", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(cwd, ["checkout", "-b", "feature/synced"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "feature.txt"]);
        yield* git(cwd, ["commit", "-m", "feature commit"]);
        yield* git(cwd, ["push", "-u", "origin", "feature/synced"]);

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

        assert.equal(status.hasUpstream, true);
        assert.equal(status.aheadCount, 0);
        assert.equal(status.behindCount, 0);
        assert.equal(status.aheadOfDefaultCount, 1);
      }),
    );

    it.effect("disables SSH askpass for background upstream status fetches", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const tempDir = yield* makeTmpDir("git-vcs-driver-ssh-env-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const sshLogPath = pathService.join(tempDir, "ssh-env.txt");
        const sshWrapperPath = pathService.join(tempDir, "ssh-wrapper.sh");
        const previousGitSsh = process.env.GIT_SSH;
        const previousAskpassRequire = process.env.SSH_ASKPASS_REQUIRE;
        const previousAskpassLog = process.env.T3_TEST_SSH_ASKPASS_LOG;

        yield* fileSystem.writeFileString(
          sshWrapperPath,
          [
            "#!/bin/sh",
            'printf "%s\\n" "${SSH_ASKPASS_REQUIRE:-}" > "$T3_TEST_SSH_ASKPASS_LOG"',
            "exit 1",
            "",
          ].join("\n"),
        );
        yield* fileSystem.chmod(sshWrapperPath, 0o755);
        yield* git(cwd, ["remote", "add", "origin", "ssh://example.invalid/repo.git"]);
        yield* git(cwd, ["update-ref", `refs/remotes/origin/${initialBranch}`, "HEAD"]);
        yield* git(cwd, ["branch", "--set-upstream-to", `origin/${initialBranch}`]);

        yield* Effect.gen(function* () {
          process.env.GIT_SSH = sshWrapperPath;
          process.env.SSH_ASKPASS_REQUIRE = "force";
          process.env.T3_TEST_SSH_ASKPASS_LOG = sshLogPath;

          yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

          assert.equal((yield* fileSystem.readFileString(sshLogPath)).trim(), "never");
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (previousGitSsh === undefined) {
                delete process.env.GIT_SSH;
              } else {
                process.env.GIT_SSH = previousGitSsh;
              }
              if (previousAskpassRequire === undefined) {
                delete process.env.SSH_ASKPASS_REQUIRE;
              } else {
                process.env.SSH_ASKPASS_REQUIRE = previousAskpassRequire;
              }
              if (previousAskpassLog === undefined) {
                delete process.env.T3_TEST_SSH_ASKPASS_LOG;
              } else {
                process.env.T3_TEST_SSH_ASKPASS_LOG = previousAskpassLog;
              }
            }),
          ),
        );
      }),
    );

    it.effect("backs a failing upstream fetch off instead of refetching on every status read", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const tempDir = yield* makeTmpDir("git-vcs-driver-backoff-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const fetchLogPath = pathService.join(tempDir, "fetch-calls.txt");
        const sshWrapperPath = pathService.join(tempDir, "ssh-wrapper.sh");
        const previousGitSsh = process.env.GIT_SSH;
        const previousFetchLog = process.env.T3_TEST_FETCH_LOG;

        // A stand-in ssh transport that records every invocation then fails, so a
        // fetch that reaches the remote leaves a countable trace.
        yield* fileSystem.writeFileString(
          sshWrapperPath,
          ["#!/bin/sh", 'printf "call\\n" >> "$T3_TEST_FETCH_LOG"', "exit 1", ""].join("\n"),
        );
        yield* fileSystem.chmod(sshWrapperPath, 0o755);
        yield* git(cwd, ["remote", "add", "origin", "ssh://example.invalid/repo.git"]);
        yield* git(cwd, ["update-ref", `refs/remotes/origin/${initialBranch}`, "HEAD"]);
        yield* git(cwd, ["branch", "--set-upstream-to", `origin/${initialBranch}`]);

        const logMessages: string[] = [];
        const captureLogger = Logger.make(({ message }) => {
          logMessages.push(String(message));
        });

        yield* Effect.gen(function* () {
          process.env.GIT_SSH = sshWrapperPath;
          process.env.T3_TEST_FETCH_LOG = fetchLogPath;
          const driver = yield* GitVcsDriver.GitVcsDriver;
          const fetchInvocations = Effect.gen(function* () {
            const exists = yield* fileSystem.exists(fetchLogPath);
            if (!exists) return 0;
            return (yield* fileSystem.readFileString(fetchLogPath))
              .split("\n")
              .filter((line) => line.length > 0).length;
          });

          // First read triggers the upstream fetch, which the wrapper fails with a
          // non-zero exit.
          yield* driver.statusDetails(cwd);
          const afterFirst = yield* fetchInvocations;
          assert.ok(afterFirst >= 1, "first status read should attempt the upstream fetch");

          // The failed branch (and only it) logs this warning once per outage. A
          // non-zero exit reaching the "refreshed" branch — the pre-fix bug — would
          // log nothing, so this pins the fix end-to-end: a non-zero exit is counted
          // as a failure (which is what puts the entry into the failure backoff,
          // whose 30s→30m curve is covered by the statusUpstreamRefreshBackoff tests).
          assert.isTrue(
            logMessages.some((message) => message.includes("upstreamRefreshFailing")),
            "a failed upstream fetch should log the failing-refresh warning",
          );

          // A second read moments later is served from the cached outcome, so it does
          // not re-hit the remote. (This shows the entry is cached; the failure-vs-
          // success TTL magnitude is asserted separately by the backoff unit tests.)
          yield* driver.statusDetails(cwd);
          const afterSecond = yield* fetchInvocations;
          assert.equal(
            afterSecond,
            afterFirst,
            "the cached outcome should suppress the repeat fetch",
          );
        }).pipe(
          Effect.provide(Logger.layer([captureLogger], { mergeWithExisting: false })),
          Effect.ensuring(
            Effect.sync(() => {
              if (previousGitSsh === undefined) delete process.env.GIT_SSH;
              else process.env.GIT_SSH = previousGitSsh;
              if (previousFetchLog === undefined) delete process.env.T3_TEST_FETCH_LOG;
              else process.env.T3_TEST_FETCH_LOG = previousFetchLog;
            }),
          ),
        );
      }),
    );

    it.effect("reuses the no-upstream fallback ahead count for default-branch delta", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(cwd, ["checkout", "-b", "feature/no-upstream"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "feature.txt"]);
        yield* git(cwd, ["commit", "-m", "feature commit"]);

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

        assert.equal(status.hasUpstream, false);
        assert.equal(status.aheadCount, 1);
        assert.equal(status.behindCount, 0);
        assert.equal(status.aheadOfDefaultCount, 1);
      }),
    );
  });

  describe("refName operations", () => {
    it.effect("creates, checks out, renames, and lists refs", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* driver.createRef({ cwd, refName: "feature/original" });
        const switchRef = yield* driver.switchRef({ cwd, refName: "feature/original" });
        assert.equal(switchRef.refName, "feature/original");

        const renamed = yield* driver.renameBranch({
          cwd,
          oldBranch: "feature/original",
          newBranch: "feature/renamed",
        });
        assert.equal(renamed.branch, "feature/renamed");
        assert.equal(yield* git(cwd, ["branch", "--show-current"]), "feature/renamed");

        const refs = yield* driver.listRefs({ cwd });
        assert.equal(
          refs.refs.find((refName) => refName.name === "feature/renamed")?.current,
          true,
        );
      }),
    );

    it.effect("returns the existing refName when rename source and target match", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const current = yield* git(cwd, ["branch", "--show-current"]);
        const result = yield* driver.renameBranch({
          cwd,
          oldBranch: current,
          newBranch: current,
        });

        assert.equal(result.branch, current);
      }),
    );
  });

  describe("worktree operations", () => {
    it.effect("creates and removes a worktree for a new refName", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const pathService = yield* Path.Path;
        const worktreePath = pathService.join(
          yield* makeTmpDir("git-worktrees-"),
          "feature-worktree",
        );
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const created = yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/worktree",
        });

        assert.equal(created.worktree.path, worktreePath);
        assert.equal(created.worktree.refName, "feature/worktree");
        assert.equal(yield* git(worktreePath, ["branch", "--show-current"]), "feature/worktree");

        yield* driver.removeWorktree({ cwd, path: worktreePath });
        const fileSystem = yield* FileSystem.FileSystem;
        assert.equal(yield* fileSystem.exists(worktreePath), false);
      }),
    );
  });

  describe("commit context", () => {
    it.effect("stages selected files and commits only those files", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* writeTextFile(cwd, "a.txt", "a\n");
        yield* writeTextFile(cwd, "b.txt", "b\n");

        const context = yield* driver.prepareCommitContext(cwd, ["a.txt"]);
        assert.include(context?.stagedSummary ?? "", "a.txt");
        assert.notInclude(context?.stagedSummary ?? "", "b.txt");

        const commit = yield* driver.commit(cwd, "Add a", "");
        assert.match(commit.commitSha, /^[a-f0-9]{40}$/);
        assert.equal(yield* git(cwd, ["log", "-1", "--pretty=%s"]), "Add a");

        const status = yield* git(cwd, ["status", "--porcelain"]);
        assert.include(status, "?? b.txt");
        assert.notInclude(status, "a.txt");
      }),
    );
  });

  describe("remote operations", () => {
    it.effect("pushes with upstream setup and skips when already up to date", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* (yield* GitVcsDriver.GitVcsDriver).createRef({
          cwd,
          refName: "feature/push",
        });
        yield* (yield* GitVcsDriver.GitVcsDriver).switchRef({
          cwd,
          refName: "feature/push",
        });
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* (yield* GitVcsDriver.GitVcsDriver).prepareCommitContext(cwd);
        yield* (yield* GitVcsDriver.GitVcsDriver).commit(cwd, "Add feature", "");

        const pushed = yield* (yield* GitVcsDriver.GitVcsDriver).pushCurrentBranch(cwd, null);
        assert.deepInclude(pushed, {
          status: "pushed",
          branch: "feature/push",
          setUpstream: true,
        });
        assert.equal(
          yield* git(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]),
          "origin/feature/push",
        );

        const skipped = yield* (yield* GitVcsDriver.GitVcsDriver).pushCurrentBranch(cwd, null);
        assert.deepInclude(skipped, {
          status: "skipped_up_to_date",
          branch: "feature/push",
        });
      }),
    );

    it.effect(
      "pushes upstream branches to the remote branch name, not the upstream shorthand",
      () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const remote = yield* makeTmpDir("git-remote-");
          yield* initRepoWithCommit(cwd);
          const driver = yield* GitVcsDriver.GitVcsDriver;
          yield* git(cwd, ["branch", "-M", "main"]);
          yield* git(remote, ["init", "--bare"]);
          yield* git(cwd, ["remote", "add", "origin", remote]);
          yield* git(cwd, ["push", "-u", "origin", "main"]);
          yield* writeTextFile(cwd, "upstream.txt", "upstream\n");
          yield* driver.prepareCommitContext(cwd);
          yield* driver.commit(cwd, "Add upstream update", "");

          const pushed = yield* driver.pushCurrentBranch(cwd, null);

          assert.deepInclude(pushed, {
            status: "pushed",
            branch: "main",
            upstreamBranch: "origin/main",
            setUpstream: false,
          });
          assert.equal(
            yield* git(remote, ["log", "-1", "--pretty=%s", "main"]),
            "Add upstream update",
          );
          const badBranch = yield* driver.execute({
            operation: "GitVcsDriver.test.showBadRemoteBranch",
            cwd: remote,
            args: ["show-ref", "--verify", "--quiet", "refs/heads/origin/main"],
            allowNonZeroExit: true,
            timeoutMs: 10_000,
          });
          assert.notEqual(badBranch.exitCode, 0);
        }),
    );

    it.effect("pushes to the requested remote instead of the primary remote", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const originRemote = yield* makeTmpDir("git-origin-remote-");
        const publishRemote = yield* makeTmpDir("git-publish-remote-");
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(originRemote, ["init", "--bare"]);
        yield* git(publishRemote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", originRemote]);
        yield* git(cwd, ["remote", "add", "origin-1", publishRemote]);

        const pushed = yield* driver.pushCurrentBranch(cwd, null, { remoteName: "origin-1" });

        assert.deepInclude(pushed, {
          status: "pushed",
          branch: "main",
          upstreamBranch: "origin-1/main",
          setUpstream: true,
        });
        assert.equal(
          yield* git(publishRemote, ["log", "-1", "--pretty=%s", "main"]),
          "initial commit",
        );
        const originMain = yield* driver.execute({
          operation: "GitVcsDriver.test.originMainMissing",
          cwd: originRemote,
          args: ["show-ref", "--verify", "--quiet", "refs/heads/main"],
          allowNonZeroExit: true,
          timeoutMs: 10_000,
        });
        assert.notEqual(originMain.exitCode, 0);
      }),
    );
  });

  describe("checkpoint capture index seeding", () => {
    const cpRef = (name: string) => CheckpointRef.make(`refs/t3/checkpoints/${name}`);

    const getCheckpoints = Effect.gen(function* () {
      const vcs = yield* VcsDriver.VcsDriver;
      const checkpoints = vcs.checkpoints;
      if (!checkpoints) {
        throw new Error("git VcsDriver should expose checkpoint ops");
      }
      return checkpoints;
    });

    it.effect("captures modified, untracked, and deleted paths from the working tree", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const checkpoints = yield* getCheckpoints;

        yield* writeTextFile(cwd, "keep.txt", "v1\n");
        yield* git(cwd, ["add", "keep.txt"]);
        yield* git(cwd, ["commit", "-m", "add keep"]);

        yield* writeTextFile(cwd, "keep.txt", "v2\n");
        yield* writeTextFile(cwd, "new.txt", "fresh\n");
        yield* git(cwd, ["rm", "README.md"]);

        const ref = cpRef("seed/working-tree");
        yield* checkpoints.captureCheckpoint({ cwd, checkpointRef: ref });

        assert.equal(yield* git(cwd, ["show", `${ref}:keep.txt`]), "v2");
        assert.equal(yield* git(cwd, ["show", `${ref}:new.txt`]), "fresh");
        const tree = yield* git(cwd, ["ls-tree", "-r", "--name-only", ref]);
        assert.notInclude(tree.split("\n"), "README.md");
      }),
    );

    // Regression guard for the review's correctness finding: when the real index
    // marks a tracked file skip-worktree, `git add -A` would skip it and freeze
    // the checkpoint at the stale INDEX blob. The capture must record DISK content.
    it.effect("captures disk content for skip-worktree files, not the stale index blob", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const checkpoints = yield* getCheckpoints;

        yield* writeTextFile(cwd, "cfg.txt", "committed\n");
        yield* git(cwd, ["add", "cfg.txt"]);
        yield* git(cwd, ["commit", "-m", "add cfg"]);
        yield* git(cwd, ["update-index", "--skip-worktree", "cfg.txt"]);
        yield* writeTextFile(cwd, "cfg.txt", "local-only\n");

        const ref = cpRef("seed/skip-worktree");
        yield* checkpoints.captureCheckpoint({ cwd, checkpointRef: ref });

        assert.equal(yield* git(cwd, ["show", `${ref}:cfg.txt`]), "local-only");
      }),
    );

    it.effect("captures disk content for assume-unchanged files", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const checkpoints = yield* getCheckpoints;

        yield* writeTextFile(cwd, "cfg.txt", "committed\n");
        yield* git(cwd, ["add", "cfg.txt"]);
        yield* git(cwd, ["commit", "-m", "add cfg"]);
        yield* git(cwd, ["update-index", "--assume-unchanged", "cfg.txt"]);
        yield* writeTextFile(cwd, "cfg.txt", "local-only\n");

        const ref = cpRef("seed/assume-unchanged");
        yield* checkpoints.captureCheckpoint({ cwd, checkpointRef: ref });

        assert.equal(yield* git(cwd, ["show", `${ref}:cfg.txt`]), "local-only");
      }),
    );

    it.effect("captures untracked files when the repo has no index yet (fallback)", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const checkpoints = yield* getCheckpoints;
        yield* git(cwd, ["init"]);
        yield* git(cwd, ["config", "user.email", "test@test.com"]);
        yield* git(cwd, ["config", "user.name", "Test"]);
        yield* writeTextFile(cwd, "scratch.txt", "data\n");

        const ref = cpRef("seed/no-index");
        yield* checkpoints.captureCheckpoint({ cwd, checkpointRef: ref });

        assert.isTrue(yield* checkpoints.hasCheckpointRef({ cwd, checkpointRef: ref }));
        assert.equal(yield* git(cwd, ["show", `${ref}:scratch.txt`]), "data");
      }),
    );

    // The fast path (copy the real index) must produce the SAME tree as the old
    // read-tree HEAD seed — the equivalence the whole change rests on.
    it.effect("produces the same tree as a read-tree HEAD seed", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const checkpoints = yield* getCheckpoints;
        const pathService = yield* Path.Path;

        yield* writeTextFile(cwd, "README.md", "# changed\n");
        yield* writeTextFile(cwd, "nested/new.txt", "nested\n");

        const refIndexDir = yield* makeTmpDir("ref-index-");
        const refEnv: NodeJS.ProcessEnv = {
          ...process.env,
          GIT_INDEX_FILE: pathService.join(refIndexDir, "index"),
        };
        yield* git(cwd, ["read-tree", "HEAD"], refEnv);
        yield* git(cwd, ["add", "-A", "--", "."], refEnv);
        const expectedTree = yield* git(cwd, ["write-tree"], refEnv);

        const ref = cpRef("seed/equivalence");
        yield* checkpoints.captureCheckpoint({ cwd, checkpointRef: ref });
        const actualTree = yield* git(cwd, ["rev-parse", `${ref}^{tree}`]);

        assert.equal(actualTree, expectedTree);
      }),
    );

    // Fast path must reconcile to disk: a file staged then edited is captured at
    // its on-disk content, not the staged blob copied in from the real index.
    it.effect("captures disk content for a file modified after staging", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const checkpoints = yield* getCheckpoints;

        yield* writeTextFile(cwd, "f.txt", "staged\n");
        yield* git(cwd, ["add", "f.txt"]);
        yield* writeTextFile(cwd, "f.txt", "modified\n");

        const ref = cpRef("seed/staged-then-modified");
        yield* checkpoints.captureCheckpoint({ cwd, checkpointRef: ref });

        assert.equal(yield* git(cwd, ["show", `${ref}:f.txt`]), "modified");
      }),
    );

    // The index exists (staged file) but there is no HEAD yet: the fast path must
    // still produce a valid root checkpoint, and the partial-copy fallback must not
    // run `git add -A` on a corrupt index.
    it.effect("captures a root checkpoint when the index has staged files but no HEAD", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const checkpoints = yield* getCheckpoints;
        yield* git(cwd, ["init"]);
        yield* git(cwd, ["config", "user.email", "test@test.com"]);
        yield* git(cwd, ["config", "user.name", "Test"]);
        yield* writeTextFile(cwd, "staged.txt", "content\n");
        yield* git(cwd, ["add", "staged.txt"]);

        const ref = cpRef("seed/no-head-staged");
        yield* checkpoints.captureCheckpoint({ cwd, checkpointRef: ref });

        assert.isTrue(yield* checkpoints.hasCheckpointRef({ cwd, checkpointRef: ref }));
        assert.equal(yield* git(cwd, ["show", `${ref}:staged.txt`]), "content");
      }),
    );

    // A linked worktree has its own index under .git/worktrees/<name>/; capture must
    // seed from that, not the main worktree's index (`rev-parse --git-path index`).
    it.effect("captures from a linked worktree using the worktree-correct index", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const pathService = yield* Path.Path;
        const checkpoints = yield* getCheckpoints;

        const worktreeDir = pathService.join(yield* makeTmpDir("linked-wt-"), "wt");
        yield* git(cwd, ["worktree", "add", "-b", "wt-branch", worktreeDir]);
        yield* writeTextFile(worktreeDir, "wt-only.txt", "in-worktree\n");

        const ref = cpRef("seed/worktree");
        yield* checkpoints.captureCheckpoint({ cwd: worktreeDir, checkpointRef: ref });

        assert.equal(yield* git(worktreeDir, ["show", `${ref}:wt-only.txt`]), "in-worktree");
      }),
    );

    // --- Untracked size bound (2026-07-14). Heavy untracked artifacts must be SKIPPED from
    // capture so `git add -A` cannot blow the process timeout, and SYMMETRICALLY must not be
    // deleted by restore's `git clean`. Design: docs/design/2026-07-14-checkpoint-untracked-size-bound.
    const OVER = GitVcsDriver.MAX_UNTRACKED_CHECKPOINT_FILE_BYTES + 4096;
    const UNDER = GitVcsDriver.MAX_UNTRACKED_CHECKPOINT_FILE_BYTES - 4096;

    it.effect("skips an oversized untracked file from the checkpoint tree, keeps small ones", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const checkpoints = yield* getCheckpoints;

        yield* writeSizedFile(cwd, "big.bin", OVER);
        yield* writeTextFile(cwd, "small.txt", "tiny\n");

        const ref = cpRef("bound/skip-oversized");
        yield* checkpoints.captureCheckpoint({ cwd, checkpointRef: ref });

        const tree = (yield* git(cwd, ["ls-tree", "-r", "--name-only", ref])).split("\n");
        assert.notInclude(tree, "big.bin");
        assert.include(tree, "small.txt");
      }),
    );

    // The exact data-loss case the Stage-6 correctness review caught: `git clean -fd` removes a
    // FULLY-UNTRACKED directory wholesale, so a file-level pathspec exclude is silently ignored.
    // Restore must use `git clean -e` (ignore machinery), which descends and preserves the file
    // while still cleaning small untracked siblings.
    it.effect("does not delete an oversized untracked file on restore (fully-untracked subtree)", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const checkpoints = yield* getCheckpoints;
        const fs = yield* FileSystem.FileSystem;
        const p = yield* Path.Path;

        yield* writeSizedFile(cwd, "research/matrices/big.npz", OVER);

        const ref = cpRef("bound/restore-preserves");
        yield* checkpoints.captureCheckpoint({ cwd, checkpointRef: ref });

        const tree = (yield* git(cwd, ["ls-tree", "-r", "--name-only", ref])).split("\n");
        assert.notInclude(tree, "research/matrices/big.npz");

        // A small untracked file created after capture — restore SHOULD clean this one.
        yield* writeTextFile(cwd, "research/matrices/scratch.txt", "junk\n");

        yield* checkpoints.restoreCheckpoint({ cwd, checkpointRef: ref });

        assert.isTrue(
          yield* fs.exists(p.join(cwd, "research/matrices/big.npz")),
          "oversized untracked file must survive restore",
        );
        assert.isFalse(
          yield* fs.exists(p.join(cwd, "research/matrices/scratch.txt")),
          "small untracked file created after capture must be cleaned by restore",
        );
      }),
    );

    it.effect("captures an untracked file just under the threshold", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const checkpoints = yield* getCheckpoints;

        yield* writeSizedFile(cwd, "just-under.bin", UNDER);

        const ref = cpRef("bound/under-threshold");
        yield* checkpoints.captureCheckpoint({ cwd, checkpointRef: ref });

        const tree = (yield* git(cwd, ["ls-tree", "-r", "--name-only", ref])).split("\n");
        assert.include(tree, "just-under.bin");
      }),
    );

    it.effect("still captures a large TRACKED file (bound is untracked-only)", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const checkpoints = yield* getCheckpoints;

        yield* writeSizedFile(cwd, "tracked-big.bin", OVER);
        yield* git(cwd, ["add", "tracked-big.bin"]);
        yield* git(cwd, ["commit", "-m", "add big tracked"]);
        yield* writeSizedFile(cwd, "tracked-big.bin", OVER + 8);

        const ref = cpRef("bound/tracked-large");
        yield* checkpoints.captureCheckpoint({ cwd, checkpointRef: ref });

        const tree = (yield* git(cwd, ["ls-tree", "-r", "--name-only", ref])).split("\n");
        assert.include(tree, "tracked-big.bin");
      }),
    );

    // A '[' in the name breaks a naive gitignore `-e` pattern → parent dir removed wholesale.
    // The `-e` pattern must escape gitignore metacharacters.
    it.effect("skips + preserves an oversized untracked file whose name has a gitignore metachar", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const checkpoints = yield* getCheckpoints;
        const fs = yield* FileSystem.FileSystem;
        const p = yield* Path.Path;

        yield* writeSizedFile(cwd, "research/big[v2].npz", OVER);

        const ref = cpRef("bound/metachar-name");
        yield* checkpoints.captureCheckpoint({ cwd, checkpointRef: ref });
        const tree = (yield* git(cwd, ["ls-tree", "-r", "--name-only", ref])).split("\n");
        assert.notInclude(tree, "research/big[v2].npz");

        yield* checkpoints.restoreCheckpoint({ cwd, checkpointRef: ref });
        assert.isTrue(
          yield* fs.exists(p.join(cwd, "research/big[v2].npz")),
          "metacharacter-named oversized file must survive restore",
        );
      }),
    );

    it.effect("normal repo with no oversized files behaves as before (plain add + clean)", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const checkpoints = yield* getCheckpoints;
        const fs = yield* FileSystem.FileSystem;
        const p = yield* Path.Path;

        yield* writeTextFile(cwd, "a.txt", "a\n");
        yield* writeTextFile(cwd, "dir/b.txt", "b\n");

        const ref = cpRef("bound/normal");
        yield* checkpoints.captureCheckpoint({ cwd, checkpointRef: ref });
        const tree = (yield* git(cwd, ["ls-tree", "-r", "--name-only", ref])).split("\n");
        assert.include(tree, "a.txt");
        assert.include(tree, "dir/b.txt");

        yield* writeTextFile(cwd, "c.txt", "c\n");
        yield* checkpoints.restoreCheckpoint({ cwd, checkpointRef: ref });
        assert.isFalse(
          yield* fs.exists(p.join(cwd, "c.txt")),
          "untracked file created after capture must be cleaned",
        );
        assert.isTrue(yield* fs.exists(p.join(cwd, "a.txt")));
      }),
    );
  });
});

describe("statusUpstreamRefreshBackoff", () => {
  const seconds = (d: Duration.Duration) => Duration.toMillis(d) / 1000;

  it("waits the base delay after the first failure and doubles each subsequent failure", () => {
    assert.equal(seconds(statusUpstreamRefreshBackoff(1)), 30);
    assert.equal(seconds(statusUpstreamRefreshBackoff(2)), 60);
    assert.equal(seconds(statusUpstreamRefreshBackoff(3)), 120);
    assert.equal(seconds(statusUpstreamRefreshBackoff(4)), 240);
  });

  it("caps the backoff at the maximum for a persistently failing remote", () => {
    // 30min cap = 1800s; reached once 30s * 2**n exceeds it.
    assert.equal(seconds(statusUpstreamRefreshBackoff(7)), 1800);
    assert.equal(seconds(statusUpstreamRefreshBackoff(8)), 1800);
    // Never overflows to Infinity even for an absurd failure count.
    const huge = seconds(statusUpstreamRefreshBackoff(1000));
    assert.equal(huge, 1800);
    assert.ok(Number.isFinite(huge));
  });

  it("never decreases as failures accumulate", () => {
    let previous = 0;
    for (let failures = 1; failures <= 40; failures++) {
      const current = seconds(statusUpstreamRefreshBackoff(failures));
      assert.ok(current >= previous, `backoff decreased at failure ${failures}`);
      previous = current;
    }
  });

  it("clamps a non-positive count to the base delay", () => {
    assert.equal(seconds(statusUpstreamRefreshBackoff(0)), 30);
  });
});
