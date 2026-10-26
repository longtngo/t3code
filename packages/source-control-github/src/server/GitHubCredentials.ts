import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as HostProcess from "@t3tools/shared/HostProcess";

import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import { readSourceControlHostSettings } from "@t3tools/source-control-core/shared/definition";

import * as GitHubClient from "../shared/definition.ts";
import { parseGitHubAuthStatus } from "./gitHubAuthStatus.ts";

/**
 * Every gh run on the server shares this. A burst of them (a status poll across many checkouts)
 * otherwise starts enough at once to trip GitHub's secondary rate limit.
 */
export const GH_PROCESS_CONCURRENCY = { key: "gh", limit: 4 } as const;

const TOKEN_TTL = Duration.minutes(5);
const MISSING_TTL = Duration.seconds(10);

export const GitHubCredentialSource = Schema.Literals(["settings", "env", "gh", "folder"]);
export type GitHubCredentialSource = typeof GitHubCredentialSource.Type;

/** What git answered when asked which login a folder uses; never anything it printed. */
export type GitHubFolderOutcome = "hit" | "empty" | "exit" | "timeout" | "invalid";

export interface GitHubCredential {
  readonly host: string;
  readonly token: Redacted.Redacted<string>;
  readonly source: GitHubCredentialSource;
  readonly fingerprint: string;
  /** The login gh confirmed this token belongs to, when the request named one. */
  readonly account?: string;
  /** The named login is not signed in to gh, so this is gh's active login instead. */
  readonly fallback?: "not-signed-in";
  /** The login that was asked for when `fallback` replaced it; names which login to sign in. */
  readonly requestedAccount?: string;
  /** What the folder lookup answered, when one was consulted. */
  readonly folder?: GitHubFolderOutcome;
}

export class GitHubCliMissingError extends Schema.TaggedError<GitHubCliMissingError>()(
  "GitHubCliMissingError",
  { host: Schema.String },
) {
  override get message(): string {
    return `No GitHub credential for ${this.host}: set GH_TOKEN, or install the GitHub CLI and run \`gh auth login\`.`;
  }
}

export class GitHubNotSignedInError extends Schema.TaggedError<GitHubNotSignedInError>()(
  "GitHubNotSignedInError",
  { host: Schema.String, account: Schema.optional(Schema.String) },
) {
  override get message(): string {
    return this.account === undefined
      ? `No GitHub credential for ${this.host}: run \`gh auth login --hostname ${this.host}\`.`
      : `No GitHub credential for ${this.account} on ${this.host}: run \`gh auth login --hostname ${this.host}\` for that account or pick another in Settings → Source Control.`;
  }
}

export class GitHubHostDisabledError extends Schema.TaggedError<GitHubHostDisabledError>()(
  "GitHubHostDisabledError",
  { host: Schema.String },
) {
  override get message(): string {
    return `GitHub host ${this.host} is turned off in Settings → Source Control.`;
  }
}

export class GitHubCliFailedError extends Schema.TaggedError<GitHubCliFailedError>()(
  "GitHubCliFailedError",
  { host: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `The GitHub CLI could not hand over a credential for ${this.host}. Check \`gh auth status\` on the server.`;
  }
}

export type GitHubCredentialUnavailableError =
  | GitHubCliMissingError
  | GitHubNotSignedInError
  | GitHubHostDisabledError
  | GitHubCliFailedError;

export class GitHubCredentials extends Context.Service<
  GitHubCredentials,
  {
    /** `cwd` is the project folder whose git config may name the account; null when none. */
    readonly get: (
      host: string,
      cwd: string | null,
    ) => Effect.Effect<GitHubCredential, GitHubCredentialUnavailableError>;
    /** Drops every held token for the host after GitHub refused one, so the next read asks again. */
    readonly invalidate: (host: string) => Effect.Effect<void>;
    /** The other signed-in stored gh logins for `host`; [] when the account was an explicit choice. */
    readonly others: (
      host: string,
      cwd: string | null,
    ) => Effect.Effect<ReadonlyArray<GitHubCredential>>;
  }
