import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { runWatchRescanBackstop, WATCH_RESCAN_INTERVAL } from "./watchRescanBackstop.ts";

it.effect("runs every step each interval and survives a failing step", () =>
  Effect.gen(function* () {
    let a = 0;
    let b = 0;
    const failing = Effect.sync(() => {
      a += 1;
    }).pipe(Effect.andThen(Effect.fail("boom")));
    const ok = Effect.sync(() => {
      b += 1;
    });
    const fiber = yield* Effect.forkChild(runWatchRescanBackstop([failing, ok]));
    yield* TestClock.adjust(WATCH_RESCAN_INTERVAL);
    yield* TestClock.adjust(WATCH_RESCAN_INTERVAL);
    assert.deepStrictEqual([a, b], [2, 2]);
    yield* Fiber.interrupt(fiber);
  }),
);
