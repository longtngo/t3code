import { describe, expect, it } from "@effect/vitest";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { pumpBoundedLiveBuffer } from "./boundedLiveBuffer.ts";

describe("pumpBoundedLiveBuffer", () => {
  // `it.live` (real Clock) because these fork the pump and rely on a real
  // `Effect.sleep` to let the forked fiber process the backlog; `it.effect`'s
  // TestClock would never advance the sleep.

  it.live("delivers every event to a prompt consumer, in order", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const source = Stream.make(1, 2, 3);
        const buffer = yield* Queue.dropping<number, Cause.Done>(16);
        yield* Effect.forkScoped(pumpBoundedLiveBuffer(source, buffer));
        const result = yield* Stream.fromQueue(buffer).pipe(Stream.take(3), Stream.runCollect);
        expect(result).toEqual([1, 2, 3]);
      }),
    ),
  );

  it.live(
    "bounds the buffer and ENDS the stream (does not grow unbounded) when the consumer never drains",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const capacity = 2;
          // Tiny capacity so a non-draining consumer overflows immediately.
          const buffer = yield* Queue.dropping<number, Cause.Done>(capacity);

          // A source far larger than the buffer, standing in for a flood of live
          // domain events while the socket writer is stalled. Fork the pump; NOTHING
          // consumes the buffer's stream — the point is that a stalled consumer can
          // never grow the buffer past `capacity`, and that the pump ends rather than
          // retaining the whole flood (the OOM).
          const pump = yield* Effect.forkScoped(
            pumpBoundedLiveBuffer(Stream.range(0, 100_000), buffer),
          );

          // The pump fiber must COMPLETE (it stopped after ending the buffer on the
          // first overflow), proving it did not buffer all 100k or spin forever.
          yield* Fiber.await(pump).pipe(Effect.timeout("2 seconds"));

          // Draining the now-ENDED buffer must terminate (not hang) and yield no
          // more than `capacity` items — proof it bounded instead of retaining all.
          const drained = yield* Stream.fromQueue(buffer).pipe(
            Stream.runCollect,
            Effect.timeout("2 seconds"),
          );
          expect(drained.length).toBeLessThanOrEqual(capacity);
        }),
      ),
  );

  it.live(
    "keeps taking from an upstream hub (never pins it) and releases the subscription on overflow",
    () =>
      Effect.gen(function* () {
        // End-to-end OOM property: a stalled subscriber must never pin the shared
        // (unbounded) hub. The pump owns the subscription via `Stream.fromPubSub`,
        // so ending on overflow releases it and the hub reclaims. A background
        // producer publishes until the pump ends, so the test is independent of
        // subscribe/publish timing (no fixed sleep race).
        const hub = yield* PubSub.unbounded<number>();
        yield* Effect.scoped(
          Effect.gen(function* () {
            const buffer = yield* Queue.dropping<number, Cause.Done>(2);
            const pump = yield* Effect.forkScoped(
              pumpBoundedLiveBuffer(Stream.fromPubSub(hub), buffer),
              { startImmediately: true },
            );
            // Publish continuously until the pump has ended (overflowed). Racing the
            // producer against the pump means the pump is guaranteed to observe a
            // flood regardless of scheduling.
            yield* Effect.forkScoped(
              PubSub.publish(hub, 1).pipe(Effect.delay("1 milli"), Effect.forever),
            );
            yield* Fiber.await(pump).pipe(Effect.timeout("2 seconds"));
          }),
        );
        // The subscription scope has now closed. With no live subscriber, an
        // unbounded PubSub retains nothing — the stalled consumer did not pin it.
        yield* PubSub.publish(hub, 1);
        expect(yield* PubSub.size(hub)).toBe(0);
      }),
  );

  it.live("ending the buffer surfaces as clean stream completion (no error, triggers resync)", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const capacity = 1;
        const buffer = yield* Queue.dropping<number, Cause.Done>(capacity);
        yield* Effect.forkScoped(pumpBoundedLiveBuffer(Stream.range(0, 100), buffer));
        yield* Effect.sleep("50 millis");
        // `Stream.fromQueue` excludes `Cause.Done`; a completed (not failed) stream
        // is what the client transport treats as a resubscribe trigger. `runCollect`
        // succeeding (rather than failing) is the proof of clean completion.
        const exit = yield* Stream.fromQueue(buffer).pipe(
          Stream.runCollect,
          Effect.timeout("2 seconds"),
          Effect.exit,
        );
        expect(exit._tag).toBe("Success");
      }),
    ),
  );
});
