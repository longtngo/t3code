import { describe, expect, it } from "@effect/vitest";
import { SourceControlProviderKind } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";

import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import type * as GitHubRest from "./GitHubRest.ts";
import { makeRepositoryAccountRouter } from "./gitHubRepositoryAccount.ts";

type Access = "ok" | 401 | 403 | 404 | 502 | "die";

interface Sent {
  readonly kind: "probe" | "effect";
  readonly path: string;
  /** The login the request went out as. */
  readonly as: string;
  /** The login it was pinned to, or null when it ran as the folder's own account. */
  readonly pinned: string | null;
  readonly scope: string;
}

const HOST = "github.com";
const FOLDERS: Record<string, string> = { "/x": "A", "/y": "C", "/z": "A" };
const folderLogin = (cwd: string | null) => (cwd === null ? "nobody" : (FOLDERS[cwd] ?? "nobody"));
const loginOf = (fingerprint: string) => fingerprint.replace(/^fp-/, "");

function credentialOf(login: string): GitHubCredentials.GitHubCredential {
  return {
    host: HOST,
    token: Redacted.make(`token-${login}`),
    source: "gh",
    fingerprint: `fp-${login}`,
    account: login,
  };
}

function harness() {
  const sent: Array<Sent> = [];
  const state = {
    explicit: false,
    /** `${login} ${path}` -> answer; anything unlisted is 404. */
    access: new Map<string, Access>(),
    signedOut: new Set<string>(),
    /** Logins whose background (non-interactive) requests are refused before leaving. */
    paused: new Set<string>(),
    logins: ["A", "B", "C"],
    nameless: false,
    othersCalls: 0,
    /** How many of the next `others` calls fail as a failed `gh auth status` listing. */
    othersFailures: 0,
    credentialCalls: 0,
    /** When set, `arrived` completes on the `callers`th call and folder probes wait for `release`. */
    gate: null as {
      readonly callers: number;
      readonly arrived: Deferred.Deferred<void>;
      readonly release: Deferred.Deferred<void>;
    } | null,
  };

  const whoami = Effect.gen(function* () {
    const pin = yield* GitHubRequestPolicy.PinnedGitHubCredential;
    const scope = yield* SourceControlRateLimit.CredentialScope;
    return { pinned: pin === null ? null : loginOf(pin.credentialFingerprint), scope };
  });

  const service: GitHubRest.GitHubRest["Service"] = {
    credential: (_host, cwd) =>
      Effect.gen(function* () {
        state.credentialCalls++;
        if (state.gate !== null && state.credentialCalls === state.gate.callers) {
          yield* Deferred.succeed(state.gate.arrived, undefined);
        }
        const { host: _, ...held } = credentialOf(folderLogin(cwd));
        return state.explicit ? { ...held, explicit: true as const } : held;
      }),
    rest: (input) =>
      Effect.gen(function* () {
        const { pinned, scope } = yield* whoami;
        const as = pinned ?? folderLogin(input.cwd);
        sent.push({ kind: "probe", path: input.path, as, pinned, scope });
        if (state.gate !== null && pinned === null) yield* Deferred.await(state.gate.release);
        const access = state.access.get(`${as} ${input.path}`) ?? 404;
        const context = { host: HOST, operation: input.operation };
        if (state.paused.has(as) && !(yield* SourceControlRateLimit.Interactive)) {
          return yield* new SourceControlRateLimit.SourceControlRateLimitPausedError({
            provider: SourceControlProviderKind.make("github"),
            host: HOST,
            retryAt: 0,
          });
        }
        if (access === "ok") {
          return { status: 200, headers: {}, body: "{}", truncated: false, invalidUtf8: false };
        }
        if (access === "die") return yield* Effect.die(new Error("probe crashed"));
        if (access === 404) return yield* new GitHubRequestPolicy.GitHubApiNotFoundError(context);
        if (access === 401) {
          return yield* new GitHubRequestPolicy.GitHubApiAuthenticationError(context);
        }
        return yield* new GitHubRequestPolicy.GitHubApiResponseError({
          ...context,
          status: access,
        });
      }),
    withDirectory: () => () => Effect.die("unused"),
    appCredential: () => Effect.succeedNone,
    account: (host, login) =>
      state.signedOut.has(login)
        ? Effect.fail(new GitHubCredentials.GitHubNotSignedInError({ host, account: login }))
        : Effect.succeed(credentialOf(login)),
    others: (host, cwd) =>
      Effect.suspend(() => {
        state.othersCalls++;
        if (state.othersFailures > 0) {
          state.othersFailures--;
          return Effect.fail(new GitHubCredentials.GitHubCliFailedError({ host, cause: "status" }));
        }
        return Effect.succeed(
          state.logins
            .filter((login) => login !== folderLogin(cwd))
            .map((login) => {
              if (!state.nameless) return credentialOf(login);
              const { account: _, ...held } = credentialOf(login);
              return held;
            }),
        );
      }),
  };

  /** The wrapped call: records who it ran as, then answers with `answer` for that login. */
  const call = (cwd: string | null, answer: (as: string) => Access = () => "ok") =>
    Effect.gen(function* () {
      const { pinned, scope } = yield* whoami;
      const as = pinned ?? folderLogin(cwd);
      sent.push({ kind: "effect", path: "call", as, pinned, scope });
      const outcome = answer(as);
      const context = { host: HOST, operation: "call" };
      if (outcome === 404) return yield* new GitHubRequestPolicy.GitHubApiNotFoundError(context);
      if (outcome === 401) {
        return yield* new GitHubRequestPolicy.GitHubApiAuthenticationError(context);
      }
      if (outcome !== "ok") {
        return yield* new GitHubRequestPolicy.GitHubApiResponseError({
          ...context,
          status: 502,
        });
      }
      return as;
    });

  const spans: Array<Tracer.NativeSpan> = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });

  return {
    state,
    service,
    call,
    tracer,
    probes: () => sent.filter((entry) => entry.kind === "probe"),
    effects: () => sent.filter((entry) => entry.kind === "effect"),
    /** One wrapped call's `github.account_route.*` annotations, by index. */
    annotations: (index: number) =>
      Object.fromEntries(
        [
          ...(spans.filter((span) => span.name === "call")[index]?.attributes.entries() ?? []),
        ].filter(([key]) => key.startsWith("github.account_route")),
      ),
    /** The `github.account_route` annotations on the wrapped calls' spans, in order. */
    routes: () =>
      spans
        .filter((span) => span.name === "call")
        .map((span) => {
          const login = span.attributes.get("github.account_route.login");
          const route = String(span.attributes.get("github.account_route"));
          return login === undefined ? route : `${route}:${String(login)}`;
        }),
  };
}

