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
 * Decide what a Stop-button press should dispatch. The first press for a thread sends a
 * cooperative `thread.turn.interrupt`; a deliberate second press (while that interrupt is still
 * pending escalation) goes straight to a hard `thread.session.stop`, which force-kills a turn
 * wedged inside a tool — the case the server's stall watchdog is structurally blind to, because
 * it abstains whenever the open-tool set is non-empty.
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
  // A backwards clock jump makes the arming untrustworthy. Fall back to the cooperative press,
  // which both fails safe and keeps the button working — treating it as "ignore" would wedge
  // Stop entirely until the clock caught up.
  if (elapsedMs < 0 || elapsedMs > STOP_ESCALATION_WINDOW_MS) {
    return "interrupt";
  }
  return elapsedMs < STOP_ESCALATION_MIN_MS ? "ignore" : "hardStop";
}
