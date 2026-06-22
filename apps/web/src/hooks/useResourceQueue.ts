import { useEffect, useState, useSyncExternalStore } from "react";
import type { EnvironmentId, ResourceQueueSnapshot } from "@t3tools/contracts";
import { readEnvironmentApi } from "~/environmentApi";

function subscribeVisibility(listener: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}

/** Pause polling while the tab is hidden so a backgrounded window costs nothing. */
function useDocumentVisible(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    () => typeof document === "undefined" || !document.hidden,
    () => true,
  );
}

/** Background cadence: a glanceable count that does not need to be live. */
const IDLE_INTERVAL_MS = 60_000;
/** Active cadence: while the popover is open, refresh the list + count every few seconds. */
const ACTIVE_INTERVAL_MS = 5_000;

export interface ResourceQueueState {
  /** Latest snapshot, or null before the first poll resolves. */
  readonly snapshot: ResourceQueueSnapshot | null;
}

/**
 * Poll the environment's resource-broker queue. The cadence is `fast` (popover open) vs
 * slow (background); changing it re-polls immediately so opening the popover refreshes at
 * once. Polling pauses while the tab is hidden, and a transient RPC failure keeps the last
 * snapshot rather than clearing it.
 */
export function useResourceQueue(
  environmentId: EnvironmentId | null,
  fast: boolean,
): ResourceQueueState {
  const [snapshot, setSnapshot] = useState<ResourceQueueSnapshot | null>(null);
  const visible = useDocumentVisible();
  const active = environmentId != null && visible;
  const intervalMs = fast ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS;

  useEffect(() => {
    if (!active || environmentId == null) return;
    const api = readEnvironmentApi(environmentId);
    if (!api) return;
    let cancelled = false;
    const tick = () => {
      api.resourceQueue
        .get()
        .then((next) => {
          if (!cancelled) setSnapshot(next);
        })
        .catch(() => {
          // Transient RPC failure: keep the last snapshot and try again next tick.
        });
    };
    tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [environmentId, active, intervalMs]);

  return { snapshot };
}
