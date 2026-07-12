import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  getWsConnectionStatus,
  getWsReconnectDelayMsForRetry,
  getWsConnectionUiState,
  recordWsConnectionAttempt,
  recordWsConnectionClosed,
  recordWsConnectionErrored,
  recordWsConnectionOpened,
  recordWsHeartbeatPing,
  recordWsHeartbeatPong,
  recordWsHeartbeatTimeout,
  resetWsConnectionStateForTests,
  setBrowserOnlineStatus,
} from "./wsConnectionState";

describe("wsConnectionState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-03T20:30:00.000Z"));
    resetWsConnectionStateForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("treats a disconnected browser as offline once the websocket drops", () => {
    recordWsConnectionAttempt("ws://localhost:3020/ws");
    recordWsConnectionOpened();
    recordWsConnectionClosed({ code: 1006, reason: "offline" });
    setBrowserOnlineStatus(false);

    expect(getWsConnectionUiState(getWsConnectionStatus())).toBe("offline");
  });

  it("records heartbeat ping/pong round-trip and timeout counts", () => {
    recordWsConnectionAttempt("ws://localhost:3020/ws");
    recordWsConnectionOpened();

    recordWsHeartbeatPing();
    expect(getWsConnectionStatus().lastHeartbeatPingAt).toBe("2026-04-03T20:30:00.000Z");

    // A pong 250ms after the ping yields a 250ms RTT (the detection-latency signal).
    vi.advanceTimersByTime(250);
    recordWsHeartbeatPong();
    expect(getWsConnectionStatus()).toMatchObject({
      lastHeartbeatPongAt: "2026-04-03T20:30:00.250Z",
      lastHeartbeatRttMs: 250,
    });

    // A pong with no outstanding ping keeps the prior RTT rather than inventing one.
    resetWsConnectionStateForTests();
    recordWsHeartbeatPong();
    expect(getWsConnectionStatus().lastHeartbeatRttMs).toBeNull();

    recordWsHeartbeatTimeout();
    recordWsHeartbeatTimeout();
    expect(getWsConnectionStatus().heartbeatTimeoutCount).toBe(2);
  });

  it("stays in the initial connecting state until the first disconnect", () => {
    recordWsConnectionAttempt("ws://localhost:3020/ws");

    expect(getWsConnectionStatus()).toMatchObject({
      attemptCount: 1,
      hasConnected: false,
      phase: "connecting",
    });
    expect(getWsConnectionUiState(getWsConnectionStatus())).toBe("connecting");
  });

  it("schedules the next retry after a failed websocket attempt", () => {
    recordWsConnectionAttempt("ws://localhost:3020/ws", {
      connectionLabel: "Remote Mac",
    });
    recordWsConnectionErrored("Unable to connect to the T3 server WebSocket.");

    const firstRetryDelayMs = getWsReconnectDelayMsForRetry(0);
    if (firstRetryDelayMs === null) {
      throw new Error("Expected an initial retry delay.");
    }

    expect(getWsConnectionStatus()).toMatchObject({
      connectionLabel: "Remote Mac",
      nextRetryAt: new Date(Date.now() + firstRetryDelayMs).toISOString(),
      reconnectAttemptCount: 1,
      reconnectPhase: "waiting",
    });
  });

  it("adds a version mismatch hint to websocket errors when metadata includes one", () => {
    recordWsConnectionAttempt("ws://localhost:3020/ws", {
      connectionLabel: "Remote Mac",
    });
    recordWsConnectionErrored("Unable to connect to the T3 server WebSocket.", {
      versionMismatchHint: "Version mismatch. Try syncing the client and server.",
    });

    expect(getWsConnectionStatus()).toMatchObject({
      lastError:
        "Unable to connect to the T3 server WebSocket. Hint: Version mismatch. Try syncing the client and server.",
    });
  });

  it("adds a version mismatch hint to websocket close reasons when metadata includes one", () => {
    recordWsConnectionAttempt("ws://localhost:3020/ws");
    recordWsConnectionOpened();
    recordWsConnectionClosed(
      { code: 1006, reason: "socket closed" },
      {
        versionMismatchHint: "Version mismatch. Try syncing the client and server.",
      },
    );

    expect(getWsConnectionStatus()).toMatchObject({
      closeReason: "socket closed Hint: Version mismatch. Try syncing the client and server.",
    });
  });

  it("never marks the reconnect cycle as exhausted with infinite retries", () => {
    recordWsConnectionAttempt("wss://x");
    recordWsConnectionOpened();
    for (let attempt = 0; attempt < 12; attempt += 1) {
      recordWsConnectionAttempt("wss://x");
      recordWsConnectionErrored("boom");
    }
    expect(getWsConnectionStatus()).toMatchObject({
      reconnectPhase: "waiting",
    });
    expect(getWsConnectionStatus().nextRetryAt).not.toBeNull();
  });
});
