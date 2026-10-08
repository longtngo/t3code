import { create } from "zustand";

import { SLOW_RPC_ACK_THRESHOLD_MS } from "./rpc/requestLatencyState";

/**
 * Queue entries this tab is taking out of the Queue, by thread key: a Queue row dropped into a
 * custom section, or a queued thread being snoozed, stays queued until that command lands. This
 * tab's coordinator claims none of them. Another tab's coordinator cannot see the mark.
 */
export const useThreadQueueLeavingStore = create<{ readonly keys: ReadonlyMap<string, number> }>(
  () => ({ keys: new Map() }),
);

// Counted: a drop and a snooze can mark the same row at once, and the first to end must not
// release the other.
function setLeaving(key: string, leaving: boolean) {
  useThreadQueueLeavingStore.setState(({ keys }) => {
    const next = new Map(keys);
    const count = (next.get(key) ?? 0) + (leaving ? 1 : -1);
    if (count > 0) next.set(key, count);
    else next.delete(key);
    return { keys: next };
  });
}

/**
 * Keeps `key` from being sent while `run` takes it out of the Queue. Whatever `run`'s outcome, the
 * mark ends with it: a row still queued then (a refused or failed move) is sendable again at once.
 * Commands have no timeout of their own, so a command that never answers (a dead connection) gives
 * the row back after the slow-request threshold rather than holding it forever.
 */
export async function whileLeavingThreadQueue<T>(key: string, run: () => Promise<T>): Promise<T> {
  let marked = true;
  const release = () => {
    if (!marked) return;
    marked = false;
    setLeaving(key, false);
  };
  setLeaving(key, true);
  const timer = setTimeout(release, SLOW_RPC_ACK_THRESHOLD_MS);
  try {
    return await run();
  } finally {
    clearTimeout(timer);
    release();
  }
}
