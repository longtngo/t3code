/**
 * CursorUsage — fetch normalized Cursor account usage from Cursor's internal
 * dashboard API (`POST …/GetCurrentPeriodUsage`) with an enterprise fallback
 * (`GET /auth/usage`).
 *
 * The Cursor Agent SDK / ACP bridge does not expose OAuth tokens, so — like
 * community usage tools — we resolve credentials from local stores (env var →
 * CLI keychain → Cursor Desktop SQLite). Everything is best-effort: missing
 * tokens or failed requests yield `null` and the UI shows no usage readout.
 *
 * @module CursorUsage
 */
// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";

import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import type { AccountUsageUpdatedPayload } from "@t3tools/contracts";

const CURSOR_API_BASE = "https://api2.cursor.sh";
const CURRENT_PERIOD_USAGE_ENDPOINT = `${CURSOR_API_BASE}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`;
const AUTH_USAGE_ENDPOINT = `${CURSOR_API_BASE}/auth/usage`;
const TOKEN_ENDPOINT = `${CURSOR_API_BASE}/oauth/token`;
const CURSOR_OAUTH_CLIENT_ID = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB";
const REQUEST_TIMEOUT = Duration.seconds(10);
const ACCESS_TOKEN_KEYCHAIN_SERVICE = "cursor-access-token";
const REFRESH_TOKEN_KEYCHAIN_SERVICE = "cursor-refresh-token";
const SQLITE_ACCESS_TOKEN_KEY = "cursorAuth/accessToken";
const SQLITE_REFRESH_TOKEN_KEY = "cursorAuth/refreshToken";

export class CursorUsageFetchError extends Data.TaggedError("CursorUsageFetchError")<{
  readonly detail: string;
  readonly cause?: unknown;
}> {}

// ---------------------------------------------------------------------------
// Raw API response → normalized payload
// ---------------------------------------------------------------------------

const RawPlanUsage = Schema.Struct({
  totalSpend: Schema.optional(Schema.Number),
  includedSpend: Schema.optional(Schema.Number),
  remaining: Schema.optional(Schema.Number),
  limit: Schema.optional(Schema.Number),
  autoPercentUsed: Schema.optional(Schema.Number),
  apiPercentUsed: Schema.optional(Schema.Number),
  totalPercentUsed: Schema.optional(Schema.Number),
});

const RawSpendLimitUsage = Schema.Struct({
  totalSpend: Schema.optional(Schema.Number),
  pooledLimit: Schema.optional(Schema.Number),
  pooledUsed: Schema.optional(Schema.Number),
  pooledRemaining: Schema.optional(Schema.Number),
  individualLimit: Schema.optional(Schema.Number),
  individualUsed: Schema.optional(Schema.Number),
  individualRemaining: Schema.optional(Schema.Number),
  limitType: Schema.optional(Schema.String),
});

const RawCurrentPeriodUsageResponse = Schema.Struct({
  billingCycleStart: Schema.optional(Schema.String),
  billingCycleEnd: Schema.optional(Schema.String),
  planUsage: Schema.optional(Schema.NullOr(RawPlanUsage)),
  spendLimitUsage: Schema.optional(Schema.NullOr(RawSpendLimitUsage)),
});
export type RawCurrentPeriodUsageResponse = typeof RawCurrentPeriodUsageResponse.Type;

const RawAuthUsageBucket = Schema.Struct({
  numRequests: Schema.optional(Schema.Number),
  numRequestsTotal: Schema.optional(Schema.Number),
  maxRequestUsage: Schema.optional(Schema.NullOr(Schema.Number)),
});

const decodeAuthUsageBucket = Schema.decodeUnknownOption(RawAuthUsageBucket);
export type RawAuthUsageResponse = Record<string, unknown>;

const decodeCurrentPeriodUsage = Schema.decodeUnknownEffect(RawCurrentPeriodUsageResponse);

