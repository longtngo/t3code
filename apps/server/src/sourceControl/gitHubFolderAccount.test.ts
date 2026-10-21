// @effect-diagnostics nodeBuiltinImport:off - fixtures are built with plain fs in a private temp dir.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as Tracer from "effect/Tracer";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";
import { GIT_REMOTE_PROMPT_ENV } from "@t3tools/source-control-core/server/SourceControlHost";

import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ServerSourceControlHost from "./ServerSourceControlHost.ts";

const SECRET = "SECRET-XYZ";

/** Everything observability could carry out of the process: span attributes/events, failures, logs. */
const captured: string[] = [];

/**
 * A stock `NativeSpan` keeps success values, which here would hold the raw helper output, so
 * success exits are dropped the way the production local-file span does.
 */
const capturingTracer = Tracer.make({
  span(options) {
    const span = new Tracer.NativeSpan(options);
    const end = span.end.bind(span);
    span.end = (endTime, exit) => {
      captured.push(
        JSON.stringify([...span.attributes]),
        JSON.stringify(span.events),
        Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "",
      );
      end(endTime, Exit.isSuccess(exit) ? Exit.void : exit);
    };
    return span;
  },
});

const capturingLogger = Logger.make(({ message, cause }) => {
  captured.push(JSON.stringify(message), Cause.pretty(cause));
});

const hostLayer = ServerSourceControlHost.layer.pipe(
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
  Layer.provide(Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({})),
  Layer.provideMerge(VcsProcess.layer),
);

const testLayer = Layer.mergeAll(
  GitHubCredentials.layer.pipe(Layer.provide(NodeCrypto.layer), Layer.provideMerge(hostLayer)),
  Logger.layer([capturingLogger]),
  Layer.succeed(Tracer.Tracer, capturingTracer),
).pipe(Layer.provideMerge(NodeServices.layer));

let root: string;

/** A repo whose only credential helper runs `body`, a shell script run by git's `fill`. */
const makeRepo = Effect.fn("makeRepo")(function* (name: string, body: (marker: string) => string) {
  const process = yield* VcsProcess.VcsProcess;
  const dir = NodePath.join(root, name);
  const marker = NodePath.join(dir, "ran");
  const script = NodePath.join(dir, "helper.sh");
  yield* Effect.promise(async () => {
    await NodeFSP.mkdir(dir);
    await NodeFSP.writeFile(script, `#!/bin/sh\ntouch ${marker}\n${body(marker)}\n`);
    await NodeFSP.chmod(script, 0o755);
  });
  const git = (...args: string[]) =>
    process.run({ operation: "test", command: "git", args, cwd: dir });
  yield* git("init", "--quiet");
  // The empty entry resets the helper list; the second is the fixture's helper.
  yield* git("config", "--local", "--add", "credential.https://github.com.helper", "");
  yield* git("config", "--local", "--add", "credential.https://github.com.helper", `!${script}`);
  return { dir, marker };
});

const printSecret = `echo username=alice\necho password=${SECRET}\necho ${SECRET} >&2`;

const exists = (path: string) =>
  NodeFSP.stat(path).then(
    () => true,
    () => false,
  );

/** The account `get` resolved for `cwd`: `folder` when git named one, otherwise gh's active login. */
const resolve = (cwd: string) =>
  Effect.gen(function* () {
    const credentials = yield* GitHubCredentials.GitHubCredentials;
    const credential = yield* credentials.get("github.com", cwd);
    return {
      source: credential.source,
      account: credential.account,
      folder: credential.folder,
      // Only the fake gh's tokens and the fixture secret are ever returned, so a real token cannot
      // reach a failure message while a leak of the helper's output still reaches expectNoSecret.
      token: /^token-[a-z]+$/.test(Redacted.value(credential.token))
        ? Redacted.value(credential.token)
        : Redacted.value(credential.token).includes(SECRET)
          ? SECRET
          : "<not-the-fake-gh>",
    };
  }).pipe(Effect.provide(testLayer));

const expectNoSecret = (...values: ReadonlyArray<unknown>) => {
  expect(JSON.stringify([...values, captured])).not.toContain(SECRET);
};

