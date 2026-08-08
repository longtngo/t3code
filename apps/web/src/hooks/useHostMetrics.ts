import { useCallback, useSyncExternalStore } from "react";

import { useDocumentVisible } from "./useDocumentVisible";
import type { EnvironmentId } from "@t3tools/contracts";
import type { HostMetricsSample } from "~/lib/hostMetrics";
import { hostMetricsEnvironment } from "~/state/hostMetrics";
import { useEnvironmentQuery } from "~/state/query";

const STORAGE_KEY = "t3code:host-metrics-enabled";

let enabledListeners: Array<() => void> = [];

function emitEnabledChange() {
  for (const listener of enabledListeners) listener();
}

function hasStorage() {
  return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

/** Default on so the metrics are discoverable; the toggle is for opting out to save bandwidth. */
function getStoredEnabled(): boolean {
  if (!hasStorage()) return true;
  return localStorage.getItem(STORAGE_KEY) !== "false";
}

function subscribeEnabled(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  enabledListeners.push(listener);
  const handleStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) emitEnabledChange();
  };
  window.addEventListener("storage", handleStorage);
  return () => {
    enabledListeners = enabledListeners.filter((entry) => entry !== listener);
    window.removeEventListener("storage", handleStorage);
  };
}

/** Persisted (per-client, cross-tab) toggle for whether host metrics stream. */
export function useHostMetricsEnabled(): readonly [boolean, (next: boolean) => void] {
  const enabled = useSyncExternalStore(subscribeEnabled, getStoredEnabled, () => true);
  const setEnabled = useCallback((next: boolean) => {
    if (!hasStorage()) return;
    localStorage.setItem(STORAGE_KEY, next ? "true" : "false");
    emitEnabledChange();
  }, []);
  return [enabled, setEnabled] as const;
}

export interface HostMetricsState {
  readonly sample: HostMetricsSample | null;
  /** True while a live subscription is attached and pushing samples. */
  readonly streaming: boolean;
}

/**
 * Subscribe to the environment's host-metrics stream while `enabled` and the tab
 * is visible. Passing `null` to the query atom (when inactive) tears the
 * subscription down — which, with the family's `idleTtlMs: 0`, stops the
 * server-side sampling too. Returning to the tab resubscribes fresh.
 */
export function useHostMetrics(environmentId: EnvironmentId, enabled: boolean): HostMetricsState {
  const visible = useDocumentVisible();
  const active = enabled && visible;
  const view = useEnvironmentQuery(
    active ? hostMetricsEnvironment.samples({ environmentId, input: {} }) : null,
  );
  const sample = view.data;
  return { sample, streaming: active && sample !== null };
}
