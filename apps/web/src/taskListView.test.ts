import {
  EnvironmentId,
  EventId,
  ThreadId,
  TurnId,
  type OrchestrationLatestTurn,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { taskListHeaderState } from "./components/TaskListPanel.logic";
import {
  derivePlanGroups,
  latestTurnTaskCounts,
  resolvePlanHistoryRows,
  selectTaskListView,
  unionPlanActivityRows,
  type LandedPlanHistoryRead,
} from "./session-logic";

// Fixtures are the panel's two real sources — a thread's live `activities` window and a
// `thread.planHistory.list` response — run through the same pipeline the hook runs. Never a
// hand-built group array: with one, every selection branch passes even when neither source
// can reach the group.

type StepStatus = "pending" | "inProgress" | "completed";

function planRow(
  id: string,
  turnId: string | null,
  createdAt: string,
  steps: ReadonlyArray<readonly [string, StepStatus]>,
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    createdAt,
    kind: "turn.plan.updated",
    summary: "Plan updated",
    tone: "info",
    payload: { plan: steps.map(([step, status]) => ({ step, status })) },
    turnId: turnId === null ? null : TurnId.make(turnId),
  };
}

function toolRow(id: string, turnId: string, createdAt: string): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    createdAt,
    kind: "tool.completed",
    summary: "Tool call",
    tone: "tool",
    payload: {},
    turnId: TurnId.make(turnId),
  };
}

function latestTurn(
  turnId: string,
  times: { requestedAt: string; completedAt: string | null },
): OrchestrationLatestTurn {
  return {
    turnId: TurnId.make(turnId),
    state: times.completedAt === null ? "running" : "completed",
    requestedAt: times.requestedAt,
    startedAt: times.requestedAt,
    completedAt: times.completedAt,
    assistantMessageId: null,
  };
}

const ENVIRONMENT = EnvironmentId.make("environment-1");
const THREAD = ThreadId.make("thread-1");
const NOW = Date.parse("2026-09-12T12:00:00.000Z");
const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();

/** The hook's pipeline, minus React: resolve the read, union with live, group, select. */
function view(input: {
  live: ReadonlyArray<OrchestrationThreadActivity>;
  current: ReadonlyArray<OrchestrationThreadActivity> | null;
  retained?: LandedPlanHistoryRead | null;
  latest: OrchestrationLatestTurn | null;
}) {
  const readRows = resolvePlanHistoryRows(
    input.current,
    input.retained ?? null,
    ENVIRONMENT,
    THREAD,
    input.latest,
  );
  const rows = unionPlanActivityRows(readRows, input.live, null);
  return selectTaskListView(derivePlanGroups(rows), input.latest?.turnId ?? null, NOW);
}

// A long turn whose three plan rows span 30 minutes. The live window holds only the last one
// (the 500-row cap keeps the newest rows), so live alone cannot time either step.
const longTurnRows = (turnId: string, startHoursAgo: number) => {
  const start = NOW - startHoursAgo * 3_600_000;
  const at = (minutes: number) => new Date(start + minutes * 60_000).toISOString();
  return [
    planRow(`${turnId}-p1`, turnId, at(0), [
      ["Build", "inProgress"],
      ["Test", "pending"],
    ]),
    planRow(`${turnId}-p2`, turnId, at(10), [
      ["Build", "completed"],
      ["Test", "inProgress"],
    ]),
    planRow(`${turnId}-p3`, turnId, at(30), [
      ["Build", "completed"],
      ["Test", "completed"],
    ]),
  ];
};

