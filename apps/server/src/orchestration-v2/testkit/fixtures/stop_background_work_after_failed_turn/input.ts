import type { OrchestratorFixtureInput } from "../shared.ts";

export const STOP_BACKGROUND_WORK_AFTER_FAILED_TURN_PROMPT =
  "Start the dev server in the background with `bun run dev` and keep it running.";

export function stopBackgroundWorkAfterFailedTurnInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: STOP_BACKGROUND_WORK_AFTER_FAILED_TURN_PROMPT },
      { type: "stop_background_work", targetRunIndex: 1 },
    ],
  };
}

export function stopBackgroundWorkAfterReleaseInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: STOP_BACKGROUND_WORK_AFTER_FAILED_TURN_PROMPT },
      { type: "advance_clock", duration: "31 minutes" },
      { type: "stop_background_work", targetRunIndex: 1 },
    ],
  };
}

/**
 * FORK Stop ladder: the composer's first (cooperative) Stop press on a turn that
 * already settled. Nothing is left to end cooperatively, so the press is hard
 * and the Waiting strip clears exactly as after the strip's own Stop.
 */
export function stopBackgroundWorkAfterFailedTurnCooperativeInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: STOP_BACKGROUND_WORK_AFTER_FAILED_TURN_PROMPT },
      { type: "stop_background_work", targetRunIndex: 1, mode: "cooperative" },
    ],
  };
}
