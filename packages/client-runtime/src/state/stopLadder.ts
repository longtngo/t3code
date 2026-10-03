/**
 * The Stop ladder, shared by every client.
 *
 * Web and mobile both dispatch Stop, and both need the same escalation, or a
 * turn wedged inside a tool is only recoverable from one of them. The rule
 * lived in `apps/web/src/components/ChatView.logic.ts`, where mobile could not
 * reach it.
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
 * Decide what a Stop-button press should dispatch. The first press for a thread sends
 * `run.interrupt` with `mode: "cooperative"`, which ends the turn but keeps the provider session;
 * a deliberate second press (while that interrupt is still pending escalation) sends
 * `mode: "hard"`, which restarts the provider runtime and so kills a turn wedged inside a tool.
 * The server also escalates on its own once a cooperative interrupt has not ended the turn
 * within its grace (`COOPERATIVE_INTERRUPT_GRACE`, 8 s). The second press is the faster way
 * out: a hard `run.interrupt` cancels the cooperative interrupt still waiting out that grace.
 *
 * Escalation is valid only inside a BAND, not merely "second press ever":
 *
 *   |<- ignore ->|<---------- hardStop ----------->|<- interrupt (stale, re-arms) ->
 *   0          500ms                              10s
 *
 * The ceiling alone would be a downgrade. Expiring the arming after a few seconds makes two
 * presses in quick succession the *only* way to reach the force-stop — which is precisely the
 * reflexive double-click that fires it by accident. The floor is what keeps the destructive rung
 * behind a deliberate act; the ceiling is what stops it going stale. Neither works alone.
 *
 * Deciding from a TIMESTAMP rather than a countdown is what makes this correct without depending
 * on a timer having fired: a backgrounded tab throttles timers, and the arming must still have
 * expired when the user comes back. The timer in the component only reverts the button's
 * appearance.
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
 * The Stop button's look, decided from the same arming and clock as
 * `nextStopAction`, so the armed rung shows exactly while a press would take
 * it: not during the 500 ms floor, and not after the window. `changesInMs` is
 * when the look next changes; a client schedules one repaint there (no
 * continuous animation).
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
