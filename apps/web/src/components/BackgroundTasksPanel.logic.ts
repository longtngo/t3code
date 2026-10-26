import type { ThreadStructure } from "@t3tools/client-runtime/state/models";
import type { PendingBackgroundWorkTask } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set(["preparing", "starting", "running"]);

/**
 * The Background section rows. Once the latest run settles they are exactly `settledTasks`, so the
 * section and the banner cannot disagree. While a run works that list is empty by design, so this
 * reads the provider thread's roster and shows a mid-turn background shell immediately.
 */
export function backgroundPanelTasks(input: {
  readonly projection: ThreadStructure | null;
  readonly settledTasks: ReadonlyArray<PendingBackgroundWorkTask>;
}): ReadonlyArray<PendingBackgroundWorkTask> {
  const { projection } = input;
  if (projection === null) return input.settledTasks;
  const runActive = projection.runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status));
  if (!runActive) return input.settledTasks;
  const activeProviderThreadId = projection.thread.activeProviderThreadId;
  const byTaskId = new Map<string, PendingBackgroundWorkTask>();
  for (const providerThread of projection.providerThreads) {
    if (activeProviderThreadId !== null && providerThread.id !== activeProviderThreadId) continue;
    for (const task of providerThread.pendingBackgroundTasks ?? []) {
      if (!byTaskId.has(task.taskId)) byTaskId.set(task.taskId, task);
    }
  }
  return [...byTaskId.values()];
}

/** The row's kind label. Work the adapter cannot name reads as a plain task. */
export function backgroundTaskKindLabel(kind: PendingBackgroundWorkTask["kind"]): string {
  switch (kind) {
    case "subagent":
      return "Subagent";
    case "command":
      return "Shell";
    case "monitor":
      return "Monitor";
    case "background_task":
      return "Task";
  }
}