const finitePercent = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export const unixMsToIso = (value: string | number | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  const ms = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const normalizeSpendLimit = (
  spend: typeof RawSpendLimitUsage.Type | null | undefined,
): {
  readonly onDemand: AccountUsageUpdatedPayload["extra"];
  readonly scope: "team" | "individual" | undefined;
} => {
  if (!spend) {
    return { onDemand: null, scope: undefined };
  }

  if (typeof spend.pooledLimit === "number" && spend.pooledLimit > 0) {
    const used = spend.pooledUsed ?? 0;
    const limit = spend.pooledLimit;
    return {
      scope: "team",
      onDemand: {
        isEnabled: true,
        usedCredits: used,
        monthlyLimit: limit,
        utilization: limit > 0 ? (used / limit) * 100 : 0,
        currency: "USD",
      },
    };
  }

  if (typeof spend.individualLimit === "number" && spend.individualLimit > 0) {
    const used = spend.individualUsed ?? 0;
    const limit = spend.individualLimit;
    return {
      scope: "individual",
      onDemand: {
        isEnabled: true,
        usedCredits: used,
        monthlyLimit: limit,
        utilization: limit > 0 ? (used / limit) * 100 : 0,
        currency: "USD",
      },
    };
  }

  return { onDemand: null, scope: undefined };
};

const windowFromPercent = (
  value: number | null,
  resetsAt: string | null,
): AccountUsageUpdatedPayload["fiveHour"] =>
  value === null ? null : { utilization: value, resetsAt };

/** Map Cursor dashboard usage to the shared account-usage contract. */
export const normalizeCurrentPeriodUsage = (
  raw: RawCurrentPeriodUsageResponse,
): AccountUsageUpdatedPayload => {
  const resetsAt = unixMsToIso(raw.billingCycleEnd);
  const plan = raw.planUsage ?? null;
  const spend = normalizeSpendLimit(raw.spendLimitUsage);

  let auto: AccountUsageUpdatedPayload["fiveHour"] = null;
  let api: AccountUsageUpdatedPayload["fiveHour"] = null;
  let total: AccountUsageUpdatedPayload["fiveHour"] = null;

  if (plan) {
    auto = windowFromPercent(finitePercent(plan.autoPercentUsed), resetsAt);
    api = windowFromPercent(finitePercent(plan.apiPercentUsed), resetsAt);

    const totalPct = finitePercent(plan.totalPercentUsed);
    if (totalPct !== null) {
      total = { utilization: totalPct, resetsAt };
    } else if (
      typeof plan.limit === "number" &&
      plan.limit > 0 &&
      typeof plan.includedSpend === "number"
    ) {
      total = {
        utilization: (plan.includedSpend / plan.limit) * 100,
        resetsAt,
      };
    }
  }

  return {
    fiveHour: null,
    sevenDay: null,
    extra: null,
    cursor: {
      auto,
      api,
      total,
      onDemand: spend.onDemand,
      ...(spend.scope ? { onDemandScope: spend.scope } : {}),
    },
  };
};

/** Enterprise-style request buckets from `GET /auth/usage`. */
export const normalizeAuthUsage = (
  raw: RawAuthUsageResponse,
  preferredModelKey = "gpt-4",
): AccountUsageUpdatedPayload | null => {
  const preferred = decodeAuthUsageBucket(raw[preferredModelKey]);
  const bucket =
    (preferred._tag === "Some" ? preferred.value : undefined) ??
    Object.entries(raw).flatMap(([, value]) => {
      const decoded = decodeAuthUsageBucket(value);
      if (decoded._tag !== "Some") return [];
      if (typeof decoded.value.maxRequestUsage !== "number" || decoded.value.maxRequestUsage <= 0) {
        return [];
      }
      return [decoded.value];
    })[0];

  if (!bucket || typeof bucket.maxRequestUsage !== "number" || bucket.maxRequestUsage <= 0) {
    return null;
  }

  const used = bucket.numRequests ?? bucket.numRequestsTotal ?? 0;
  return {
    fiveHour: null,
    sevenDay: null,
    extra: null,
    cursor: {
      auto: null,
      api: null,
      total: null,
      onDemand: null,
      requests: {
        used,
        limit: bucket.maxRequestUsage,
        utilization: (used / bucket.maxRequestUsage) * 100,
      },
    },
  };
};

export const mergeUsageSnapshots = (
  primary: AccountUsageUpdatedPayload,
  fallback: AccountUsageUpdatedPayload | null,
): AccountUsageUpdatedPayload => {
  if (fallback === null) return primary;
  const primaryCursor = primary.cursor;
  const fallbackCursor = fallback.cursor;
  if (!primaryCursor && !fallbackCursor) {
    return {
      fiveHour: primary.fiveHour ?? fallback.fiveHour,
      sevenDay: primary.sevenDay ?? fallback.sevenDay,
      extra: primary.extra ?? fallback.extra,
    };
  }
  return {
    fiveHour: null,
    sevenDay: null,
    extra: null,
    cursor: {
      auto: primaryCursor?.auto ?? fallbackCursor?.auto ?? null,
      api: primaryCursor?.api ?? fallbackCursor?.api ?? null,
      total: primaryCursor?.total ?? fallbackCursor?.total ?? null,
      onDemand: primaryCursor?.onDemand ?? fallbackCursor?.onDemand ?? null,
      onDemandScope: primaryCursor?.onDemandScope ?? fallbackCursor?.onDemandScope,
      requests: primaryCursor?.requests ?? fallbackCursor?.requests,
    },
  };
};

export const hasUsageSignal = (payload: AccountUsageUpdatedPayload): boolean => {
  if (payload.cursor) {
    const cursor = payload.cursor;
    return (
      cursor.auto !== null ||
      cursor.api !== null ||
      cursor.total !== null ||
      cursor.onDemand !== null ||
      cursor.requests !== undefined
    );
  }
  return payload.fiveHour !== null || payload.sevenDay !== null || payload.extra !== null;
};

// ---------------------------------------------------------------------------
// OAuth token resolution (env → CLI keychain → Cursor Desktop SQLite)
// ---------------------------------------------------------------------------

export interface CursorAuthTokens {
  readonly accessToken: string;
  readonly refreshToken: Option.Option<string>;
}

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
  service: string,
): Effect.Effect<Option.Option<string>> => {
  if (process.platform !== "darwin") return Effect.succeed(Option.none());
  return Effect.gen(function* () {
    const command = ChildProcess.make("security", ["find-generic-password", "-s", service, "-w"]);
    const child = yield* spawner.spawn(command);
    const [stdout, exitCode] = yield* Effect.all([
      readStreamAsString(child.stdout),
      child.exitCode,
    ]);
    if (exitCode !== 0) return Option.none();
    const token = stdout.trim();
    return token.length > 0 ? Option.some(token) : Option.none();
  }).pipe(
    Effect.scoped,
    Effect.timeout(REQUEST_TIMEOUT),
    Effect.orElseSucceed(() => Option.none()),
  );
};