describe("GitHub folder account lookup against real git", () => {
  beforeEach(async () => {
    captured.length = 0;
    root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-folder-account-"));
    // A fake gh: a named login's token is `token-<login>`, so the result shows which was asked for.
    const bin = NodePath.join(root, "bin");
    await NodeFSP.mkdir(bin);
    await NodeFSP.writeFile(
      NodePath.join(bin, "gh"),
      `#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = --user ] && user=$2; shift; done\necho token-\${user:-active}\n`,
    );
    await NodeFSP.chmod(NodePath.join(bin, "gh"), 0o755);
    await NodeFSP.writeFile(NodePath.join(root, "gitconfig"), "");
    // No real helper on this machine may run: only the fixture's repo config is read.
    vi.stubEnv("GIT_CONFIG_GLOBAL", NodePath.join(root, "gitconfig"));
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
    for (const name of ["GH_TOKEN", "GITHUB_TOKEN"]) vi.stubEnv(name, "");
    vi.stubEnv("GIT_DIR", undefined);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await NodeFSP.rm(root, { recursive: true, force: true });
  });

  it.live("success: names the account and the password stays inside git's pipe", () =>
    Effect.gen(function* () {
      const repo = yield* makeRepo("x", () => printSecret);
      const result = yield* resolve(repo.dir);
      // The fake gh answered, so no real gh on this machine was asked.
      expect(result).toMatchObject({ source: "folder", account: "alice", token: "token-alice" });
      expect(yield* Effect.promise(() => exists(repo.marker))).toBe(true);
      expectNoSecret(result);
    }).pipe(Effect.provide(testLayer)),
  );

  it.live(
    "failed fill (no username, helper exits 1) after printing the password: no account, no leak",
    () =>
      Effect.gen(function* () {
        const repo = yield* makeRepo(
          "x",
          () => `echo password=${SECRET}; echo ${SECRET} >&2; exit 1`,
        );
        const result = yield* resolve(repo.dir);
        expect(result).toMatchObject({ source: "gh" });
        expect(yield* Effect.promise(() => exists(repo.marker))).toBe(true);
        expectNoSecret(result);
      }).pipe(Effect.provide(testLayer)),
  );

  it.live("timeout: gives up on a hung helper with no account and no leak", () =>
    Effect.gen(function* () {
      const repo = yield* makeRepo("x", () => `echo ${SECRET} >&2; exec sleep 30`);
      const result = yield* resolve(repo.dir);
      expect(result).toMatchObject({ source: "gh", folder: "timeout", token: "token-active" });
      expect(yield* Effect.promise(() => exists(repo.marker))).toBe(true);
      expectNoSecret(result);
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("output past the limit: no account, no leak", () =>
    Effect.gen(function* () {
      const repo = yield* makeRepo(
        "x",
        () =>
          `echo username=alice\nprintf password=${SECRET}\nhead -c 70000 /dev/zero | tr '\\0' A\necho`,
      ); // A valid key padded with printable bytes: git drops a line with no `=`, and stops at a NUL.
      const result = yield* resolve(repo.dir);
      // git answers `alice` before the oversized password line, so falling back means the limit fired.
      expect(result).toMatchObject({ source: "gh", folder: "exit" });
      expect(yield* Effect.promise(() => exists(repo.marker))).toBe(true);
      expectNoSecret(result);
    }).pipe(Effect.provide(testLayer)),
  );

  // Control: a variant that logs the raw output must be caught by the same check.
  it.live("leaky control: logging the raw helper output makes the check fire", () =>
    Effect.gen(function* () {
      const repo = yield* makeRepo("x", () => printSecret);
      const result = yield* resolve(repo.dir);
      const process = yield* VcsProcess.VcsProcess;
      const raw = yield* process.run({
        operation: "leaky",
        command: "git",
        args: ["-C", repo.dir, "credential", "fill"],
        cwd: repo.dir,
        stdin: "protocol=https\nhost=github.com\n\n",
        env: GIT_REMOTE_PROMPT_ENV,
        allowNonZeroExit: true,
      });
      yield* Effect.logInfo(raw.stdout);
      expect(() => expectNoSecret(result)).toThrow();
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("inherited GIT_DIR cannot redirect the lookup", () =>
    Effect.gen(function* () {
      const x = yield* makeRepo("x", () => "echo username=alice; echo password=a");
      const other = yield* makeRepo("other", () => "echo username=bob; echo password=b");
      vi.stubEnv("GIT_DIR", NodePath.join(other.dir, ".git"));
      expect(yield* resolve(x.dir)).toMatchObject({ source: "folder", account: "alice" });
      // Control: the same fill with GIT_DIR inherited is answered by the other repo.
      const process = yield* VcsProcess.VcsProcess;
      const inherited = yield* process.run({
        operation: "control",
        command: "git",
        args: ["-C", x.dir, "credential", "fill"],
        cwd: x.dir,
        stdin: "protocol=https\nhost=github.com\n\n",
        env: GIT_REMOTE_PROMPT_ENV,
      });
      expect(inherited.stdout).toContain("username=bob");
    }).pipe(Effect.provide(testLayer)),
  );
});
