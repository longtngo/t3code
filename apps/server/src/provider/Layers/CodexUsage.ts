/**
 * CodexUsage — fetch normalized OpenAI/Codex account usage from the Codex
 * app-server (`account/rateLimits/read`).
 *
 * The Codex CLI does not expose rate limits outside an interactive session, but
 * the app-server JSON-RPC API does — the same source Codex `/status` uses.
 * Everything here is best-effort: spawn/auth failures yield `null` and the UI
 * simply shows no usage readout.
 *
 * @module CodexUsage
 */
// @effect-diagnostics globalDate:off
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexSchema from "effect-codex-app-server/schema";
import * as CodexErrors from "effect-codex-app-server/errors";

import type { AccountUsageCodexPayload, AccountUsageUpdatedPayload } from "@t3tools/contracts";

import { expandHomePath } from "../../pathExpansion.ts";
import { buildCodexInitializeParams } from "./CodexProvider.ts";

const REQUEST_TIMEOUT = Duration.seconds(15);

export class CodexUsageFetchError extends Data.TaggedError("CodexUsageFetchError")<{
  readonly detail: string;
  readonly cause?: unknown;
}> {}

type RawRateLimitWindow = CodexSchema.V2GetAccountRateLimitsResponse__RateLimitWindow;
type RawRateLimitSnapshot = CodexSchema.V2GetAccountRateLimitsResponse__RateLimitSnapshot;
type RawRateLimitsResponse = CodexSchema.V2GetAccountRateLimitsResponse;

const unixSecondsToIso = (value: number | null | undefined): string | null => {
  if (value == null || !Number.isFinite(value)) return null;
  return new Date(value * 1000).toISOString();
};

const normalizeWindow = (
  window: RawRateLimitWindow | null | undefined,
): AccountUsageCodexPayload["primary"] => {
  if (!window) return null;
  return {
    utilization: window.usedPercent,
    resetsAt: unixSecondsToIso(window.resetsAt),
    windowDurationMins: window.windowDurationMins ?? null,
  };
};

const normalizeCredits = (
  credits: CodexSchema.V2GetAccountRateLimitsResponse__CreditsSnapshot | null | undefined,
): AccountUsageCodexPayload["credits"] => {
  if (!credits) return null;
  return {
    balance: credits.balance ?? null,
    hasCredits: credits.hasCredits,
    unlimited: credits.unlimited,
  };
};

const normalizeSnapshot = (snapshot: RawRateLimitSnapshot): AccountUsageCodexPayload => ({
  primary: normalizeWindow(snapshot.primary),
  secondary: normalizeWindow(snapshot.secondary),
  credits: normalizeCredits(snapshot.credits),
  planType: snapshot.planType ?? null,
  limitName: snapshot.limitName ?? null,
});

const pickPreferredSnapshot = (response: RawRateLimitsResponse): RawRateLimitSnapshot | null => {
  const byLimitId = response.rateLimitsByLimitId;
  if (byLimitId && typeof byLimitId === "object") {
    const codexBucket = byLimitId.codex ?? byLimitId["codex"];
    if (codexBucket) return codexBucket;
  }
  return response.rateLimits ?? null;
};

/**
 * Map a Codex rate-limits response to the normalized contract payload. Pure —
 * primary unit-test seam.
 */
export const normalizeCodexRateLimits = (
  response: RawRateLimitsResponse,
): AccountUsageUpdatedPayload | null => {
  const snapshot = pickPreferredSnapshot(response);
  if (!snapshot) return null;
  const codex = normalizeSnapshot(snapshot);
  if (!hasCodexUsageSignal(codex)) return null;
  return {
    fiveHour: null,
    sevenDay: null,
    extra: null,
    codex,
  };
};

/** True when the normalized Codex payload has at least one displayable segment. */
export const hasCodexUsageSignal = (codex: AccountUsageCodexPayload): boolean => {
  if (codex.primary) return true;
  if (codex.secondary) return true;
  if (codex.credits?.hasCredits === true) return true;
  return false;
};

export interface CodexAccountUsagePollDeps {
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
}

const readRateLimits = (
  deps: CodexAccountUsagePollDeps,
): Effect.Effect<
  AccountUsageUpdatedPayload | null,
  CodexUsageFetchError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function* () {
    const resolvedHomePath = deps.homePath ? expandHomePath(deps.homePath) : undefined;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtimeScope = yield* Scope.Scope;
    const env = {
      ...(deps.environment ?? process.env),
      ...(resolvedHomePath ? { CODEX_HOME: resolvedHomePath } : {}),
    };
    const child = yield* spawner
      .spawn(
        ChildProcess.make(deps.binaryPath, ["app-server"], {
          cwd: deps.cwd,
          env,
          extendEnv: deps.environment === undefined,
        }),
      )
      .pipe(
        Effect.provideService(Scope.Scope, runtimeScope),
        Effect.mapError(
          (cause) =>
            new CodexUsageFetchError({ detail: "Failed to spawn Codex app-server", cause }),
        ),
      );
    const clientContext = yield* CodexClient.layerChildProcess(child).pipe(
      Layer.build,
      Effect.provideService(Scope.Scope, runtimeScope),
    );
    const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
      Effect.provide(clientContext),
    );

    yield* client.request("initialize", buildCodexInitializeParams());
    yield* client.notify("initialized", undefined);
    const response = yield* client.request("account/rateLimits/read", undefined);
    return normalizeCodexRateLimits(response);
  }).pipe(
    Effect.timeout(REQUEST_TIMEOUT),
    Effect.mapError((error) =>
      error instanceof CodexUsageFetchError
        ? error
        : new CodexUsageFetchError({ detail: "Failed to fetch Codex rate limits snapshot" }),
    ),
  );

/**
 * Build the best-effort poll effect: spawn a short-lived app-server, read rate
 * limits, normalize. Returns `null` when auth is missing or the request fails.
 */
export const makeAccountUsagePoll = (
  deps: CodexAccountUsagePollDeps,
): Effect.Effect<AccountUsageUpdatedPayload | null> =>
  readRateLimits(deps).pipe(
    Effect.scoped,
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, deps.spawner),
    Effect.tapError((error) =>
      Effect.logDebug("Codex usage poll failed", {
        detail: error instanceof CodexUsageFetchError ? error.detail : "unknown",
      }),
    ),
    Effect.orElseSucceed(() => null),
  );

/** Normalize a live `account/rateLimits/updated` notification payload. */
export const normalizeCodexRateLimitsNotification = (
  payload: CodexSchema.V2AccountRateLimitsUpdatedNotification,
): AccountUsageUpdatedPayload | null =>
  normalizeCodexRateLimits({
    rateLimits: payload.rateLimits,
  });

