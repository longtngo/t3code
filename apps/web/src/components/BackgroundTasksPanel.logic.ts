import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import type { PendingBackgroundWorkTask } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set(["preparing", "starting", "running"]);

/**
 * The details card's Background section rows: provider-owned work that outlives (or may outlive) the turn that
 * started it.
 *
 * Once the latest run settles, the rows are exactly `settledTasks`, the list the composer's
 * background-work banner shows and Stop ends, so the section and the banner cannot disagree. While a
 * run is still working that list is empty by design (the turn's own Stop covers it), so the section
 * reads the active provider thread's roster instead: a background shell launched mid-turn is
 * listed as soon as the provider reports it.
 */
export function backgroundPanelTasks(input: {
  readonly projection: OrchestrationV2ThreadProjection | null;
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
