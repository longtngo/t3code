/**
 * OAuthUsage — fetch normalized Claude account usage from the Anthropic OAuth
 * usage API (`GET /api/oauth/usage`).
 *
 * This is the same data source the reference `statusline.sh` uses for its
 * `5h` / `7d` / `extra` segments. The `@anthropic-ai/claude-agent-sdk` does not
 * expose its OAuth token to host code, so — exactly like the statusline — we
 * resolve the token directly from the local credential stores (env var → macOS
 * Keychain → credentials file). Everything here is best-effort: a missing token
 * or a failed request yields `null` and the UI simply shows no usage readout.
 *
 * @module OAuthUsage
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";

import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import type { AccountUsageUpdatedPayload } from "@t3tools/contracts";

const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
// Bound both the keychain subprocess and the HTTP request so a hung credential
// store or network call can never stall the poller (statusline.sh uses --max-time 10).
const REQUEST_TIMEOUT = Duration.seconds(10);
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const OAUTH_BETA_HEADER = "oauth-2025-04-20";
const USER_AGENT = "claude-code/statusline";

export class OAuthUsageFetchError extends Data.TaggedError("OAuthUsageFetchError")<{
  readonly detail: string;
  readonly cause?: unknown;
}> {}

// ---------------------------------------------------------------------------
// Raw API response → normalized payload
// ---------------------------------------------------------------------------

const RawWindow = Schema.Struct({
  utilization: Schema.optional(Schema.NullOr(Schema.Number)),
  resets_at: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawExtra = Schema.Struct({
  is_enabled: Schema.optional(Schema.NullOr(Schema.Boolean)),
  monthly_limit: Schema.optional(Schema.NullOr(Schema.Number)),
  used_credits: Schema.optional(Schema.NullOr(Schema.Number)),
  utilization: Schema.optional(Schema.NullOr(Schema.Number)),
  currency: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawUsageResponse = Schema.Struct({
  five_hour: Schema.optional(Schema.NullOr(RawWindow)),
  seven_day: Schema.optional(Schema.NullOr(RawWindow)),
  extra_usage: Schema.optional(Schema.NullOr(RawExtra)),
});
export type RawUsageResponse = typeof RawUsageResponse.Type;

const decodeRawUsage = Schema.decodeUnknownEffect(RawUsageResponse);

const normalizeWindow = (
  window: typeof RawWindow.Type | null | undefined,
): AccountUsageUpdatedPayload["fiveHour"] => {
  if (!window) return null;
  return {
    utilization: window.utilization ?? 0,
    resetsAt: window.resets_at ?? null,
  };
};

/**
 * Map the raw OAuth usage JSON to the normalized contract payload. Credits stay
 * in integer cents (the web layer formats them). Pure — primary unit-test seam.
 */
export const normalizeUsage = (raw: RawUsageResponse): AccountUsageUpdatedPayload => {
  const extra = raw.extra_usage
    ? {
        isEnabled: raw.extra_usage.is_enabled ?? false,
        usedCredits: raw.extra_usage.used_credits ?? 0,
        monthlyLimit: raw.extra_usage.monthly_limit ?? 0,
        utilization: raw.extra_usage.utilization ?? 0,
        currency: raw.extra_usage.currency ?? null,
      }
    : null;
  return {
    fiveHour: normalizeWindow(raw.five_hour),
    sevenDay: normalizeWindow(raw.seven_day),
    extra,
  };
};

// ---------------------------------------------------------------------------
// OAuth token resolution (env → macOS Keychain → credentials file)
// ---------------------------------------------------------------------------

const claudeConfigDir = (env: NodeJS.ProcessEnv): string =>
  env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.length > 0
    ? env.CLAUDE_CONFIG_DIR
    : `${homedir()}/.claude`;

const keychainServiceName = (env: NodeJS.ProcessEnv): string => {
  if (env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.length > 0) {
    const hash = createHash("sha256").update(env.CLAUDE_CONFIG_DIR).digest("hex").slice(0, 8);
    return `${KEYCHAIN_SERVICE}-${hash}`;
  }
  return KEYCHAIN_SERVICE;
};

const accessTokenFromBlob = (blob: string): Option.Option<string> => {
  try {
    const parsed = JSON.parse(blob) as { claudeAiOauth?: { accessToken?: unknown } };
    const token = parsed.claudeAiOauth?.accessToken;
    return typeof token === "string" && token.length > 0 ? Option.some(token) : Option.none();
  } catch {
    return Option.none();
  }
};

const readStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const tokenFromKeychain = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  env: NodeJS.ProcessEnv,
): Effect.Effect<Option.Option<string>> => {
  if (process.platform !== "darwin") return Effect.succeed(Option.none());
  return Effect.gen(function* () {
    const command = ChildProcess.make("security", [
      "find-generic-password",
      "-s",
      keychainServiceName(env),
      "-w",
    ]);
    const child = yield* spawner.spawn(command);
    const [stdout, exitCode] = yield* Effect.all([
      readStreamAsString(child.stdout),
      child.exitCode,
    ]);
    if (exitCode !== 0) return Option.none();
    return accessTokenFromBlob(stdout.trim());
  }).pipe(
    Effect.scoped,
    Effect.timeout(REQUEST_TIMEOUT),
    Effect.orElseSucceed(() => Option.none()),
  );
};

