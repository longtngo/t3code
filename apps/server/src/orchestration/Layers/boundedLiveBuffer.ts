import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

/**
 * Drain a live `source` stream into a bounded per-subscription `buffer`, ending the
 * buffer cleanly when the consumer falls behind. This is the OOM bound for each WS
 * subscription's live tail.
 *
 * Every WS subscribe (thread or shell) forks this pump to drain the (unbounded)
 * domain-event hub into a per-subscription buffer that the socket writer consumes
 * at its own pace. The pump offers every item **unconditionally** so the upstream
 * hub is always reclaimed (a subscription whose take-loop stalls would otherwise
 * pin the hub — retaining every thread's events for it forever). When the bounded
 * {@link Queue.dropping} buffer rejects an offer (the consumer is `capacity` events
 * behind — a stalled or dead socket that stopped draining without a close frame),
 * the pump {@link Queue.end}s the buffer and stops.
 *
 * `Queue.end` on a `Queue<A, Cause.Done>` surfaces to {@link Stream.fromQueue} as a
 * NORMAL completion (`Cause.Done` is excluded from the stream's error channel), so
 * the RPC stream ends cleanly rather than erroring. The client transport treats a
 * completed subscription stream as a resubscribe trigger and reconnects from its
 * last-applied sequence (`afterSequence`), so the server replays exactly what was
 * missed — a brief catch-up, never lost data, and the buffer never grows unbounded.
 *
 * The caller owns the `buffer` (so it can also offer control markers / drain it);
 * fork this pump into the subscription's scope. Only the WS live paths use this;
 * internal reactors consume the lossless `streamDomainEvents` and are untouched.
 */
export const pumpBoundedLiveBuffer = <A, E, R>(
  source: Stream.Stream<A, E, R>,
  buffer: Queue.Queue<A, Cause.Done>,
): Effect.Effect<void, E, R> =>
  // `runForEach` (not `runForEachWhile`) so the drain path is byte-for-byte the
  // original unbounded pump — the coalescing/timing of the live tail is unchanged
  // for every well-behaved subscriber. Only on overflow does the offer return
  // `false`; we then end the buffer (clean completion for the consumer) and
  // interrupt this forked pump to stop taking (`Queue.end` is durable, so a later
  // offer to the ended buffer would otherwise busy-loop returning `false`).
  Stream.runForEach(source, (item) =>
    Effect.flatMap(Queue.offer(buffer, item), (accepted) =>
      accepted ? Effect.void : Effect.andThen(Queue.end(buffer), Effect.interrupt),
    ),
  );
