import { useSyncExternalStore } from "react";

function subscribeVisibility(listener: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}

/**
 * Whether the tab is currently visible, so pollers and live subscriptions can stand down
 * while a backgrounded window costs nothing.
 *
 * The server snapshot is `true`: during SSR there is no document to be hidden, and starting
 * "visible" means the first client render does not flash a paused state before hydration.
 */
export function useDocumentVisible(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    () => typeof document === "undefined" || !document.hidden,
    () => true,
  );
}