const tokenFromCredentialsFile = (
  fileSystem: FileSystem.FileSystem,
  env: NodeJS.ProcessEnv,
): Effect.Effect<Option.Option<string>> =>
  Effect.gen(function* () {
    const filePath = `${claudeConfigDir(env)}/.credentials.json`;
    const exists = yield* fileSystem.exists(filePath);
    if (!exists) return Option.none();
    const contents = yield* fileSystem.readFileString(filePath);
    return accessTokenFromBlob(contents);
  }).pipe(Effect.orElseSucceed(() => Option.none()));

export interface ResolveTokenDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly spawner: Option.Option<ChildProcessSpawner.ChildProcessSpawner["Service"]>;
  readonly fileSystem: Option.Option<FileSystem.FileSystem>;
}

/**
 * Resolve the Claude OAuth access token, mirroring `statusline.sh`'s
 * `get_oauth_token`: env var → macOS Keychain → credentials file. Never fails.
 */
export const resolveOAuthToken = (deps: ResolveTokenDeps): Effect.Effect<Option.Option<string>> =>
  Effect.gen(function* () {
    const envToken = deps.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (typeof envToken === "string" && envToken.length > 0) {
      return Option.some(envToken);
    }
    if (Option.isSome(deps.spawner)) {
      const fromKeychain = yield* tokenFromKeychain(deps.spawner.value, deps.env);
      if (Option.isSome(fromKeychain)) return fromKeychain;
    }
    if (Option.isSome(deps.fileSystem)) {
      const fromFile = yield* tokenFromCredentialsFile(deps.fileSystem.value, deps.env);
      if (Option.isSome(fromFile)) return fromFile;
    }
    return Option.none();
  });

// ---------------------------------------------------------------------------
// Fetch + poll
// ---------------------------------------------------------------------------

/** Fetch and normalize the usage snapshot for a resolved token. */
export const fetchUsageSnapshot = (
  httpClient: HttpClient.HttpClient,
  token: string,
): Effect.Effect<AccountUsageUpdatedPayload, OAuthUsageFetchError> =>
  httpClient
    .get(USAGE_ENDPOINT, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "anthropic-beta": OAUTH_BETA_HEADER,
        "User-Agent": USER_AGENT,
      },
    })
    .pipe(
      Effect.flatMap((response) =>
        response.status >= 200 && response.status < 300
          ? Effect.succeed(response)
          : // The status code is safe to surface for diagnostics; the request
            // (incl. the Authorization header) is not, so we don't carry it.
            Effect.fail(
              new OAuthUsageFetchError({
                detail: `usage endpoint returned HTTP ${response.status}`,
              }),
            ),
      ),
      Effect.flatMap((response) => response.json),
      Effect.flatMap(decodeRawUsage),
      Effect.map(normalizeUsage),
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.mapError((error) =>
        // Preserve our safe status-bearing detail; collapse any other cause
        // (network/decode/timeout) to a generic message — it can carry the
        // request (incl. the Authorization header) and may be logged upstream.
        error instanceof OAuthUsageFetchError
          ? error
          : new OAuthUsageFetchError({ detail: "Failed to fetch OAuth usage snapshot" }),
      ),
    );

export interface AccountUsagePollDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly httpClient: Option.Option<HttpClient.HttpClient>;
  readonly spawner: Option.Option<ChildProcessSpawner.ChildProcessSpawner["Service"]>;
  readonly fileSystem: Option.Option<FileSystem.FileSystem>;
}

/**
 * Build the best-effort poll effect: resolve a token, fetch + normalize usage.
 * Returns `null` when no token is available, the HTTP client is missing, or the
 * request fails — callers treat `null` as "no update this tick".
 */
export const makeAccountUsagePoll = (
  deps: AccountUsagePollDeps,
): Effect.Effect<AccountUsageUpdatedPayload | null> => {
  if (Option.isNone(deps.httpClient)) return Effect.succeed(null);
  const httpClient = deps.httpClient.value;
  return resolveOAuthToken(deps).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed<AccountUsageUpdatedPayload | null>(null),
        onSome: (token) => fetchUsageSnapshot(httpClient, token),
      }),
    ),
    // Failures yield "no update this tick" (null), but log a safe, token-free
    // line so a persistently-empty usage meter (e.g. an expired token → HTTP
    // 401) is diagnosable instead of silent.
    Effect.tapError((error) =>
      Effect.logDebug("OAuth usage poll failed", {
        detail: error instanceof OAuthUsageFetchError ? error.detail : "token resolution failed",
      }),
    ),
    Effect.orElseSucceed(() => null),
  );
};
