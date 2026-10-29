import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import { ChildProcessSpawner } from "effect/process";
import { VcsProcessTimeoutError } from "@t3tools/contracts";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http";

import * as GitHubRest from "./GitHubRest.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubQuota from "./GitHubQuota.ts";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as GitHubAppSignIn from "./GitHubAppSignIn.ts";

const appSignedOut = Layer.mock(GitHubAppSignIn.GitHubAppSignIn)({
  enabled: false,
  token: () => Effect.succeedNone,
  invalidate: () => Effect.void,
});

const NOW = Date.parse("2026-10-05T12:00:00.000Z");

function harness(respond: (request: HttpClientRequest.HttpClientRequest) => Response) {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  let tokens = ["first", "second"];
  let invalidations = 0;
  let credentialReads = 0;
  const credentials = Layer.succeed(
    GitHubCredentials.GitHubCredentials,
    GitHubCredentials.GitHubCredentials.of({
      get: (host) =>
        Effect.sync(() => {
          credentialReads++;
          return {
            host,
            token: Redacted.make(tokens[0]!),
            source: "gh" as const,
            fingerprint: `${host}:${tokens[0]}`,
          };
        }),
      account: () => Effect.die("unused"),
      others: () => Effect.succeed([]),
      saved: () => Effect.succeedNone,
      fingerprint: (host, token) => Effect.succeed(`${host}:${token}`),
      invalidate: () =>
        Effect.sync(() => {
          invalidations++;
          tokens = tokens.slice(1);
        }),
    }),
  );
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      requests.push(request);
      return Effect.succeed(HttpClientResponse.fromWeb(request, respond(request)));
    }),
  );
  const layer = GitHubRest.layer.pipe(
    Layer.provide(Layer.mergeAll(credentials, http, appSignedOut)),
    Layer.provideMerge(GitHubQuota.layer),
    Layer.provideMerge(SourceControlRateLimit.layer),
  );
  return {
    layer,
    requests,
    invalidations: () => invalidations,
    credentialReads: () => credentialReads,
  };
}

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });

describe("environmentToken", () => {
  it("follows gh's precedence per kind of host", () => {
    const env = { GH_TOKEN: "gh", GITHUB_TOKEN: "github", GH_ENTERPRISE_TOKEN: "ghe" };
    expect(GitHubCredentials.environmentToken("github.com", env)).toBe("gh");
    expect(GitHubCredentials.environmentToken("acme.ghe.com", { GITHUB_TOKEN: "github" })).toBe(
      "github",
    );
    expect(GitHubCredentials.environmentToken("git.acme.internal", env)).toBeNull();
    expect(
      GitHubCredentials.environmentToken("git.acme.internal", {
        ...env,
        GH_HOST: "git.acme.internal",
      }),
    ).toBe("ghe");
    expect(GitHubCredentials.environmentToken("git.acme.internal", { GH_TOKEN: "gh" })).toBeNull();
  });
});