describe("selectTaskListView", () => {
  it("renders the latest turn's plan as primary when it has one", () => {
    const read = [
      planRow("t1-p", "turn-1", hoursAgo(1), [["Old", "completed"]]),
      planRow("t2-p", "turn-2", hoursAgo(0.5), [["Now", "inProgress"]]),
    ];
    const live = [toolRow("t2-tool", "turn-2", hoursAgo(0.4)), read[1]!];
    const result = view({
      live,
      current: read,
      latest: latestTurn("turn-2", { requestedAt: hoursAgo(0.6), completedAt: null }),
    });
    expect(result.primaryKind).toBe("latest");
    expect(result.primary?.turnId).toBe("turn-2");
    expect(result.history.map((group) => group.turnId)).toEqual(["turn-1"]);
  });

  it("promotes the newest group at any age when the latest turn has no plan", () => {
    // Weeks old: a 3h bound on promotion would empty this panel.
    const read = [
      planRow("t1-p", "turn-1", hoursAgo(24 * 30), [["Ancient", "completed"]]),
      planRow("t2-p", "turn-2", hoursAgo(24 * 21), [["Old", "completed"]]),
    ];
    const live = [toolRow("t3-tool", "turn-3", hoursAgo(0.1))];
    const result = view({
      live,
      current: read,
      latest: latestTurn("turn-3", { requestedAt: hoursAgo(0.2), completedAt: hoursAgo(0.05) }),
    });
    expect(result.primaryKind).toBe("promoted");
    expect(result.primary?.turnId).toBe("turn-2");
    expect(result.history).toEqual([]);
  });

  it("has no primary only when neither source holds a group", () => {
    const result = view({
      live: [toolRow("t1-tool", "turn-1", hoursAgo(0.1))],
      current: [],
      latest: latestTurn("turn-1", { requestedAt: hoursAgo(0.2), completedAt: null }),
    });
    expect(result).toEqual({ primary: null, primaryKind: null, history: [] });
  });

  describe("never lists the primary's turn in history", () => {
    const read = [
      planRow("t1-p", "turn-1", hoursAgo(2), [["One", "completed"]]),
      planRow("t2-p", "turn-2", hoursAgo(1), [["Two", "completed"]]),
      planRow("t3-p", "turn-3", hoursAgo(0.5), [["Three", "inProgress"]]),
    ];

    it("when the latest turn has a plan", () => {
      const result = view({
        live: read,
        current: read,
        latest: latestTurn("turn-3", { requestedAt: hoursAgo(0.6), completedAt: null }),
      });
      expect(result.primary?.turnId).toBe("turn-3");
      expect(result.history.map((group) => group.turnId)).toEqual(["turn-2", "turn-1"]);
    });

    it("when the latest turn has none", () => {
      const result = view({
        live: [...read, toolRow("t4-tool", "turn-4", hoursAgo(0.1))],
        current: read,
        latest: latestTurn("turn-4", { requestedAt: hoursAgo(0.2), completedAt: null }),
      });
      expect(result.primary?.turnId).toBe("turn-3");
      expect(result.history.map((group) => group.turnId)).toEqual(["turn-2", "turn-1"]);
    });

    it("when there is no latest turn", () => {
      const result = view({ live: [], current: read, latest: null });
      expect(result.primaryKind).toBe("promoted");
      expect(result.primary?.turnId).toBe("turn-3");
      expect(result.history.map((group) => group.turnId)).toEqual(["turn-2", "turn-1"]);
    });
  });

  it("keeps history to 3 hours, newest first, without bounding the primary", () => {
    const read = [
      planRow("t1-p", "turn-1", hoursAgo(3.02), [["Aged out", "completed"]]),
      planRow("t2-p", "turn-2", hoursAgo(2.98), [["Kept", "completed"]]),
      planRow("t3-p", "turn-3", hoursAgo(1), [["Newer", "completed"]]),
      planRow("t4-p", "turn-4", hoursAgo(0.5), [["Latest", "inProgress"]]),
    ];
    const result = view({
      live: [],
      current: read,
      latest: latestTurn("turn-4", { requestedAt: hoursAgo(0.6), completedAt: null }),
    });
    expect(result.primary?.turnId).toBe("turn-4");
    expect(result.history.map((group) => group.turnId)).toEqual(["turn-3", "turn-2"]);
  });
});

