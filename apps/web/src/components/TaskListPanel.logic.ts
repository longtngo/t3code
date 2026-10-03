import type { OrchestrationV2ThreadProjection, PlanId, RunId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { ActivePlanState } from "../session-logic";
import { formatRelativeTimeLabel } from "../timestampFormat";

type TaskStep = ActivePlanState["steps"][number];
type TodoPlan = Extract<
  OrchestrationV2ThreadProjection["plans"][number],
  { readonly kind: "todo_list" }
>;

export interface TaskListView {
  /** The group the panel renders expanded at the top, or null when the thread has none. */
  readonly primary: ActivePlanState | null;
  /** `latest`: the latest run's own list. `promoted`: the newest list of an earlier run. */
  readonly primaryKind: "latest" | "promoted" | null;
  /** Every other run's final list, newest first. */
  readonly history: ReadonlyArray<ActivePlanState>;
}

const EMPTY_VIEW: TaskListView = { primary: null, primaryKind: null, history: [] };

function planTime(projection: OrchestrationV2ThreadProjection, planId: PlanId): string {
  const item = projection.turnItems.findLast(
    (candidate) => candidate.type === "todo_list" && candidate.planId === planId,
  );
  return DateTime.formatIso(item?.updatedAt ?? projection.updatedAt);
}

function toPlanState(projection: OrchestrationV2ThreadProjection, plan: TodoPlan): ActivePlanState {
  return {
    createdAt: planTime(projection, plan.id),
    runId: plan.runId,
    explanation: plan.explanation ?? null,
    steps: plan.steps.map(({ text, status, durationMs }) => ({
      step: text,
      status: status === "running" ? "inProgress" : status,
      ...(durationMs === undefined ? {} : { durationMs }),
    })),
  };
}

/**
 * Live beats finished beats superseded. A run can hold two non-superseded lists: the Claude
 * adapter does not supersede a completed list when a new one starts, and the newer of the two
 * is then the live one.
 */
const LIST_STATUS_RANK: Record<TodoPlan["status"], number> = {
  superseded: 0,
  draft: 1,
  completed: 1,
  active: 2,
};

function latestListItem(projection: OrchestrationV2ThreadProjection, planId: PlanId) {
  return projection.turnItems.findLast(
    (candidate) => candidate.type === "todo_list" && candidate.planId === planId,
  );
}

/**
 * Whether `candidate` is a newer list of the same run than `previous`. Array order is not
 * evidence: snapshots load plans ordered by plan id, a uuid. Ties fall to the lists' turn items
 * (ordinal, then update time), and only then to arrival order.
 */
function isNewerListOfRun(
  projection: OrchestrationV2ThreadProjection,
  candidate: TodoPlan,
  previous: TodoPlan,
): boolean {
  const rank = LIST_STATUS_RANK[candidate.status] - LIST_STATUS_RANK[previous.status];
  if (rank !== 0) return rank > 0;
  const candidateItem = latestListItem(projection, candidate.id);
  const previousItem = latestListItem(projection, previous.id);
  const ordinal = (candidateItem?.ordinal ?? -1) - (previousItem?.ordinal ?? -1);
  if (ordinal !== 0) return ordinal > 0;
  if (candidateItem !== undefined && previousItem !== undefined) {
    const time =
      DateTime.toEpochMillis(candidateItem.updatedAt) -
      DateTime.toEpochMillis(previousItem.updatedAt);
    if (time !== 0) return time > 0;
  }
  return true;
}

/**
 * The Task list panel's selection, read from the thread's v2 plans: one list per run (its last
 * non-superseded `todo_list`, since each update supersedes the previous one), ordered by run.
 * Primary is the latest run's list, else the newest list of any earlier run. History covers the
 * runs the client has loaded; older history arrives with the timeline's own paging.
 */
export function deriveTaskListView(
  projection: OrchestrationV2ThreadProjection | null,
  latestRunId: RunId | null,
): TaskListView {
  if (projection === null) return EMPTY_VIEW;
  const finalPlanByGroup = new Map<string, TodoPlan>();
  for (const plan of projection.plans) {
    if (plan.kind !== "todo_list" || plan.steps.length === 0) continue;
    const key = plan.runId ?? `plan:${plan.id}`;
    const previous = finalPlanByGroup.get(key);
    if (previous === undefined || isNewerListOfRun(projection, plan, previous)) {
      finalPlanByGroup.set(key, plan);
    }
  }
  if (finalPlanByGroup.size === 0) return EMPTY_VIEW;

  const runOrdinal = new Map(projection.runs.map((run) => [run.id, run.ordinal]));
  const groups = [...finalPlanByGroup.values()]
    .map((plan) => ({
      plan,
      state: toPlanState(projection, plan),
      ordinal: plan.runId === null ? undefined : runOrdinal.get(plan.runId),
    }))
    .toSorted(
      (left, right) =>
        (left.ordinal ?? Number.MAX_SAFE_INTEGER) - (right.ordinal ?? Number.MAX_SAFE_INTEGER) ||
        left.state.createdAt.localeCompare(right.state.createdAt),
    );

  const latest =
    latestRunId === null ? undefined : groups.find((group) => group.plan.runId === latestRunId);
  const primary = latest ?? groups.at(-1)!;
  return {
    primary: primary.state,
    primaryKind: latest ? "latest" : "promoted",
    history: groups
      .filter((group) => group !== primary)
      .map((group) => group.state)
      .toReversed(),
  };
}

/**
 * Counts for the launcher pill. Non-null only for the latest run's own list with at least one
 * step: a promoted list would leave a stale count lit on a thread whose run is long over.
 */
export function latestRunTaskCounts(
  view: TaskListView,
): { readonly completed: number; readonly total: number } | null {
  const { primary, primaryKind } = view;
  if (primaryKind !== "latest" || primary === null || primary.steps.length === 0) return null;
  return {
    completed: primary.steps.filter((step) => step.status === "completed").length,
    total: primary.steps.length,
  };
}

export type TaskListHeaderChip =
  | { readonly tone: "live"; readonly label: "● Updating" }
  | { readonly tone: "finished"; readonly label: "Finished" }
  | { readonly tone: "stopped"; readonly label: "Stopped" }
  | { readonly tone: "promoted"; readonly label: "Last task list"; readonly time: string };

/**
 * The header chip. Only the latest run's own list can be live, and a settled one reads
 * `Finished` only when every step completed. A promoted list always names its age; the relative
 * time clamps a future `createdAt` (server clock ahead) to "just now".
 */
export function taskListHeaderState(
  primary: ActivePlanState | null,
  primaryKind: TaskListView["primaryKind"],
  latestRunActive: boolean,
  nowMs: number,
): TaskListHeaderChip | null {
  if (primary === null || primaryKind === null) return null;
  if (primaryKind === "promoted") {
    return {
      tone: "promoted",
      label: "Last task list",
      time: formatRelativeTimeLabel(primary.createdAt, nowMs),
    };
  }
  if (latestRunActive) return { tone: "live", label: "● Updating" };
  return primary.steps.every((step) => step.status === "completed")
    ? { tone: "finished", label: "Finished" }
    : { tone: "stopped", label: "Stopped" };
}

/** The step the header names: the first running, else the first pending, else the last. */
export function taskListCurrentStep(steps: ReadonlyArray<TaskStep>): TaskStep | null {
  return (
    steps.find((step) => step.status === "inProgress") ??
    steps.find((step) => step.status === "pending") ??
    steps.at(-1) ??
    null
  );
}
