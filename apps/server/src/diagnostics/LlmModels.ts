import type { LlmModelsSample } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { LlmServeManager } from "../llm/LlmServeManager.ts";

/** Floor on the requested cadence; model load state changes slowly, so this is coarse. */
const MIN_INTERVAL_MS = 1000;
/** First sample uses a short window so the indicator fills in quickly. */
const BOOTSTRAP_DELAY_MS = 300;

interface SamplerState {
  /** The first tick uses a short window; subsequent ticks use the full interval. */
  readonly first: boolean;
}

/**
 * Per-subscriber local-model samples from `LlmServeManager`'s snapshot (which scans `ps`,
 * the models dirs, and probes processes). `list` is total, so the error channel is `never`.
 * Ends with the subscriber's scope: no background work without a listener.
 */
export function llmModelsStream(
  intervalMs: number,
): Stream.Stream<LlmModelsSample, never, LlmServeManager> {
  const interval = Duration.millis(Math.max(MIN_INTERVAL_MS, Math.round(intervalMs)));
  const bootstrap = Duration.millis(BOOTSTRAP_DELAY_MS);
  const initial: SamplerState = { first: true };

  return Stream.unfold(initial, (state) =>
    Effect.gen(function* () {
      yield* Effect.sleep(state.first ? bootstrap : interval);
      const manager = yield* LlmServeManager;
      const { providers, ramBudgetBytes, ramUsedBytes } = yield* manager.list;
      const now = yield* DateTime.now;
      const sample: LlmModelsSample = {
        ts: DateTime.toEpochMillis(now),
        providers,
        ramBudgetBytes,
        ramUsedBytes,
      };
      return [sample, { first: false }] as const;
    }),
  );
}