describe("plan row union", () => {
  const durations = (result: ReturnType<typeof view>) =>
    result.primary?.steps.map((step) => step.durationMs);

  it("renders the read's full durations for a turn whose live rows were cut", () => {
    const full = longTurnRows("turn-1", 2);
    const live = [full[2]!, toolRow("t2-tool", "turn-2", hoursAgo(0.1))];
    const latest = latestTurn("turn-2", { requestedAt: hoursAgo(0.2), completedAt: null });

    // Before any read lands: live alone, truncated.
    expect(durations(view({ live, current: null, latest }))).toEqual([undefined, undefined]);
    expect(durations(view({ live, current: full, latest }))).toEqual([600_000, 1_200_000]);
  });

  it("keeps the last landed read across a key change while the new read is pending", () => {
    const full = longTurnRows("turn-1", 2);
    const retained: LandedPlanHistoryRead = {
      environmentId: ENVIRONMENT,
      threadId: THREAD,
      rows: full,
    };
    const live = [
      full[2]!,
      toolRow("t2-tool", "turn-2", hoursAgo(0.3)),
      toolRow("t3-tool", "turn-3", hoursAgo(0.05)),
    ];
    const result = view({
      live,
      current: null,
      retained,
      latest: latestTurn("turn-3", { requestedAt: hoursAgo(0.1), completedAt: null }),
    });
    expect(result.primaryKind).toBe("promoted");
    expect(durations(result)).toEqual([600_000, 1_200_000]);
  });

  it("returns [] when a retained read survives a revert to zero turns", () => {
    const retained: LandedPlanHistoryRead = {
      environmentId: ENVIRONMENT,
      threadId: THREAD,
      rows: longTurnRows("turn-1", 2),
    };
    expect(resolvePlanHistoryRows(null, retained, ENVIRONMENT, THREAD, null)).toEqual([]);
  });

  it("does not carry a read over to a different thread", () => {
    const retained: LandedPlanHistoryRead = {
      environmentId: ENVIRONMENT,
      threadId: ThreadId.make("thread-other"),
      rows: longTurnRows("turn-1", 2),
    };
    expect(resolvePlanHistoryRows(null, retained, ENVIRONMENT, THREAD, null)).toBeNull();
  });

  it("does not carry a read over to a different environment with the same thread id", () => {
    const retained: LandedPlanHistoryRead = {
      environmentId: EnvironmentId.make("environment-other"),
      threadId: THREAD,
      rows: longTurnRows("turn-1", 2),
    };
    const latest = latestTurn("turn-2", { requestedAt: hoursAgo(0.2), completedAt: null });
    expect(resolvePlanHistoryRows(null, retained, ENVIRONMENT, THREAD, latest)).toBeNull();
  });

  it("includes a live plan row that arrived after the read landed, as the turn's final state", () => {
    const full = longTurnRows("turn-1", 2).slice(0, 2);
    const arrived = planRow("turn-1-p3", "turn-1", hoursAgo(1.5), [
      ["Build", "completed"],
      ["Test", "completed"],
      ["Ship", "inProgress"],
    ]);
    const result = view({
      live: [full[1]!, arrived],
      current: full,
      latest: latestTurn("turn-1", { requestedAt: hoursAgo(2.1), completedAt: null }),
    });
    expect(result.primaryKind).toBe("latest");
    expect(result.primary?.steps).toEqual([
      { step: "Build", status: "completed", durationMs: 600_000 },
      { step: "Test", status: "completed", durationMs: 1_200_000 },
      { step: "Ship", status: "inProgress" },
    ]);
  });

  it("drops turns a revert deleted from the retained read", () => {
    // turn-0 planned, turn-1 did not, turns 2 and 3 planned. Revert back to turn-1: turns 2
    // and 3 are gone, and the projector stamps the post-revert latest turn with its
    // checkpoint's completedAt.
    const read = [
      planRow("t0-p", "turn-0", hoursAgo(2.5), [["Kept", "completed"]]),
      planRow("t2-p", "turn-2", hoursAgo(1), [["Deleted", "completed"]]),
      planRow("t3-p", "turn-3", hoursAgo(0.5), [["Deleted too", "completed"]]),
    ];
    const retained: LandedPlanHistoryRead = {
      environmentId: ENVIRONMENT,
      threadId: THREAD,
      rows: read,
    };
    const turn1CompletedAt = hoursAgo(1.5);
    const result = view({
      live: [toolRow("t1-tool", "turn-1", hoursAgo(1.8))],
      current: null,
      retained,
      latest: latestTurn("turn-1", {
        requestedAt: turn1CompletedAt,
        completedAt: turn1CompletedAt,
      }),
    });
    expect(result.primaryKind).toBe("promoted");
    expect(result.primary?.turnId).toBe("turn-0");
    expect(result.history).toEqual([]);
  });

  it("reuses the union when its plan-row inputs are unchanged", () => {
    const full = longTurnRows("turn-1", 2);
    const live = [full[2]!, toolRow("t2-tool", "turn-2", hoursAgo(0.2))];
    const first = unionPlanActivityRows(full, live, null);

    // A non-plan append yields a new live array but the same plan rows.
    const appended = [...live, toolRow("t2-tool-2", "turn-2", hoursAgo(0.1))];
    expect(unionPlanActivityRows(full, appended, first)).toBe(first);

    // A new plan row is a real change.
    const planned = [...appended, planRow("t2-p", "turn-2", hoursAgo(0.05), [["New", "pending"]])];
    const second = unionPlanActivityRows(full, planned, first);
    expect(second).not.toBe(first);
    expect(second).toHaveLength(4);
  });
});

