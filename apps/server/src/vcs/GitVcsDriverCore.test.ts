import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, describe } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  CheckpointRef,
  GitCommandError,
  type ReviewDiffFileContentsInput,
} from "@t3tools/contracts";
import { ServerConfig } from "../config.ts";
import {
  makeGitVcsDriverCore,
  splitNullSeparatedGitStdoutPaths,
  statusUpstreamRefreshFailureCooldown,
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

const makeNonRepositoryHandle = () =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(128)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.encodeText(Stream.make("fatal: not a git repository")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

const makeSuccessfulHandle = (stdout: string) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.encodeText(Stream.make(stdout)),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

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

const makeReviewDiffFileContentsInput = (
  cwd: string,
  overrides: Partial<Omit<ReviewDiffFileContentsInput, "cwd">> = {},
): ReviewDiffFileContentsInput => ({
  cwd,
  sourceKind: "working-tree",
  changeType: "change",
  baseRef: "HEAD",
  headRef: null,
  oldPath: "README.md",
  newPath: "README.md",
  ...overrides,
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

it.effect("uses stable diagnostics for every parsed non-repository command", () => {
  const commands: Array<{ readonly args: ReadonlyArray<string>; readonly lcAll?: string }> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      if (!ChildProcess.isStandardCommand(command)) {
        return assert.fail("expected a standard Git command");
      }
      commands.push({
        args: command.args,
        ...(command.options.env?.LC_ALL ? { lcAll: command.options.env.LC_ALL } : {}),
      });
      return makeNonRepositoryHandle();
    }),
  );
  const nodeServicesLayer = Layer.merge(
    NodeServices.layer,
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
  );
  const layer = GitVcsDriver.layer.pipe(
    Layer.provide(ServerConfigLayer),
    Layer.provideMerge(nodeServicesLayer),
  );

  return Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const cwd = "/repo";

    yield* driver.statusDetailsLocal(cwd);
    yield* driver.statusDetailsRemote(cwd, { refreshUpstream: false });
    yield* driver.listRefs({ cwd });

    assert.deepStrictEqual(commands, [
      { args: ["status", "--porcelain=2", "--branch"], lcAll: "C" },
      { args: ["rev-parse", "--abbrev-ref", "HEAD"], lcAll: "C" },
      { args: ["rev-parse", "--git-common-dir"], lcAll: "C" },
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("invalidates origin remote cache when a driver mutation adds origin", () =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const cwd = yield* makeTmpDir();
    const remote = yield* makeTmpDir("git-vcs-driver-remote-");
    yield* initRepoWithCommit(cwd);
    yield* git(remote, ["init", "--bare"]);

    const before = yield* driver.statusDetailsLocal(cwd);
    assert.equal(before.hasOriginRemote, false);

    yield* driver.ensureRemote({ cwd, preferredName: "origin", url: remote });

    const after = yield* driver.statusDetailsLocal(cwd);
    assert.equal(after.hasOriginRemote, true);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("re-reads origin remote status after cache TTL expiry and bypassed invalidation", () =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const cwd = yield* makeTmpDir();
    const remote = yield* makeTmpDir("git-vcs-driver-remote-");
    yield* initRepoWithCommit(cwd);
    yield* git(remote, ["init", "--bare"]);

    // First call caches hasOriginRemote = false (5-min TTL)
    assert.equal((yield* driver.statusDetailsLocal(cwd)).hasOriginRemote, false);

    // Add origin via raw git (bypasses invalidation hook)
    yield* git(cwd, ["remote", "add", "origin", remote]);

    // Cache still has the stale false (TTL not yet expired)
    const stillCached = yield* driver.statusDetailsLocal(cwd);
    assert.equal(stillCached.hasOriginRemote, false);

    // Advance past the 5-minute TTL so the cache entry expires
    yield* TestClock.adjust("6 minutes");

    // After expiry, the next call re-executes and picks up the remote
    const afterExpiry = yield* driver.statusDetailsLocal(cwd);
    assert.equal(afterExpiry.hasOriginRemote, true);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("coalesces concurrent ref pages into one repository snapshot", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawnedArgs = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]);
      const firstWorktreeScanStarted = yield* Deferred.make<void>();
      const remoteNamesScanCompleted = yield* Deferred.make<void>();
      const delayFirstWorktreeScan = yield* Ref.make(true);
      const countingSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            return yield* Effect.die("expected a standard Git command");
          }
          yield* Ref.update(spawnedArgs, (current) => [...current, command.args]);
          const isWorktreeScan =
            command.args.includes("worktree") && command.args.includes("--porcelain");
          const shouldDelay =
            isWorktreeScan && (yield* Ref.getAndSet(delayFirstWorktreeScan, false));
          if (shouldDelay) {
            yield* Deferred.succeed(firstWorktreeScanStarted, undefined);
            yield* Effect.sleep("8 seconds");
          }
          const handle = yield* delegate.spawn(command);
          const isRemoteNamesScan =
            command.args.length === 3 &&
            command.args[0] === "--git-dir" &&
            command.args[2] === "remote";
          return isRemoteNamesScan
            ? ChildProcessSpawner.makeHandle({
                ...handle,
                exitCode: handle.exitCode.pipe(
                  Effect.tap(() => Deferred.succeed(remoteNamesScanCompleted, undefined)),
                ),
              })
            : handle;
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, countingSpawner),
      );
      const cwd = yield* makeTmpDir();
      const runGit = (args: ReadonlyArray<string>) =>
        driver.execute({
          operation: "GitVcsDriver.test.coalescedListRefs",
          cwd,
          args,
          timeoutMs: 10_000,
        });

      yield* driver.initRepo({ cwd });
      yield* runGit(["config", "user.email", "test@test.com"]);
      yield* runGit(["config", "user.name", "Test"]);
      yield* writeTextFile(cwd, "README.md", "# test\n");
      yield* runGit(["add", "."]);
      yield* runGit(["commit", "-m", "initial commit"]);
      yield* Ref.set(spawnedArgs, []);

      const initialRequest = yield* driver
        .listRefs({ cwd, refresh: true, limit: 100 })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(firstWorktreeScanStarted);
      yield* Deferred.await(remoteNamesScanCompleted);
      yield* TestClock.adjust("6 seconds");
      const laterRequests = yield* Effect.all(
        Array.from({ length: 30 }, (_, index) =>
          driver.listRefs({
            cwd,
            refresh: true,
            query: `missing-${index}`,
            limit: 100,
          }),
        ),
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust("2 seconds");
      yield* Fiber.join(initialRequest);
      yield* Fiber.join(laterRequests);
      yield* driver.listRefs({ cwd, cursor: 1, limit: 100 });

      const firstSnapshotCommands = yield* Ref.get(spawnedArgs);
      const snapshotRefScans = firstSnapshotCommands.filter(
        (args) =>
          args.includes("for-each-ref") &&
          args.includes("refs/heads") &&
          args.includes("refs/remotes"),
      );
      const worktreeScans = firstSnapshotCommands.filter(
        (args) => args.includes("worktree") && args.includes("--porcelain"),
      );
      assert.equal(snapshotRefScans.length, 1);
      assert.equal(worktreeScans.length, 1);

      yield* driver.createRef({ cwd, refName: "feature/cache-invalidation" });
      const refreshed = yield* driver.listRefs({ cwd, limit: 100 });
      assert.equal(
        refreshed.refs.some((ref) => ref.name === "feature/cache-invalidation"),
        true,
      );
      const allCommands = yield* Ref.get(spawnedArgs);
      assert.equal(
        allCommands.filter(
          (args) =>
            args.includes("for-each-ref") &&
            args.includes("refs/heads") &&
            args.includes("refs/remotes"),
        ).length,
        2,
      );
    }),
  ).pipe(Effect.provide(ServerConfigLayer.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect("retries an in-flight ref snapshot invalidated by a mutation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const firstWorktreeScanStarted = yield* Deferred.make<void>();
      const firstRefScanCompleted = yield* Deferred.make<void>();
      const releaseFirstWorktreeScan = yield* Deferred.make<void>();
      const delayFirstWorktreeScan = yield* Ref.make(true);
      const refScans = yield* Ref.make(0);
      const coordinatingSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            return yield* Effect.die("expected a standard Git command");
          }
          const isWorktreeScan =
            command.args.includes("worktree") && command.args.includes("--porcelain");
          if (isWorktreeScan && (yield* Ref.getAndSet(delayFirstWorktreeScan, false))) {
            yield* Deferred.succeed(firstWorktreeScanStarted, undefined);
            yield* Deferred.await(releaseFirstWorktreeScan);
          }
          const handle = yield* delegate.spawn(command);
          const isRefScan =
            command.args.includes("for-each-ref") &&
            command.args.includes("refs/heads") &&
            command.args.includes("refs/remotes");
          if (!isRefScan) return handle;
          const scan = yield* Ref.updateAndGet(refScans, (count) => count + 1);
          return scan === 1
            ? ChildProcessSpawner.makeHandle({
                ...handle,
                exitCode: handle.exitCode.pipe(
                  Effect.tap(() => Deferred.succeed(firstRefScanCompleted, undefined)),
                ),
              })
            : handle;
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, coordinatingSpawner),
      );
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver));

      const inFlight = yield* driver
        .listRefs({ cwd, refresh: true, limit: 100 })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(firstWorktreeScanStarted);
      yield* Deferred.await(firstRefScanCompleted);

      yield* driver.createRef({ cwd, refName: "feature/during-refresh" });
      yield* Deferred.succeed(releaseFirstWorktreeScan, undefined);

      const refs = yield* Fiber.join(inFlight);
      assert.isTrue(refs.refs.some((ref) => ref.name === "feature/during-refresh"));
      assert.equal(yield* Ref.get(refScans), 2);
    }),
  ).pipe(Effect.provide(ServerConfigLayer.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect("invalidates a ref snapshot when a mutation fails after changing Git", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const partiallyFailingSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            return yield* Effect.die("expected a standard Git command");
          }
          if (command.args[0] === "branch" && command.args[1] === "feature/partial-failure") {
            const handle = yield* delegate.spawn(command);
            yield* handle.exitCode;
            return makeNonRepositoryHandle();
          }
          return yield* delegate.spawn(command);
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, partiallyFailingSpawner),
      );
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver));
      yield* driver.listRefs({ cwd, refresh: true });

      yield* driver.createRef({ cwd, refName: "feature/partial-failure" }).pipe(Effect.flip);

      const refs = yield* driver.listRefs({ cwd });
      assert.isTrue(refs.refs.some((ref) => ref.name === "feature/partial-failure"));
    }),
  ).pipe(Effect.provide(ServerConfigLayer.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect("fails a ref snapshot when for-each-ref exits unsuccessfully", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const snapshotAttempts = yield* Ref.make(0);
      const failingSnapshotSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            return yield* Effect.die("expected a standard Git command");
          }
          if (command.args.includes("for-each-ref")) {
            yield* Ref.update(snapshotAttempts, (count) => count + 1);
            return makeNonRepositoryHandle();
          }
          return yield* delegate.spawn(command);
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, failingSnapshotSpawner),
      );
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver));

      const error = yield* driver.listRefs({ cwd, refresh: true }).pipe(Effect.flip);

      assert.deepInclude(error, {
        _tag: "GitCommandError",
        operation: "GitVcsDriver.listRefs.snapshotRefs",
        detail: "Git ref snapshot enumeration failed.",
        exitCode: 128,
      });
      assert.equal(yield* Ref.get(snapshotAttempts), 1);
    }),
  ).pipe(Effect.provide(ServerConfigLayer.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect("marks the current branch when worktree metadata is unavailable", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const incompleteMetadataSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            return yield* Effect.die("expected a standard Git command");
          }
          const isWorktreeRoot =
            command.args.includes("rev-parse") && command.args.includes("--show-toplevel");
          const isWorktreeList =
            command.args.includes("worktree") && command.args.includes("--porcelain");
          if (isWorktreeRoot || isWorktreeList) {
            return makeNonRepositoryHandle();
          }
          return yield* delegate.spawn(command);
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, incompleteMetadataSpawner),
      );
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd).pipe(
        Effect.provideService(GitVcsDriver.GitVcsDriver, driver),
      );

      const refs = yield* driver.listRefs({ cwd, refresh: true });

      assert.isTrue(refs.isRepo);
      assert.isTrue(refs.refs.find((ref) => ref.name === initialBranch)?.current);
    }),
  ).pipe(Effect.provide(ServerConfigLayer.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect("ignores worktree metadata for directories that no longer exist", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const missingWorktreePath = "/missing/deleted-worktree";
      const staleWorktreeSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            return yield* Effect.die("expected a standard Git command");
          }
          const isWorktreeList =
            command.args.includes("worktree") && command.args.includes("--porcelain");
          if (isWorktreeList) {
            return makeSuccessfulHandle(
              `worktree ${missingWorktreePath}\0HEAD deadbeef\0branch refs/heads/stale-worktree\0\0`,
            );
          }
          return yield* delegate.spawn(command);
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, staleWorktreeSpawner),
      );
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver));
      yield* git(cwd, ["branch", "stale-worktree"]).pipe(
        Effect.provideService(GitVcsDriver.GitVcsDriver, driver),
      );

      const refs = yield* driver.listRefs({ cwd, refresh: true });

      assert.equal(refs.refs.find((ref) => ref.name === "stale-worktree")?.worktreePath, null);
    }),
  ).pipe(Effect.provide(ServerConfigLayer.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect("refreshes the current branch after an external checkout", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      yield* git(cwd, ["branch", "external-checkout"]);

      const initialRefs = yield* driver.listRefs({ cwd, refresh: true });
      assert.isTrue(initialRefs.refs.find((ref) => ref.name === initialBranch)?.current);

      // Raw execute intentionally bypasses the driver's mutation invalidation,
      // matching a checkout performed by another process.
      yield* driver.execute({
        operation: "GitVcsDriver.test.externalCheckout",
        cwd,
        args: ["checkout", "external-checkout"],
        timeoutMs: 10_000,
      });
      yield* TestClock.adjust("6 seconds");

      const refreshedRefs = yield* driver.listRefs({ cwd, refresh: true });
      assert.isTrue(refreshedRefs.refs.find((ref) => ref.name === "external-checkout")?.current);
      assert.isFalse(refreshedRefs.refs.find((ref) => ref.name === initialBranch)?.current);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("backs off failed upstream refreshes across linked worktrees", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fetchAttempts = yield* Ref.make(0);
      const failingFetchSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            return yield* Effect.die("expected a standard Git command");
          }
          if (command.args.includes("fetch") && command.args.includes("--quiet")) {
            yield* Ref.update(fetchAttempts, (count) => count + 1);
            return makeNonRepositoryHandle();
          }
          return yield* delegate.spawn(command);
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, failingFetchSpawner),
      );
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* makeTmpDir();
      const remote = yield* makeTmpDir("git-vcs-driver-remote-");
      const worktreesRoot = yield* makeTmpDir("git-vcs-driver-worktrees-");
      const pathService = yield* Path.Path;
      const worktreePath = pathService.join(worktreesRoot, "linked");
      const runGit = (workingDirectory: string, args: ReadonlyArray<string>) =>
        driver.execute({
          operation: "GitVcsDriver.test.upstreamRefreshBackoff",
          cwd: workingDirectory,
          args,
          timeoutMs: 10_000,
        });

      yield* driver.initRepo({ cwd });
      yield* runGit(cwd, ["config", "user.email", "test@test.com"]);
      yield* runGit(cwd, ["config", "user.name", "Test"]);
      yield* writeTextFile(cwd, "README.md", "# test\n");
      yield* runGit(cwd, ["add", "."]);
      yield* runGit(cwd, ["commit", "-m", "initial commit"]);
      const initialBranch = (yield* runGit(cwd, ["branch", "--show-current"])).stdout.trim();
      yield* runGit(remote, ["init", "--bare"]);
      yield* runGit(cwd, ["remote", "add", "origin", remote]);
      yield* runGit(cwd, ["push", "-u", "origin", initialBranch]);
      yield* runGit(cwd, ["worktree", "add", "-b", "feature/linked", worktreePath]);
      yield* runGit(worktreePath, [
        "branch",
        "--set-upstream-to",
        `origin/${initialBranch}`,
        "feature/linked",
      ]);
      const rootCommonDir = (yield* runGit(cwd, ["rev-parse", "--git-common-dir"])).stdout.trim();
      const linkedCommonDir = (yield* runGit(worktreePath, [
        "rev-parse",
        "--git-common-dir",
      ])).stdout.trim();
      assert.equal(
        yield* fileSystem.realPath(pathService.resolve(cwd, rootCommonDir)),
        yield* fileSystem.realPath(pathService.resolve(worktreePath, linkedCommonDir)),
      );
      yield* Ref.set(fetchAttempts, 0);

      yield* driver.statusDetailsRemote(cwd);
      yield* driver.statusDetailsRemote(worktreePath);
      assert.equal(yield* Ref.get(fetchAttempts), 1);

      yield* TestClock.adjust("29 seconds");
      yield* driver.statusDetailsRemote(worktreePath);
      assert.equal(yield* Ref.get(fetchAttempts), 1);

      yield* TestClock.adjust("1 second");
      yield* driver.statusDetailsRemote(cwd);
      assert.equal(yield* Ref.get(fetchAttempts), 2);

      yield* TestClock.adjust("59 seconds");
      yield* driver.statusDetailsRemote(worktreePath);
      assert.equal(yield* Ref.get(fetchAttempts), 2);

      yield* TestClock.adjust("1 second");
      yield* driver.statusDetailsRemote(cwd);
      assert.equal(yield* Ref.get(fetchAttempts), 3);
    }),
  ).pipe(Effect.provide(ServerConfigLayer.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.layer(TestLayer)("GitVcsDriver core integration", (it) => {
  describe("process environment", () => {
    it.effect("preserves the caller locale for general Git subprocesses", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();

        const locale = yield* git(
          cwd,
          ["-c", 'alias.print-locale=!printf "%s" "$LC_ALL"', "print-locale"],
          { LC_ALL: "zh_CN.UTF-8" },
        );

        assert.equal(locale, "zh_CN.UTF-8");
      }),
    );
  });

  describe("structured errors", () => {
    it.effect("preserves structured spawn context and the platform cause", () =>
      Effect.gen(function* () {
        const parent = yield* makeTmpDir();
        const pathService = yield* Path.Path;
        const cwd = pathService.join(parent, "missing");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const error = yield* driver
          .execute({
            operation: "GitVcsDriver.test.missingCwd",
            cwd,
            args: ["status", "--short"],
          })
          .pipe(Effect.flip);

        assert.deepInclude(error, {
          _tag: "GitCommandError",
          operation: "GitVcsDriver.test.missingCwd",
          command: "git",
          argumentCount: 2,
          cwd,
          detail: "Failed to spawn Git process.",
        });
        if (!(error.cause instanceof PlatformError.PlatformError)) {
          return assert.fail("expected the original platform error cause");
        }
        assert.equal(error.cause.reason._tag, "NotFound");
        assert.notInclude(error.detail, error.cause.message);
      }),
    );

    it.effect("does not retain git arguments or stderr in command failures", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.initRepo({ cwd });

        const secret = "secret-token-value";
        const error = yield* driver
          .execute({
            operation: "GitVcsDriver.test.redactedFailure",
            cwd,
            args: ["status", `--unknown-option=${secret}`],
          })
          .pipe(Effect.flip);

        assert.deepInclude(error, {
          _tag: "GitCommandError",
          operation: "GitVcsDriver.test.redactedFailure",
          command: "git",
          argumentCount: 2,
          cwd,
        });
        assert.isNumber(error.exitCode);
        assert.isAbove(error.stderrLength ?? 0, 0);
        assert.notInclude(error.detail, secret);
        assert.notInclude(error.message, secret);
        assert.notProperty(error, "args");
        assert.notProperty(error, "stderr");
      }),
    );

    it.effect("recovers a structurally identified missing cwd as a non-repository", () =>
      Effect.gen(function* () {
        const parent = yield* makeTmpDir();
        const pathService = yield* Path.Path;
        const cwd = pathService.join(parent, "missing");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const [localStatus, remoteStatus, refs] = yield* Effect.all([
          driver.statusDetails(cwd),
          driver.statusDetailsRemote(cwd, { refreshUpstream: false }),
          driver.listRefs({ cwd }),
        ]);

        assert.equal(localStatus.isRepo, false);
        assert.equal(remoteStatus.isRepo, false);
        assert.equal(refs.isRepo, false);
        assert.deepStrictEqual(refs.refs, []);
      }),
    );

    it.effect("does not wrap a remove-worktree command failure in a synthetic error", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const pathService = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const notAWorktree = pathService.join(cwd, "not-a-worktree");
        yield* fileSystem.makeDirectory(notAWorktree);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.initRepo({ cwd });

        const error = yield* driver.removeWorktree({ cwd, path: notAWorktree }).pipe(Effect.flip);

        assert.deepInclude(error, {
          _tag: "GitCommandError",
          operation: "GitVcsDriver.removeWorktree",
          command: "git",
          argumentCount: 3,
          cwd,
        });
        assert.notProperty(error, "cause");
        assert.notProperty(error, "stderr");
        assert.notInclude(error.detail, "Git command failed in");
      }),
    );
  });

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

    it.effect("honors whitespace filtering for worktree and branch previews", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["checkout", "-b", "feature/whitespace"]);
        yield* writeTextFile(cwd, "README.md", "#  test\n");
        yield* git(cwd, ["add", "README.md"]);
        yield* git(cwd, ["commit", "-m", "change whitespace"]);
        yield* writeTextFile(cwd, "README.md", "#   test\n");

        const included = yield* driver.getReviewDiffPreview({
          cwd,
          baseRef: initialBranch,
          ignoreWhitespace: false,
        });
        const ignored = yield* driver.getReviewDiffPreview({
          cwd,
          baseRef: initialBranch,
          ignoreWhitespace: true,
        });

        assert.isNotEmpty(included.sources.find((source) => source.kind === "working-tree")?.diff);
        assert.isNotEmpty(included.sources.find((source) => source.kind === "branch-range")?.diff);
        assert.strictEqual(
          ignored.sources.find((source) => source.kind === "working-tree")?.diff,
          "",
        );
        assert.strictEqual(
          ignored.sources.find((source) => source.kind === "branch-range")?.diff,
          "",
        );
      }),
    );

    it.effect("loads full file contents for working-tree diff expansion", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const pathService = yield* Path.Path;
        yield* writeTextFile(cwd, "nested/.keep", "");
        yield* writeTextFile(cwd, "README.md", "# changed\nunchanged context\n");

        const contents = yield* driver.getReviewDiffFileContents(
          makeReviewDiffFileContentsInput(pathService.join(cwd, "nested")),
        );

        assert.strictEqual(contents.oldContents, "# test\n");
        assert.strictEqual(contents.newContents, "# changed\nunchanged context\n");
      }),
    );

    it.effect("attributes working-tree filesystem failures to the failing operation", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const error = yield* driver
          .getReviewDiffFileContents(
            makeReviewDiffFileContentsInput(cwd, {
              changeType: "new",
              oldPath: "missing.ts",
              newPath: "missing.ts",
            }),
          )
          .pipe(Effect.flip);

        assert.deepInclude(error, {
          _tag: "GitCommandError",
          operation: "GitVcsDriver.getReviewDiffFileContents.workingTree.fs.realPath",
          command: "fs.realPath",
          cwd,
          detail: "Could not resolve diff file 'missing.ts'.",
        });
      }),
    );

    it.effect("loads new and deleted files without reading their missing side", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        yield* writeTextFile(cwd, "added.ts", "export const added = true;\n");
        yield* fileSystem.remove(pathService.join(cwd, "README.md"));

        const [added, deleted] = yield* Effect.all([
          driver.getReviewDiffFileContents(
            makeReviewDiffFileContentsInput(cwd, {
              changeType: "new",
              oldPath: "added.ts",
              newPath: "added.ts",
            }),
          ),
          driver.getReviewDiffFileContents(
            makeReviewDiffFileContentsInput(cwd, { changeType: "deleted" }),
          ),
        ]);

        assert.deepStrictEqual(added, {
          oldContents: "",
          newContents: "export const added = true;\n",
        });
        assert.deepStrictEqual(deleted, {
          oldContents: "# test\n",
          newContents: "",
        });
      }),
    );

    it.effect("loads merge-base and head contents for branch diff expansion", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["checkout", "-b", "feature/context"]);
        yield* writeTextFile(cwd, "README.md", "# branch change\nunchanged context\n");
        yield* git(cwd, ["add", "README.md"]);
        yield* git(cwd, ["commit", "-m", "change readme"]);

        const contents = yield* driver.getReviewDiffFileContents(
          makeReviewDiffFileContentsInput(cwd, {
            sourceKind: "branch-range",
            baseRef: initialBranch,
            headRef: "feature/context",
          }),
        );

        assert.strictEqual(contents.oldContents, "# test\n");
        assert.strictEqual(contents.newContents, "# branch change\nunchanged context\n");
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

    it.effect("reports changes to a file named HEAD", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, "HEAD", "first line\n");
        yield* git(cwd, ["add", "HEAD"]);
        yield* git(cwd, ["commit", "-m", "add HEAD file"]);
        yield* writeTextFile(cwd, "HEAD", "first line\nsecond line\n");

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

        assert.equal(status.isRepo, true);
        assert.equal(status.hasWorkingTreeChanges, true);
        assert.deepInclude(status.workingTree.files, {
          path: "HEAD",
          insertions: 1,
          deletions: 0,
        });
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

    it.effect("reports remote divergence without reading working-tree details", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(cwd, ["checkout", "-b", "feature/remote-status"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "feature.txt"]);
        yield* git(cwd, ["commit", "-m", "feature commit"]);
        yield* git(cwd, ["push", "-u", "origin", "feature/remote-status"]);
        yield* writeTextFile(cwd, "untracked.txt", "local-only\n");

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetailsRemote(cwd);

        assert.equal(status.isRepo, true);
        assert.equal(status.branch, "feature/remote-status");
        assert.equal(status.hasUpstream, true);
        assert.equal(status.aheadCount, 0);
        assert.equal(status.behindCount, 0);
        assert.equal(status.aheadOfDefaultCount, 1);
        assert.notProperty(status, "workingTree");
        assert.notProperty(status, "hasWorkingTreeChanges");
      }),
    );

    it.effect("reports remote status on unborn HEAD without failing", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.initRepo({ cwd });
        const initialBranch = yield* git(cwd, ["symbolic-ref", "--short", "HEAD"]);

        const status = yield* driver.statusDetailsRemote(cwd, { refreshUpstream: false });

        assert.equal(status.isRepo, true);
        assert.equal(status.branch, initialBranch);
        assert.equal(status.hasUpstream, false);
        assert.equal(status.aheadCount, 0);
        assert.equal(status.behindCount, 0);
      }),
    );

    it.effect("can read cached remote divergence without fetching upstream", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const updater = yield* makeTmpDir("git-vcs-driver-updater-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);

        yield* git(updater, ["clone", remote, "."]);
        yield* git(updater, ["config", "user.email", "test@test.com"]);
        yield* git(updater, ["config", "user.name", "Test"]);
        yield* writeTextFile(updater, "remote.txt", "remote\n");
        yield* git(updater, ["add", "remote.txt"]);
        yield* git(updater, ["commit", "-m", "remote commit"]);
        yield* git(updater, ["push", "origin", initialBranch]);

        const driver = yield* GitVcsDriver.GitVcsDriver;
        const cachedStatus = yield* driver.statusDetailsRemote(cwd, {
          refreshUpstream: false,
        });
        const refreshedStatus = yield* driver.statusDetailsRemote(cwd);

        assert.equal(cachedStatus.behindCount, 0);
        assert.equal(refreshedStatus.behindCount, 1);
      }),
    );

    it.effect("uses origin HEAD for default-branch detection with a non-origin upstream", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const origin = yield* makeTmpDir("git-vcs-driver-origin-");
        const upstream = yield* makeTmpDir("git-vcs-driver-upstream-");
        yield* initRepoWithCommit(cwd);
        yield* git(origin, ["init", "--bare"]);
        yield* git(upstream, ["init", "--bare"]);
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(cwd, ["remote", "add", "origin", origin]);
        yield* git(cwd, ["remote", "add", "upstream", upstream]);
        yield* git(cwd, ["push", "origin", "main"]);
        yield* git(cwd, ["push", "upstream", "main"]);
        yield* git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
        yield* git(cwd, ["checkout", "-b", "release"]);
        yield* writeTextFile(cwd, "release.txt", "release\n");
        yield* git(cwd, ["add", "release.txt"]);
        yield* git(cwd, ["commit", "-m", "release commit"]);
        yield* git(cwd, ["push", "-u", "upstream", "release"]);
        yield* git(cwd, [
          "symbolic-ref",
          "refs/remotes/upstream/HEAD",
          "refs/remotes/upstream/release",
        ]);

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetailsRemote(cwd);

        assert.equal(status.branch, "release");
        assert.equal(status.upstreamRef, "upstream/release");
        assert.equal(status.isDefaultBranch, false);
      }),
    );

    it.effect("makes background upstream status fetches non-interactive", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const tempDir = yield* makeTmpDir("git-vcs-driver-ssh-env-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const sshLogPath = pathService.join(tempDir, "ssh-env.txt");
        const sshWrapperPath = pathService.join(tempDir, "ssh-wrapper.sh");
        const envKeys = [
          "GCM_INTERACTIVE",
          "GIT_ASKPASS",
          "GIT_SSH",
          "GIT_TERMINAL_PROMPT",
          "SSH_ASKPASS",
          "SSH_ASKPASS_REQUIRE",
          "T3_TEST_SSH_ASKPASS_LOG",
        ] as const;
        const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

        yield* fileSystem.writeFileString(
          sshWrapperPath,
          [
            "#!/bin/sh",
            'printf "GCM_INTERACTIVE=%s\\n" "${GCM_INTERACTIVE:-}" > "$T3_TEST_SSH_ASKPASS_LOG"',
            'printf "GIT_ASKPASS=%s\\n" "${GIT_ASKPASS:-}" >> "$T3_TEST_SSH_ASKPASS_LOG"',
            'printf "GIT_TERMINAL_PROMPT=%s\\n" "${GIT_TERMINAL_PROMPT:-}" >> "$T3_TEST_SSH_ASKPASS_LOG"',
            'printf "SSH_ASKPASS=%s\\n" "${SSH_ASKPASS:-}" >> "$T3_TEST_SSH_ASKPASS_LOG"',
            'printf "SSH_ASKPASS_REQUIRE=%s\\n" "${SSH_ASKPASS_REQUIRE:-}" >> "$T3_TEST_SSH_ASKPASS_LOG"',
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
          process.env.GCM_INTERACTIVE = "always";
          process.env.GIT_ASKPASS = "git-askpass";
          process.env.GIT_TERMINAL_PROMPT = "1";
          process.env.SSH_ASKPASS = "ssh-askpass";
          process.env.SSH_ASKPASS_REQUIRE = "force";
          process.env.T3_TEST_SSH_ASKPASS_LOG = sshLogPath;

          yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

          assert.deepEqual((yield* fileSystem.readFileString(sshLogPath)).trim().split(/\r?\n/), [
            "GCM_INTERACTIVE=never",
            "GIT_ASKPASS=",
            "GIT_TERMINAL_PROMPT=0",
            "SSH_ASKPASS=",
            "SSH_ASKPASS_REQUIRE=never",
          ]);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              for (const key of envKeys) {
                const previous = previousEnv.get(key);
                if (previous === undefined) {
                  delete process.env[key];
                } else {
                  process.env[key] = previous;
                }
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
          // whose 30s→15m curve is covered by the
          // statusUpstreamRefreshFailureCooldown tests).
          assert.isTrue(
            logMessages.some((message) => message.includes("upstreamRefreshFailing")),
            "a failed upstream fetch should log the failing-refresh warning",
          );

          // A second read moments later is served from the cached outcome, so it does
          // not re-hit the remote. (This shows the entry is cached; the failure-vs-
          // success TTL magnitude is asserted separately by the backoff unit tests.)
          const messagesBeforeSecondRead = logMessages.length;
          yield* driver.statusDetails(cwd);
          const afterSecond = yield* fetchInvocations;
          assert.equal(
            afterSecond,
            afterFirst,
            "the cached outcome should suppress the repeat fetch",
          );

          // Backoff suppresses the repeat FETCH. It does not, on its own, suppress
          // the repeat LOG: if the loader fails rather than returning an outcome,
          // the cache stores a failed Exit, every read re-propagates it, and
          // `Effect.ignoreCause({ log: true })` prints the whole cause again -- for
          // the entire cooldown, which reaches 15 minutes. That is what produced
          // 40,000+ identical stack traces and a 128 MB server.log while the fetch
          // itself was correctly backing off.
          assert.equal(
            logMessages.length,
            messagesBeforeSecondRead,
            "a read served from the cached failure must not re-log it",
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

    it.effect("reports combined staged and unstaged edits to the same file", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, "feature.ts", "// line one\n");
        yield* git(cwd, ["add", "feature.ts"]);
        yield* git(cwd, ["commit", "-m", "add feature"]);
        yield* writeTextFile(cwd, "feature.ts", "// line one\n// line two\n");
        yield* git(cwd, ["add", "feature.ts"]);
        yield* writeTextFile(cwd, "feature.ts", "// line one\n// line two\n// line three\n");

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

        assert.equal(status.isRepo, true);
        assert.equal(status.hasWorkingTreeChanges, true);
        const file = status.workingTree.files.find((f) => f.path === "feature.ts");
        assert.ok(file);
        // HEAD has 1 line. Staged has 2 lines (+1). Unstaged has 3 lines (+2 from HEAD).
        // Combined net from HEAD: +2 insertions.
        assert.equal(file.insertions, 2);
        assert.equal(file.deletions, 0);
      }),
    );

    it.effect("reports staged file counts on unborn HEAD without failing", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.initRepo({ cwd });
        yield* git(cwd, ["config", "user.email", "test@test.com"]);
        yield* git(cwd, ["config", "user.name", "Test"]);
        yield* writeTextFile(cwd, "initial.ts", "// first file\n");
        yield* git(cwd, ["add", "initial.ts"]);

        const status = yield* driver.statusDetails(cwd);

        assert.equal(status.isRepo, true);
        assert.equal(status.workingTree.files.length, 1);
        const file = status.workingTree.files[0];
        if (file) {
          assert.equal(file.path, "initial.ts");
          assert.equal(file.insertions, 1);
        }
      }),
    );
  });

  describe("refName operations", () => {
    it.effect("optionally includes remote refs that match local branches", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const deduplicated = yield* driver.listRefs({ cwd });
        assert.equal(
          deduplicated.refs.some((ref) => ref.name === `origin/${initialBranch}`),
          false,
        );

        const complete = yield* driver.listRefs({ cwd, includeMatchingRemoteRefs: true });
        assert.equal(
          complete.refs.some((ref) => ref.name === initialBranch),
          true,
        );
        assert.equal(
          complete.refs.some((ref) => ref.name === `origin/${initialBranch}`),
          true,
        );

        const remoteOnly = yield* driver.listRefs({
          cwd,
          includeMatchingRemoteRefs: true,
          refKind: "remote",
          limit: 1,
        });
        assert.equal(remoteOnly.refs.length, 1);
        assert.equal(remoteOnly.refs[0]?.name, `origin/${initialBranch}`);
        assert.equal(remoteOnly.refs[0]?.isRemote, true);
      }),
    );

    it.effect("marks the origin default ref as default when no local copy exists", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(cwd, ["remote", "set-head", "origin", initialBranch]);
        yield* git(cwd, ["checkout", "-b", "feature/only-local"]);
        yield* git(cwd, ["branch", "-D", initialBranch]);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const refs = yield* driver.listRefs({ cwd });
        const remoteDefault = refs.refs.find((ref) => ref.name === `origin/${initialBranch}`);
        assert.equal(remoteDefault?.isRemote, true);
        assert.equal(remoteDefault?.isDefault, true);
      }),
    );

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
    it.effect("preserves newline characters in worktree paths when listing refs", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const worktreesRoot = yield* makeTmpDir("git-vcs-driver-worktrees-");
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const worktreePath = pathService.join(worktreesRoot, "linked\nworktree");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* git(cwd, ["worktree", "add", "-b", "feature/newline-path", worktreePath]);

        const refs = yield* driver.listRefs({ cwd, refresh: true });
        const listedPath = refs.refs.find(
          (ref) => ref.name === "feature/newline-path",
        )?.worktreePath;

        if (typeof listedPath !== "string") {
          return assert.fail("expected the linked branch to include its worktree path");
        }
        assert.equal(
          yield* fileSystem.realPath(listedPath),
          yield* fileSystem.realPath(worktreePath),
        );
      }),
    );

    it.effect("checks out submodules in a new worktree", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;

        // Git refuses `file:` submodule transports by default (CVE-2022-39253)
        // and ignores repo-level config for it, so a local fixture needs the
        // env allowance. Real submodules are https/ssh and need none of this.
        const previousAllowedProtocol = process.env.GIT_ALLOW_PROTOCOL;
        process.env.GIT_ALLOW_PROTOCOL = "file";
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (previousAllowedProtocol === undefined) {
              delete process.env.GIT_ALLOW_PROTOCOL;
            } else {
              process.env.GIT_ALLOW_PROTOCOL = previousAllowedProtocol;
            }
          }),
        );

        // A real submodule: `git worktree add` leaves these empty, which is
        // what silently strips shared tooling out of every new worktree.
        const submoduleRepo = yield* makeTmpDir("git-submodule-");
        yield* initRepoWithCommit(submoduleRepo);
        yield* writeTextFile(submoduleRepo, "SHARED.md", "# shared\n");
        yield* git(submoduleRepo, ["add", "."]);
        yield* git(submoduleRepo, ["commit", "-m", "shared"]);

        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["submodule", "add", submoduleRepo, "shared"]);
        yield* git(cwd, ["commit", "-m", "add submodule"]);

        const worktreePath = pathService.join(
          yield* makeTmpDir("git-worktrees-"),
          "submodule-worktree",
        );
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/submodules",
        });

        assert.equal(
          yield* fileSystem.exists(pathService.join(worktreePath, "shared", "SHARED.md")),
          true,
        );
      }),
    );

    it.effect("still creates the worktree when submodule checkout fails", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;

        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        // Points at a repository that does not exist, so the checkout fails the
        // way an unreachable private remote would. Creation must still succeed.
        yield* writeTextFile(
          cwd,
          ".gitmodules",
          '[submodule "missing"]\n\tpath = missing\n\turl = /nonexistent/repo.git\n',
        );
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "add unreachable submodule"]);

        const worktreePath = pathService.join(
          yield* makeTmpDir("git-worktrees-"),
          "broken-submodule-worktree",
        );
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const created = yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/broken-submodules",
        });

        assert.equal(created.worktree.path, worktreePath);
        assert.equal(yield* fileSystem.exists(worktreePath), true);
      }),
    );

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

    it.effect("removes the same worktree path twice without failing", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const pathService = yield* Path.Path;
        const worktreePath = pathService.join(yield* makeTmpDir("git-worktrees-"), "shared");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/shared",
        });

        // Two threads can record the same worktree path; the second delete
        // must be a no-op instead of exit 128.
        yield* driver.removeWorktree({ cwd, path: worktreePath });
        yield* driver.removeWorktree({ cwd, path: worktreePath });
      }),
    );

    it.effect("prunes stale registrations when removing an already-gone worktree", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const pathService = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const worktreesRoot = yield* makeTmpDir("git-worktrees-");
        const stalePath = pathService.join(worktreesRoot, "stale");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* driver.createWorktree({
          cwd,
          path: stalePath,
          refName: initialBranch,
          newRefName: "feature/stale",
        });
        // Delete the directory behind git's back so the registration goes stale.
        yield* fileSystem.remove(stalePath, { recursive: true });

        yield* driver.removeWorktree({
          cwd,
          path: pathService.join(worktreesRoot, "never-registered"),
        });

        const registered = yield* git(cwd, ["worktree", "list", "--porcelain"]);
        assert.notInclude(registered, "stale");
      }),
    );
  });

  describe("remote operations", () => {
    it.effect("ensureRemote reuses an existing remote across ssh/https transport variants", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* git(cwd, ["remote", "add", "origin", "https://github.com/pingdotgg/t3code.git"]);

        const reusedForSsh = yield* driver.ensureRemote({
          cwd,
          preferredName: "pingdotgg",
          url: "git@github.com:pingdotgg/t3code.git",
        });
        assert.equal(reusedForSsh, "origin");

        const reusedForSshScheme = yield* driver.ensureRemote({
          cwd,
          preferredName: "pingdotgg",
          url: "ssh://git@github.com/pingdotgg/t3code",
        });
        assert.equal(reusedForSshScheme, "origin");

        const reusedForBareSshScheme = yield* driver.ensureRemote({
          cwd,
          preferredName: "pingdotgg",
          url: "ssh://github.com/pingdotgg/t3code",
        });
        assert.equal(reusedForBareSshScheme, "origin");

        const reusedForSshPort = yield* driver.ensureRemote({
          cwd,
          preferredName: "pingdotgg",
          url: "ssh://git@github.com:22/pingdotgg/t3code",
        });
        assert.equal(reusedForSshPort, "origin");

        const reusedForSshWithPort = yield* driver.ensureRemote({
          cwd,
          preferredName: "pingdotgg",
          url: "ssh://git@github.com:22/pingdotgg/t3code.git",
        });
        assert.equal(reusedForSshWithPort, "origin");

        const addedForFork = yield* driver.ensureRemote({
          cwd,
          preferredName: "octocat",
          url: "git@github.com:octocat/t3code.git",
        });
        assert.equal(addedForFork, "octocat");
        assert.equal(yield* git(cwd, ["remote"]), "octocat\norigin");
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

    it.effect("treats selected file paths literally", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* writeTextFile(cwd, "selected[1].txt", "literal\n");
        yield* writeTextFile(cwd, "selected1.txt", "pattern match\n");

        yield* driver.prepareCommitContext(cwd, ["selected[1].txt"]);

        assert.equal(yield* git(cwd, ["diff", "--cached", "--name-only"]), "selected[1].txt");

        const status = yield* git(cwd, ["status", "--porcelain"]);
        assert.include(status, "?? selected1.txt");
      }),
    );
  });

  describe("remote operations", () => {
    it.effect("creates a worktree from the latest fetched remote commit", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        const peer = yield* makeTmpDir("git-peer-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(remote, ["symbolic-ref", "HEAD", `refs/heads/${initialBranch}`]);
        const beforeFetch = yield* git(cwd, ["rev-parse", `refs/remotes/origin/${initialBranch}`]);

        yield* git(peer, ["clone", remote, "."]);
        yield* git(peer, ["config", "user.email", "test@test.com"]);
        yield* git(peer, ["config", "user.name", "Test"]);
        yield* writeTextFile(peer, "remote-change.txt", "remote\n");
        yield* git(peer, ["add", "remote-change.txt"]);
        yield* git(peer, ["commit", "-m", "remote change"]);
        yield* git(peer, ["push", "origin", initialBranch]);
        const remoteHead = yield* git(peer, ["rev-parse", "HEAD"]);
        assert.notEqual(beforeFetch, remoteHead);

        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.fetchRemote({ cwd, remoteName: "origin" });

        const resolvedBase = yield* driver.resolveRemoteTrackingCommit({
          cwd,
          refName: initialBranch,
          fallbackRemoteName: "origin",
        });
        const explicitlyResolvedBase = yield* driver.resolveRemoteTrackingCommit({
          cwd,
          refName: `origin/${initialBranch}`,
          fallbackRemoteName: "origin",
        });

        assert.deepEqual(resolvedBase, {
          commitSha: remoteHead,
          remoteRefName: `origin/${initialBranch}`,
        });
        assert.deepEqual(explicitlyResolvedBase, resolvedBase);
        assert.equal(yield* git(cwd, ["rev-parse", initialBranch]), beforeFetch);

        const pathService = yield* Path.Path;
        const worktreePath = pathService.join(
          yield* makeTmpDir("git-fetched-worktrees-"),
          "fetched-origin",
        );
        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: resolvedBase.commitSha,
          newRefName: "t3code/fetched-origin",
          baseRefName: resolvedBase.remoteRefName,
        });

        assert.equal(yield* git(worktreePath, ["rev-parse", "HEAD"]), remoteHead);
        assert.equal(
          yield* driver.readConfigValue(worktreePath, "branch.t3code/fetched-origin.gh-merge-base"),
          initialBranch,
        );
        assert.equal(
          yield* driver.readConfigValue(worktreePath, "branch.t3code/fetched-origin.remote"),
          null,
        );
        const status = yield* driver.statusDetails(worktreePath);
        assert.equal(status.aheadCount, 0);
        assert.equal(status.aheadOfDefaultCount, 0);
      }),
    );

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

    it.effect("allows pushes to run longer than the default command timeout", () =>
      Effect.gen(function* () {
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const pushStarted = yield* Deferred.make<void>();
        const delayedPushSpawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (ChildProcess.isStandardCommand(command) && command.args[0] === "push") {
              yield* Deferred.succeed(pushStarted, undefined);
              yield* Effect.sleep("31 seconds");
            }
            return yield* delegate.spawn(command);
          }),
        );
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, delayedPushSpawner),
          Effect.provide(ServerConfigLayer),
        );
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);

        const pushing = yield* driver
          .pushCurrentBranch(cwd, null)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(pushStarted);
        yield* TestClock.adjust("31 seconds");
        const pushed = yield* Fiber.join(pushing);

        assert.deepInclude(pushed, {
          status: "pushed",
          setUpstream: true,
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

    it.effect("publishes a branch tracking its base under its own name, not the base", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", "main"]);
        yield* git(cwd, ["checkout", "-b", "dev"]);
        yield* git(cwd, ["push", "-u", "origin", "dev"]);
        const devSha = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* git(cwd, ["checkout", "-b", "feature/x", "origin/dev"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* driver.prepareCommitContext(cwd);
        yield* driver.commit(cwd, "Add feature", "");

        const pushed = yield* driver.pushCurrentBranch(cwd, null);

        assert.deepInclude(pushed, {
          status: "pushed",
          branch: "feature/x",
          upstreamBranch: "origin/feature/x",
          setUpstream: true,
        });
        assert.equal(yield* git(remote, ["log", "-1", "--pretty=%s", "feature/x"]), "Add feature");
        assert.equal(yield* git(remote, ["rev-parse", "dev"]), devSha);
        assert.equal(
          yield* git(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]),
          "origin/feature/x",
        );
        assert.equal(yield* driver.readConfigValue(cwd, "branch.feature/x.gh-merge-base"), "dev");
      }),
    );

    it.effect("keeps a recorded merge base when publishing a tracked branch", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", "main"]);
        yield* git(cwd, ["checkout", "-b", "feature/y", "origin/main"]);
        yield* git(cwd, ["config", "branch.feature/y.gh-merge-base", "release/v2"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* driver.prepareCommitContext(cwd);
        yield* driver.commit(cwd, "Add feature", "");

        const pushed = yield* driver.pushCurrentBranch(cwd, null);

        assert.deepInclude(pushed, {
          status: "pushed",
          branch: "feature/y",
          upstreamBranch: "origin/feature/y",
          setUpstream: true,
        });
        assert.equal(
          yield* driver.readConfigValue(cwd, "branch.feature/y.gh-merge-base"),
          "release/v2",
        );
      }),
    );

    it.effect("still pushes a git-mangled tracking alias to its upstream head", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "my-org/upstream", remote]);
        yield* git(cwd, ["push", "my-org/upstream", "main:effect-atom"]);
        yield* git(cwd, ["fetch", "my-org/upstream"]);
        // `checkout --track my-org/upstream/effect-atom` cannot name the local
        // branch `effect-atom`, so git keeps `upstream/effect-atom`. Its
        // upstream is still its published head.
        yield* git(cwd, ["checkout", "--track", "my-org/upstream/effect-atom"]);
        assert.equal(
          yield* git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
          "upstream/effect-atom",
        );
        yield* writeTextFile(cwd, "alias.txt", "alias\n");
        yield* driver.prepareCommitContext(cwd);
        yield* driver.commit(cwd, "Add alias update", "");

        const pushed = yield* driver.pushCurrentBranch(cwd, null);

        assert.deepInclude(pushed, {
          status: "pushed",
          branch: "upstream/effect-atom",
          upstreamBranch: "my-org/upstream/effect-atom",
          setUpstream: false,
        });
        assert.equal(
          yield* git(remote, ["log", "-1", "--pretty=%s", "effect-atom"]),
          "Add alias update",
        );
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
    it.effect(
      "does not delete an oversized untracked file on restore (fully-untracked subtree)",
      () =>
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
    it.effect(
      "skips + preserves an oversized untracked file whose name has a gitignore metachar",
      () =>
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

describe("statusUpstreamRefreshFailureCooldown", () => {
  const seconds = (d: Duration.Duration) => Duration.toMillis(d) / 1000;

  it("waits the base delay after the first failure and doubles each subsequent failure", () => {
    assert.equal(seconds(statusUpstreamRefreshFailureCooldown(1)), 30);
    assert.equal(seconds(statusUpstreamRefreshFailureCooldown(2)), 60);
    assert.equal(seconds(statusUpstreamRefreshFailureCooldown(3)), 120);
    assert.equal(seconds(statusUpstreamRefreshFailureCooldown(4)), 240);
  });

  it("caps the backoff at the maximum for a persistently failing remote", () => {
    // 15min cap = 900s; reached once 30s * 2**n exceeds it.
    assert.equal(seconds(statusUpstreamRefreshFailureCooldown(6)), 900);
    assert.equal(seconds(statusUpstreamRefreshFailureCooldown(7)), 900);
    // Never overflows to Infinity even for an absurd failure count.
    const huge = seconds(statusUpstreamRefreshFailureCooldown(1000));
    assert.equal(huge, 900);
    assert.ok(Number.isFinite(huge));
  });

  it("never decreases as failures accumulate", () => {
    let previous = 0;
    for (let failures = 1; failures <= 40; failures++) {
      const current = seconds(statusUpstreamRefreshFailureCooldown(failures));
      assert.ok(current >= previous, `cooldown decreased at failure ${failures}`);
      previous = current;
    }
  });

  it("clamps a non-positive count to the base delay", () => {
    assert.equal(seconds(statusUpstreamRefreshFailureCooldown(0)), 30);
  });
});
