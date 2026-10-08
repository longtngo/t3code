import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { SLOW_RPC_ACK_THRESHOLD_MS } from "./rpc/requestLatencyState";
import { useThreadQueueLeavingStore, whileLeavingThreadQueue } from "./threadQueueLeaving";

const never = () => new Promise<never>(() => {});
const marked = (key: string) => useThreadQueueLeavingStore.getState().keys.has(key);

describe("whileLeavingThreadQueue with a command that never answers", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    useThreadQueueLeavingStore.setState({ keys: new Map() });
  });
  afterEach(() => vi.useRealTimers());

  it("releases the row after the slow-request threshold, so it is not held forever", () => {
    void whileLeavingThreadQueue("a", never);
    vi.advanceTimersByTime(SLOW_RPC_ACK_THRESHOLD_MS - 1);
    expect(marked("a")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(marked("a")).toBe(false);
  });

  it("a late answer after the release does not release another mark on the row", async () => {
    let answer!: () => void;
    const late = whileLeavingThreadQueue(
      "a",
      () => new Promise<void>((resolve) => (answer = resolve)),
    );
    vi.advanceTimersByTime(SLOW_RPC_ACK_THRESHOLD_MS);
    void whileLeavingThreadQueue("a", never);
    answer();
    await late;
    expect(marked("a")).toBe(true);
  });

  it("an answer in time leaves nothing that cuts the next mark on the row short", async () => {
    await whileLeavingThreadQueue("a", async () => {});
    vi.advanceTimersByTime(SLOW_RPC_ACK_THRESHOLD_MS / 2);
    void whileLeavingThreadQueue("a", never);
    vi.advanceTimersByTime(SLOW_RPC_ACK_THRESHOLD_MS / 2);
    expect(marked("a")).toBe(true);
  });
});
