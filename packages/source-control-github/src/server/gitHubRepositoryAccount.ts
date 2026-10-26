import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Hash from "effect/Hash";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";

import type * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import type * as GitHubRest from "./GitHubRest.ts";

type RepositoryAccount =
  | { readonly _tag: "Folder" }
  | { readonly _tag: "None" }
  | {
      readonly _tag: "Unchanged";
      readonly reason:
        | "probe-error"
        | "nameless-login"
        | "refused-locally"
        | "login-refused"
        | "logins-unavailable";
    }
  | { readonly _tag: "Login"; readonly login: string };

const REMEMBER_ACCOUNT = Duration.minutes(10);
const REMEMBER_UNKNOWN = Duration.seconds(60);

const pinned =
  (credential: GitHubCredentials.GitHubCredential) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) => {
    const { fingerprint, ...held } = credential;
    return effect.pipe(
      Effect.provideService(GitHubRequestPolicy.PinnedGitHubCredential, {
        ...held,
        credentialFingerprint: fingerprint,
      }),
      Effect.provideService(SourceControlRateLimit.CredentialScope, fingerprint),
    );
  };

/** Equal by `id` alone, so folders on one login share an entry; the first caller's `cwd` probes. */
class Target implements Equal.Equal {
  readonly id: string;
  readonly host: string;
  readonly path: string;
  readonly cwd: string | null;
  constructor(input: Pick<Target, "id" | "host" | "path" | "cwd">) {
    this.id = input.id;
    this.host = input.host;
    this.path = input.path;
    this.cwd = input.cwd;
  }
  [Equal.symbol](that: Equal.Equal): boolean {
    return that instanceof Target && that.id === this.id;
  }
  [Hash.symbol](): number {
    return Hash.string(this.id);
  }
}

/** `owner/name` (or a longer path ending in them); an absent part is "". */
export function parseRepositorySelector(value: string): {
  readonly owner: string;
  readonly name: string;
} {
  const parts = value.trim().split("/").filter(Boolean);
  return { name: parts.at(-1) ?? "", owner: parts.at(-2) ?? "" };
}

/** The wrapped call names this account's repository, so its not-found means the login lost it. */
const forgetsLogin = (error: unknown) =>
  Predicate.isTagged(error, "GitHubApiNotFoundError") ||
  Predicate.isTagged(error, "GitHubApiAuthenticationError");

export const makeRepositoryAccountRouter = Effect.fn("GitHubRepositoryAccount.make")(function* (
  rest: GitHubRest.GitHubRest["Service"],
) {
  const resolve = Effect.fn("GitHubRepositoryAccount.resolve")(function* ({
    host,
    path,
    cwd,
  }: Target) {
    const probe = rest
      .rest({
        host,
        cwd,
        operation: "resolveRepositoryAccount",
        path,
      })
      .pipe(
        Effect.as("visible" as const),
        Effect.catch((error) =>
          Effect.succeed(
            error._tag === "GitHubApiNotFoundError"
              ? ("hidden" as const)
              : error._tag === "SourceControlRateLimitPausedError"
                ? ("refused-locally" as const)
                : ("probe-error" as const),
          ),
        ),
      );
    const unchanged = (reason: Extract<RepositoryAccount, { _tag: "Unchanged" }>["reason"]) =>
      ({ _tag: "Unchanged", reason }) satisfies RepositoryAccount;
    const asFolder = yield* probe;
    if (asFolder === "visible") return { _tag: "Folder" } satisfies RepositoryAccount;
    if (asFolder !== "hidden") return unchanged(asFolder);
    const others = yield* rest.others(host, cwd).pipe(Effect.option);
    if (Option.isNone(others)) return unchanged("logins-unavailable");
    for (const other of others.value) {
      const seen = yield* pinned(other)(probe);
      if (seen === "visible") {
        return other.account === undefined
          ? unchanged("nameless-login")
          : ({ _tag: "Login", login: other.account } satisfies RepositoryAccount);
      }
      // The folder probe already reached GitHub, so this answer is kept like any other.
      if (seen !== "hidden") return unchanged(seen === "refused-locally" ? "login-refused" : seen);
    }
    return { _tag: "None" } satisfies RepositoryAccount;
  });

  const memory = yield* Cache.makeWith(resolve, {
    capacity: 256,
    timeToLive: (exit) =>
      // Nothing was learned about other logins: the folder probe was refused before it left (an
      // interactive caller may get through), or gh could not list them.
      Exit.isFailure(exit) ||
      (exit.value._tag === "Unchanged" &&
        (exit.value.reason === "refused-locally" || exit.value.reason === "logins-unavailable"))
        ? Duration.zero
        : exit.value._tag === "Folder" || exit.value._tag === "Login"
          ? REMEMBER_ACCOUNT
          : REMEMBER_UNKNOWN,
  });

  /**
   * Runs `effect` once, pinned to the login that can see `repository`, or exactly as today.
   * Untraced: it annotates the current span rather than opening another.
   */
  return Effect.fnUntraced(function* <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    target: { readonly host: string; readonly cwd: string | null; readonly repository: string },
  ) {
    const routed = (route: string, reason?: string) =>
      Effect.annotateCurrentSpan({
        "github.account_route": route,
        ...(reason === undefined ? {} : { "github.account_route.reason": reason }),
      });
    if ((yield* GitHubRequestPolicy.PinnedGitHubCredential) !== null) {
      yield* routed("pinned");
      return yield* effect;
    }
    const folder = yield* rest.credential(target.host, target.cwd);
    if (folder.explicit) {
      yield* routed("explicit");
      return yield* effect;
    }
    const selector = parseRepositorySelector(target.repository);
    // The selector fills the name before the owner, so an owner means both parts are there.
    if (selector.owner === "") {
      yield* routed("unchanged", "malformed-repository");
      return yield* effect;
    }
    const host = GitHubRequestPolicy.normalizeHost(target.host);
    const [owner, name] = [selector.owner, selector.name].map((part) =>
      encodeURIComponent(part.toLowerCase()),
    );
    // Encoding leaves no space inside a part, so the parts never run into each other.
    const key = new Target({
      id: [encodeURIComponent(host), owner, name, encodeURIComponent(folder.fingerprint)].join(" "),
      host,
      path: `repos/${owner}/${name}`,
      cwd: target.cwd,
    });
    let account = yield* Cache.get(memory, key);
    // A pause or reserve that refused a background probe does not apply to an interactive caller.
    if (
      account._tag === "Unchanged" &&
      account.reason === "login-refused" &&
      (yield* SourceControlRateLimit.Interactive)
    ) {
      yield* Cache.invalidate(memory, key);
      account = yield* Cache.get(memory, key);
    }
    if (account._tag !== "Login") {
      yield* routed(
        account._tag.toLowerCase(),
        account._tag === "Unchanged" ? account.reason : undefined,
      );
      return yield* effect;
    }
    const forget = Cache.invalidate(memory, key).pipe(
      Effect.andThen(Effect.annotateCurrentSpan("github.account_route.forgot", account.login)),
    );
    const credential = yield* rest.account(target.host, account.login).pipe(Effect.result);
    if (Result.isFailure(credential)) {
      yield* forget;
      yield* routed("unchanged", "account-unavailable");
      return yield* effect;
    }
    yield* Effect.annotateCurrentSpan({
      "github.account_route": "login",
      "github.account_route.login": account.login,
    });
    return yield* pinned(credential.success)(effect).pipe(
      Effect.tapError((error) => (forgetsLogin(error) ? forget : Effect.void)),
    );
  });
});
