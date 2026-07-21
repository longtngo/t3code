import * as Stream from "effect/Stream";

/**
 * Event-count bound for a long-lived WebSocket subscription stream — the twin of
 * {@link ../orchestration/Layers/boundedSubscriberStream.boundedSubscriberStream},
 * which bounds the *same* subscription streams on the other axis (consumer-lag
 * capacity). Both end the stream *cleanly* so the client resubscribes-and-resyncs;
 * this one is triggered by throughput rather than by a slow consumer.
 *
 * ## Why this exists — and a CORRECTION (2026-07-21)
 *
 * This recycle was introduced (2026-07-18) believing the recurring server OOM came
 * from a per-element fiber-`_stack` accumulation: that `RpcServer`'s forked request
 * fiber running `Stream.runForEachArray(stream, sendChunk)` grew its continuation
 * `_stack` by one frame per streamed element. **That mechanism was wrong.**
 * `Stream.runForEachArray` (and `Stream.fromPull`) run under `Effect.forever` /
 * `whileLoop`, which is trampolined to constant stack depth (`Channel.js` runWith /
 * `internal/effect.js` whileLoop) — they do NOT grow `_stack` per element.
 *
 * The real leak (source-verified 2026-07-21) was a non-stack-safe schedule loop
 * inside effect's `Stream.groupedWithin` → `aggregateWithin` (`stepToBuffer`), used
 * ONLY on `subscribeThread`: every idle 20 ms `Schedule.spaced` tick self-recursed
 * under `flatMap(() => Effect.never)` + `catchDone`, pinning +2 frames per tick
 * forever. That is fixed by replacing `groupedWithin` with `batchWithinStackSafe`
 * (see {@link ./orchestration/Layers/batchWithinStackSafe}). This `Stream.take`
 * recycle did NOT prevent that leak (it bounds *emitted* elements, while the leak
 * grew fastest when zero were emitted) — which is why the server kept OOM-crashing
 * after it shipped.
 *
 * ## What this actually does now
 *
 * Capping a subscription stream at `maxElements` ends it cleanly, so the RpcServer
 * request fiber completes and the client transport resubscribes-and-resyncs
 * (identical to `boundedSubscriberStream`'s drop-behind path). With the real leak
 * fixed elsewhere, this is a *defensive* periodic event-count bound on long-lived
 * streams, not the OOM cure it was thought to be. Its remaining value is uncertain
 * given the trampolining finding above — it is a candidate for removal (a
 * documented follow-up), kept for now as harmless (clean resubscribes) belt-and-
 * braces.
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
