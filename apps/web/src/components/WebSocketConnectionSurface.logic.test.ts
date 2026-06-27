import { describe, expect, it } from "vite-plus/test";

import type { WsConnectionStatus } from "../rpc/wsConnectionState";
import {
  outageGraceMs,
  shouldAutoReconnect,
  shouldRestartStalledReconnect,
  shouldSurfaceOutage,
  WS_OUTAGE_GRACE_MS,
} from "./WebSocketConnectionSurface";

function makeStatus(overrides: Partial<WsConnectionStatus> = {}): WsConnectionStatus {
  return {
    attemptCount: 0,
    closeCode: null,
    closeReason: null,
    connectionLabel: null,
    connectedAt: null,
    disconnectedAt: null,
    hasConnected: false,
    lastError: null,
    lastErrorAt: null,
    nextRetryAt: null,
    online: true,
    phase: "idle",
    reconnectAttemptCount: 0,
    reconnectMaxAttempts: 8,
    reconnectPhase: "idle",
    socketUrl: null,
    ...overrides,
  };
}

describe("WebSocketConnectionSurface.logic", () => {
  it("forces reconnect on online when the app was offline", () => {
    expect(
      shouldAutoReconnect(
        makeStatus({
          disconnectedAt: "2026-04-03T20:00:00.000Z",
          online: false,
          phase: "disconnected",
        }),
        "online",
      ),
    ).toBe(true);
  });

  it("forces reconnect on focus only for previously connected disconnected states", () => {
    expect(
      shouldAutoReconnect(
        makeStatus({
          hasConnected: true,
          online: true,
          phase: "disconnected",
          reconnectAttemptCount: 3,
          reconnectPhase: "waiting",
        }),
        "focus",
      ),
    ).toBe(true);

    expect(
      shouldAutoReconnect(
        makeStatus({
          hasConnected: false,
          online: true,
          phase: "disconnected",
          reconnectAttemptCount: 1,
          reconnectPhase: "waiting",
        }),
        "focus",
      ),
    ).toBe(false);
  });

  it("forces reconnect on focus for exhausted reconnect loops", () => {
    expect(
      shouldAutoReconnect(
        makeStatus({
          hasConnected: true,
          online: true,
          phase: "disconnected",
          reconnectAttemptCount: 8,
          reconnectPhase: "exhausted",
        }),
        "focus",
      ),
    ).toBe(true);
  });

  it("restarts a stalled reconnect window after the scheduled retry time passes", () => {
    expect(
      shouldRestartStalledReconnect(
        makeStatus({
          hasConnected: true,
          nextRetryAt: "2026-04-03T20:00:01.000Z",
          online: true,
          phase: "disconnected",
          reconnectAttemptCount: 3,
          reconnectPhase: "waiting",
        }),
        "2026-04-03T20:00:01.000Z",
      ),
    ).toBe(true);

    expect(
      shouldRestartStalledReconnect(
        makeStatus({
          hasConnected: true,
          nextRetryAt: "2026-04-03T20:00:01.000Z",
          online: true,
          phase: "disconnected",
          reconnectAttemptCount: 3,
          reconnectPhase: "attempting",
        }),
        "2026-04-03T20:00:01.000Z",
      ),
    ).toBe(false);
  });
});

describe("shouldSurfaceOutage", () => {
  const start = Date.parse("2026-04-03T20:00:00.000Z");
  it("stays silent before the grace window elapses", () => {
    const status = makeStatus({
      hasConnected: true,
      disconnectedAt: new Date(start).toISOString(),
      reconnectPhase: "waiting",
    });
    expect(shouldSurfaceOutage(status, start + 1_000, WS_OUTAGE_GRACE_MS)).toBe(false);
  });
  it("surfaces once the grace window elapses", () => {
    const status = makeStatus({
      hasConnected: true,
      disconnectedAt: new Date(start).toISOString(),
      reconnectPhase: "waiting",
    });
    expect(shouldSurfaceOutage(status, start + 3_000, WS_OUTAGE_GRACE_MS)).toBe(true);
  });
  it("surfaces immediately when exhausted regardless of timing", () => {
    const status = makeStatus({ hasConnected: true, reconnectPhase: "exhausted" });
    expect(shouldSurfaceOutage(status, start, WS_OUTAGE_GRACE_MS)).toBe(true);
  });
  it("stays silent when there is no active outage", () => {
    expect(shouldSurfaceOutage(makeStatus({ disconnectedAt: null }), start, 0)).toBe(false);
  });
});

describe("outageGraceMs", () => {
  it("surfaces offline immediately and other outages after the window", () => {
    expect(outageGraceMs("offline")).toBe(0);
    expect(outageGraceMs("reconnecting")).toBe(WS_OUTAGE_GRACE_MS);
  });
});
