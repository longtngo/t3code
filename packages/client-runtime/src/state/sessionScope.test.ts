import {
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  type AuthSessionState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  RemoteEnvironmentAuthFetchError,
  RemoteEnvironmentAuthTimeoutError,
  RemoteEnvironmentAuthUndeclaredStatusError,
} from "../rpc/http.ts";
import { ConnectionTransientError } from "../connection/model.ts";
import { sessionResultDeniesScope, sessionResultGrantsScope } from "./sessionScope.ts";

const URL = "https://env.example.test/api/auth/session";
const session = {
  authenticated: true,
  scopes: [AuthOrchestrationOperateScope],
} as unknown as AuthSessionState;

const failedRefresh = (error: unknown) =>
  AsyncResult.failure<AuthSessionState, unknown>(Cause.fail(error), {
    previousSuccess: Option.some(AsyncResult.success(session)) as never,
  });

const fetchError = (response?: HttpClientResponse.HttpClientResponse) => {
  const request = HttpClientRequest.get(URL);
  return new RemoteEnvironmentAuthFetchError({
    message: "failed",
    cause: new HttpClientError.HttpClientError({
      reason:
        response === undefined
          ? new HttpClientError.TransportError({ request, description: "offline" })
          : new HttpClientError.StatusCodeError({ request, response }),
    }),
  });
};

describe("sessionResultGrantsScope", () => {
  it("keeps cached scopes when a refresh never reached the server", () => {
    expect(
      sessionResultGrantsScope(failedRefresh(fetchError()), AuthOrchestrationOperateScope),
    ).toBe(true);
    expect(
      sessionResultGrantsScope(
        failedRefresh(new RemoteEnvironmentAuthTimeoutError(URL, 6_000)),
        AuthOrchestrationOperateScope,
      ),
    ).toBe(true);
    const relayRenewal = new RemoteEnvironmentAuthFetchError({
      message: "Could not authorize the environment request.",
      cause: new ConnectionTransientError({ reason: "network", detail: "offline" }),
    });
    expect(
      sessionResultGrantsScope(failedRefresh(relayRenewal), AuthOrchestrationOperateScope),
    ).toBe(true);
  });

  it("revokes cached scopes when the server answered or the failure is unrecognised", () => {
    const answered = fetchError(
      HttpClientResponse.fromWeb(HttpClientRequest.get(URL), new Response(null, { status: 401 })),
    );
    for (const error of [
      answered,
      new RemoteEnvironmentAuthUndeclaredStatusError(URL, 500),
      new RemoteEnvironmentAuthFetchError({ message: "rejected renewal", cause: { ok: false } }),
      new Error("unknown"),
    ]) {
      expect(sessionResultGrantsScope(failedRefresh(error), AuthOrchestrationOperateScope)).toBe(
        false,
      );
    }
  });

  it("grants only what a live session holds", () => {
    expect(
      sessionResultGrantsScope(AsyncResult.success(session), AuthOrchestrationOperateScope),
    ).toBe(true);
    expect(sessionResultGrantsScope(AsyncResult.initial(), AuthOrchestrationOperateScope)).toBe(
      false,
    );
  });
});

describe("sessionResultDeniesScope", () => {
  it("denies only a loaded session that lacks the scope", () => {
    expect(sessionResultDeniesScope(AsyncResult.success(session), AuthFilesystemReadScope)).toBe(
      true,
    );
    expect(
      sessionResultDeniesScope(AsyncResult.success(session), AuthOrchestrationOperateScope),
    ).toBe(false);
  });

  it("defers to the server while the grant is loading or its refresh failed", () => {
    expect(sessionResultDeniesScope(AsyncResult.initial(), AuthFilesystemReadScope)).toBe(false);
    const answered = new RemoteEnvironmentAuthUndeclaredStatusError(URL, 502);
    for (const error of [answered, fetchError()]) {
      expect(sessionResultDeniesScope(failedRefresh(error), AuthFilesystemReadScope)).toBe(false);
    }
  });
});
