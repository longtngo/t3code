import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { readEnvironmentApi } from "~/environmentApi";
import type { HostMetricsSample } from "~/lib/hostMetrics";

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

function subscribeVisibility(listener: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}

/** Pause streaming while the tab is hidden so a backgrounded window costs nothing. */
function useDocumentVisible(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    () => typeof document === "undefined" || !document.hidden,
    () => true,
  );
}

export interface HostMetricsState {
  readonly sample: HostMetricsSample | null;
  /** True while a live subscription is attached and pushing samples. */
  readonly streaming: boolean;
}

/**
 * Subscribe to the environment's host-metrics stream while `enabled` and the tab
 * is visible. Tears down on disable, environment change, or unmount — which stops
 * the server-side sampling too.
 */
export function useHostMetrics(environmentId: EnvironmentId, enabled: boolean): HostMetricsState {
  const [sample, setSample] = useState<HostMetricsSample | null>(null);
  const visible = useDocumentVisible();
  const active = enabled && visible;

  useEffect(() => {
    if (!active) {
      setSample(null);
      return;
    }
    const api = readEnvironmentApi(environmentId);
    if (!api) return;
    const unsubscribe = api.hostMetrics.subscribe((next) => setSample(next));
    return () => {
      unsubscribe();
    };
  }, [environmentId, active]);

  return { sample, streaming: active && sample !== null };
}
