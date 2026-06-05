import { homedir } from "node:os";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { normalizeUsage, resolveOAuthToken, type RawUsageResponse } from "./OAuthUsage.ts";

describe("OAuthUsage.normalizeUsage", () => {
  // Shape verified against the live GET /api/oauth/usage response (2026-06-04).
  const liveSample: RawUsageResponse = {
    five_hour: { utilization: 45.0, resets_at: "2026-06-04T19:30:00.236199+00:00" },
    seven_day: { utilization: 24.0, resets_at: "2026-06-08T09:00:00.236223+00:00" },
    extra_usage: {
      is_enabled: true,
      monthly_limit: 200000,
      used_credits: 43540.0,
      utilization: 21.77,
      currency: "CAD",
    },
  };

  it("maps the live sample to the normalized contract shape", () => {
    const result = normalizeUsage(liveSample);
    assert.deepStrictEqual(result, {
      fiveHour: { utilization: 45, resetsAt: "2026-06-04T19:30:00.236199+00:00" },
      sevenDay: { utilization: 24, resetsAt: "2026-06-08T09:00:00.236223+00:00" },
      extra: {
        isEnabled: true,
        usedCredits: 43540,
        monthlyLimit: 200000,
        utilization: 21.77,
        currency: "CAD",
      },
    });
  });

  it("tolerates null seven_day / missing extra_usage", () => {
    const result = normalizeUsage({
      five_hour: { utilization: 10, resets_at: "2026-06-04T19:30:00Z" },
      seven_day: null,
    });
    assert.deepStrictEqual(result, {
      fiveHour: { utilization: 10, resetsAt: "2026-06-04T19:30:00Z" },
      sevenDay: null,
      extra: null,
    });
  });

  it("defaults missing numeric fields to 0 and missing currency to null", () => {
    const result = normalizeUsage({
      five_hour: {},
      extra_usage: { is_enabled: true },
    });
    assert.deepStrictEqual(result, {
      fiveHour: { utilization: 0, resetsAt: null },
      sevenDay: null,
      extra: { isEnabled: true, usedCredits: 0, monthlyLimit: 0, utilization: 0, currency: null },
    });
  });
});

describe("OAuthUsage.resolveOAuthToken", () => {
  const credentialsBlob = (token: string) =>
    JSON.stringify({ claudeAiOauth: { accessToken: token } });

  /** In-memory FileSystem serving only the given path → contents map. */
  const fileSystemWith = (files: Record<string, string>) =>
    Option.some(
      FileSystem.makeNoop({
        exists: (path) => Effect.succeed(path in files),
        readFileString: (path) => Effect.succeed(files[path] ?? ""),
      }),
    );

  /**
   * Fake `security find-generic-password` spawner: records each requested
   * Keychain service name and answers with that service's credential blob
   * (exit 44 — item not found — when absent, like the real tool).
   */
  const keychainSpawner = (blobByService: Record<string, string>, serviceCalls: string[]) =>
    Option.some(
      ChildProcessSpawner.make((command) => {
        const { args } = command as unknown as { args: ReadonlyArray<string> };
        const service = args[args.indexOf("-s") + 1] ?? "";
        serviceCalls.push(service);
        const blob = blobByService[service];
        return Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(blob === undefined ? 44 : 0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.encodeText(Stream.make(blob ?? "")),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        );
      }),
    );

  it.effect("prefers CLAUDE_CODE_OAUTH_TOKEN from the provided env", () =>
    Effect.gen(function* () {
      const token = yield* resolveOAuthToken({
        env: { CLAUDE_CODE_OAUTH_TOKEN: "env-token" },
        spawner: Option.none(),
        fileSystem: fileSystemWith({}),
      });
      assert.deepStrictEqual(token, Option.some("env-token"));
    }),
  );

  it.effect("resolves each instance's credentials file from its own CLAUDE_CONFIG_DIR", () =>
    Effect.gen(function* () {
      const fileSystem = fileSystemWith({
        "/cfg-uni/.credentials.json": credentialsBlob("uni-token"),
        "/cfg-personal/.credentials.json": credentialsBlob("personal-token"),
      });
      const uni = yield* resolveOAuthToken({
        env: { CLAUDE_CONFIG_DIR: "/cfg-uni" },
        spawner: Option.none(),
        fileSystem,
      });
      const personal = yield* resolveOAuthToken({
        env: { CLAUDE_CONFIG_DIR: "/cfg-personal" },
        spawner: Option.none(),
        fileSystem,
      });
      assert.deepStrictEqual(uni, Option.some("uni-token"));
      assert.deepStrictEqual(personal, Option.some("personal-token"));
    }),
  );

  it.effect("follows env.HOME for the credentials file when CLAUDE_CONFIG_DIR is unset", () =>
    Effect.gen(function* () {
      const token = yield* resolveOAuthToken({
        env: { HOME: "/instance-home" },
        spawner: Option.none(),
        fileSystem: fileSystemWith({
          "/instance-home/.claude/.credentials.json": credentialsBlob("home-token"),
        }),
      });
      assert.deepStrictEqual(token, Option.some("home-token"));
    }),
  );

  it.effect("falls back to homedir() when env.HOME is empty", () =>
    Effect.gen(function* () {
      // A bare `env.HOME ?? homedir()` would resolve HOME="" to a config dir at
      // the filesystem root — serve a decoy there to pin that it is never read.
      const token = yield* resolveOAuthToken({
        env: { HOME: "" },
        spawner: Option.none(),
        fileSystem: fileSystemWith({
          "/.claude/.credentials.json": credentialsBlob("root-decoy-token"),
          [`${homedir()}/.claude/.credentials.json`]: credentialsBlob("default-home-token"),
        }),
      });
      assert.deepStrictEqual(token, Option.some("default-home-token"));
    }),
  );

  // The Keychain branch only runs on darwin (resolveOAuthToken short-circuits
  // elsewhere). Pre-existing salting behavior, but the per-instance fix depends
  // on it: distinct CLAUDE_CONFIG_DIR values must query distinct services.
  it.effect.runIf(process.platform === "darwin")(
    "salts the Keychain service name by CLAUDE_CONFIG_DIR so instances resolve their own login",
    () =>
      Effect.gen(function* () {
        const serviceCalls: string[] = [];
        const spawner = keychainSpawner(
          { "Claude Code-credentials": credentialsBlob("default-keychain-token") },
          serviceCalls,
        );
        const fileSystem = fileSystemWith({});

        const salted = yield* resolveOAuthToken({
          env: { CLAUDE_CONFIG_DIR: "/cfg-uni" },
          spawner,
          fileSystem,
        });
        const unsalted = yield* resolveOAuthToken({
          env: {},
          spawner,
          fileSystem,
        });

        assert.equal(serviceCalls.length, 2);
        const saltedService = serviceCalls[0] ?? "";
        assert.match(saltedService, /^Claude Code-credentials-[0-9a-f]{8}$/);
        assert.equal(serviceCalls[1], "Claude Code-credentials");
        // The salted service has no stored login → no token; the default does.
        assert.deepStrictEqual(salted, Option.none());
        assert.deepStrictEqual(unsalted, Option.some("default-keychain-token"));
      }),
  );
});
