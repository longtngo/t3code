import type { OrchestrationBackgroundTask, OrchestrationThreadActivity } from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";

import { formatRelativeTimeLabel } from "../timestampFormat";

const TASK_LIFECYCLE_KINDS: ReadonlySet<string> = new Set([
  "task.started",
  "task.updated",
  "task.completed",
]);

/**
 * The Background read's refetch key. Every background task start or end appends a lifecycle
 * activity, which always lands in the live window; a session that dies clears the live count
 * without one; a revert can delete rows outside the window but always moves the latest turn.
 */
export function backgroundTasksRefreshKey(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  liveCount: number,
  latestTurnId: string | null,
): string {
  let newest = "";
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (
      activity &&
      TASK_LIFECYCLE_KINDS.has(activity.kind) &&
      typeof activity.payload === "object" &&
      activity.payload !== null &&
      (activity.payload as Record<string, unknown>).agentKind === "background"
    ) {
      newest = activity.id;
      break;
    }
  }
  return `${newest}|${liveCount}|${latestTurnId ?? ""}`;
}

function taskTypeLabel(taskType: string | null): string {
  switch (taskType) {
    case "local_bash":
    case "shell":
      return "Shell";
    case "monitor":
    case "monitor_mcp":
      return "Monitor";
    default:
      return "Task";
  }
}

/** The row's second line: kind, when it started, and how long it ran. */
export function backgroundTaskDetail(task: OrchestrationBackgroundTask, nowMs: number): string {
  const parts = [
    taskTypeLabel(task.taskType),
    `started ${formatRelativeTimeLabel(task.startedAt, nowMs)}`,
  ];
  if (task.endedAt !== null) {
    parts.push(`ran ${formatDuration(Date.parse(task.endedAt) - Date.parse(task.startedAt))}`);
  } else if (task.status === "stopped") {
    parts.push("ended without a result");
  }
  return parts.join(" · ");
}

export type BackgroundTasksReadStatus = "unsupported" | "pending" | "ready" | "error";

export type BackgroundTasksPanelState =
  | { readonly kind: "unavailable"; readonly canRetry: boolean }
  | { readonly kind: "loading" }
  | { readonly kind: "empty" }
  | { readonly kind: "list"; readonly failed: boolean };

/** What the panel body shows. A landed list stays on screen while a refetch runs or fails. */
export function backgroundTasksPanelState(
  tasks: ReadonlyArray<OrchestrationBackgroundTask> | null,
  status: BackgroundTasksReadStatus,
): BackgroundTasksPanelState {
  if (tasks !== null) {
    return tasks.length === 0 && status !== "error"
      ? { kind: "empty" }
      : { kind: "list", failed: status === "error" };
  }
  switch (status) {
    case "unsupported":
      return { kind: "unavailable", canRetry: false };
    case "error":
      return { kind: "unavailable", canRetry: true };
    case "pending":
      return { kind: "loading" };
    case "ready":
      return { kind: "empty" };
  }
}
