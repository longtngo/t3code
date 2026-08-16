import { describe, expect, it } from "@effect/vitest";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

import { WEBSOCKET_KEEPALIVE_IDLE_MS, enableWebSocketKeepAlive } from "./wsKeepAlive.ts";

function requestWithSource(source: unknown): HttpServerRequest.HttpServerRequest {
  return { source } as unknown as HttpServerRequest.HttpServerRequest;
}

describe("enableWebSocketKeepAlive", () => {
  it("enables keepalive on the request's socket with the idle delay", () => {
    const calls: Array<readonly [boolean, number]> = [];
    const request = requestWithSource({
      socket: {
        setKeepAlive: (enable: boolean, delay: number) => calls.push([enable, delay]),
      },
    });

    expect(enableWebSocketKeepAlive(request)).toBe(true);
    expect(calls).toEqual([[true, WEBSOCKET_KEEPALIVE_IDLE_MS]]);
  });

  it("honours an explicit idle delay", () => {
    const calls: Array<readonly [boolean, number]> = [];
    const request = requestWithSource({
      socket: { setKeepAlive: (enable: boolean, delay: number) => calls.push([enable, delay]) },
    });

    enableWebSocketKeepAlive(request, 1234);

    expect(calls).toEqual([[true, 1234]]);
  });

  it("reports false when the platform exposes no socket, rather than pretending", () => {
    // A silently-unprotected connection is the failure this whole helper exists
    // to prevent, so "no socket" must be observable and not look like success.
    expect(enableWebSocketKeepAlive(requestWithSource(null))).toBe(false);
    expect(enableWebSocketKeepAlive(requestWithSource({}))).toBe(false);
    expect(enableWebSocketKeepAlive(requestWithSource({ socket: null }))).toBe(false);
  });

  it("reports false when the socket cannot do keepalive", () => {
    expect(enableWebSocketKeepAlive(requestWithSource({ socket: {} }))).toBe(false);
    expect(enableWebSocketKeepAlive(requestWithSource({ socket: { setKeepAlive: "nope" } }))).toBe(
      false,
    );
  });

  it("uses an idle delay short enough to reclaim a dead peer in minutes", () => {
    // The probe interval and count are OS defaults; the idle delay is the only
    // part this can set, so it must not be so long that it dominates.
    expect(WEBSOCKET_KEEPALIVE_IDLE_MS).toBeGreaterThan(0);
    expect(WEBSOCKET_KEEPALIVE_IDLE_MS).toBeLessThanOrEqual(60_000);
  });
});