export const cursorStateDbPath = (env: NodeJS.ProcessEnv = process.env): string => {
  const home = env.HOME && env.HOME.length > 0 ? env.HOME : homedir();
  switch (process.platform) {
    case "darwin":
      return `${home}/Library/Application Support/Cursor/User/globalStorage/state.vscdb`;
    case "win32": {
      const appData =
        env.APPDATA && env.APPDATA.length > 0 ? env.APPDATA : `${home}/AppData/Roaming`;
      return `${appData}/Cursor/User/globalStorage/state.vscdb`;
    }
    default:
      return `${home}/.config/Cursor/User/globalStorage/state.vscdb`;
  }
};

const readSqliteItem = (dbPath: string, key: string): Option.Option<string> => {
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(key) as
        | { value?: unknown }
        | undefined;
      const value = row?.value;
      return typeof value === "string" && value.length > 0 ? Option.some(value) : Option.none();
    } finally {
      db.close();
    }
  } catch {
    return Option.none();
  }
};

const tokenFromStateDb = (
  fileSystem: FileSystem.FileSystem,
  env: NodeJS.ProcessEnv,
  key: string,
): Effect.Effect<Option.Option<string>> =>
  Effect.gen(function* () {
    const dbPath = cursorStateDbPath(env);
    const exists = yield* fileSystem.exists(dbPath);
    if (!exists) return Option.none();
    return readSqliteItem(dbPath, key);
  }).pipe(Effect.orElseSucceed(() => Option.none()));

export interface ResolveTokenDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly spawner: Option.Option<ChildProcessSpawner.ChildProcessSpawner["Service"]>;
  readonly fileSystem: Option.Option<FileSystem.FileSystem>;
}

