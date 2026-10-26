import { WS_METHODS } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  getSlowRpcAckRequests,
  resetRequestLatencyStateForTests,
  trackRpcRequestSent,
  LONG_RUNNING_RPC_ACK_THRESHOLD_MS,
  SLOW_RPC_ACK_THRESHOLD_MS,
} from "./requestLatencyState";

describe("requestLatencyState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetRequestLatencyStateForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Fork rule: slow-by-design and background calls get the long leash, never the untracked set,
  // so a call that has wedged is still reported.
  it.each([WS_METHODS.serverGetUsageSummary, WS_METHODS.serverReportClientActivity])(
    "gives %s the long leash instead of no tracking",
    (method) => {
      trackRpcRequestSent("1", method);
      vi.advanceTimersByTime(LONG_RUNNING_RPC_ACK_THRESHOLD_MS - 1);

      expect(getSlowRpcAckRequests()).toEqual([]);

      vi.advanceTimersByTime(1);

      expect(getSlowRpcAckRequests()).toMatchObject([
        { requestId: "1", tag: method, thresholdMs: LONG_RUNNING_RPC_ACK_THRESHOLD_MS },
      ]);
    },
  );

  it.each(
    Object.values(WS_METHODS).filter(
      (method) => method.startsWith("pullRequests.") && !method.includes("subscribe"),
    ),
  )("keeps quiet about pull request request %s at the normal threshold", (method) => {
    trackRpcRequestSent("1", method);
    vi.advanceTimersByTime(SLOW_RPC_ACK_THRESHOLD_MS * 2);

    expect(getSlowRpcAckRequests()).toEqual([]);
  });

  // Quiet at 15s because fanning out across every server takes that long, still audible at 120s
  // because by then the call has wedged. Subscriptions are excluded by `isTrackedRpcAck` (every
  // method containing "subscribe" is a long-lived stream), so `pullRequests.subscribeRefreshes` is
  // left out of this enumeration.
  it.each(
    Object.values(WS_METHODS).filter(
      (method) => method.startsWith("pullRequests.") && !method.includes("subscribe"),
    ),
  )("still reports pull request request %s once it has wedged", (method) => {
    trackRpcRequestSent("1", method);
    vi.advanceTimersByTime(LONG_RUNNING_RPC_ACK_THRESHOLD_MS - 1);
    expect(getSlowRpcAckRequests()).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(getSlowRpcAckRequests()).toMatchObject([
      { requestId: "1", tag: method, thresholdMs: LONG_RUNNING_RPC_ACK_THRESHOLD_MS },
    ]);
  });
});
