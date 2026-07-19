import * as Stream from "effect/Stream";

/**
 * Event-count bound for a long-lived WebSocket subscription stream — the twin of
 * {@link ../orchestration/Layers/boundedSubscriberStream.boundedSubscriberStream},
 * which bounds the *same* subscription streams on the other axis (consumer-lag
 * capacity). Both end the stream *cleanly* so the client resubscribes-and-resyncs;
 * this one is triggered by throughput rather than by a slow consumer.
 *
 * ## Why this exists
 *
 * Effect's `RpcServer` streaming layer (`effect/unstable/rpc`) handles each
 * subscription request in its own forked request fiber running
 * `Stream.runForEachArray(stream, sendChunk)`. That fiber's continuation `_stack`
 * grows by one frame per streamed element and is never trimmed for the life of the
 * subscription. On long-lived, high-volume subscriptions (`subscribeThread`,
 * `subscribeShell`, `subscribeTerminalMetadata` during long autonomous sessions)
 * the stack grows unbounded — a sustained ~1.7 GB/hr heap climb to an OOM crash at
 * whatever `--max-old-space-size` ceiling is set. Capturing 4+ live heap snapshots
 * pinned the leak to this per-element accumulation (517K → 690K → 1.09M frames);
 * the fiber (and its stack) is freed the moment its stream completes.
 *
 * Capping the stream at `maxElements` ends it cleanly, the RpcServer fiber
 * completes and frees its stack, and the client transport treats the clean
 * completion as a resubscribe-and-resync trigger (identical to what
 * `boundedSubscriberStream`'s drop-behind path already does in production). Peak
 * per-fiber stack is bounded to `maxElements` frames and rebuilt from zero on each
 * recycle, so the heap can no longer climb without bound.
 *
 * The completion MUST be clean (`Exit.success`): the client resubscribes on a
 * successful stream end but *stops* (no resubscribe) on a non-transport error.
 * `Stream.take` ends via `Cause.done()` — a successful halt — which is exactly
 * what the client requires.
 */
export const DEFAULT_WS_SUBSCRIPTION_MAX_EVENTS = 20000;

/**
 * Floor for any enabled recycle limit. A too-small limit turns the recycle into a
 * tight snapshot-only resubscribe loop (`take(1)` emits only the snapshot frame →
 * immediate resubscribe → 100 % CPU, no live updates delivered), so a
 * fat-fingered env must never be able to wedge the server. Positive values below
 * the floor are clamped up to it.
 */
export const MIN_WS_SUBSCRIPTION_MAX_EVENTS = 100;

/**
 * Resolve the per-subscription recycle limit from a raw environment string.
 *
 * - `"0"` → `0`, an explicit kill-switch (mirrors the `T3CODE_HUB_GAUGE_MS === "0"`
 *   idiom in {@link ../orchestration/Layers/OrchestrationEngine}). A plain
 *   `parsePositiveIntEnv(...) ?? DEFAULT` cannot express disable — it maps `"0"` to
 *   `undefined` → default, which would leave the recycle silently ON. The sentinel
 *   is a strict `"0"`: near-misses (`"00"`, `" 0 "`) fall through to the default,
 *   i.e. the recycle stays ON — the fail-safe direction (protection on, never wedged).
 * - unset / non-numeric / non-finite / non-positive → {@link DEFAULT_WS_SUBSCRIPTION_MAX_EVENTS}.
 * - any positive value → clamped up to {@link MIN_WS_SUBSCRIPTION_MAX_EVENTS}.
 */
export const resolveSubscriptionRecycleLimit = (raw: string | undefined): number => {
  if (raw === "0") return 0;
  if (raw === undefined) return DEFAULT_WS_SUBSCRIPTION_MAX_EVENTS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_WS_SUBSCRIPTION_MAX_EVENTS;
  return Math.max(parsed, MIN_WS_SUBSCRIPTION_MAX_EVENTS);
};

/**
 * Cap a long-lived subscription stream at `maxElements` emitted elements, ending
 * it *cleanly* so the effect `RpcServer` request fiber completes and frees its
 * accumulated continuation `_stack`. `maxElements <= 0` disables the recycle
 * (identity — the stream is returned untouched). See the module doc for the full
 * rationale.
 */
export const recycleSubscriptionStream = <A, E, R>(
  stream: Stream.Stream<A, E, R>,
  maxElements: number,
): Stream.Stream<A, E, R> => (maxElements > 0 ? Stream.take(stream, maxElements) : stream);
