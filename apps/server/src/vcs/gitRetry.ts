import * as Schedule from "effect/Schedule";

import { parsePositiveIntEnv } from "../provider/Layers/parsePositiveIntEnv.ts";

/** Total capture attempts (initial try + retries) when unconfigured. */
export const DEFAULT_GIT_RETRY_ATTEMPTS = 3;

/**
 * Whether a VCS failure is transient (timeout or spawn starvation) and so safe to retry for an
 * idempotent operation. Matches by `_tag` to accept the whole capture error union. A real git exit
 * and decode/detection/unsupported failures are NOT transient.
 */
export const isTransientVcsError = (error: {
  readonly _tag: string;
  readonly reason?: string | undefined;
}): boolean => {
  if (error._tag === "VcsProcessTimeoutError" || error._tag === "VcsProcessSpawnError") {
    return true;
  }
  // Status and detection paths fail with `GitCommandError`, not the VCS-tagged errors, so match its
  // `reason` too or a `rev-parse` timeout is never retried. `detail` is prose: never match on it.
  return (
    error._tag === "GitCommandError" && (error.reason === "timeout" || error.reason === "spawn")
  );
};

/**
 * Bounded, jittered exponential backoff; `attempts` counts all tries, `<= 1` disables retry.
 * The bound lives in `Effect.retry`'s `times` because effect 4 beta dropped `Schedule.both` and
 * `upTo` bounds elapsed time, not attempts.
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
