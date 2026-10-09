import {
  MessageId,
  NodeId,
  PlanId,
  ProviderInstanceId,
  RunId,
  TurnItemId,
  type OrchestrationV2PlanArtifact,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import type { ActivePlanState } from "../session-logic";
import { makeThreadProjectionFixture } from "../test-fixtures";
import {
  deriveTaskListView,
  taskListHeaderState,
  taskListToggleSummary,
  type TaskListView,
} from "./TaskListPanel.logic";

const NOW = Date.parse("2026-09-12T12:00:00.000Z");
const base = makeThreadProjectionFixture();

function run(ordinal: number, status: OrchestrationV2Run["status"] = "completed") {
  const instanceId = ProviderInstanceId.make("claude");
  return {
    id: RunId.make(`run-${ordinal}`),
    threadId: base.thread.id,
    ordinal,
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "claude-sonnet-4-6" },
    providerThreadId: null,
    userMessageId: MessageId.make(`message-${ordinal}`),
    rootNodeId: null,
    activeAttemptId: null,
    status,
    requestedAt: DateTime.makeUnsafe("2026-09-12T10:00:00.000Z"),
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  } satisfies OrchestrationV2Run;
}

function todo(
  id: string,
  runOrdinal: number | null,
  steps: ReadonlyArray<readonly [string, "pending" | "running" | "completed"]>,
  status: OrchestrationV2PlanArtifact["status"] = "active",
) {
  return {
    id: PlanId.make(id),
    threadId: base.thread.id,
    runId: runOrdinal === null ? null : RunId.make(`run-${runOrdinal}`),
    nodeId: NodeId.make(`node-${id}`),
    kind: "todo_list" as const,
    status,
    steps: steps.map(([text, stepStatus], index) => ({
      id: `${id}-${index}`,
      text,
      status: stepStatus,
    })),
  } satisfies OrchestrationV2PlanArtifact;
}

function todoItem(planId: string, updatedAt: string) {
  return {
    id: TurnItemId.make(`item-${planId}`),
    threadId: base.thread.id,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed" as const,
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe(updatedAt),
    type: "todo_list" as const,
    planId: PlanId.make(planId),
    steps: [],
  } satisfies OrchestrationV2TurnItem;
}

function projection(
  plans: ReadonlyArray<OrchestrationV2PlanArtifact>,
  runs: ReadonlyArray<OrchestrationV2Run>,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem> = [],
): OrchestrationV2ThreadProjection {
  return { ...base, plans, runs, turnItems };
}

function stepTexts(plan: ActivePlanState | null) {
  return plan?.steps.map((step) => `${step.step}:${step.status}`) ?? null;
}