describe("latestTurnTaskCounts", () => {
  it("counts the latest turn's own outstanding plan", () => {
    const read = [
      planRow("t1-p", "turn-1", hoursAgo(1), [
        ["Build", "completed"],
        ["Test", "completed"],
        ["Ship", "inProgress"],
      ]),
    ];
    const result = view({
      live: read,
      current: read,
      latest: latestTurn("turn-1", { requestedAt: hoursAgo(1.1), completedAt: null }),
    });
    expect(latestTurnTaskCounts(result.primary, result.primaryKind)).toEqual({
      completed: 2,
      total: 3,
    });
  });

  // Same fixture as `selectTaskListView`'s promotion test above: without the primaryKind
  // guard, a 97-day-old promoted list would light the badge every time it's the newest group.
  it("is null for a promoted group, even with outstanding steps", () => {
    const read = [
      planRow("t1-p", "turn-1", hoursAgo(24 * 30), [
        ["Old", "inProgress"],
        ["Older", "pending"],
      ]),
    ];
    const result = view({
      live: [toolRow("t2-tool", "turn-2", hoursAgo(0.1))],
      current: read,
      latest: latestTurn("turn-2", { requestedAt: hoursAgo(0.2), completedAt: hoursAgo(0.05) }),
    });
    expect(result.primaryKind).toBe("promoted");
    expect(latestTurnTaskCounts(result.primary, result.primaryKind)).toBeNull();
  });

  it("is null when the latest turn has no plan at all", () => {
    const result = view({
      live: [toolRow("t1-tool", "turn-1", hoursAgo(0.1))],
      current: [],
      latest: latestTurn("turn-1", { requestedAt: hoursAgo(0.2), completedAt: null }),
    });
    expect(latestTurnTaskCounts(result.primary, result.primaryKind)).toBeNull();
  });

  // `derivePlanGroups` never emits a zero-step group in practice, so this constructs the shape
  // directly rather than through the pipeline — the function must not divide 0/0 into a lit badge.
  it("is null for a zero-step plan", () => {
    const zeroStepPlan = { createdAt: hoursAgo(0.1), turnId: TurnId.make("turn-1"), steps: [] };
    expect(latestTurnTaskCounts(zeroStepPlan, "latest")).toBeNull();
  });
});

