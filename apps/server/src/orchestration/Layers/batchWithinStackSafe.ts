import * as Arr from "effect/Array";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

/**
 * Coalesce a long-lived subscription stream into `<= maxBatch`-element batches by
 * **backpressure** — the stack-safe, timer-free replacement for
 * `Stream.groupedWithin`. The twin of
 * {@link ./boundedSubscriberStream.boundedSubscriberStream}: same shape (a bounded
 * `Queue` + a scoped forked pump), here to batch rather than to drop-behind.
 *
 * ## Why this exists (the OOM it fixes)
 *
 * `Stream.groupedWithin(n, d)` lowers to effect's `aggregateWithin`, whose
 * internal schedule loop `stepToBuffer` (effect `Stream.js:5887`) is **not
 * stack-safe**: while the subscription is idle, its `Schedule.spaced` tick
 * self-recurses inside a `flatMap(() => Effect.never)` + `Pull.catchDone` that
 * never unwinds, pinning +2 continuation frames on the request fiber's `_stack`
 * *per tick, forever*. On `subscribeThread` that was a monotonic ~1.9 GB/hr heap
 * climb to an OOM crash at the V8 ceiling every ~13-14 h. (Two live heap snapshots
 * 365 s apart measured the `_stack` growing 161,817 -> 191,523 frames — tracking
 * the 20 ms timer, not the event rate.) The prior `Stream.take` recycle could not
 * fix it: it bounds *emitted* frames, and this leak grows fastest when *zero*
 * frames are emitted.
 *
 * ## Why this is safe
 *
 * - **Stack-safe.** Both the pump (`Stream.runForEachArray`) and the output
 *   (`Stream.fromPull`) are driven by the channel runtime's `Effect.forever` /
 *   `whileLoop` (effect `Channel.js:3714`), which is trampolined to constant stack
 *   depth. There is no self-recursion accumulating frames (unlike `stepToBuffer`).
 * - **No idle timer.** When the queue is empty, `Queue.takeBetween(q, 1, maxBatch)`
 *   parks on `awaitTake` (a blocked `Deferred`) — no schedule ticking, no frame
 *   growth. This is the exact property `groupedWithin` lacked.
 * - **Memory bounded.** The hand-off queue is `Queue.bounded`. If the consumer
 *   (socket writer) stalls, `offerAll` in the pump backpressures once the queue is
 *   full, so memory is capped at `bufferCapacity` here plus the upstream
 *   `boundedSubscriberStream` buffer. For a *slow-but-alive* consumer the upstream
 *   then drops+ends → source ends → `Queue.end` → clean stream end → resubscribe.
 *   For a *fully dead* socket the pump simply stays parked in `offerAll` (bounded,
 *   not growing) until the WS transport's dead-socket detection tears down the RPC
 *   scope, which interrupts the parked pump — reclaim is via transport teardown,
 *   not the internal chain, but memory is bounded throughout. An unbounded queue
 *   here would instead re-open the exact dead-socket OOM this closes.
 * - **Clean completion.** `Queue.end` fails the queue with `Cause.Done`; a take on
 *   an ended+empty queue surfaces `Cause.Done`, which `Stream.fromPull` erases via
 *   `Pull.ExcludeDone` into an `Exit.success` stream end (not a transport error) —
 *   so the client resubscribes rather than stopping.
 *
 * ## Semantics
 *
 * Coalescing is backpressure-driven: events accumulate only when they arrive
 * faster than the consumer sends them (a slow/constrained client, or a burst
 * outrunning the round-trip), and the next pull returns them as one `<= maxBatch`
 * batch. A client that keeps up gets size-1 batches with zero added latency. FIFO
 * order; every batch is >= 1 element (never emits an empty batch).
 *
 * @param source the (already per-subscription, already-filtered) event stream
 * @param maxBatch max events per emitted batch (>= 1)
 * @param bufferCapacity bounded hand-off buffer size (backpressure threshold)
 */
export const batchWithinStackSafe = <A>(
  source: Stream.Stream<A>,
  maxBatch: number,
  bufferCapacity: number,
): Stream.Stream<A[]> => {
  if (maxBatch < 1) {
    throw new Error(`batchWithinStackSafe: maxBatch must be >= 1 (got ${maxBatch})`);
  }
  return Stream.unwrap(
    Effect.gen(function* () {
      // Bounded (backpressuring) queue; `Cause.Done` in the error channel lets
      // `Queue.end` signal clean completion (excluded by `Pull` => `Stream<A[]>`).
      const queue = yield* Queue.bounded<A, Cause.Done>(bufferCapacity);
      // Pump: drain source arrays into the queue; end the queue when the source
      // ends OR fails. `ensuring(Queue.end)` intentionally maps a source *failure*
      // to clean completion too (same philosophy as boundedSubscriberStream; the
      // live event stream realistically only ends cleanly). `runForEachArray` is
      // `Effect.forever`/`whileLoop` — trampolined, so the pump holds constant
      // stack depth regardless of event volume.
      yield* Effect.forkScoped(
        Stream.runForEachArray(source, (chunk) => Queue.offerAll(queue, chunk)).pipe(
          Effect.ensuring(Queue.end(queue)),
        ),
      );
      // Pull: block for >= 1 element (idle => park, no timer), take up to
      // `maxBatch` of whatever accumulated since the last pull => one batch per
      // downstream element. `fromPull` takes an acquire effect that resolves to
      // the (reused) pull.
      const pull = Queue.takeBetween(queue, 1, maxBatch).pipe(
        Effect.map((batch) => Arr.of(batch)),
      );
      return Stream.fromPull(Effect.succeed(pull));
    }),
  );
};
