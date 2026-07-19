import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";

import {
  DEFAULT_WS_SUBSCRIPTION_MAX_EVENTS,
  MIN_WS_SUBSCRIPTION_MAX_EVENTS,
  recycleSubscriptionStream,
  resolveSubscriptionRecycleLimit,
} from "./recycleSubscriptionStream.ts";

describe("resolveSubscriptionRecycleLimit", () => {
  it("returns the default when unset", () => {
    expect(resolveSubscriptionRecycleLimit(undefined)).toBe(DEFAULT_WS_SUBSCRIPTION_MAX_EVENTS);
  });

  it('treats "0" as an explicit disable (the kill-switch a bare parsePositiveIntEnv cannot express)', () => {
    // Regression guard: `parsePositiveIntEnv(...) ?? DEFAULT` maps "0" to the
    // default (recycle stays ON). The "0" sentinel must resolve to 0 (disabled).
    expect(resolveSubscriptionRecycleLimit("0")).toBe(0);
  });

  it("clamps a too-small positive value up to the floor", () => {
    // take(1) would be a tight snapshot-only resubscribe loop.
    expect(resolveSubscriptionRecycleLimit("1")).toBe(MIN_WS_SUBSCRIPTION_MAX_EVENTS);
    expect(resolveSubscriptionRecycleLimit("99")).toBe(MIN_WS_SUBSCRIPTION_MAX_EVENTS);
  });

  it("honors a valid positive value at or above the floor", () => {
    expect(resolveSubscriptionRecycleLimit("100")).toBe(100);
    expect(resolveSubscriptionRecycleLimit("50000")).toBe(50000);
  });

  it("falls back to the default for non-numeric, negative, or empty input", () => {
    expect(resolveSubscriptionRecycleLimit("abc")).toBe(DEFAULT_WS_SUBSCRIPTION_MAX_EVENTS);
    expect(resolveSubscriptionRecycleLimit("-5")).toBe(DEFAULT_WS_SUBSCRIPTION_MAX_EVENTS);
    expect(resolveSubscriptionRecycleLimit("")).toBe(DEFAULT_WS_SUBSCRIPTION_MAX_EVENTS);
  });

  it("uses the strict '0' disable sentinel — near-misses keep the recycle ON (fail-safe)", () => {
    // Only exactly "0" disables; "00"/" 0 " fall through to the default so the
    // protection stays on rather than silently wedging or disabling.
    expect(resolveSubscriptionRecycleLimit("00")).toBe(DEFAULT_WS_SUBSCRIPTION_MAX_EVENTS);
    expect(resolveSubscriptionRecycleLimit(" 0 ")).toBe(DEFAULT_WS_SUBSCRIPTION_MAX_EVENTS);
  });

  it("parses a leading integer from tolerant input (parseInt semantics), then floors it", () => {
    expect(resolveSubscriptionRecycleLimit("50000abc")).toBe(50000);
    expect(resolveSubscriptionRecycleLimit(" 30000")).toBe(30000);
    // A leading-integer parse below the floor is still clamped up.
    expect(resolveSubscriptionRecycleLimit("5xyz")).toBe(MIN_WS_SUBSCRIPTION_MAX_EVENTS);
  });
});

describe("recycleSubscriptionStream", () => {
  it.effect("ends the stream CLEANLY after exactly `maxElements` elements", () =>
    Effect.gen(function* () {
      // An unbounded source; the recycle must cap it and complete with success
      // (Exit.success) — the signal the client transport resubscribes on. An error
      // exit would instead make the client stop, silently killing live updates.
      const source = Stream.iterate(0, (n) => n + 1);
      const recycled = recycleSubscriptionStream(source, 5);

      const exit = yield* Stream.runCollect(recycled).pipe(Effect.exit);

      expect(Exit.isSuccess(exit)).toBe(true);
      if (Exit.isSuccess(exit)) {
        expect(Array.from(exit.value)).toEqual([0, 1, 2, 3, 4]);
      }
    }),
  );

  it.effect("is an identity passthrough when disabled (maxElements <= 0)", () =>
    Effect.gen(function* () {
      const source = Stream.make(1, 2, 3);
      // A finite source proves the disabled path does not cap; an infinite source
      // would hang if the recycle were wrongly a no-limit take.
      const collected = yield* Stream.runCollect(recycleSubscriptionStream(source, 0));
      expect(Array.from(collected)).toEqual([1, 2, 3]);

      const collectedNegative = yield* Stream.runCollect(recycleSubscriptionStream(source, -1));
      expect(Array.from(collectedNegative)).toEqual([1, 2, 3]);
    }),
  );

  it.effect("passes through a source shorter than the limit without recycling", () =>
    Effect.gen(function* () {
      const source = Stream.make(1, 2, 3);
      const collected = yield* Stream.runCollect(recycleSubscriptionStream(source, 20000));
      expect(Array.from(collected)).toEqual([1, 2, 3]);
    }),
  );
});