describe("deriveTaskListView", () => {
  it("keeps one list per run: a run's update supersedes its earlier list", () => {
    const view = deriveTaskListView(
      projection(
        [
          todo("p1", 1, [["Read the code", "running"]], "superseded"),
          todo("p2", 1, [
            ["Read the code", "completed"],
            ["Write the fix", "running"],
          ]),
        ],
        [run(1, "running")],
      ),
      RunId.make("run-1"),
    );
    expect(view.primaryKind).toBe("latest");
    expect(stepTexts(view.primary)).toEqual([
      "Read the code:completed",
      "Write the fix:inProgress",
    ]);
    expect(view.history).toEqual([]);
  });

  it("does not let a superseded list that arrives late replace the run's current one", () => {
    const view = deriveTaskListView(
      projection(
        [
          todo("p2", 1, [["Current", "completed"]]),
          todo("p1", 1, [["Stale", "pending"]], "superseded"),
        ],
        [run(1)],
      ),
      RunId.make("run-1"),
    );
    expect(stepTexts(view.primary)).toEqual(["Current:completed"]);
  });

  // The Claude adapter leaves a completed list un-superseded when the run starts another, and
  // snapshots load plans ordered by plan id (a uuid), so either array order can arrive.
  const ORDERS = ["arrival", "plan id"] as const;
  it.each(ORDERS)(
    "picks a run's current list over its earlier finished one (%s order)",
    (order) => {
      const finished = todo("p-old", 1, [["Old step", "completed"]], "completed");
      const current = todo("p-new", 1, [["New step", "running"]]);
      const view = deriveTaskListView(
        projection(order === "arrival" ? [finished, current] : [current, finished], [run(1)]),
        RunId.make("run-1"),
      );
      expect(stepTexts(view.primary)).toEqual(["New step:inProgress"]);
    },
  );
  it.each(ORDERS)(
    "picks the later of two finished lists by their turn items (%s order)",
    (order) => {
      const first = todo("p-first", 1, [["First list", "completed"]], "completed");
      const second = todo("p-second", 1, [["Second list", "completed"]], "completed");
      const plans = order === "arrival" ? [first, second] : [second, first];
      // The turn item's ordinal decides, even against a later update time (a finished list
      // can be touched again, e.g. a step duration landing late).
      const byOrdinal = [
        { ...todoItem("p-first", "2026-09-12T11:00:00.000Z"), ordinal: 2 },
        { ...todoItem("p-second", "2026-09-12T10:00:00.000Z"), ordinal: 7 },
      ];
      expect(
        stepTexts(
          deriveTaskListView(projection(plans, [run(1)], byOrdinal), RunId.make("run-1")).primary,
        ),
      ).toEqual(["Second list:completed"]);
      // Equal ordinals fall to the update time.
      const byTime = [
        { ...todoItem("p-first", "2026-09-12T10:00:00.000Z"), ordinal: 4 },
        { ...todoItem("p-second", "2026-09-12T11:00:00.000Z"), ordinal: 4 },
      ];
      expect(
        stepTexts(
          deriveTaskListView(projection(plans, [run(1)], byTime), RunId.make("run-1")).primary,
        ),
      ).toEqual(["Second list:completed"]);
    },
  );

  it("lists earlier runs newest first by run order, not by arrival order", () => {
    const view = deriveTaskListView(
      projection(
        [
          todo("p2", 2, [["Second", "completed"]], "completed"),
          todo("p3", 3, [["Third", "pending"]]),
          todo("p1", 1, [["First", "completed"]], "completed"),
        ],
        [run(3, "running"), run(1), run(2)],
      ),
      RunId.make("run-3"),
    );
    expect(stepTexts(view.primary)).toEqual(["Third:pending"]);
    expect(view.history.map((group) => group.steps[0]?.step)).toEqual(["Second", "First"]);
  });

  it("promotes the newest earlier list when the latest run wrote none", () => {
    const view = deriveTaskListView(
      projection(
        [
          todo("p1", 1, [["First", "completed"]], "completed"),
          todo("p2", 2, [["Second", "completed"]], "completed"),
        ],
        [run(1), run(2), run(3, "running")],
        [todoItem("p2", "2026-09-12T09:00:00.000Z")],
      ),
      RunId.make("run-3"),
    );
    expect(view.primaryKind).toBe("promoted");
    expect(stepTexts(view.primary)).toEqual(["Second:completed"]);
    expect(view.primary?.createdAt).toBe("2026-09-12T09:00:00.000Z");
    expect(view.history.map((group) => group.steps[0]?.step)).toEqual(["First"]);
  });

  it("ignores proposed plans and empty lists, and is empty without a projection", () => {
    const proposed = {
      id: PlanId.make("proposal"),
      threadId: base.thread.id,
      runId: RunId.make("run-1"),
      nodeId: NodeId.make("node-proposal"),
      kind: "proposed_plan" as const,
      status: "active" as const,
      markdown: "# Plan",
    } satisfies OrchestrationV2PlanArtifact;
    const view = deriveTaskListView(
      projection([proposed, todo("p-empty", 1, [])], [run(1)]),
      RunId.make("run-1"),
    );
    expect(view).toEqual({ primary: null, primaryKind: null, history: [] });
    expect(deriveTaskListView(null, null).primary).toBeNull();
  });

  it("keys each list by its run, or its plan id when runless, stable across updates", () => {
    const before = deriveTaskListView(
      projection(
        [
          todo("p-run", 2, [["Run step", "running"]]),
          todo("p-solo", null, [["Solo step", "running"]]),
        ],
        [run(2, "running")],
        [todoItem("p-solo", "2026-09-12T10:00:00.000Z")],
      ),
      RunId.make("run-2"),
    );
    const after = deriveTaskListView(
      projection(
        [
          todo("p-run", 2, [["Run step", "running"]], "superseded"),
          todo("p-run-2", 2, [
            ["Run step", "completed"],
            ["Next step", "running"],
          ]),
          todo("p-solo", null, [["Solo step", "completed"]]),
        ],
        [run(2, "running")],
        [todoItem("p-solo", "2026-09-12T11:00:00.000Z")],
      ),
      RunId.make("run-2"),
    );
    for (const view of [before, after]) {
      expect(view.primary?.groupKey).toBe("run-2");
      expect(view.history.map((entry) => entry.groupKey)).toEqual(["plan:p-solo"]);
    }
  });
});

