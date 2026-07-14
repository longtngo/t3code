import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

/**
 * Wrap an eager PubSub subscription in a bounded, self-draining buffer so a slow
 * or dead WebSocket consumer can never pin the (unbounded) domain-event hub.
 *
 * The hub (`OrchestrationEngine`'s `eventPubSub`) is `PubSub.unbounded`: it
 * retains every message until *every* current subscriber has taken it. A WS
 * subscription whose downstream socket write blocks (a dead mobile socket with no
 * close frame) backpressures its own take-loop → it stops draining → the hub
 * retains all threads' events for it forever → OOM. This is the confirmed leak.
 *
 * The fix decouples the take-loop from the socket write: a forked pump takes from
 * the subscription **immediately and unconditionally** (so the hub always
 * reclaims) into a bounded {@link Queue.dropping} buffer that the socket writer
 * drains at its own pace. If the consumer falls `capacity` events behind, the
 * next offer is dropped; rather than silently diverge the client (which does no
 * mid-stream gap detection), the pump **shuts the buffer down**, ending the
 * stream cleanly. The client transport treats a completed subscription stream as
 * a resubscribe trigger and re-attaches from its last-applied sequence, so the
 * server replays exactly what it missed — a brief catch-up, never lost data.
 *
 * Only the WS-facing `subscribeDomainEvents` uses this; the internal reactors
 * consume `streamDomainEvents` and must stay lossless, so they are untouched.
 */
export const boundedSubscriberStream = <A>(
  subscription: PubSub.Subscription<A>,
  capacity: number,
): Effect.Effect<Stream.Stream<A>, never, Scope.Scope> =>
  Effect.gen(function* () {
    // `Cause.Done` in the queue's error channel lets `Queue.end` signal clean
    // completion; `Stream.fromQueue` excludes it, so the stream stays `Stream<A>`.
    const buffer = yield* Queue.dropping<A, Cause.Done>(capacity);
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        while (true) {
          const item = yield* PubSub.take(subscription);
          const accepted = yield* Queue.offer(buffer, item);
          if (!accepted) {
            // Consumer is `capacity` behind: end the stream *cleanly* (a `Done`
            // signal, excluded from the stream's error channel) so the RPC
            // completes normally and the client resubscribes-and-resyncs from its
            // last-applied sequence, instead of pinning the hub. `Queue.shutdown`
            // would interrupt the stream (surfacing as an error) — the transport
            // would then log-and-stop rather than resubscribe.
            yield* Queue.end(buffer);
            return;
          }
        }
      }),
    );
    return Stream.fromQueue(buffer);
  });
