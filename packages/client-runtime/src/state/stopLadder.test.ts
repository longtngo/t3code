import { describe, expect, it } from "vite-plus/test";

import {
  STOP_ESCALATION_MIN_MS,
  STOP_ESCALATION_WINDOW_MS,
  nextStopAction,
  stopRungAt,
} from "./stopLadder.ts";

/**
 * Web tests this through ChatView.logic; these pin it where BOTH clients now
 * read it from, so a change here cannot silently alter mobile alone.
 */
const at = (elapsedMs: number, threadId = "thread-1") =>
  nextStopAction({
    threadId,
    armed: { threadId: "thread-1", atMs: 1_000_000 },
    nowMs: 1_000_000 + elapsedMs,
  });

describe("nextStopAction", () => {
  it("interrupts when nothing is armed", () => {
    expect(nextStopAction({ threadId: "thread-1", armed: null, nowMs: 1 })).toBe("interrupt");
  });

  it("ignores a reflexive double-press below the floor", () => {
    // The floor is what keeps the destructive rung behind a deliberate act.
    expect(at(0)).toBe("ignore");
    expect(at(STOP_ESCALATION_MIN_MS - 1)).toBe("ignore");
  });

  it("force-stops a deliberate second press inside the band", () => {
    expect(at(STOP_ESCALATION_MIN_MS)).toBe("hardStop");
    expect(at(STOP_ESCALATION_WINDOW_MS)).toBe("hardStop");
  });

  it("re-arms rather than escalating once the window has passed", () => {
    // The ceiling stops a stale arming force-stopping a turn minutes later.
    expect(at(STOP_ESCALATION_WINDOW_MS + 1)).toBe("interrupt");
  });

  it("does not carry an arming across threads", () => {
    expect(at(STOP_ESCALATION_MIN_MS, "thread-2")).toBe("interrupt");
  });

  it("falls back to interrupt when the clock jumps backwards", () => {
    // Treating it as "ignore" would wedge Stop entirely until the clock caught up.
    expect(at(-1)).toBe("interrupt");
  });

  it("still escalates an arming whose turn already ended, so callers must clear it", () => {
    // The module sees a thread and a clock, never a turn. Inside the window an
    // arming left over from a finished turn is indistinguishable from a live
    // one, so both clients clear it when the session leaves "running"
    // (ChatView.tsx and ThreadRouteScreen.tsx). This pins WHY: without that
    // reset, the next turn's first Stop force-stops the session.
    expect(
      nextStopAction({
        threadId: "thread-1",
        armed: { threadId: "thread-1", atMs: 0 },
        nowMs: STOP_ESCALATION_WINDOW_MS - 1,
      }),
    ).toBe("hardStop");
    // Cleared, the same press is the cooperative first rung again.
    expect(
      nextStopAction({
        threadId: "thread-1",
        armed: null,
        nowMs: STOP_ESCALATION_WINDOW_MS - 1,
      }),
    ).toBe("interrupt");
  });
});

describe("after the hard rung was sent", () => {
  const forceStopping = { threadId: "thread-1", atMs: 1_000_000, forceStopping: true };
  const press = (elapsedMs: number) =>
    nextStopAction({ threadId: "thread-1", armed: forceStopping, nowMs: 1_000_000 + elapsedMs });

  it("ignores presses while the force-stop is on its way, never sending the cooperative rung", () => {
    expect(press(0)).toBe("ignore");
    expect(press(STOP_ESCALATION_MIN_MS)).toBe("ignore");
    expect(press(STOP_ESCALATION_WINDOW_MS)).toBe("ignore");
  });

  it("re-sends the hard rung once the window passes with the turn still running", () => {
    expect(press(STOP_ESCALATION_WINDOW_MS + 1)).toBe("hardStop");
  });
});

describe("stopRungAt", () => {
  const armedAt = (elapsedMs: number, armed = { threadId: "thread-1", atMs: 1_000_000 }) =>
    stopRungAt({ threadId: "thread-1", armed, nowMs: armed.atMs + elapsedMs });

  it("shows the armed rung exactly while nextStopAction would take it", () => {
    for (const elapsed of [
      0,
      STOP_ESCALATION_MIN_MS - 1,
      STOP_ESCALATION_MIN_MS,
      STOP_ESCALATION_WINDOW_MS,
      STOP_ESCALATION_WINDOW_MS + 1,
    ]) {
      const action = nextStopAction({
        threadId: "thread-1",
        armed: { threadId: "thread-1", atMs: 1_000_000 },
        nowMs: 1_000_000 + elapsed,
      });
      expect(armedAt(elapsed).rung === "armed").toBe(action === "hardStop");
    }
  });

  it("schedules one repaint at each boundary", () => {
    expect(armedAt(0).changesInMs).toBe(STOP_ESCALATION_MIN_MS);
    expect(armedAt(STOP_ESCALATION_MIN_MS).changesInMs).toBe(
      STOP_ESCALATION_WINDOW_MS - STOP_ESCALATION_MIN_MS + 1,
    );
    expect(armedAt(STOP_ESCALATION_WINDOW_MS + 1).changesInMs).toBeNull();
  });

  it("shows the force-stop until the turn settles, and nothing on another thread", () => {
    const forceStopping = { threadId: "thread-1", atMs: 1_000_000, forceStopping: true };
    expect(armedAt(STOP_ESCALATION_WINDOW_MS * 10, forceStopping).rung).toBe("forceStopping");
    expect(stopRungAt({ threadId: "thread-2", armed: forceStopping, nowMs: 1_000_000 }).rung).toBe(
      "idle",
    );
  });
});
