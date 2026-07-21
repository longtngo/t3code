import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";

import { batchWithinStackSafe } from "./batchWithinStackSafe.ts";

const collect = <A>(source: Stream.Stream<A>, maxBatch: number, cap: number) =>
  Stream.runCollect(batchWithinStackSafe(source, maxBatch, cap));

describe("batchWithinStackSafe", () => {
  it.effect("delivers every event exactly once, in order", () =>
    Effect.gen(function* () {
      const input = Array.from({ length: 200 }, (_, i) => i);
      const batches = yield* collect(Stream.fromArray(input), 64, 4096);
      expect(batches.flat()).toEqual(input);
    }),
  );

  it.effect("coalesces a burst into batches of up to maxBatch (actually >1)", () =>
    // A single-chunk source lands the whole burst in the queue via one offerAll
    // before/at the first pull, so takeBetween(1, 64) returns a 64-element batch.
    // Regression guard for the inert `takeBetween(q, 0, …)` drain, which would
    // have made every batch size-1 (bandwidth optimization silently defeated).
    Effect.gen(function* () {
      const input = Array.from({ length: 100 }, (_, i) => i);
      const batches = yield* collect(Stream.fromArray(input), 64, 4096);
      expect(batches.flat()).toEqual(input);
      expect(batches.every((b) => b.length >= 1 && b.length <= 64)).toBe(true);
      expect(batches.some((b) => b.length > 1)).toBe(true);
    }),
  );

  it.effect("respects the maxBatch cap", () =>
    Effect.gen(function* () {
      const input = Array.from({ length: 100 }, (_, i) => i);
      const batches = yield* collect(Stream.fromArray(input), 10, 4096);
      expect(batches.flat()).toEqual(input);
      expect(batches.every((b) => b.length <= 10)).toBe(true);
    }),
  );

  it.effect("never emits an empty batch", () =>
    Effect.gen(function* () {
      const input = Array.from({ length: 50 }, (_, i) => i);
      const batches = yield* collect(Stream.fromArray(input), 8, 4096);
      expect(batches.every((b) => b.length >= 1)).toBe(true);
    }),
  );

  it.effect("yields a size-1 batch for a single isolated element", () =>
    Effect.gen(function* () {
      const batches = yield* collect(Stream.make(42), 64, 4096);
      expect(batches).toEqual([[42]]);
    }),
  );

  it.effect("delivers all events with no loss under backpressure (bufferCapacity << input)", () =>
    // cap 4 << 500 drives the bounded queue through many park/resume cycles and
    // proves delivery stays loss-free and ordered under backpressure. (This does
    // NOT by itself prove the queue is bounded — an unbounded queue would pass it
    // too; boundedness is established by `Queue.bounded` + source review, and
    // end-to-end by the live heap-sawtooth verification.)
    Effect.gen(function* () {
      const input = Array.from({ length: 500 }, (_, i) => i);
      const batches = yield* collect(Stream.fromArray(input), 8, 4);
      expect(batches.flat()).toEqual(input);
      expect(batches.every((b) => b.length >= 1 && b.length <= 8)).toBe(true);
    }),
  );

  it.effect("completes cleanly (Exit.success) when the source ends", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(collect(Stream.fromArray([1, 2, 3]), 64, 4096));
      expect(Exit.isSuccess(exit)).toBe(true);
    }),
  );

  it.effect("handles an empty source: clean completion, no batches", () =>
    Effect.gen(function* () {
      const batches = yield* collect(Stream.empty, 64, 4096);
      expect(batches).toEqual([]);
    }),
  );

  it("throws for maxBatch < 1 (would be a nonsensical batch bound)", () => {
    expect(() => batchWithinStackSafe(Stream.empty, 0, 16)).toThrow(/maxBatch must be >= 1/);
  });
});
