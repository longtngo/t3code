/**
 * The Stop ladder, shared so web and mobile escalate identically; otherwise a turn wedged in a
 * tool is recoverable from only one of them.
 */

export const STOP_ESCALATION_MIN_MS = 500;

/**
 * How long the arming survives. Past this the wedge the escalation belonged to is stale: a press
 * now and a press ten minutes from now must not be the same gesture.
 */
export const STOP_ESCALATION_WINDOW_MS = 10_000;

/**
 * How long a sent hard rung keeps the button on the destructive path. The arming is held per
 * view, not per thread, so it can outlive the turn it was for (the thread starts a new turn while
 * another one is on screen). Past this a press is a fresh first press again.
 */
export const STOP_FORCE_STOPPING_STALE_MS = 60_000;

/**
 * First press: cooperative `run.interrupt`. A second press inside the band [500ms, 10s) is a hard
 * interrupt that restarts the runtime (faster than the server's own 8 s escalation). The floor keeps
 * a reflexive double-click off the destructive rung; the ceiling stops arming going stale. Decided
 * from a TIMESTAMP, not a timer, because background tabs throttle timers.
 */
export type StopAction = "interrupt" | "hardStop" | "ignore";

export interface ArmedStopEscalation {
  readonly threadId: string;
  readonly atMs: number;
  /**
   * The hard rung was sent at `atMs` and the turn has not settled yet. Presses
   * inside the window are no-ops (the force-stop is already on its way); after
   * it, a press re-sends the hard rung, until the arming goes stale
   * (`STOP_FORCE_STOPPING_STALE_MS`) and a press is cooperative again.
   */
  readonly forceStopping?: boolean;
}

export function nextStopAction(input: {
  readonly threadId: string;
  readonly armed: ArmedStopEscalation | null;
  readonly nowMs: number;
}): StopAction {
  const armed = input.armed;
  if (armed === null || armed.threadId !== input.threadId) {
    return "interrupt";
  }
  const elapsedMs = input.nowMs - armed.atMs;
  if (armed.forceStopping === true) {
    if (elapsedMs < 0 || elapsedMs > STOP_FORCE_STOPPING_STALE_MS) return "interrupt";
    return elapsedMs <= STOP_ESCALATION_WINDOW_MS ? "ignore" : "hardStop";
  }
  // A backwards clock jump makes the arming untrustworthy. Fall back to the cooperative press,
  // which both fails safe and keeps the button working — treating it as "ignore" would wedge
  // Stop entirely until the clock caught up.
  if (elapsedMs < 0 || elapsedMs > STOP_ESCALATION_WINDOW_MS) {
    return "interrupt";
  }
  return elapsedMs < STOP_ESCALATION_MIN_MS ? "ignore" : "hardStop";
}

/** What the Stop button should show. */
export type StopRung = "idle" | "armed" | "forceStopping";

/**
 * Same arming and clock as `nextStopAction`, so the armed look shows exactly while a press would
 * hard-stop. `changesInMs` is when to schedule the one repaint (no continuous animation).
 */
export function stopRungAt(input: {
  readonly threadId: string | null;
  readonly armed: ArmedStopEscalation | null;
  readonly nowMs: number;
}): { readonly rung: StopRung; readonly changesInMs: number | null } {
  const armed = input.armed;
  if (armed === null || armed.threadId !== input.threadId)
    return { rung: "idle", changesInMs: null };
  const elapsedMs = input.nowMs - armed.atMs;
  if (armed.forceStopping === true) {
    if (elapsedMs < 0 || elapsedMs > STOP_FORCE_STOPPING_STALE_MS) {
      return { rung: "idle", changesInMs: null };
    }
    return { rung: "forceStopping", changesInMs: STOP_FORCE_STOPPING_STALE_MS - elapsedMs + 1 };
  }
  if (elapsedMs < 0 || elapsedMs > STOP_ESCALATION_WINDOW_MS) {
    return { rung: "idle", changesInMs: null };
  }
  if (elapsedMs < STOP_ESCALATION_MIN_MS) {
    return { rung: "idle", changesInMs: STOP_ESCALATION_MIN_MS - elapsedMs };
  }
  return { rung: "armed", changesInMs: STOP_ESCALATION_WINDOW_MS - elapsedMs + 1 };
}