describe("GitHubRest", () => {
  it.effect("traces the operation, path and quota, never the query string or the token", () => {
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const { layer } = harness(() =>
      json({ ok: true }, { headers: { "x-ratelimit-remaining": "4800" } }),
    );
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const api = yield* GitHubRest.GitHubRest;
      yield* api.rest({
        host: "github.com",
        cwd: null,
        operation: "listWorkflowRuns",
        path: "repos/acme/web/actions/runs?head_sha=abc123&branch=feat%2Fx",
      });
      const send = spans.find((span) => span.name === "GitHubRest.send")!;
      expect(Object.fromEntries(send.attributes)).toMatchObject({
        "github.operation": "listWorkflowRuns",
        "github.kind": "rest",
        "url.path": "/repos/acme/web/actions/runs",
        "http.response.status_code": 200,
        "github.ratelimit.remaining": 4800,
      });
      const everything = spans
        .flatMap((span) => [...span.attributes].map(([key, value]) => `${key}=${String(value)}`))
        .join("\n");
      expect(everything).not.toContain("head_sha");
      expect(everything).not.toContain("first");
      expect(spans.some((span) => span.attributes.has("url.full"))).toBe(false);
    }).pipe(Effect.provide(layer), Effect.withTracer(tracer));
  });

  it.effect("lets an interactive request through a pause a background read recorded", () => {
    const reset = Math.floor(NOW / 1000) + 600;
    let call = 0;
    const { layer, requests } = harness(() =>
      ++call === 1
        ? json(
            { message: "API rate limit exceeded" },
            {
              status: 403,
              headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
            },
          )
        : json({ ok: true }),
    );
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const api = yield* GitHubRest.GitHubRest;
      const read = {
        host: "github.com",
        cwd: null,
        operation: "sweep",
        path: "repos/acme/web/pulls",
      };
      yield* Effect.flip(api.rest(read));
      expect((yield* Effect.flip(api.rest(read)))._tag).toBe("SourceControlRateLimitPausedError");
      const merged = yield* api
        .rest({
          host: "github.com",
          cwd: null,
          operation: "merge",
          method: "PUT",
          path: "repos/acme/web/pulls/7/merge",
        })
        .pipe(Effect.provideService(SourceControlRateLimit.Interactive, true));
      expect(merged.status).toBe(200);
      expect(requests).toHaveLength(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("maps REST 403 with an exhausted quota to a rate limit, and 304 to an answer", () => {
    let call = 0;
    const { layer } = harness(() =>
      ++call === 1
        ? new Response(null, { status: 304 })
        : json(
            { message: "API rate limit exceeded" },
            {
              status: 403,
              headers: { "retry-after": "60" },
            },
          ),
    );
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const api = yield* GitHubRest.GitHubRest;
      const notModified = yield* api.rest({
        host: "github.com",
        cwd: null,
        operation: "checks",
        path: "repos/acme/web/pulls/7",
        ifNoneMatch: '"abc"',
      });
      expect(notModified.status).toBe(304);
      const error = yield* Effect.flip(
        api.rest({
          host: "github.com",
          cwd: null,
          operation: "checks",
          path: "repos/acme/web/pulls/7",
        }),
      );
      expect(error).toMatchObject({ _tag: "GitHubApiRateLimitError", retryAt: NOW + 60_000 });
    }).pipe(Effect.provide(layer));
  });

  it.effect("drops a refused token so the next request asks the source again", () => {
    const { layer, requests, invalidations } = harness((request) =>
      request.headers.authorization === "Bearer first"
        ? new Response(null, { status: 401 })
        : json({ ok: true }),
    );
    return Effect.gen(function* () {
      const api = yield* GitHubRest.GitHubRest;
      const refused = yield* Effect.flip(
        api.rest({ host: "github.com", cwd: null, operation: "user", path: "user" }),
      );
      expect(refused._tag).toBe("GitHubApiAuthenticationError");
      expect(invalidations()).toBe(1);
      const answered = yield* api.rest({
        host: "github.com",
        cwd: null,
        operation: "user",
        path: "user",
      });
      expect(answered.status).toBe(200);
      expect(requests.map((request) => request.headers.authorization)).toEqual([
        "Bearer first",
        "Bearer second",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "sends as the folder's account, pinned or not, and traces which credential it was",
    () => {
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const asked: Array<string | null> = [];
      const credentials = Layer.succeed(
        GitHubCredentials.GitHubCredentials,
        GitHubCredentials.GitHubCredentials.of({
          get: (host, cwd) => {
            asked.push(cwd);
            if (cwd === "/gone")
              return Effect.fail(new GitHubCredentials.GitHubNotSignedInError({ host }));
            return Effect.succeed(
              cwd === "/x"
                ? {
                    host,
                    token: Redacted.make("token-A"),
                    source: "folder" as const,
                    fingerprint: "a",
                    account: "alice",
                  }
                : {
                    host,
                    token: Redacted.make("token-active"),
                    source: "gh" as const,
                    fingerprint: "active",
                    fallback: "not-signed-in" as const,
                    requestedAccount: "bob",
                  },
            );
          },
          saved: () => Effect.succeedNone,
          fingerprint: (host, token) => Effect.succeed(`${host}:${token}`),
          account: () => Effect.die("unused"),
          others: () => Effect.succeed([]),
          invalidate: () => Effect.void,
        }),
      );
      const authorizations: Array<string | undefined> = [];
      const http = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          authorizations.push(request.headers.authorization);
          return Effect.succeed(HttpClientResponse.fromWeb(request, json({})));
        }),
      );
      const layer = GitHubRest.layer.pipe(
        Layer.provide(Layer.mergeAll(credentials, http, appSignedOut)),
        Layer.provideMerge(GitHubQuota.layer),
        Layer.provideMerge(SourceControlRateLimit.layer),
      );
      return Effect.gen(function* () {
        const api = yield* GitHubRest.GitHubRest;
        const read = (cwd: string | null) =>
          api.rest({ host: "github.com", cwd, operation: "user", path: "user" });
        yield* read("/x");
        yield* read("/y");
        // Pinned to /x, a read naming no folder still sends as /x's account.
        yield* api.withDirectory({ host: "github.com", cwd: "/x" })(read(null));
        // A pinned fallback still traces that it fell back.
        yield* api.withDirectory({ host: "github.com", cwd: "/y" })(read(null));
        // A folder whose credential cannot resolve sends nothing.
        const failed = yield* Effect.flip(
          api.withDirectory({ host: "github.com", cwd: "/gone" })(read(null)),
        );
        expect(failed._tag).toBe("GitHubNotSignedInError");
        expect(asked).toEqual(["/x", "/y", "/x", "/y", "/gone"]);
        expect(authorizations).toEqual([
          "Bearer token-A",
          "Bearer token-active",
          "Bearer token-A",
          "Bearer token-active",
        ]);
        const sends = spans
          .filter((span) => span.name === "GitHubRest.send")
          .map((span) => Object.fromEntries(span.attributes));
        expect(sends[0]).toMatchObject({
          "github.credential.source": "folder",
          "github.credential.account": "alice",
        });
        expect(sends[0]).not.toHaveProperty("github.credential.fallback");
        expect(sends[1]).toMatchObject({
          "github.credential.source": "gh",
          "github.credential.fallback": "not-signed-in",
          // Names the login to sign in to gh, which `account` cannot: gh never confirmed it.
          "github.credential.requested_account": "bob",
        });
        expect(sends[1]).not.toHaveProperty("github.credential.account");
        expect(sends[2]).toMatchObject({
          "github.credential.source": "folder",
          "github.credential.account": "alice",
        });
        expect(sends[3]).toMatchObject({
          "github.credential.source": "gh",
          "github.credential.fallback": "not-signed-in",
          "github.credential.requested_account": "bob",
        });
        expect(sends[0]).not.toHaveProperty("github.credential.requested_account");
        expect(JSON.stringify(sends)).not.toContain("/x");
      }).pipe(Effect.provide(layer), Effect.withTracer(tracer));
    },
  );

  it.effect("traces what the folder lookup answered, never what it printed", () => {
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const fills: Record<string, { readonly stdout: string; readonly exitCode: number }> = {
      "/hit": { stdout: "username=alice\npassword=SECRET-1\n", exitCode: 0 },
      "/exit": { stdout: "username=bob\npassword=SECRET-2\n", exitCode: 1 },
    };
    const run: SourceControlHost.SourceControlHost["Service"]["process"]["run"] = (input) => {
      const fill = fills[input.cwd];
      return Effect.succeed(
        input.command === "git"
          ? TestSourceControlHost.processOutput(fill?.stdout ?? "", {
              exitCode: ChildProcessSpawner.ExitCode(fill?.exitCode ?? 0),
            })
          : TestSourceControlHost.processOutput(
              input.args.includes("--user")
                ? `token-for-${input.args[input.args.indexOf("--user") + 1]}\n`
                : "active-token\n",
            ),
      );
    };
    const http = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, json({})))),
    );
    const layer = GitHubRest.layerWithDependencies.pipe(
      Layer.provide(SourceControlRateLimit.layer),
      Layer.provide(http),
      Layer.provide(TestSourceControlHost.layer({ process: { run } })),
      Layer.provide(Layer.succeed(HostProcess.Environment, {})),
      Layer.provide(NodeCrypto.layer),
    );
    return Effect.gen(function* () {
      const api = yield* GitHubRest.GitHubRest;
      const read = (cwd: string | null) =>
        api.rest({ host: "github.com", cwd, operation: "user", path: "user" });
      yield* read("/hit");
      yield* read("/exit");
      // The answer rides through a pin, and a read naming no folder consulted none.
      yield* api.withDirectory({ host: "github.com", cwd: "/exit" })(read(null));
      yield* read(null);
      const sends = spans
        .filter((span) => span.name === "GitHubRest.send")
        .map((span) => Object.fromEntries(span.attributes));
      expect(sends[0]).toMatchObject({
        "github.credential.source": "folder",
        "github.credential.account": "alice",
        "github.credential.folder": "hit",
      });
      expect(sends[1]).toMatchObject({
        "github.credential.source": "gh",
        "github.credential.folder": "exit",
      });
      expect(sends[1]).not.toHaveProperty("github.credential.account");
      expect(sends[2]).toMatchObject({
        "github.credential.source": "gh",
        "github.credential.folder": "exit",
      });
      expect(sends[3]).toMatchObject({ "github.credential.source": "gh" });
      expect(sends[3]).not.toHaveProperty("github.credential.folder");
      const traced = JSON.stringify(spans.map((span) => Object.fromEntries(span.attributes)));
      for (const printed of ["SECRET-1", "SECRET-2", "bob"]) {
        expect(traced).not.toContain(printed);
      }
    }).pipe(Effect.withTracer(tracer), Effect.provide(layer));
  });

  it.effect("refuses to send a pinned credential to another host", () => {
    const { layer, requests } = harness(() => json({}));
    return Effect.gen(function* () {
      const api = yield* GitHubRest.GitHubRest;
      const error = yield* Effect.flip(
        api.rest({ host: "git.acme.internal", cwd: null, operation: "user", path: "user" }),
      ).pipe(
        Effect.provideService(GitHubRequestPolicy.PinnedGitHubCredential, {
          host: "github.com",
          token: Redacted.make("pinned"),
          credentialFingerprint: "github.com:pinned",
          source: "gh",
        }),
      );
      expect(error._tag).toBe("GitHubApiAuthenticationError");
      expect(requests).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });
});