>()("@t3tools/source-control-github/server/GitHubCredentials") {}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}

function isGitHubDotCom(host: string): boolean {
  return host === "github.com" || host.endsWith(".ghe.com");
}

/** Restrict GH_ENTERPRISE_TOKEN to GH_HOST to prevent remote URLs from leaking it. */
export function environmentToken(
  host: string,
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const names = isGitHubDotCom(host)
    ? ["GH_TOKEN", "GITHUB_TOKEN"]
    : env.GH_HOST?.trim().toLowerCase() === host
      ? ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]
      : [];
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return null;
}

const USERNAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/u;

/** The `username=` git's credential helpers named, or null. Reads nothing else from the output. */
export function parseFillUsername(stdout: string): string | null {
  for (const line of stdout.split("\n")) {
    if (line.startsWith("username=")) {
      const name = line.slice("username=".length).trim();
      return USERNAME.test(name) ? name : null;
    }
  }
  return null;
}

/** @public */
export const make = Effect.gen(function* () {
  const sourceControlHost = yield* SourceControlHost.SourceControlHost;
  const process = sourceControlHost.process;
  const crypto = yield* Crypto.Crypto;
  const environment = yield* HostProcess.Environment;
  const workingDirectory = yield* HostProcess.WorkingDirectory;

  const fingerprintOf = (host: string, token: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(token)).pipe(
      Effect.map((digest) => `${host}:${Hex.encode(digest)}`),
      Effect.orDie,
    );

  const fromGh = (host: string, account: string | undefined) =>
    process
      .run({
        operation: "GitHubCredentials.get",
        command: "gh",
        args: [
          "auth",
          "token",
          "--hostname",
          host,
          ...(account === undefined ? [] : ["--user", account]),
        ],
        cwd: workingDirectory,
        // Never let gh print the token into a debug log. Blank the token variables too: gh hands
        // GH_ENTERPRISE_TOKEN to any --hostname, and environmentToken already picked the hosts
        // an environment token may go to, so here gh answers only from its own logins.
        env: {
          GH_DEBUG: "",
          GH_PROMPT_DISABLED: "1",
          GH_TOKEN: "",
          GITHUB_TOKEN: "",
          GH_ENTERPRISE_TOKEN: "",
          GITHUB_ENTERPRISE_TOKEN: "",
        },
        timeoutMs: 10_000,
        concurrency: GH_PROCESS_CONCURRENCY,
      })
      .pipe(
        Effect.mapError((error) =>
          error._tag === "VcsProcessSpawnError" &&
          error.cause instanceof PlatformError.PlatformError &&
          error.cause.reason._tag === "NotFound"
            ? new GitHubCliMissingError({ host })
            : // gh exits non-zero with "no oauth token" when it has no login for the host.
              error._tag === "VcsProcessExitError"
              ? new GitHubNotSignedInError({ host, ...(account === undefined ? {} : { account }) })
              : new GitHubCliFailedError({ host, cause: error }),
        ),
        Effect.map((output) => output.stdout.trim()),
        Effect.filterOrFail(
          (token) => token !== "",
          () => new GitHubNotSignedInError({ host, ...(account === undefined ? {} : { account }) }),
        ),
      );

  /**
   * The Settings choice and saved token for a host, read fresh so a change applies at once.
   * Unreadable settings fall back to gh's own choice and no saved token.
   */
  const hostSettings = (host: string) =>
    sourceControlHost.settings.get.pipe(
      Effect.map((settings) => {
        const github = readSourceControlHostSettings(
          GitHubClient.settings,
          settings.sourceControlHosts[GitHubClient.definition.kind],
        );
        return { choice: github.hosts[host], saved: github.tokens[host]?.trim() || null };
      }),
      Effect.orElseSucceed(() => ({ choice: undefined, saved: null })),
    );

  /** Which login git's own config picks for `host` in `cwd`; null when it has no answer. */
  const lookupFolderAccount = Effect.fn("GitHubCredentials.folderAccount")(function* (
    host: string,
    cwd: string,
  ) {
    const outcome = (value: GitHubFolderOutcome, account: string | null = null) =>
      Effect.annotateCurrentSpan("github.folder_account.outcome", value).pipe(
        Effect.as({ account, outcome: value }),
      );
    if (host.includes("\n")) return yield* outcome("invalid");
    return yield* process
      .run({
        operation: "GitHubCredentials.folderAccount",
        command: "git",
        args: ["-c", "credential.interactive=never", "-C", cwd, "credential", "fill"],
        cwd,
        stdin: `protocol=https\nhost=${host}\n\n`,
        env: {
          ...SourceControlHost.GIT_REMOTE_PROMPT_ENV,
          GIT_DIR: undefined,
          GIT_WORK_TREE: undefined,
          GIT_COMMON_DIR: undefined,
        },
        allowNonZeroExit: true,
        outputMode: "error",
        maxOutputBytes: 65_536,
        timeoutMs: 2_000,
      })
      .pipe(
        // Only the username leaves here: the output also carries a password.
        Effect.flatMap((output) => {
          const account = output.exitCode === 0 ? parseFillUsername(output.stdout) : null;
          return outcome(
            output.exitCode !== 0
              ? "exit"
              : account !== null
                ? "hit"
                : output.stdout.includes("username=")
                  ? "invalid"
                  : "empty",
            account,
          );
        }),
        Effect.catch((error) =>
          outcome(error._tag === "VcsProcessTimeoutError" ? "timeout" : "exit"),
        ),
      );
  });

  /** Keyed `host\0cwd`; every answer, none included, is kept as long as a token. */
  const folderCache = yield* Cache.makeWith(
    (key: string) => {
      const [host = key, cwd = ""] = key.split("\u0000");
      return lookupFolderAccount(host, cwd);
    },
    { capacity: 256, timeToLive: () => TOKEN_TTL },
  );

  /** Keyed `host` for gh's active login or `host\0account` for a named one. */
  const lookup = Effect.fn("GitHubCredentials.lookup")(function* (key: string) {
    const [host = key, account] = key.split("\u0000");
    const token = yield* fromGh(host, account).pipe(
      Effect.tapError((error) =>
        account !== undefined && error._tag === "GitHubNotSignedInError"
          ? // Neutral: `named` falls back to the active login, but `others` just skips this one.
            Effect.logWarning(`GitHub account ${account} on ${host} is not signed in to gh`)
          : Effect.void,
      ),
    );
    return { token: Redacted.make(token), fingerprint: yield* fingerprintOf(host, token) };
  });

  const tokenCache = yield* Cache.makeWith(lookup, {
    capacity: 32,
    // A transient gh failure (a timeout, a locked keyring) is asked again on the next read; a
    // named login gh lacks is remembered as long as a token, so its warning logs once per TTL.
    timeToLive: (exit) => {
      const error = Option.getOrUndefined(Exit.findErrorOption(exit));
      return Exit.isSuccess(exit)
        ? TOKEN_TTL
        : error?._tag === "GitHubCliFailedError"
          ? Duration.zero
          : error?._tag === "GitHubNotSignedInError" && error.account !== undefined
            ? TOKEN_TTL
            : MISSING_TTL;
    },
  });

  const active = (host: string) =>
    Cache.get(tokenCache, host).pipe(
      Effect.map((held): GitHubCredential => ({ host, ...held, source: "gh" })),
    );

  /** A named login's token; one gh no longer holds (logged out, expired) falls back to active. */
  const named = (host: string, account: string, source: "gh" | "folder") =>
    Cache.get(tokenCache, `${host}\u0000${account}`).pipe(
      Effect.map((held): GitHubCredential => ({ host, ...held, source, account })),
      Effect.catchTags({
        GitHubNotSignedInError: () =>
          active(host).pipe(
            Effect.map((credential): GitHubCredential => ({
              ...credential,
              fallback: "not-signed-in",
              requestedAccount: account,
            })),
          ),
      }),
    );

  const ghLogins = (host: string) =>
    process
      .run({
        operation: "GitHubCredentials.others",
        command: "gh",
        args: ["auth", "status", "--json", "hosts", "--hostname", host],
        cwd: workingDirectory,
        env: {
          GH_DEBUG: "",
          GH_PROMPT_DISABLED: "1",
          GH_TOKEN: "",
          GITHUB_TOKEN: "",
          GH_ENTERPRISE_TOKEN: "",
          GITHUB_ENTERPRISE_TOKEN: "",
        },
        // gh exits 1 when any stored login has failed; the JSON still lists the others.
        allowNonZeroExit: true,
        timeoutMs: 10_000,
        concurrency: GH_PROCESS_CONCURRENCY,
      })
      .pipe(
        Effect.map((output) =>
          parseGitHubAuthStatus(output.stdout)
            .accounts.filter(
              (entry) =>
                entry.host === host && entry.authenticated && entry.environmentVariable === null,
            )
            .map((entry) => entry.account),
        ),
      );

  const get: GitHubCredentials["Service"]["get"] = Effect.fn("GitHubCredentials.get")(
    function* (rawHost, cwd) {
      const host = normalizeHost(rawHost);
      const { choice, saved } = yield* hostSettings(host);
      if (choice?.enabled === false) {
        return yield* new GitHubHostDisabledError({ host });
      }
      // A token saved in Settings is the most deliberate choice, so it comes before the
      // environment and gh. It is read from the secret store each time, so it needs no cache.
      if (saved !== null) {
        return {
          host,
          token: Redacted.make(saved),
          source: "settings",
          fingerprint: yield* fingerprintOf(host, saved),
        } satisfies GitHubCredential;
      }
      // An environment token wins over any account, exactly as it does in gh.
      const fromEnv = environmentToken(host, environment);
      if (fromEnv !== null) {
        return {
          host,
          token: Redacted.make(fromEnv),
          source: "env",
          fingerprint: yield* fingerprintOf(host, fromEnv),
        } satisfies GitHubCredential;
      }
      // A pin outranks the folder: outside configured trees git answers with the active login.
      if (choice?.account !== undefined) return yield* named(host, choice.account, "gh");
      if (cwd === null) return yield* active(host);
      const folder = yield* Cache.get(folderCache, `${host}\u0000${cwd}`);
      const credential = yield* folder.account === null
        ? active(host)
        : named(host, folder.account, "folder");
      return { ...credential, folder: folder.outcome };
    },
  );

  return GitHubCredentials.of({
    get,
    others: Effect.fn("GitHubCredentials.others")(function* (rawHost, cwd) {
      const host = normalizeHost(rawHost);
      // Only when T3 picked the account itself. Read from Settings rather than the credential's
      // `source`: a pin and a signed-out folder account both come back as `gh`.
      const { choice, saved } = yield* hostSettings(host);
      if (choice?.enabled === false || saved !== null || choice?.account !== undefined) return [];
      if (environmentToken(host, environment) !== null) return [];
      const tried = yield* get(host, cwd).pipe(Effect.option);
      if (Option.isNone(tried)) return [];
      const logins = yield* ghLogins(host).pipe(Effect.orElseSucceed(() => []));
      const found: Array<GitHubCredential> = [];
      for (const login of logins) {
        // Straight from the token cache, not `named`: a signed-out login is skipped rather than
        // replaced by the active one, so no two entries share a token and each names its sender.
        const held = yield* Cache.get(tokenCache, `${host}\u0000${login}`).pipe(Effect.option);
        if (Option.isNone(held) || held.value.fingerprint === tried.value.fingerprint) continue;
        found.push({ host, ...held.value, source: "gh", account: login });
      }
      return found;
    }),
    invalidate: Effect.fn("GitHubCredentials.invalidate")(function (rawHost) {
      const host = normalizeHost(rawHost);
      return Cache.keys(tokenCache).pipe(
        Effect.flatMap((keys) =>
          Effect.forEach(
            Array.from(keys).filter((key) => key === host || key.startsWith(`${host}\u0000`)),
            (key) => Cache.invalidate(tokenCache, key),
            { discard: true },
          ),
        ),
      );
    }),
  });
});

export const layer = Layer.effect(GitHubCredentials, make);
