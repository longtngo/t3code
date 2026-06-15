import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { readEnvironmentApi } from "~/environmentApi";
import type { LlmModelsSample } from "~/lib/llmModels";

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

export interface LlmModelsState {
  readonly sample: LlmModelsSample | null;
  /** True while a live subscription is attached and pushing samples. */
  readonly streaming: boolean;
}

/**
 * Subscribe to the environment's local-model probe stream while `enabled` and the tab
 * is visible. Tears down on disable, environment change, or unmount — which stops the
 * server-side probing too.
 */
export function useLlmModels(environmentId: EnvironmentId, enabled = true): LlmModelsState {
  const [sample, setSample] = useState<LlmModelsSample | null>(null);
  const visible = useDocumentVisible();
  const active = enabled && visible;

  useEffect(() => {
    if (!active) {
      setSample(null);
      return;
    }
    const api = readEnvironmentApi(environmentId);
    if (!api) return;
    const unsubscribe = api.llmModels.subscribe((next) => setSample(next));
    return () => {
      unsubscribe();
    };
  }, [environmentId, active]);

  return { sample, streaming: active && sample !== null };
}

export interface LlmModelActions {
  /** PID currently being unloaded, or modelId currently being loaded (for per-row spinners). */
  readonly pending: ReadonlySet<string>;
  readonly load: (modelId: string) => Promise<void>;
  readonly unload: (pid: number) => Promise<void>;
}

/**
 * Load/unload actions for the local-model manager, tracking in-flight keys so rows
 * can show a spinner and ignore double-clicks. `onError` surfaces a typed failure
 * (e.g. budget exceeded) to the caller for a toast.
 */
export function useLlmModelActions(
  environmentId: EnvironmentId,
  onError?: (message: string) => void,
): LlmModelActions {
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());

  const withPending = useCallback(
    async (key: string, run: () => Promise<unknown>) => {
      setPending((prev) => new Set(prev).add(key));
      try {
        await run();
      } catch (error) {
        onError?.(error instanceof Error ? error.message : String(error));
      } finally {
        setPending((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    },
    [onError],
  );

  const load = useCallback(
    (modelId: string) => {
      const api = readEnvironmentApi(environmentId);
      if (!api) return Promise.resolve();
      return withPending(`load:${modelId}`, () => api.llmModels.load({ modelId }));
    },
    [environmentId, withPending],
  );

  const unload = useCallback(
    (pid: number) => {
      const api = readEnvironmentApi(environmentId);
      if (!api) return Promise.resolve();
      return withPending(`unload:${pid}`, () => api.llmModels.unload({ pid }));
    },
    [environmentId, withPending],
  );

  return { pending, load, unload };
}