describe("GitHubCredentials", () => {
  const unexpectedHttp = HttpClient.make((request) =>
    Effect.die(`Unexpected request to ${request.url}`),
  );
  const credentialsWith = (run: SourceControlHost.SourceControlHost["Service"]["process"]["run"]) =>
    GitHubCredentials.layer.pipe(
      Layer.provide(TestSourceControlHost.layer({ process: { run } })),
      Layer.provide(NodeCrypto.layer),
      Layer.provide(Layer.succeed(HttpClient.HttpClient, unexpectedHttp)),
    );

  it.effect("does not cache a gh failure that is not about signing in", () => {
    let calls = 0;
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const first = yield* Effect.flip(credentials.get("github.com", null));
      expect(first._tag).toBe("GitHubCliFailedError");
      expect((yield* credentials.get("github.com", null)).source).toBe("gh");
      expect(calls).toBe(2);
    }).pipe(
      Effect.provide(
        credentialsWith(() =>
          ++calls === 1
            ? Effect.fail(
                new VcsProcessTimeoutError({
                  operation: "GitHubCredentials.get",
                  command: "gh",
                  cwd: "/",
                  timeoutMs: 10_000,
                }),
              )
            : Effect.succeed({
                exitCode: ChildProcessSpawner.ExitCode(0),
                stdout: "token\n",
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              }),
        ),
      ),
    );
  });

  it.effect("fails with GitHubNotSignedInError when gh prints no token", () =>
    Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const error = yield* Effect.flip(credentials.get("git.acme.internal", null));
      expect(error._tag).toBe("GitHubNotSignedInError");
    }).pipe(
      Effect.provide(
        credentialsWith(() =>
          Effect.succeed({
            exitCode: ChildProcessSpawner.ExitCode(0),
            stdout: "\n",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
        ),
      ),
    ),
  );
});