// The composer's tasks badge vanishes on three gates (design doc "Problem" table): gate 1 —
// every step completed; gate 2 — the latest turn settled; gate 3 — a new turn starts that
// writes no plan. The Task list panel exists to keep showing the list through all three. These
// two tests pin the panel's pipeline against the same gates, end to end through the hook's real
// helpers — never a hand-built group or view.
describe("task list panel survives the composer badge's eviction gates", () => {
  it("does not evict a fully-completed, settled latest turn, even with a newer background turn's plan (gates 1 + 2)", () => {
    const read = [
      planRow("t1-p", "turn-1", hoursAgo(0.5), [
        ["Build", "completed"],
        ["Test", "completed"],
      ]),
      // A background/subagent turn can post a plan update after the user's latest turn settles:
      // its row sorts AFTER turn-1's (later createdAt) while `latestTurnId` stays "turn-1". This
      // discriminates "primary chosen by turnId match" from "primary = last group in the
      // array" — with only turn-1 present, both selections agree and the test proves nothing.
      planRow("tbg-p", "turn-bg", hoursAgo(0.3), [["Background", "inProgress"]]),
    ];
    const result = view({
      live: read,
      current: read,
      latest: latestTurn("turn-1", { requestedAt: hoursAgo(0.6), completedAt: hoursAgo(0.4) }),
    });
    expect(result.primaryKind).toBe("latest");
    expect(result.primary?.turnId).toBe("turn-1");
    expect(result.primary?.steps.map((step) => step.status)).toEqual(["completed", "completed"]);
    expect(result.history.map((group) => group.turnId)).toContain("turn-bg");

    // Feed the same primary/primaryKind the panel would, through the header chip logic: a
    // settled ("not running") latest turn whose steps all completed reads as "Finished", not
    // vanished.
    expect(taskListHeaderState(result.primary, result.primaryKind, false, NOW)).toEqual({
      tone: "finished",
      label: "Finished",
    });
  });

  it("promotes the previous turn's plan through the gate-3 transition, before the new read lands", () => {
    // (a) The read lands for key (thread, turn-1): turn-1's plan, every step completed, with
    // real step durations (a 20-minute turn).
    const turn1Start = NOW - 2 * 3_600_000;
    const at = (minutes: number) => new Date(turn1Start + minutes * 60_000).toISOString();
    const turn1Rows = [
      planRow("t1-p1", "turn-1", at(0), [
        ["Build", "inProgress"],
        ["Test", "pending"],
      ]),
      planRow("t1-p2", "turn-1", at(10), [
        ["Build", "completed"],
        ["Test", "inProgress"],
      ]),
      planRow("t1-p3", "turn-1", at(20), [
        ["Build", "completed"],
        ["Test", "completed"],
      ]),
    ];
    const before = view({
      live: turn1Rows,
      current: turn1Rows,
      latest: latestTurn("turn-1", { requestedAt: hoursAgo(2), completedAt: hoursAgo(1.6) }),
    });
    expect(before.primaryKind).toBe("latest");
    const durationsBeforeTransition = before.primary?.steps.map((step) => step.durationMs);
    expect(durationsBeforeTransition).toEqual([600_000, 600_000]);

    // (b) The latest turn becomes turn-2, which writes no plan rows at all; the new read for
    // (thread, turn-2) has not landed (`current: null`). The hook retains turn-1's landed read
    // rather than starting the new key empty.
    const retained: LandedPlanHistoryRead = {
      environmentId: ENVIRONMENT,
      threadId: THREAD,
      rows: turn1Rows,
    };
    const after = view({
      live: [toolRow("t2-tool", "turn-2", hoursAgo(0.1))],
      current: null,
      retained,
      latest: latestTurn("turn-2", { requestedAt: hoursAgo(0.2), completedAt: null }),
    });
    expect(after.primaryKind).toBe("promoted");
    expect(after.primary?.turnId).toBe("turn-1");
    expect(after.primary?.steps.map((step) => step.durationMs)).toEqual(durationsBeforeTransition);
    expect(after.history.map((group) => group.turnId)).not.toContain("turn-1");
  });
});
