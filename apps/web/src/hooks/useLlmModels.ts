import { useCallback, useState } from "react";

import { useDocumentVisible } from "./useDocumentVisible";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { LlmModelsSample } from "~/lib/llmModels";
import { llmModelsEnvironment } from "~/state/llmModels";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

export interface LlmModelsState {
  readonly sample: LlmModelsSample | null;
  /** True while a live subscription is attached and pushing samples. */
  readonly streaming: boolean;
}

/**
 * Subscribe to the environment's local-model probe stream while `enabled` and the tab
 * is visible. Passing `null` to the query atom (when inactive) tears the subscription
 * down — which, with the family's `idleTtlMs: 0`, stops the server-side probing too.
 */
export function useLlmModels(environmentId: EnvironmentId, enabled = true): LlmModelsState {
  const visible = useDocumentVisible();
  const active = enabled && visible;
  const view = useEnvironmentQuery(
    active ? llmModelsEnvironment.samples({ environmentId, input: {} }) : null,
  );
  const sample = view.data;
  return { sample, streaming: active && sample !== null };
}

export interface LlmModelActions {
  /** Config ids with a load/unload in flight (for per-row spinners + double-click guards). */
  readonly pending: ReadonlySet<string>;
  readonly load: (configId: string) => Promise<void>;
  readonly unload: (configId: string) => Promise<void>;
}

/**
 * Load/unload actions for the local-model manager, tracking in-flight keys so rows
 * can show a spinner and ignore double-clicks. `onError` surfaces a typed failure
 * (e.g. budget exceeded) to the caller for a toast/inline message.
 */
export function useLlmModelActions(
  environmentId: EnvironmentId,
  onError?: (message: string) => void,
): LlmModelActions {
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const loadCommand = useAtomCommand(llmModelsEnvironment.load, {
    label: "llm-models:load",
    reportFailure: false,
  });
  const unloadCommand = useAtomCommand(llmModelsEnvironment.unload, {
    label: "llm-models:unload",
    reportFailure: false,
  });

  const withPending = useCallback(async (key: string, run: () => Promise<void>) => {
    setPending((prev) => new Set(prev).add(key));
    try {
      await run();
    } finally {
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }, []);

  const load = useCallback(
    (configId: string) =>
      withPending(`load:${configId}`, async () => {
        const result = await loadCommand({ environmentId, input: { configId } });
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          onError?.(error instanceof Error ? error.message : String(error));
        }
      }),
    [environmentId, loadCommand, onError, withPending],
  );

  const unload = useCallback(
    (configId: string) =>
      withPending(`unload:${configId}`, async () => {
        const result = await unloadCommand({ environmentId, input: { configId } });
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          onError?.(error instanceof Error ? error.message : String(error));
        }
      }),
    [environmentId, unloadCommand, onError, withPending],
  );

  return { pending, load, unload };
}
