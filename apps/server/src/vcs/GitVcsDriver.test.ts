import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";
import { assert, it } from "@effect/vitest";

import { CheckpointRef, GitCommandError } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";
import { runVcsDriverContractSuite } from "./testing/VcsDriverContractHarness.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-git-vcs-contract-",
});
const GitContractLayer = Layer.mergeAll(GitVcsDriver.vcsLayer, GitVcsDriver.layer).pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const runGit = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.execute({
      operation: "GitVcsDriver.contract.git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
  });

type GitContractError = GitCommandError | PlatformError.PlatformError;

runVcsDriverContractSuite<GitVcsDriver.GitVcsDriver, GitContractError>({
  name: "Git",
  kind: "git",
  layer: GitContractLayer,
  fixture: {
    createRepo: (cwd) =>
      Effect.gen(function* () {
        yield* runGit(cwd, ["init"]);
        yield* runGit(cwd, ["config", "user.email", "test@test.com"]);
        yield* runGit(cwd, ["config", "user.name", "Test"]);
      }),
    writeFile: (cwd, relativePath, contents) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const absolutePath = path.join(cwd, relativePath);
        yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
        yield* fileSystem.writeFileString(absolutePath, contents);
      }),
    trackFile: (cwd, relativePath) => runGit(cwd, ["add", relativePath]),
    commit: (cwd, message) => runGit(cwd, ["commit", "-m", message]),
    ignorePath: (cwd, pattern) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.writeFileString(path.join(cwd, ".gitignore"), `${pattern}\n`);
      }),
  },
});

// Real clock, real git: the pull has to be genuinely in flight, holding
// `.git/index.lock`, at the moment it is interrupted.
it.live(
  "an interrupted pull leaves no index.lock behind and does not move HEAD",
  () =>
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-git-interrupt-" });
      const upstream = path.join(root, "upstream");
      const clone = path.join(root, "clone");
      yield* fileSystem.makeDirectory(upstream);

      // Upstream: a base commit the clone will sit on, then a commit that adds
      // many files. `.gitattributes` is in the BASE commit so the clone already
      // routes every file through the filter configured below.
      yield* runGit(upstream, ["init", "-q", "-b", "main"]);
      yield* runGit(upstream, ["config", "user.email", "test@test.com"]);
      yield* runGit(upstream, ["config", "user.name", "Test"]);
      yield* fileSystem.writeFileString(path.join(upstream, ".gitattributes"), "* filter=slow\n");
      yield* runGit(upstream, ["add", ".gitattributes"]);
      yield* runGit(upstream, ["commit", "-q", "-m", "base"]);
      for (let index = 0; index < 60; index += 1) {
        yield* fileSystem.writeFileString(path.join(upstream, `file-${index}.txt`), `${index}\n`);
      }
      yield* runGit(upstream, ["add", "."]);
      yield* runGit(upstream, ["commit", "-q", "-m", "many files"]);

      // Clone at the tip, then step back so the pull has real work to do. A smudge
      // filter that sleeps per file makes the checkout - the part of the pull that
      // holds index.lock - take seconds instead of milliseconds, deterministically.
      yield* runGit(root, ["clone", "-q", `file://${upstream}`, clone]);
      yield* runGit(clone, ["config", "filter.slow.smudge", "sleep 0.1; cat"]);
      yield* runGit(clone, ["reset", "-q", "--hard", "HEAD~1"]);
      const before = yield* driver.readHeadSha(clone);
      assert.isString(before);

      const lockPath = path.join(clone, ".git", "index.lock");
      const pull = yield* driver.pullCurrentBranch(clone).pipe(Effect.forkChild);

      // Positive control: the lock is really held before we interrupt. Without this
      // the assertions below would pass on a pull that simply never started.
      let lockSeen = false;
      for (let attempt = 0; attempt < 2_000 && !lockSeen; attempt += 1) {
        lockSeen = yield* fileSystem.exists(lockPath);
        if (!lockSeen) yield* Effect.sleep("5 millis");
      }
      assert.isTrue(lockSeen, "the pull never took index.lock, so nothing was interrupted");

      yield* Fiber.interrupt(pull);

      assert.isFalse(yield* fileSystem.exists(lockPath), "index.lock was left behind");
      assert.isFalse(yield* fileSystem.exists(path.join(clone, ".git", "MERGE_HEAD")));
      // Unmoved HEAD is what separates "interrupted" from "left to finish on its own".
      assert.strictEqual(yield* driver.readHeadSha(clone), before);
    }).pipe(Effect.provide(GitContractLayer)),
  30_000,
);

// Real clock, real spawner, and a `git` that ignores SIGTERM. This pins
// `FORCE_KILL_AFTER`: without it the release finalizer waits on a wedged git
// forever, and the command timeout that was meant to bound it never resolves.
it.live(
  "a git that ignores SIGTERM is still reaped, so its command timeout resolves",
  () =>
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-git-wedged-" });
      const shimDir = path.join(root, "bin");
      yield* fileSystem.makeDirectory(shimDir);
      const pidFile = path.join(root, "git.pid");
      // The loop matters: a group SIGTERM kills an untrapped `sleep` child, and a
      // shell whose only child died would fall through and exit on its own.
      yield* fileSystem.writeFileString(
        path.join(shimDir, "git"),
        `#!/bin/sh\necho $$ > "${pidFile}"\ntrap "" TERM\nwhile true; do sleep 0.2; done\n`,
      );
      yield* fileSystem.chmod(path.join(shimDir, "git"), 0o755);

      // Live clock under `it.live`: the wall time is the whole measurement.
      const startedAt = yield* Clock.currentTimeMillis;
      const exit = yield* driver
        .execute({
          operation: "GitVcsDriver.test.wedged",
          cwd: root,
          args: ["status"],
          timeoutMs: 500,
          env: { PATH: `${shimDir}:${process.env.PATH ?? ""}` },
        })
        .pipe(Effect.exit);
      const elapsedMs = (yield* Clock.currentTimeMillis) - startedAt;

      assert.isTrue(Exit.isFailure(exit), "a wedged git must surface as a failed command");
      // The command timeout (0.5s) plus the SIGTERM grace, with slack for a busy
      // host. Well under the 30s a plain timeout would sit at, and nowhere near
      // the forever it sits at without the escalation.
      assert.isBelow(elapsedMs, 15_000, `took ${elapsedMs}ms: the escalation did not fire`);

      const pid = Number((yield* fileSystem.readFileString(pidFile)).trim());
      assert.isTrue(Number.isInteger(pid) && pid > 0, "the shim never reported its pid");
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      assert.isFalse(alive, `git shim ${pid} survived the escalation`);
    }).pipe(Effect.provide(GitContractLayer)),
  30_000,
);

