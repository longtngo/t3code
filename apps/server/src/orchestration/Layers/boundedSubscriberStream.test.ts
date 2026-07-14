import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import { boundedSubscriberStream } from "./boundedSubscriberStream.ts";

describe("boundedSubscriberStream", () => {
  // `it.live` (real Clock) because these exercise the forked pump and a real
  // `Effect.sleep`; `it.effect`'s TestClock would never advance the sleep.
  it.live("delivers every event to a prompt consumer, in order", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const hub = yield* PubSub.unbounded<number>();
        const subscription = yield* PubSub.subscribe(hub);
        const stream = yield* boundedSubscriberStream(subscription, 16);
        yield* PubSub.publish(hub, 1);
        yield* PubSub.publish(hub, 2);
        yield* PubSub.publish(hub, 3);
        const result = yield* stream.pipe(Stream.take(3), Stream.runCollect);
        expect(result).toEqual([1, 2, 3]);
      }),
    ),
  );

  it.live(
    "terminates cleanly (bounded) instead of buffering unboundedly when the consumer falls `capacity` behind",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const hub = yield* PubSub.unbounded<number>();
          const subscription = yield* PubSub.subscribe(hub);
          // Tiny capacity so a non-draining consumer overflows immediately.
          const stream = yield* boundedSubscriberStream(subscription, 2);

          // Publish far more than the buffer can hold while nothing consumes the
          // returned stream — the pump must drain the subscription (so the hub
          // never pins) and, on overflow, end the stream rather than grow.
          for (let n = 0; n < 100; n++) {
            yield* PubSub.publish(hub, n);
          }
          // Let the forked pump process the backlog and trip the overflow.
          yield* Effect.sleep("50 millis");

          // The stream must COMPLETE (not hang, not interrupt) — proof the
          // overflow ended it cleanly — and must have delivered no more than the
          // buffer capacity — proof it did not retain all 100. A timeout guards
          // against a hang regression.
          const collected = yield* Stream.runCollect(stream).pipe(Effect.timeout("2 seconds"));
          expect(collected.length).toBeLessThanOrEqual(2);
        }),
      ),
  );

  it.live("stops draining the hub once the subscriber scope closes", () =>
    Effect.gen(function* () {
      const hub = yield* PubSub.unbounded<number>();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(hub);
          // Fork the pump; we don't consume the returned stream — the point is
          // that closing the scope stops it draining.
          yield* boundedSubscriberStream(subscription, 4).pipe(Effect.asVoid);
        }),
      );
      // With no live subscriber, an unbounded PubSub retains nothing.
      yield* PubSub.publish(hub, 1);
      expect(yield* PubSub.size(hub)).toBe(0);
    }),
  );
});
