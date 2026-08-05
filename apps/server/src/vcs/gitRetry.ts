import * as Schedule from "effect/Schedule";

import { parsePositiveIntEnv } from "../provider/Layers/parsePositiveIntEnv.ts";

/** Total capture attempts (initial try + retries) when unconfigured. */
export const DEFAULT_GIT_RETRY_ATTEMPTS = 3;

/**
 * Whether a VCS process failure is *transient* — a host-overload timeout
 * (`VcsProcessTimeoutError`) or a fork/exec spawn starvation (`VcsProcessSpawnError`) — and
 * therefore safe to retry for an idempotent operation. Matches the existing tagged error
 * types structurally by `_tag`, so it accepts the whole capture error union without a schema
 * dependency. `VcsProcessExitError` (a real non-zero git exit) and decode/detection/unsupported
 * failures are NOT transient and must not be retried.
 */
export const isTransientVcsError = (error: {
  readonly _tag: string;
  readonly reason?: string | undefined;
}): boolean => {
  if (error._tag === "VcsProcessTimeoutError" || error._tag === "VcsProcessSpawnError") {
    return true;
  }
  // The read-only status and detection paths fail with `GitCommandError`, not
  // the VCS-tagged errors, so a host-overload timeout on `rev-parse` used to be
  // reported as a hard failure and retried by nobody — which is most of the
  // repeated `rev-parse` noise in the log. The reason field carries the same
  // distinction structurally; `detail` is prose and must not be matched on.
  return error._tag === "GitCommandError" && (error.reason === "timeout" || error.reason === "spawn");
};

/**
 * Bounded, jittered exponential backoff for retrying transient VCS failures.
 * `attempts` is the total number of tries (initial + retries); `attempts <= 1`
 * disables retry (`times: 0`).
 *
 * The recurrence bound lives in `Effect.retry`'s `times` option rather than in the
 * schedule: effect 4.0.0-beta.102 dropped `Schedule.both` (the AND-combinator this
 * previously used to intersect the always-recurring backoff with `recurs`), and it
 * has no replacement count-bounding combinator — only `upTo`, which bounds by total
 * elapsed duration, not by attempts.
 */
export const makeTransientGitRetryPolicy = (attempts: number) =>
  ({
    schedule: Schedule.exponential("500 millis").pipe(Schedule.jittered),
    times: Math.max(0, attempts - 1),
    while: isTransientVcsError,
  }) as const;

/** Total capture attempts from `T3CODE_GIT_RETRY_ATTEMPTS` (default 3; set to 1 to disable). */
export const resolveGitRetryAttempts = (): number =>
  parsePositiveIntEnv("T3CODE_GIT_RETRY_ATTEMPTS") ?? DEFAULT_GIT_RETRY_ATTEMPTS;
