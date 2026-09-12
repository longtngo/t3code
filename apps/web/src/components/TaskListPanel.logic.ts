import type { ActivePlanState } from "../session-logic";
import { formatRelativeTimeLabel } from "../timestampFormat";
import type { TaskListState } from "../hooks/useTaskList";

type TaskStep = ActivePlanState["steps"][number];

export type TaskListHeaderChip =
  | { readonly tone: "live"; readonly label: "● Updating" }
  | { readonly tone: "finished"; readonly label: "Finished" }
  | { readonly tone: "stopped"; readonly label: "Stopped" }
  | { readonly tone: "promoted"; readonly label: "Last task list"; readonly time: string };

/**
 * The header chip. Only the latest turn's own plan can be live, and a settled one reads
 * `Finished` only when every step completed. A promoted group always names its age; the relative
 * time clamps a future `createdAt` (server clock ahead) to "just now".
 */
export function taskListHeaderState(
  primary: ActivePlanState | null,
  primaryKind: TaskListState["primaryKind"],
  latestTurnRunning: boolean,
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
  if (latestTurnRunning) return { tone: "live", label: "● Updating" };
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

export type TaskListPanelState =
  | { readonly kind: "unavailable"; readonly canRetry: boolean }
  | { readonly kind: "loading" }
  | { readonly kind: "empty" }
  | { readonly kind: "plan"; readonly historyFailed: boolean };

/**
 * What the panel body shows. With no primary, a read that is unsupported or failed means the
 * thread's task lists have no source, so it must not claim the thread has none.
 */
export function taskListPanelState(
  primary: ActivePlanState | null,
  historyStatus: TaskListState["historyStatus"],
): TaskListPanelState {
  if (primary !== null) return { kind: "plan", historyFailed: historyStatus === "error" };
  switch (historyStatus) {
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

/**
 * Where the history read stands. The read is requested only while the Task list panel shows, so
 * a hidden panel reads `pending`: the instant it shows, the query starts, and a thread whose
 * primary is outside the live window must show loading, never "No task list yet" or
 * "unavailable". A thread the server does not know yet (a draft) has no history to read.
 */
export function taskListHistoryStatus(read: {
  readonly supported: boolean;
  readonly enabled: boolean;
  readonly serverThread: boolean;
  readonly error: string | null;
  readonly current: unknown;
}): TaskListState["historyStatus"] {
  if (!read.serverThread) return "ready";
  if (!read.supported) return "unsupported";
  if (!read.enabled) return "pending";
  if (read.error !== null) return "error";
  return read.current !== null ? "ready" : "pending";
}