export const resolveCursorAuthTokens = (
  deps: ResolveTokenDeps,
): Effect.Effect<Option.Option<CursorAuthTokens>> =>
  Effect.gen(function* () {
    const envAccess = deps.env.CURSOR_ACCESS_TOKEN;
    if (typeof envAccess === "string" && envAccess.length > 0) {
      const envRefresh = deps.env.CURSOR_REFRESH_TOKEN;
      return Option.some({
        accessToken: envAccess,
        refreshToken:
          typeof envRefresh === "string" && envRefresh.length > 0
            ? Option.some(envRefresh)
            : Option.none(),
      });
    }

    let accessToken = Option.none<string>();
    let refreshToken = Option.none<string>();

    if (Option.isSome(deps.spawner)) {
      accessToken = yield* tokenFromKeychain(deps.spawner.value, ACCESS_TOKEN_KEYCHAIN_SERVICE);
      refreshToken = yield* tokenFromKeychain(deps.spawner.value, REFRESH_TOKEN_KEYCHAIN_SERVICE);
    }

    if (Option.isNone(accessToken) && Option.isSome(deps.fileSystem)) {
      accessToken = yield* tokenFromStateDb(
        deps.fileSystem.value,
        deps.env,
        SQLITE_ACCESS_TOKEN_KEY,
      );
      if (Option.isNone(refreshToken)) {
        refreshToken = yield* tokenFromStateDb(
          deps.fileSystem.value,
          deps.env,
          SQLITE_REFRESH_TOKEN_KEY,
        );
      }
    }

    return Option.map(accessToken, (token) => ({
      accessToken: token,
      refreshToken,
    }));
  });

export const jwtExpiresAtMs = (token: string): number | null => {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp)
      ? payload.exp * 1000
      : null;
  } catch {
    return null;
  }
};

export const isAccessTokenExpired = (token: string, nowMs = Date.now()): boolean => {
  const expiresAt = jwtExpiresAtMs(token);
  if (expiresAt === null) return false;
  return nowMs >= expiresAt - 30_000;
};

interface RefreshTokenResponse {
  readonly access_token?: unknown;
  readonly shouldLogout?: unknown;
}

const decodeRefreshTokenResponse = (value: unknown): RefreshTokenResponse | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RefreshTokenResponse)
    : null;

/** Refresh a short-lived JWT when a refresh token is available. */
export const refreshAccessToken = (
  httpClient: HttpClient.HttpClient,
  refreshToken: string,
): Effect.Effect<string, CursorUsageFetchError> =>
  HttpClientRequest.post(TOKEN_ENDPOINT).pipe(
    HttpClientRequest.acceptJson,
    HttpClientRequest.bodyJson({
      grant_type: "refresh_token",
      client_id: CURSOR_OAUTH_CLIENT_ID,
      refresh_token: refreshToken,
    }),
    Effect.flatMap(httpClient.execute),
    Effect.flatMap((response) =>
      response.status >= 200 && response.status < 300
        ? Effect.succeed(response)
        : Effect.fail(
            new CursorUsageFetchError({
              detail: `token refresh returned HTTP ${response.status}`,
            }),
          ),
    ),
    Effect.flatMap((response) => response.json),
    Effect.flatMap((json) => {
      const decoded = decodeRefreshTokenResponse(json);
      if (!decoded || decoded.shouldLogout === true) {
        return Effect.fail(
          new CursorUsageFetchError({
            detail: "Cursor refresh token is invalid; re-run `agent login` or sign into Cursor.",
          }),
        );
      }
      const accessToken = decoded.access_token;
      if (typeof accessToken !== "string" || accessToken.length === 0) {
        return Effect.fail(
          new CursorUsageFetchError({
            detail: "Cursor token refresh returned an empty access token.",
          }),
        );
      }
      return Effect.succeed(accessToken);
    }),
    Effect.timeout(REQUEST_TIMEOUT),
    Effect.mapError((error) =>
      error instanceof CursorUsageFetchError
        ? error
        : new CursorUsageFetchError({ detail: "Failed to refresh Cursor access token" }),
    ),
  );

export const resolveUsableAccessToken = (
  httpClient: HttpClient.HttpClient,
  tokens: CursorAuthTokens,
): Effect.Effect<string, CursorUsageFetchError> => {
  if (!isAccessTokenExpired(tokens.accessToken)) {
    return Effect.succeed(tokens.accessToken);
  }
  return Option.match(tokens.refreshToken, {
    onNone: () =>
      Effect.fail(
        new CursorUsageFetchError({
          detail: "Cursor access token expired and no refresh token is available.",
        }),
      ),
    onSome: (refreshToken) => refreshAccessToken(httpClient, refreshToken),
  });
};

// ---------------------------------------------------------------------------
// Fetch + poll
// ---------------------------------------------------------------------------

