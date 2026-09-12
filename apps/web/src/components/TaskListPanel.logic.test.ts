import { describe, expect, it } from "vite-plus/test";

import type { ActivePlanState } from "../session-logic";
import {
  taskListCurrentStep,
  taskListHeaderState,
  taskListHistoryStatus,
  taskListPanelState,
} from "./TaskListPanel.logic";

const NOW = Date.parse("2026-09-12T12:00:00.000Z");

function plan(
  statuses: ReadonlyArray<ActivePlanState["steps"][number]["status"]>,
  createdAt = "2026-09-12T11:00:00.000Z",
): ActivePlanState {
  return {
    createdAt,
    turnId: null,
    steps: statuses.map((status, index) => ({ step: `step ${index + 1}`, status })),
  };
}

describe("taskListHeaderState", () => {
  it("reads Updating while the latest turn is running, even with every step complete", () => {
    expect(taskListHeaderState(plan(["completed", "completed"]), "latest", true, NOW)).toEqual({
      tone: "live",
      label: "● Updating",
    });
  });

  it("reads Finished only when the settled latest turn completed every step", () => {
    expect(taskListHeaderState(plan(["completed", "completed"]), "latest", false, NOW)).toEqual({
      tone: "finished",
      label: "Finished",
    });
  });

  it("reads Stopped when the settled latest turn left steps outstanding", () => {
    expect(taskListHeaderState(plan(["completed", "inProgress"]), "latest", false, NOW)).toEqual({
      tone: "stopped",
      label: "Stopped",
    });
    expect(taskListHeaderState(plan(["completed", "pending"]), "latest", false, NOW)).toEqual({
      tone: "stopped",
      label: "Stopped",
    });
  });

  it("names a promoted group with its age, ignoring whether the latest turn runs", () => {
    const promoted = plan(["completed", "pending"], "2026-09-12T09:00:00.000Z");
    for (const running of [true, false]) {
      expect(taskListHeaderState(promoted, "promoted", running, NOW)).toEqual({
        tone: "promoted",
        label: "Last task list",
        time: "3h ago",
      });
    }
  });

  it("never renders a future time when the server clock is ahead", () => {
    const ahead = plan(["completed"], "2026-09-12T12:05:00.000Z");
    expect(taskListHeaderState(ahead, "promoted", false, NOW)).toEqual({
      tone: "promoted",
      label: "Last task list",
      time: "just now",
    });
  });

  it("has no chip without a primary", () => {
    expect(taskListHeaderState(null, null, true, NOW)).toBeNull();
  });
});

describe("taskListCurrentStep", () => {
  it("prefers the first running step, then the first pending, then the last step", () => {
    expect(taskListCurrentStep(plan(["completed", "pending", "inProgress"]).steps)?.step).toBe(
      "step 3",
    );
    expect(taskListCurrentStep(plan(["completed", "pending", "pending"]).steps)?.step).toBe(
      "step 2",
    );
    expect(taskListCurrentStep(plan(["completed", "completed"]).steps)?.step).toBe("step 2");
    expect(taskListCurrentStep([])).toBeNull();
  });
});

describe("taskListPanelState", () => {
  const primary = plan(["completed"]);

  it("never shows the empty state when the read is unavailable", () => {
    expect(taskListPanelState(null, "error")).toEqual({ kind: "unavailable", canRetry: true });
    expect(taskListPanelState(null, "unsupported")).toEqual({
      kind: "unavailable",
      canRetry: false,
    });
  });

  it("is loading while the read is pending with no primary", () => {
    expect(taskListPanelState(null, "pending")).toEqual({ kind: "loading" });
  });

  it("is empty only once the read landed with nothing", () => {
    expect(taskListPanelState(null, "ready")).toEqual({ kind: "empty" });
  });

  it("renders a primary whatever the read did, flagging only a failed history read", () => {
    expect(taskListPanelState(primary, "error")).toEqual({ kind: "plan", historyFailed: true });
    for (const status of ["ready", "pending", "unsupported"] as const) {
      expect(taskListPanelState(primary, status)).toEqual({ kind: "plan", historyFailed: false });
    }
  });
});

describe("taskListHistoryStatus", () => {
  const read = { supported: true, enabled: true, serverThread: true, error: null, current: null };

  it("reads pending, never unavailable, while the panel is not showing", () => {
    expect(taskListHistoryStatus({ ...read, enabled: false })).toBe("pending");
    expect(taskListHistoryStatus({ ...read, enabled: false, error: "timed out" })).toBe("pending");
    expect(taskListHistoryStatus({ ...read, enabled: false, current: [] })).toBe("pending");
  });

  it("follows the read once the panel shows", () => {
    expect(taskListHistoryStatus(read)).toBe("pending");
    expect(taskListHistoryStatus({ ...read, current: [] })).toBe("ready");
    expect(taskListHistoryStatus({ ...read, error: "timed out" })).toBe("error");
    expect(taskListHistoryStatus({ ...read, error: "timed out", current: [] })).toBe("error");
  });

  it("is unsupported when the server has no history read, open or not", () => {
    expect(taskListHistoryStatus({ ...read, supported: false })).toBe("unsupported");
    expect(taskListHistoryStatus({ ...read, supported: false, enabled: false })).toBe(
      "unsupported",
    );
  });

  it("is ready without a read for a thread the server does not know yet", () => {
    expect(taskListHistoryStatus({ ...read, serverThread: false })).toBe("ready");
    expect(taskListHistoryStatus({ ...read, serverThread: false, supported: false })).toBe("ready");
  });
});
