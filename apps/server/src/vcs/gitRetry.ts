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
export const isTransientVcsError = (error: { readonly _tag: string }): boolean =>
  error._tag === "VcsProcessTimeoutError" || error._tag === "VcsProcessSpawnError";

/**
 * Bounded, jittered exponential backoff for retrying transient VCS failures.
 * `attempts` is the total number of tries (initial + retries); `attempts <= 1` disables
 * retry (`recurs(0)`). Uses `Schedule.both` (the v4 AND-combinator) to bound the
 * always-recurring exponential+jittered schedule by a recurrence count.
 */
export const makeTransientGitRetrySchedule = (attempts: number) =>
  Schedule.exponential("500 millis").pipe(
    Schedule.jittered,
    Schedule.both(Schedule.recurs(Math.max(0, attempts - 1))),
  );

/** Total capture attempts from `T3CODE_GIT_RETRY_ATTEMPTS` (default 3; set to 1 to disable). */
export const resolveGitRetryAttempts = (): number =>
  parsePositiveIntEnv("T3CODE_GIT_RETRY_ATTEMPTS") ?? DEFAULT_GIT_RETRY_ATTEMPTS;