it("copiedIndexStampSeconds never stamps a copied index later than its source", () => {
  // A source whose nanosecond tail Node rounded UP to the next millisecond, and so to a
  // whole second: a plain `Math.floor(ms / 1000)` returns 1787760001 here, one second
  // LATER than the real mtime. That is the value that reopens the stale capture.
  assert.equal(GitVcsDriver.copiedIndexStampSeconds(1787760001000), 1787760000);
  // Ordinary sub-second value: the second it belongs to.
  assert.equal(GitVcsDriver.copiedIndexStampSeconds(1787760000500), 1787760000);
  // Exactly on a second: one second early, which only makes more entries look racy.
  assert.equal(GitVcsDriver.copiedIndexStampSeconds(1787760000000), 1787759999);
});

it.effect("restores empty checkpoints without changing paths outside the workspace", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    for (const nested of [false, true]) {
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-empty-checkpoint-" });
      yield* runGit(root, ["init"]);
      yield* runGit(root, ["config", "user.email", "test@test.com"]);
      yield* runGit(root, ["config", "user.name", "Test"]);
      if (nested) {
        yield* fileSystem.writeFileString(path.join(root, "outside.txt"), "original\n");
        yield* runGit(root, ["add", "."]);
      }
      yield* runGit(root, ["commit", "--allow-empty", "-m", "initial"]);
      const cwd = nested ? path.join(root, "nested") : root;
      yield* fileSystem.makeDirectory(cwd, { recursive: true });
      const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/empty");
      yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });
      if (nested) {
        yield* fileSystem.writeFileString(path.join(root, "outside.txt"), "changed\n");
        yield* runGit(root, ["add", "outside.txt"]);
      }
      for (const staged of [false, true]) {
        const addedPath = path.join(cwd, "added.txt");
        yield* fileSystem.writeFileString(addedPath, "new\n");
        if (staged) yield* runGit(cwd, ["add", "added.txt"]);
        assert.isTrue(
          yield* driver.checkpoints.restoreCheckpoint({
            cwd,
            checkpointRef,
            fallbackToHead: false,
          }),
        );
        assert.isFalse(yield* fileSystem.exists(addedPath));
      }
      yield* fileSystem.writeFileString(
        path.join(root, ".git", "info", "exclude"),
        "ignored.txt\n",
      );
      yield* fileSystem.writeFileString(path.join(cwd, "ignored.txt"), "keep\n");
      yield* fileSystem.makeDirectory(path.join(cwd, "untracked"));
      yield* fileSystem.writeFileString(path.join(cwd, "untracked", "file.txt"), "remove\n");
      assert.isTrue(
        yield* driver.checkpoints.restoreCheckpoint({ cwd, checkpointRef, fallbackToHead: false }),
      );
      assert.strictEqual(yield* fileSystem.readFileString(path.join(cwd, "ignored.txt")), "keep\n");
      assert.isFalse(yield* fileSystem.exists(path.join(cwd, "untracked")));
      if (nested) {
        assert.strictEqual(
          yield* fileSystem.readFileString(path.join(root, "outside.txt")),
          "changed\n",
        );
        const staged = yield* driver.execute({
          operation: "test",
          cwd: root,
          args: ["diff", "--cached", "--name-only"],
        });
        assert.strictEqual(staged.stdout.trim(), "outside.txt");
      }
    }
  }).pipe(Effect.scoped, Effect.provide(GitContractLayer)),
);

it.effect("GitVcsDriver forwards execute env to the VCS process", () => {
  let observedEnv: NodeJS.ProcessEnv | undefined;
  let observedAppendTruncationMarker: boolean | undefined;
  let observedOutputMode: VcsProcess.VcsProcessInput["outputMode"];

  return Effect.gen(function* () {
    const driver = yield* GitVcsDriver.makeVcsDriverShape();

    yield* driver.execute({
      operation: "GitVcsDriver.test.env",
      cwd: "/repo",
      args: ["status"],
      env: {
        GIT_INDEX_FILE: "/tmp/t3-index",
      },
      appendTruncationMarker: true,
      outputMode: "error",
    });

    assert.deepStrictEqual(observedEnv, {
      GIT_INDEX_FILE: "/tmp/t3-index",
    });
    assert.strictEqual(observedAppendTruncationMarker, true);
    assert.strictEqual(observedOutputMode, "error");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(VcsProcess.VcsProcess)({
          run: (input) =>
            Effect.sync(() => {
              observedEnv = input.env;
              observedAppendTruncationMarker = input.appendTruncationMarker;
              observedOutputMode = input.outputMode;
              return {
                exitCode: ChildProcessSpawner.ExitCode(0),
                stdout: "",
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              };
            }),
        }),
      ),
    ),
  );
});