function plan(
  statuses: ReadonlyArray<ActivePlanState["steps"][number]["status"]>,
  createdAt = "2026-09-12T11:00:00.000Z",
): ActivePlanState {
  return {
    createdAt,
    runId: null,
    steps: statuses.map((status, index) => ({ step: `step ${index + 1}`, status })),
  };
}

function viewWith(
  kind: "latest" | "promoted",
  statuses: ReadonlyArray<ActivePlanState["steps"][number]["status"]>,
): TaskListView {
  return { primary: { ...plan(statuses), groupKey: "run-1" }, primaryKind: kind, history: [] };
}

describe("taskListToggleSummary", () => {
  it("shows the activity run's own list fraction while it works", () => {
    expect(
      taskListToggleSummary(viewWith("latest", ["completed", "pending", "pending"]), true, false),
    ).toBe("1/3");
  });
  it("is absent while the thread resyncs, and shows the fraction otherwise", () => {
    const view = viewWith("latest", ["completed", "pending", "pending"]);
    expect(taskListToggleSummary(view, true, true)).toBeNull();
    expect(taskListToggleSummary(view, true, false)).toBe("1/3");
  });
  it("is absent for a promoted list, an empty list, or a settled run", () => {
    expect(taskListToggleSummary(viewWith("promoted", ["completed"]), true, false)).toBeNull();
    expect(taskListToggleSummary(viewWith("latest", []), true, false)).toBeNull();
    expect(taskListToggleSummary(viewWith("latest", ["completed"]), false, false)).toBeNull();
    expect(
      taskListToggleSummary({ primary: null, primaryKind: null, history: [] }, true, false),
    ).toBeNull();
  });
  it("follows the working run's own list past a queued follow-up and a late superseded list", () => {
    // "p-r2-stale" sorts after "p-r2-live" by plan id, so a snapshot delivers it last.
    const view = deriveTaskListView(
      projection(
        [
          todo("p-r2-live", 2, [
            ["Read", "completed"],
            ["Fix", "running"],
          ]),
          todo("p-r2-stale", 2, [["Read", "running"]], "superseded"),
        ],
        [run(1), run(2, "running"), run(3, "queued")],
      ),
      RunId.make("run-2"),
    );
    expect(view.primaryKind).toBe("latest");
    expect(taskListToggleSummary(view, true, false)).toBe("1/2");
  });
});

describe("taskListHeaderState", () => {
  it("reads Updating while the latest run works, even with every step complete", () => {
    expect(taskListHeaderState(plan(["completed", "completed"]), "latest", true, NOW)).toEqual({
      tone: "live",
      label: "● Updating",
    });
  });

  it("reads Finished only when the settled latest run completed every step", () => {
    expect(taskListHeaderState(plan(["completed", "completed"]), "latest", false, NOW)).toEqual({
      tone: "finished",
      label: "Finished",
    });
    expect(taskListHeaderState(plan(["completed", "pending"]), "latest", false, NOW)).toEqual({
      tone: "stopped",
      label: "Stopped",
    });
  });

  it("names a promoted list with its age, clamping a future time", () => {
    expect(
      taskListHeaderState(plan(["pending"], "2026-09-12T09:00:00.000Z"), "promoted", true, NOW),
    ).toEqual({ tone: "promoted", label: "Last task list", time: "3h ago" });
    expect(
      taskListHeaderState(plan(["pending"], "2026-09-12T12:05:00.000Z"), "promoted", false, NOW),
    ).toEqual({ tone: "promoted", label: "Last task list", time: "just now" });
  });
});
