import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";

import { withWorkspaceLease } from "./workspaceLease.ts";

const tracker = () => {
  let inside = 0;
  let maxInside = 0;
  const enter = Effect.sync(() => {
    inside++;
    maxInside = Math.max(maxInside, inside);
  });
  const leave = Effect.sync(() => {
    inside--;
  });
  return { enter, leave, max: () => maxInside };
};

describe("withWorkspaceLease", () => {
  it.live("lets the holder take its own path again instead of deadlocking", () =>
    Effect.gen(function* () {
      const result = yield* withWorkspaceLease(
        "/tmp/lease-nested",
        withWorkspaceLease("/tmp/lease-nested", Effect.succeed("inner")),
      ).pipe(Effect.timeoutOption("2 seconds"));
      assert.deepStrictEqual(result, Option.some("inner"));
    }),
  );

  it.live("still serializes separate callers on one path, nested or not", () =>
    Effect.gen(function* () {
      const t = tracker();
      const body = t.enter.pipe(
        Effect.andThen(Effect.yieldNow),
        Effect.andThen(Effect.yieldNow),
        Effect.andThen(Effect.yieldNow),
        Effect.andThen(t.leave),
      );
      const plain = withWorkspaceLease("/tmp/lease-serial", body);
      const nested = withWorkspaceLease(
        "/tmp/lease-serial",
        withWorkspaceLease("/tmp/lease-serial", body),
      );
      yield* Effect.all([plain, nested, plain, nested, plain], { concurrency: "unbounded" });
      assert.strictEqual(t.max(), 1);
    }),
  );

  it.live("makes a fiber forked inside a lease wait once that lease has ended", () =>
    Effect.gen(function* () {
      const t = tracker();
      const outerReleased = yield* Deferred.make<void>();
      const thirdIn = yield* Deferred.make<void>();
      const releaseThird = yield* Deferred.make<void>();
      const late = yield* withWorkspaceLease(
        "/tmp/lease-forked",
        Effect.forkDetach(
          Deferred.await(outerReleased).pipe(
            Effect.andThen(Deferred.await(thirdIn)),
            Effect.andThen(
              withWorkspaceLease("/tmp/lease-forked", t.enter.pipe(Effect.andThen(t.leave))),
            ),
          ),
        ),
      );
      yield* Deferred.succeed(outerReleased, undefined);
      const third = yield* withWorkspaceLease(
        "/tmp/lease-forked",
        t.enter.pipe(
          Effect.andThen(Deferred.succeed(thirdIn, undefined)),
          Effect.andThen(Deferred.await(releaseThird)),
          Effect.andThen(Effect.yieldNow),
          Effect.andThen(t.leave),
        ),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(thirdIn);
      yield* Deferred.succeed(releaseThird, undefined);
      yield* Fiber.join(third);
      yield* Fiber.join(late);
      assert.strictEqual(t.max(), 1);
    }),
  );
});