const dashboardRequest = (token: string) =>
  HttpClientRequest.post(CURRENT_PERIOD_USAGE_ENDPOINT).pipe(
    HttpClientRequest.bearerToken(token),
    HttpClientRequest.acceptJson,
    HttpClientRequest.setHeader("Connect-Protocol-Version", "1"),
  );

export const fetchCurrentPeriodUsage = (
  httpClient: HttpClient.HttpClient,
  token: string,
): Effect.Effect<AccountUsageUpdatedPayload, CursorUsageFetchError> =>
  dashboardRequest(token).pipe(
    HttpClientRequest.bodyJson({}),
    Effect.flatMap(httpClient.execute),
    Effect.flatMap((response) =>
      response.status >= 200 && response.status < 300
        ? Effect.succeed(response)
        : Effect.fail(
            new CursorUsageFetchError({
              detail: `usage endpoint returned HTTP ${response.status}`,
            }),
          ),
    ),
    Effect.flatMap((response) => response.json),
    Effect.flatMap(decodeCurrentPeriodUsage),
    Effect.map(normalizeCurrentPeriodUsage),
    Effect.timeout(REQUEST_TIMEOUT),
    Effect.mapError((error) =>
      error instanceof CursorUsageFetchError
        ? error
        : new CursorUsageFetchError({ detail: "Failed to fetch Cursor usage snapshot" }),
    ),
  );

export const fetchAuthUsage = (
  httpClient: HttpClient.HttpClient,
  token: string,
  preferredModelKey = "gpt-4",
): Effect.Effect<AccountUsageUpdatedPayload | null, CursorUsageFetchError> =>
  httpClient
    .get(AUTH_USAGE_ENDPOINT, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    })
    .pipe(
      Effect.flatMap((response) =>
        response.status >= 200 && response.status < 300
          ? Effect.succeed(response)
          : Effect.fail(
              new CursorUsageFetchError({
                detail: `auth usage endpoint returned HTTP ${response.status}`,
              }),
            ),
      ),
      Effect.flatMap((response) => response.json),
      Effect.map((raw) =>
        typeof raw === "object" && raw !== null && !Array.isArray(raw)
          ? normalizeAuthUsage(raw as RawAuthUsageResponse, preferredModelKey)
          : null,
      ),
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.mapError((error) =>
        error instanceof CursorUsageFetchError
          ? error
          : new CursorUsageFetchError({ detail: "Failed to fetch Cursor auth usage snapshot" }),
      ),
    );

/** Fetch dashboard usage, falling back to enterprise request buckets when needed. */
export const fetchUsageSnapshot = (
  httpClient: HttpClient.HttpClient,
  token: string,
): Effect.Effect<AccountUsageUpdatedPayload, CursorUsageFetchError> =>
  Effect.gen(function* () {
    const dashboard = yield* fetchCurrentPeriodUsage(httpClient, token);
    if (hasUsageSignal(dashboard)) {
      return dashboard;
    }
    const authUsage = yield* fetchAuthUsage(httpClient, token);
    return mergeUsageSnapshots(dashboard, authUsage);
  });

export interface AccountUsagePollDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly httpClient: Option.Option<HttpClient.HttpClient>;
  readonly spawner: Option.Option<ChildProcessSpawner.ChildProcessSpawner["Service"]>;
  readonly fileSystem: Option.Option<FileSystem.FileSystem>;
}

/**
 * Build the best-effort poll effect: resolve tokens, refresh if needed, fetch +
 * normalize usage. Returns `null` when no token is available, the HTTP client
 * is missing, or the request fails.
 */
export const makeAccountUsagePoll = (
  deps: AccountUsagePollDeps,
): Effect.Effect<AccountUsageUpdatedPayload | null> => {
  if (Option.isNone(deps.httpClient)) return Effect.succeed(null);
  const httpClient = deps.httpClient.value;
  return resolveCursorAuthTokens(deps).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed<AccountUsageUpdatedPayload | null>(null),
        onSome: (tokens) =>
          resolveUsableAccessToken(httpClient, tokens).pipe(
            Effect.flatMap((accessToken) => fetchUsageSnapshot(httpClient, accessToken)),
          ),
      }),
    ),
    Effect.tapError((error) =>
      Effect.logDebug("Cursor usage poll failed", {
        detail: error instanceof CursorUsageFetchError ? error.detail : "token resolution failed",
      }),
    ),
    Effect.orElseSucceed(() => null),
  );
};
