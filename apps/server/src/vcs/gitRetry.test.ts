import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";

import { VcsProcessExitError, VcsProcessSpawnError, VcsProcessTimeoutError } from "@t3tools/contracts";

import {
  DEFAULT_GIT_RETRY_ATTEMPTS,
  isTransientVcsError,
  makeTransientGitRetryPolicy,
} from "./gitRetry.ts";

const timeoutError = () =>
  new VcsProcessTimeoutError({ operation: "op", command: "git x", cwd: "/tmp", timeoutMs: 30_000 });
const spawnError = () =>
  new VcsProcessSpawnError({ operation: "op", command: "git x", cwd: "/tmp", cause: "boom" });
const exitError = () =>
  new VcsProcessExitError({ operation: "op", command: "git x", cwd: "/tmp", exitCode: 1, detail: "d" });

// A counting effect that fails `failTimes` times with `makeError`, then succeeds with the
// attempt number. Returns the ref so the test can assert the attempt count.
const countingAttempt = (makeError: () => { readonly _tag: string }, failTimes: number) =>
  Effect.gen(function* () {
    const ref = yield* Ref.make(0);
    const attempt = Ref.updateAndGet(ref, (n) => n + 1).pipe(
      Effect.flatMap((n) => (n <= failTimes ? Effect.fail(makeError()) : Effect.succeed(n))),
    );
    return { ref, attempt } as const;
  });

describe("isTransientVcsError", () => {
  it("classifies timeout and spawn as transient; exit and others as not", () => {
    expect(isTransientVcsError(timeoutError())).toBe(true);
    expect(isTransientVcsError(spawnError())).toBe(true);
    expect(isTransientVcsError(exitError())).toBe(false);
    expect(isTransientVcsError({ _tag: "VcsOutputDecodeError" })).toBe(false);
    expect(isTransientVcsError({ _tag: "VcsRepositoryDetectionError" })).toBe(false);
  });
});

describe("transient VCS retry", () => {
  it("has a default of 3 attempts", () => {
    expect(DEFAULT_GIT_RETRY_ATTEMPTS).toBe(3);
  });

  it.effect("retries a transient (timeout) failure until it succeeds", () =>
    Effect.gen(function* () {
      const { ref, attempt } = yield* countingAttempt(timeoutError, 2);
      const result = yield* attempt.pipe(
        Effect.retry({ schedule: Schedule.recurs(5), while: isTransientVcsError }),
      );
      expect(result).toBe(3);
      expect(yield* Ref.get(ref)).toBe(3);
    }),
  );

  it.effect("retries a transient (spawn) failure until it succeeds", () =>
    Effect.gen(function* () {
      const { ref, attempt } = yield* countingAttempt(spawnError, 1);
      const result = yield* attempt.pipe(
        Effect.retry({ schedule: Schedule.recurs(5), while: isTransientVcsError }),
      );
      expect(result).toBe(2);
      expect(yield* Ref.get(ref)).toBe(2);
    }),
  );

  it.effect("does NOT retry a non-transient (exit) failure", () =>
    Effect.gen(function* () {
      const { ref, attempt } = yield* countingAttempt(exitError, 5);
      const exit = yield* attempt.pipe(
        Effect.retry({ schedule: Schedule.recurs(5), while: isTransientVcsError }),
        Effect.exit,
      );
      expect(exit._tag).toBe("Failure");
      expect(yield* Ref.get(ref)).toBe(1);
    }),
  );

  it.effect("stops after the bounded number of attempts, then propagates the failure", () =>
    Effect.gen(function* () {
      const { ref, attempt } = yield* countingAttempt(timeoutError, 100);
      const exit = yield* attempt.pipe(
        Effect.retry({ schedule: Schedule.recurs(2), while: isTransientVcsError }),
        Effect.exit,
      );
      expect(exit._tag).toBe("Failure");
      expect(yield* Ref.get(ref)).toBe(3); // initial + 2 retries
    }),
  );

  it.effect("makeTransientGitRetryPolicy(1) disables retry (times: 0)", () =>
    Effect.gen(function* () {
      const { ref, attempt } = yield* countingAttempt(timeoutError, 100);
      yield* attempt.pipe(Effect.retry(makeTransientGitRetryPolicy(1)), Effect.exit);
      expect(yield* Ref.get(ref)).toBe(1);
    }),
  );

  it("makeTransientGitRetryPolicy bounds retries via `times`, not the schedule", () => {
    // effect beta.102 dropped `Schedule.both`, so the recurrence bound moved into
    // the retry options. `times` is retries, so total attempts = times + 1.
    expect(makeTransientGitRetryPolicy(3).times).toBe(2);
    expect(makeTransientGitRetryPolicy(1).times).toBe(0);
    expect(makeTransientGitRetryPolicy(0).times).toBe(0);
    expect(makeTransientGitRetryPolicy(3).while).toBe(isTransientVcsError);
  });

  // `it.live` (real Clock): exercises the real exponential+jittered schedule, whose
  // backoff uses Effect.sleep. One transient failure → one real backoff (~500ms) → success.
  it.live("the real jittered schedule retries a transient failure to success", () =>
    Effect.gen(function* () {
      const { ref, attempt } = yield* countingAttempt(timeoutError, 1);
      const result = yield* attempt.pipe(
        Effect.retry(makeTransientGitRetryPolicy(3)),
      );
      expect(result).toBe(2);
      expect(yield* Ref.get(ref)).toBe(2);
    }),
  );
});