const R = "repos/o/r";

describe("makeRepositoryAccountRouter", () => {
  /** A fresh harness and a router over it; `run` wraps one call in a span named "call". */
  const setup = () => {
    const h = harness();
    const router = makeRepositoryAccountRouter(h.service).pipe(
      Effect.map(
        (made) =>
          (cwd: string | null, repository = "o/r", answer?: (as: string) => Access, host = HOST) =>
            made(h.call(cwd, answer), { host, cwd, repository }).pipe(Effect.withSpan("call")),
      ),
    );
    return { ...h, router };
  };

  it.effect("pinned call runs once without probing", () => {
    const h = setup();
    return Effect.gen(function* () {
      const run = yield* h.router;
      const exit = yield* run("/x", "o/r", () => 404).pipe(
        Effect.provideService(GitHubRequestPolicy.PinnedGitHubCredential, {
          host: HOST,
          token: Redacted.make("token-B"),
          source: "gh",
          account: "B",
          credentialFingerprint: "fp-B",
        }),
        Effect.exit,
      );
      expect(Exit.isFailure(exit) && String(exit.cause)).toContain("GitHubApiNotFoundError");
      expect(h.probes()).toEqual([]);
      expect(h.effects().map((entry) => entry.pinned)).toEqual(["B"]);
      expect(h.state.credentialCalls).toBe(0);
      expect(h.routes()).toEqual(["pinned"]);
    }).pipe(Effect.withTracer(h.tracer));
  });

  it.effect("explicit folder credential runs once without probing", () => {
    const h = setup();
    h.state.explicit = true;
    h.state.access.set(`B ${R}`, "ok");
    return Effect.gen(function* () {
      const run = yield* h.router;
      yield* run("/x");
      expect(h.probes()).toEqual([]);
      expect(h.effects().map((entry) => entry.pinned)).toEqual([null]);
      expect(h.routes()).toEqual(["explicit"]);
    }).pipe(Effect.withTracer(h.tracer));
  });

  it.effect("folder sees repo: runs unpinned, others never called", () => {
    const h = setup();
    h.state.access.set(`A ${R}`, "ok");
    h.state.access.set(`B ${R}`, "ok");
    return Effect.gen(function* () {
      const run = yield* h.router;
      expect(yield* run("/x")).toBe("A");
      expect(h.probes().map((entry) => `${entry.as} ${entry.path}`)).toEqual([`A ${R}`]);
      expect(h.effects().map((entry) => entry.pinned)).toEqual([null]);
      expect(h.state.othersCalls).toBe(0);
      expect(h.routes()).toEqual(["folder"]);
    }).pipe(Effect.withTracer(h.tracer));
  });

  it.effect("folder answer is remembered for 10 minutes", () => {
    const h = setup();
    h.state.access.set(`A ${R}`, "ok");
    return Effect.gen(function* () {
      const run = yield* h.router;
      yield* run("/x");
      yield* TestClock.adjust("9 minutes");
      yield* run("/x");
      expect(h.probes()).toHaveLength(1);
      yield* TestClock.adjust("2 minutes");
      yield* run("/x");
      expect(h.probes()).toHaveLength(2);
    });
  });

  it.effect("folder that can see the repo is never pinned to another folder's login", () => {
    const h = setup();
    h.state.access.set(`B ${R}`, "ok");
    h.state.access.set(`C ${R}`, "ok");
    return Effect.gen(function* () {
      const run = yield* h.router;
      expect(yield* run("/x")).toBe("B");
      expect(yield* run("/y")).toBe("C");
      expect(h.effects().map((entry) => entry.pinned)).toEqual(["B", null]);
      expect(h.probes().map((entry) => entry.as)).toEqual(["A", "B", "C"]);
      expect(h.routes()).toEqual(["login:B", "folder"]);
    }).pipe(Effect.withTracer(h.tracer));
  });

  it.effect("only B sees repo: one probe chain, effect once as B; second call skips probes", () => {
    const h = setup();
    h.state.access.set(`B ${R}`, "ok");
    return Effect.gen(function* () {
      const run = yield* h.router;
      expect(yield* run("/x")).toBe("B");
      expect(h.probes().map((entry) => [entry.as, entry.pinned, entry.scope])).toEqual([
        ["A", null, ""],
        ["B", "B", "fp-B"],
      ]);
      expect(h.effects()).toEqual([
        { kind: "effect", path: "call", as: "B", pinned: "B", scope: "fp-B" },
      ]);
      yield* TestClock.adjust("9 minutes");
      expect(yield* run("/x")).toBe("B");
      expect(h.probes()).toHaveLength(2);
      expect(h.effects()).toHaveLength(2);
      expect(h.routes()).toEqual(["login:B", "login:B"]);
      yield* TestClock.adjust("2 minutes");
      yield* run("/x");
      expect(h.probes()).toHaveLength(4);
    }).pipe(Effect.withTracer(h.tracer));
  });

  it.effect("sso 403 is unchanged for 60s", () => {
    const h = setup();
    h.state.access.set(`A ${R}`, 403);
    h.state.access.set(`B ${R}`, "ok");
    return Effect.gen(function* () {
      const run = yield* h.router;
      for (let index = 0; index < 4; index++) yield* run("/x");
      expect(h.probes()).toHaveLength(1);
      expect(h.state.othersCalls).toBe(0);
      expect(h.effects().map((entry) => entry.pinned)).toEqual([null, null, null, null]);
      expect(h.routes()).toEqual(["unchanged", "unchanged", "unchanged", "unchanged"]);
      yield* TestClock.adjust("61 seconds");
      yield* run("/x");
      expect(h.probes()).toHaveLength(2);
    }).pipe(Effect.withTracer(h.tracer));
  });

  it.effect("B probe 502 is unchanged, not none", () => {
    const h = setup();
    h.state.access.set(`B ${R}`, 502);
    h.state.access.set(`C ${R}`, "ok");
    return Effect.gen(function* () {
      const run = yield* h.router;
      expect(yield* run("/x")).toBe("A");
      // B's failure stops the chain: C, which could see it, is never asked.
      expect(h.probes().map((entry) => entry.as)).toEqual(["A", "B"]);
      expect(h.routes()).toEqual(["unchanged"]);
      h.state.access.set(`B ${R}`, "ok");
      yield* TestClock.adjust("61 seconds");
      expect(yield* run("/x")).toBe("B");
      expect(h.effects().map((entry) => entry.pinned)).toEqual([null, "B"]);
    }).pipe(Effect.withTracer(h.tracer));
  });

  it.effect("remembered B answering 404 is forgotten without replay", () => {
    const h = setup();
    h.state.access.set(`B ${R}`, "ok");
    return Effect.gen(function* () {
      const run = yield* h.router;
      yield* run("/x");
      const exit = yield* run("/x", "o/r", () => 404).pipe(Effect.exit);
      expect(Exit.isFailure(exit) && String(exit.cause)).toContain("GitHubApiNotFoundError");
      expect(h.effects()).toHaveLength(2);
      expect(h.probes()).toHaveLength(2);
      yield* run("/x");
      expect(h.probes()).toHaveLength(4);
    });
  });

  it.effect("remembered B answering 401 is forgotten without replay", () => {
    const h = setup();
    h.state.access.set(`B ${R}`, "ok");
    return Effect.gen(function* () {
      const run = yield* h.router;
      yield* run("/x");
      const exit = yield* run("/x", "o/r", () => 401).pipe(Effect.exit);
      expect(Exit.isFailure(exit) && String(exit.cause)).toContain("GitHubApiAuthenticationError");
      expect(h.effects()).toHaveLength(2);
      yield* run("/x");
      expect(h.probes()).toHaveLength(4);
    });
  });

  it.effect("remembered B failing for another reason stays remembered", () => {
    const h = setup();
    h.state.access.set(`B ${R}`, "ok");
    return Effect.gen(function* () {
      const run = yield* h.router;
      yield* run("/x");
      const exit = yield* run("/x", "o/r", () => 502).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(yield* run("/x")).toBe("B");
      expect(h.probes()).toHaveLength(2);
      expect(h.effects()).toHaveLength(3);
    });
  });

  it.effect("account() failure runs unpinned and forgets", () => {
    const h = setup();
    h.state.access.set(`B ${R}`, "ok");
    h.state.signedOut.add("B");
    return Effect.gen(function* () {
      const run = yield* h.router;
      expect(yield* run("/x")).toBe("A");
      expect(h.effects().map((entry) => [entry.pinned, entry.scope])).toEqual([[null, ""]]);
      expect(h.routes()).toEqual(["unchanged"]);
      h.state.signedOut.clear();
      expect(yield* run("/x")).toBe("B");
      expect(h.probes()).toHaveLength(4);
    }).pipe(Effect.withTracer(h.tracer));
  });

  it.effect("two repos never share an entry", () => {
    const h = setup();
    h.state.access.set(`B ${R}`, "ok");
    h.state.access.set("A repos/o/s", "ok");
    return Effect.gen(function* () {
      const run = yield* h.router;
      expect(yield* run("/x", "o/r")).toBe("B");
      expect(yield* run("/x", "o/s")).toBe("A");
      expect(h.probes().map((entry) => `${entry.as} ${entry.path}`)).toEqual([
        `A ${R}`,
        `B ${R}`,
        "A repos/o/s",
      ]);
    });
  });

  it.effect("host, owner and name match case-insensitively", () => {
    const h = setup();
    h.state.access.set(`B ${R}`, "ok");
    return Effect.gen(function* () {
      const run = yield* h.router;
      yield* run("/x", "o/r");
      yield* run("/x", " O/R ", undefined, "GitHub.com");
      expect(h.probes()).toHaveLength(2);
      expect(h.effects().map((entry) => entry.pinned)).toEqual(["B", "B"]);
    });
  });

  it.effect("five concurrent cold calls run one probe chain", () => {
    const h = setup();
    h.state.access.set(`B ${R}`, "ok");
    return Effect.gen(function* () {
      const run = yield* h.router;
      const gate = {
        callers: 5,
        arrived: yield* Deferred.make<void>(),
        release: yield* Deferred.make<void>(),
      };
      h.state.gate = gate;
      // Every caller reaches the cache while the first folder probe is still in flight.
      const calls = yield* Effect.all(
        Array.from({ length: 5 }, () => run("/x")),
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild);
      yield* Deferred.await(gate.arrived);
      yield* Deferred.succeed(gate.release, undefined);
      expect(yield* Fiber.join(calls)).toEqual(["B", "B", "B", "B", "B"]);
      expect(h.probes()).toHaveLength(2);
      expect(h.state.othersCalls).toBe(1);
    });
  });

  it.effect("two folders on one login share one probe chain", () => {
    const h = setup();
    h.state.access.set(`B ${R}`, "ok");
    return Effect.gen(function* () {
      const run = yield* h.router;
      expect(yield* run("/x")).toBe("B");
      expect(yield* run("/z")).toBe("B");
      expect(h.probes()).toHaveLength(2);
    });
  });

  it.effect("none suppresses probes for 60s", () => {
    const h = setup();
    return Effect.gen(function* () {
      const run = yield* h.router;
      yield* run("/x");
      yield* run("/x");
      expect(h.probes().map((entry) => entry.as)).toEqual(["A", "B", "C"]);
      expect(h.effects().map((entry) => entry.pinned)).toEqual([null, null]);
      expect(h.routes()).toEqual(["none", "none"]);
      yield* TestClock.adjust("61 seconds");
      yield* run("/x");
      expect(h.probes()).toHaveLength(6);
    }).pipe(Effect.withTracer(h.tracer));
  });

  it.effect("a probe that crashes is not remembered", () => {
    const h = setup();
    h.state.access.set(`A ${R}`, "die");
    return Effect.gen(function* () {
      const run = yield* h.router;
      const exit = yield* run("/x").pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(h.effects()).toHaveLength(0);
      h.state.access.set(`A ${R}`, "ok");
      expect(yield* run("/x")).toBe("A");
      expect(h.probes()).toHaveLength(2);
    });
  });

  it.effect("a repository without an owner runs unchanged without probing", () => {
    const h = setup();
    return Effect.gen(function* () {
      const run = yield* h.router;
      yield* run("/x", "r");
      yield* run("/x", " /r/ ");
      expect(h.probes()).toEqual([]);
      expect(h.effects().map((entry) => entry.pinned)).toEqual([null, null]);
      expect(h.routes()).toEqual(["unchanged", "unchanged"]);
      // Leading and trailing slashes are ignored, as every other GitHub call reads the selector.
      yield* run("/x", "/o/r/");
      expect(h.probes()[0]?.path).toBe(R);
    }).pipe(Effect.withTracer(h.tracer));
  });

  it.effect("a login that can see it but carries no name is unchanged", () => {
    const h = setup();
    h.state.nameless = true;
    h.state.access.set(`B ${R}`, "ok");
    return Effect.gen(function* () {
      const run = yield* h.router;
      expect(yield* run("/x")).toBe("A");
      expect(h.routes()).toEqual(["unchanged"]);
    }).pipe(Effect.withTracer(h.tracer));
  });

  it.effect("hostile owner and name are encoded into one path segment each", () => {
    const h = setup();
    return Effect.gen(function* () {
      const run = yield* h.router;
      yield* run("/x", "-o $|[*]\n/n a$|[*]");
      expect(h.probes()[0]?.path).toBe(
        `repos/${encodeURIComponent("-o $|[*]\n")}/${encodeURIComponent("n a$|[*]")}`,
      );
    });
  });

  it.effect("a background probe refused locally is not remembered over an interactive read", () =>
    Effect.gen(function* () {
      for (const paused of [false, true]) {
        const h = setup();
        h.state.access.set(`B ${R}`, "ok");
        if (paused) h.state.paused.add("A");
        const run = yield* h.router;
        const background = yield* run("/x");
        const interactive = yield* run("/x").pipe(
          Effect.provideService(SourceControlRateLimit.Interactive, true),
        );
        // Refused before reaching GitHub, the first call runs as the folder; the next one probes.
        expect([background, interactive]).toEqual([paused ? "A" : "B", "B"]);
        expect(h.probes().map((entry) => entry.as)).toEqual(paused ? ["A", "A", "B"] : ["A", "B"]);
      }
    }),
  );

  it.effect("another login's probe refused locally is remembered for 60s", () => {
    const h = setup();
    h.state.access.set(`B ${R}`, "ok");
    h.state.paused.add("B");
    return Effect.gen(function* () {
      const run = yield* h.router;
      for (let index = 0; index < 5; index++) expect(yield* run("/x")).toBe("A");
      // The folder probe reached GitHub once; nothing is re-sent while B stays paused.
      expect(h.probes().map((entry) => entry.as)).toEqual(["A", "B"]);
      expect(h.annotations(4)["github.account_route.reason"]).toBe("login-refused");
      h.state.paused.clear();
      yield* TestClock.adjust("61 seconds");
      expect(yield* run("/x")).toBe("B");
    }).pipe(Effect.withTracer(h.tracer));
  });

  it.effect("an interactive read re-asks a login a background read found paused", () =>
    Effect.gen(function* () {
      for (const interactive of [false, true]) {
        const h = setup();
        h.state.access.set(`B ${R}`, "ok");
        h.state.paused.add("B");
        const run = yield* h.router;
        const background = yield* run("/x");
        const second = yield* run("/x").pipe(
          Effect.provideService(SourceControlRateLimit.Interactive, interactive),
        );
        expect([background, second]).toEqual(["A", interactive ? "B" : "A"]);
        expect(h.probes().map((entry) => entry.as)).toEqual(
          interactive ? ["A", "B", "A", "B"] : ["A", "B"],
        );
      }
    }),
  );

  it.effect("a failed login listing is not remembered as none", () => {
    const h = setup();
    h.state.access.set(`B ${R}`, "ok");
    h.state.othersFailures = 1;
    return Effect.gen(function* () {
      const run = yield* h.router;
      expect(yield* run("/x")).toBe("A");
      expect(yield* run("/x")).toBe("B");
      expect(h.routes()).toEqual(["unchanged", "login:B"]);
      expect(h.annotations(0)["github.account_route.reason"]).toBe("logins-unavailable");
    }).pipe(Effect.withTracer(h.tracer));
  });

  it.effect("annotates why a call ran unchanged and when a login is forgotten", () => {
    const h = setup();
    h.state.access.set(`B ${R}`, "ok");
    h.state.access.set("A repos/o/e", 502);
    h.state.access.set("B repos/o/n", "ok");
    h.state.paused.add("A");
    return Effect.gen(function* () {
      const run = yield* h.router;
      yield* run("/x", "o/p");
      h.state.paused.clear();
      yield* run("/x", "o/e");
      yield* run("/x", "r");
      h.state.nameless = true;
      yield* run("/x", "o/n");
      h.state.nameless = false;
      yield* run("/x");
      h.state.signedOut.add("B");
      yield* run("/x");
      h.state.signedOut.clear();
      yield* run("/x");
      yield* run("/x", "o/r", () => 404).pipe(Effect.exit);
      const reason = (index: number) => h.annotations(index)["github.account_route.reason"];
      expect([0, 1, 2, 3].map(reason)).toEqual([
        "refused-locally",
        "probe-error",
        "malformed-repository",
        "nameless-login",
      ]);
      expect(h.annotations(4)).toEqual({
        "github.account_route": "login",
        "github.account_route.login": "B",
      });
      expect(h.annotations(5)).toEqual({
        "github.account_route": "unchanged",
        "github.account_route.reason": "account-unavailable",
        "github.account_route.forgot": "B",
      });
      expect(h.annotations(7)).toEqual({
        "github.account_route": "login",
        "github.account_route.login": "B",
        "github.account_route.forgot": "B",
      });
    }).pipe(Effect.withTracer(h.tracer));
  });
});
