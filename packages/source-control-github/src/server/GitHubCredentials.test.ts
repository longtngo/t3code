import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import { ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";

import { DEFAULT_SERVER_SETTINGS, VcsProcessTimeoutError } from "@t3tools/contracts";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as GitHubCredentials from "./GitHubCredentials.ts";

const TOKEN_VARIABLES = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
] as const;

/** Settings keep `enabled` explicit; a host the test leaves it off is enabled. */
const hostSettings = (
  hosts: Record<string, { readonly account?: string; readonly enabled?: boolean }>,
) =>
  Object.fromEntries(
    Object.entries(hosts).map(([host, choice]) => [host, { enabled: true, ...choice }]),
  );

/** What git's credential helpers answer for a folder: output, or a run that never finishes. */
type FillAnswer =
  | { readonly stdout: string; readonly stderr?: string; readonly exitCode?: number }
  | "hang";

function harness(
  hosts: Record<string, { readonly account?: string; readonly enabled?: boolean }> = {},
  signedOut: ReadonlyArray<string> = [],
  tokens: Record<string, string> = {},
  fills: Record<string, FillAnswer> = {},
  /** `activeSignedOut`: gh holds no active login. `stored`: what `gh auth status` lists. */
  options: { readonly activeSignedOut?: boolean; readonly stored?: ReadonlyArray<string> } = {},
) {
  const calls: Array<ReadonlyArray<string>> = [];
  const gitCalls: Array<SourceControlHost.SourceControlProcessInput> = [];
  const ghCalls: Array<SourceControlHost.SourceControlProcessInput> = [];
  const run: SourceControlHost.SourceControlHost["Service"]["process"]["run"] = (input) => {
    if (input.command === "git") {
      gitCalls.push(input);
      const answer = fills[input.cwd] ?? { stdout: "", exitCode: 128 };
      if (answer === "hang") {
        // Honours timeoutMs the way the real runner does.
        return Effect.sleep("10 seconds").pipe(
          Effect.andThen(Effect.die("a hung helper finished")),
          Effect.timeoutOrElse({
            duration: input.timeoutMs ?? 0,
            orElse: () =>
              Effect.fail(
                new VcsProcessTimeoutError({
                  operation: input.operation,
                  command: input.command,
                  cwd: input.cwd,
                  timeoutMs: input.timeoutMs ?? 0,
                }),
              ),
          }),
        );
      }
      return Effect.succeed(
        TestSourceControlHost.processOutput(answer.stdout, {
          stderr: answer.stderr ?? "",
          exitCode: ChildProcessSpawner.ExitCode(answer.exitCode ?? 0),
        }),
      );
    }
    return Effect.sync(() => {
      calls.push(input.args);
      ghCalls.push(input);
      if (input.args[1] === "status") {
        const logins = (options.stored ?? []).map((login) => ({
          state: "success",
          active: false,
          host: "github.com",
          login,
          tokenSource: "keyring",
          gitProtocol: "https",
        }));
        return {
          exitCode: ChildProcessSpawner.ExitCode(0),
          stdout: JSON.stringify({ hosts: { "github.com": logins } }),
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      }
      const user = input.args[input.args.indexOf("--user") + 1];
      const missing = input.args.includes("--user")
        ? user !== undefined && signedOut.includes(user)
        : options.activeSignedOut === true;
      if (missing) {
        return {
          exitCode: ChildProcessSpawner.ExitCode(0),
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      }
      return {
        exitCode: ChildProcessSpawner.ExitCode(0),
        stdout: input.args.includes("--user") ? `token-for-${user}\n` : "active-token\n",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    });
  };
  const settingsReads = { count: 0 };
  // Counts every settings read the service makes.
  const countedHost = Layer.effect(
    SourceControlHost.SourceControlHost,
    Effect.map(Effect.service(SourceControlHost.SourceControlHost), (host) => ({
      ...host,
      settings: {
        get: Effect.sync(() => settingsReads.count++).pipe(Effect.andThen(host.settings.get)),
      },
    })),
  );
  const layer = GitHubCredentials.layer.pipe(
    Layer.provide(countedHost),
    Layer.provideMerge(
      TestSourceControlHost.layer({
        settings: applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
          sourceControlHosts: { github: { hosts: hostSettings(hosts), tokens } },
        }),
        process: { run },
      }),
    ),
    Layer.provide(NodeCrypto.layer),
  );
  return { layer, calls, gitCalls, ghCalls, settingsReads };
}

const userCall = (user: string) => ["auth", "token", "--hostname", "github.com", "--user", user];

/** Every log message a test's effect writes. */
const capturingLogs = () => {
  const messages: Array<string> = [];
  const logger = Logger.make(({ message }) => {
    messages.push(Array.isArray(message) ? message.join(" ") : String(message));
  });
  return { messages, layer: Logger.layer([logger]) };
};

describe("GitHubCredentials", () => {
  beforeEach(() => {
    for (const name of TOKEN_VARIABLES) vi.stubEnv(name, "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.effect("asks gh for the active login when Settings pin nothing", () => {
    const { layer, calls } = harness();
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const credential = yield* credentials.get("GitHub.com", null);
      expect(Redacted.value(credential.token)).toBe("active-token");
      expect(calls).toEqual([["auth", "token", "--hostname", "github.com"]]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reads settings once per request", () => {
    const { layer, settingsReads } = harness({ "github.com": { account: "work" } });
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      yield* credentials.get("github.com", "/x");
      expect(settingsReads.count).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("never hands gh an environment token for a host it is not for", () => {
    vi.stubEnv("GH_ENTERPRISE_TOKEN", "enterprise-token");
    vi.stubEnv("GH_HOST", "ghe.example.com");
    const { layer, ghCalls } = harness();
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const credential = yield* credentials.get("evil.example.com", null);
      expect(Redacted.value(credential.token)).toBe("active-token");
      expect(ghCalls).toHaveLength(1);
      for (const name of TOKEN_VARIABLES) {
        expect(Object.hasOwn(ghCalls[0]?.env ?? {}, name)).toBe(true);
        expect(ghCalls[0]?.env?.[name]).toBe("");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("passes --user for an account pinned in Settings", () => {
    const { layer, calls } = harness({ "github.com": { account: "work" } });
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const credential = yield* credentials.get("github.com", null);
      expect(Redacted.value(credential.token)).toBe("token-for-work");
      expect(calls).toEqual([["auth", "token", "--hostname", "github.com", "--user", "work"]]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails a host turned off in Settings without asking gh", () => {
    const { layer, calls } = harness({ "github.com": { enabled: false } });
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const error = yield* Effect.flip(credentials.get("github.com", null));
      expect(error._tag).toBe("GitHubHostDisabledError");
      expect(error.message).toBe(
        "GitHub host github.com is turned off in Settings → Source Control.",
      );
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("lets an environment token win over a pinned account, as gh does", () => {
    vi.stubEnv("GH_TOKEN", "from-env");
    const { layer, calls } = harness({ "github.com": { account: "work" } });
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const credential = yield* credentials.get("github.com", null);
      expect(Redacted.value(credential.token)).toBe("from-env");
      expect(credential.source).toBe("env");
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("picks up a changed account on the next request without a restart", () => {
    const { layer, calls } = harness();
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const settings = yield* TestSourceControlHost.TestSourceControlHostSettings;
      expect(Redacted.value((yield* credentials.get("github.com", null)).token)).toBe(
        "active-token",
      );

      yield* settings.update({
        sourceControlHosts: {
          github: { hosts: { "github.com": { account: "work", enabled: true } } },
        },
      });
      expect(Redacted.value((yield* credentials.get("github.com", null)).token)).toBe(
        "token-for-work",
      );

      yield* settings.update({
        sourceControlHosts: { github: { hosts: { "github.com": { enabled: false } } } },
      });
      expect((yield* Effect.flip(credentials.get("github.com", null)))._tag).toBe(
        "GitHubHostDisabledError",
      );

      yield* settings.update({ sourceControlHosts: { github: { hosts: {} } } });
      expect(Redacted.value((yield* credentials.get("github.com", null)).token)).toBe(
        "active-token",
      );
      // The unpinned token stayed cached; only the newly pinned account cost a gh call.
      expect(calls).toHaveLength(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("falls back to the active login when the pinned one is no longer signed in", () => {
    const { layer, calls } = harness({ "github.com": { account: "gone" } }, ["gone"]);
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      expect(Redacted.value((yield* credentials.get("github.com", null)).token)).toBe(
        "active-token",
      );
      expect(calls).toEqual([
        ["auth", "token", "--hostname", "github.com", "--user", "gone"],
        ["auth", "token", "--hostname", "github.com"],
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses a token saved in Settings before GH_TOKEN and gh", () => {
    vi.stubEnv("GH_TOKEN", "env-token");
    const { layer, calls } = harness({}, [], { "github.com": "saved-token" });
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const credential = yield* credentials.get("github.com", null);
      expect(Redacted.value(credential.token)).toBe("saved-token");
      expect(credential.source).toBe("settings");
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps a host turned off even with a token saved in Settings", () => {
    const { layer } = harness({ "github.com": { enabled: false } }, [], {
      "github.com": "saved-token",
    });
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      expect((yield* Effect.flip(credentials.get("github.com", null)))._tag).toBe(
        "GitHubHostDisabledError",
      );
    }).pipe(Effect.provide(layer));
  });

  describe("folder account", () => {
    const alice = { stdout: "protocol=https\nhost=github.com\nusername=alice\npassword=pw\n" };

    it.effect("uses the account git's config names for the folder", () => {
      const { layer, calls } = harness({}, [], {}, { "/x": alice });
      return Effect.gen(function* () {
        const credentials = yield* GitHubCredentials.GitHubCredentials;
        const credential = yield* credentials.get("github.com", "/x");
        expect(Redacted.value(credential.token)).toBe("token-for-alice");
        expect(credential.source).toBe("folder");
        expect(credential.account).toBe("alice");
        expect(calls).toEqual([userCall("alice")]);
      }).pipe(Effect.provide(layer));
    });

    it.effect("asks git without prompts, outside any inherited repository", () => {
      const { layer, gitCalls } = harness({}, [], {}, { "/x": alice });
      return Effect.gen(function* () {
        const credentials = yield* GitHubCredentials.GitHubCredentials;
        yield* credentials.get("github.com", "/x");
        expect(gitCalls).toHaveLength(1);
        const call = gitCalls[0]!;
        expect(call.args).toEqual([
          "-c",
          "credential.interactive=never",
          "-C",
          "/x",
          "credential",
          "fill",
        ]);
        expect(call.cwd).toBe("/x");
        expect(call.stdin).toBe("protocol=https\nhost=github.com\n\n");
        expect(call.timeoutMs).toBe(2_000);
        expect(call.env).toMatchObject(SourceControlHost.GIT_REMOTE_PROMPT_ENV);
        for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"]) {
          expect(Object.hasOwn(call.env ?? {}, name)).toBe(true);
          expect(call.env?.[name]).toBeUndefined();
        }
      }).pipe(Effect.provide(layer));
    });

    it.effect(
      "never runs git when a saved token, an environment token, or no folder decides",
      () => {
        return Effect.gen(function* () {
          const saved = harness({}, [], { "github.com": "saved-token" }, { "/x": alice });
          const fromSaved = yield* GitHubCredentials.GitHubCredentials.pipe(
            Effect.flatMap((credentials) => credentials.get("github.com", "/x")),
            Effect.provide(saved.layer),
          );
          expect(fromSaved.source).toBe("settings");
          expect([saved.calls, saved.gitCalls]).toEqual([[], []]);

          const unscoped = harness({}, [], {}, { "/x": alice });
          const fromActive = yield* GitHubCredentials.GitHubCredentials.pipe(
            Effect.flatMap((credentials) => credentials.get("github.com", null)),
            Effect.provide(unscoped.layer),
          );
          expect(Redacted.value(fromActive.token)).toBe("active-token");
          expect(unscoped.gitCalls).toEqual([]);

          vi.stubEnv("GH_TOKEN", "from-env");
          const env = harness({}, [], {}, { "/x": alice });
          const fromEnv = yield* GitHubCredentials.GitHubCredentials.pipe(
            Effect.flatMap((credentials) => credentials.get("github.com", "/x")),
            Effect.provide(env.layer),
          );
          expect(fromEnv.source).toBe("env");
          expect([env.calls, env.gitCalls]).toEqual([[], []]);
        });
      },
    );

    it.effect("lets an account pinned in Settings outrank the folder's", () => {
      const { layer, calls, gitCalls } = harness(
        { "github.com": { account: "work" } },
        [],
        {},
        { "/x": alice },
      );
      return Effect.gen(function* () {
        const credentials = yield* GitHubCredentials.GitHubCredentials;
        const credential = yield* credentials.get("github.com", "/x");
        expect(credential.source).toBe("gh");
        expect(credential.account).toBe("work");
        expect(calls).toEqual([userCall("work")]);
        expect(gitCalls).toEqual([]);
      }).pipe(Effect.provide(layer));
    });

    it.effect("names the branch taken even when two branches share one token", () => {
      const { layer, calls } = harness({}, [], {}, { "/x": alice });
      return Effect.gen(function* () {
        const credentials = yield* GitHubCredentials.GitHubCredentials;
        const settings = yield* TestSourceControlHost.TestSourceControlHostSettings;
        const first = yield* credentials.get("github.com", "/x");
        yield* settings.update({
          sourceControlHosts: {
            github: { hosts: { "github.com": { account: "alice", enabled: true } } },
          },
        });
        const second = yield* credentials.get("github.com", "/x");
        expect([first.source, first.account]).toEqual(["folder", "alice"]);
        expect([second.source, second.account]).toEqual(["gh", "alice"]);
        expect(calls).toEqual([userCall("alice")]);
      }).pipe(Effect.provide(layer));
    });

    it.effect("falls back to the active login for a folder account gh does not hold", () => {
      const { layer, calls } = harness({}, ["gone"], {}, { "/x": { stdout: "username=gone\n" } });
      return Effect.gen(function* () {
        const credentials = yield* GitHubCredentials.GitHubCredentials;
        const credential = yield* credentials.get("github.com", "/x");
        expect(Redacted.value(credential.token)).toBe("active-token");
        expect(credential.source).toBe("gh");
        expect(credential.account).toBeUndefined();
        expect(credential.fallback).toBe("not-signed-in");
        expect(credential.requestedAccount).toBe("gone");
        // Remembered for the token lifetime, not the brief one for an unreachable gh.
        yield* TestClock.adjust("4 minutes");
        yield* credentials.get("github.com", "/x");
        expect(calls).toEqual([userCall("gone"), ["auth", "token", "--hostname", "github.com"]]);
      }).pipe(Effect.provide(layer));
    });

    it.effect.each([
      {
        name: "a failed lookup",
        host: "github.com",
        fill: { stdout: "username=alice\n", exitCode: 1 },
        spawns: 1,
        outcome: "exit",
      },
      {
        name: "an empty answer",
        host: "github.com",
        fill: { stdout: "" },
        spawns: 1,
        outcome: "empty",
      },
      {
        name: "an invalid username",
        host: "github.com",
        fill: { stdout: "username=-leading\n" },
        spawns: 1,
        outcome: "invalid",
      },
      {
        name: "a host with a newline",
        host: "git\nhub.com",
        fill: alice,
        spawns: 0,
        outcome: "invalid",
      },
    ])("uses the active login after $name, and remembers it", ({ host, fill, spawns, outcome }) => {
      const { layer, gitCalls } = harness({}, [], {}, { "/x": fill });
      return Effect.gen(function* () {
        const credentials = yield* GitHubCredentials.GitHubCredentials;
        const credential = yield* credentials.get(host, "/x");
        expect(Redacted.value(credential.token)).toBe("active-token");
        expect(credential.folder).toBe(outcome);
        yield* credentials.get(host, "/x");
        expect(gitCalls).toHaveLength(spawns);
      }).pipe(Effect.provide(layer));
    });

    it.effect("gives up on a hung helper after 2 seconds, and remembers it", () => {
      const { layer, gitCalls } = harness({}, [], {}, { "/x": "hang" });
      return Effect.gen(function* () {
        const credentials = yield* GitHubCredentials.GitHubCredentials;
        const fiber = yield* Effect.forkChild(credentials.get("github.com", "/x"));
        yield* TestClock.adjust("3 seconds");
        expect(Redacted.value((yield* Fiber.join(fiber)).token)).toBe("active-token");
        yield* credentials.get("github.com", "/x");
        expect(gitCalls).toHaveLength(1);
      }).pipe(Effect.provide(layer));
    });

    it.effect("keeps the helper's password out of every result", () => {
      const leaky = { stdout: "username=alice\npassword=SECRET-123\n", stderr: "SECRET-123" };
      const { layer } = harness({}, [], {}, { "/x": leaky, "/y": { ...leaky, exitCode: 1 } });
      return Effect.gen(function* () {
        const credentials = yield* GitHubCredentials.GitHubCredentials;
        for (const cwd of ["/x", "/y"]) {
          const exit = yield* Effect.exit(credentials.get("github.com", cwd));
          expect(JSON.stringify(exit)).not.toContain("SECRET-123");
        }
      }).pipe(Effect.provide(layer));
    });

    it("reads only a well-formed username from the helper's answer", () => {
      expect(GitHubCredentials.parseFillUsername("username=alice\npassword=SECRET-123\n")).toBe(
        "alice",
      );
      expect(
        GitHubCredentials.parseFillUsername(
          `username=${"0123456789abcdef".repeat(3).slice(0, 40)}`,
        ),
      ).toBeNull();
      // Enterprise managed users carry an underscore: handle_shortcode.
      expect(GitHubCredentials.parseFillUsername("username=octocat_acme\n")).toBe("octocat_acme");
      // A token in the username slot is longer than any login.
      expect(
        GitHubCredentials.parseFillUsername(
          `username=ghp_${"aB3dE5gH7jK9mN1pQ3sT5vX7zA9cE1gI3kM5"}\n`,
        ),
      ).toBeNull();
      expect(GitHubCredentials.parseFillUsername("username=has space\n")).toBeNull();
      expect(GitHubCredentials.parseFillUsername("password=SECRET-123\n")).toBeNull();
    });

    it.effect("asks git again once the folder's answer is older than the token lifetime", () => {
      const { layer, gitCalls } = harness({}, [], {}, { "/x": alice });
      return Effect.gen(function* () {
        const credentials = yield* GitHubCredentials.GitHubCredentials;
        yield* credentials.get("github.com", "/x");
        yield* TestClock.adjust("4 minutes");
        yield* credentials.get("github.com", "/x");
        expect(gitCalls).toHaveLength(1);
        // A git config edit applies within the lifetime.
        yield* TestClock.adjust("2 minutes");
        yield* credentials.get("github.com", "/x");
        expect(gitCalls).toHaveLength(2);
      }).pipe(Effect.provide(layer));
    });

    it.effect("leaves another host's tokens alone on invalidate", () => {
      const { layer, calls } = harness();
      return Effect.gen(function* () {
        const credentials = yield* GitHubCredentials.GitHubCredentials;
        yield* credentials.get("github.com", null);
        yield* credentials.get("ghe.example.com", null);
        yield* credentials.invalidate("github.com");
        yield* credentials.get("ghe.example.com", null);
        expect(calls).toEqual([
          ["auth", "token", "--hostname", "github.com"],
          ["auth", "token", "--hostname", "ghe.example.com"],
        ]);
      }).pipe(Effect.provide(layer));
    });

    it.effect("re-resolves every account's token after invalidate", () => {
      const { layer, calls } = harness(
        {},
        [],
        {},
        { "/x": alice, "/y": { stdout: "username=bob\n" } },
      );
      return Effect.gen(function* () {
        const credentials = yield* GitHubCredentials.GitHubCredentials;
        yield* credentials.get("github.com", "/x");
        yield* credentials.get("github.com", "/y");
        yield* credentials.invalidate("github.com");
        yield* credentials.get("github.com", "/x");
        expect(calls).toEqual([userCall("alice"), userCall("bob"), userCall("alice")]);
      }).pipe(Effect.provide(layer));
    });
  });
});

describe("GitHubCredentials.others", () => {
  beforeEach(() => {
    for (const name of TOKEN_VARIABLES) vi.stubEnv(name, "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.effect("offers no other login when the credential already tried cannot be read again", () => {
    const { layer } = harness({}, [], {}, {}, { activeSignedOut: true, stored: ["bob"] });
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      expect(yield* credentials.others("github.com", null)).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("logs a skipped login as signed out, never as falling back to the active one", () => {
    const { layer } = harness({}, ["carol"], {}, {}, { stored: ["carol", "bob"] });
    const logs = capturingLogs();
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const others = yield* credentials.others("github.com", null);
      expect(others.map((credential) => credential.account)).toEqual(["bob"]);
      expect(logs.messages).toEqual(["GitHub account carol on github.com is not signed in to gh"]);
    }).pipe(Effect.provide(Layer.merge(layer, logs.layer)));
  });
});
