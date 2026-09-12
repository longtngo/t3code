export interface PanelToggleLabelInput {
  readonly liveAgentCount: number;
  readonly taskCompletedCount?: number | undefined;
  readonly taskTotalCount?: number | undefined;
}

/**
 * The right-panel toggle's status suffix, shared verbatim by the aria-label and the tooltip so
 * the two copies can never drift. `null` when there is nothing to report, so both callers fall
 * back to their bare "Toggle right panel..." string, byte-identical to before this badge existed.
 */
export function panelToggleLabel({
  liveAgentCount,
  taskCompletedCount,
  taskTotalCount,
}: PanelToggleLabelInput): string | null {
  const parts: Array<string> = [];
  if (liveAgentCount > 0) {
    parts.push(`${liveAgentCount} ${liveAgentCount === 1 ? "agent" : "agents"} working`);
  }
  if (taskTotalCount !== undefined && taskCompletedCount !== undefined && taskTotalCount > 0) {
    parts.push(
      taskCompletedCount >= taskTotalCount
        ? `all ${taskTotalCount} ${taskTotalCount === 1 ? "task" : "tasks"} complete`
        : `${taskCompletedCount} of ${taskTotalCount} tasks complete`,
    );
  }
  return parts.length === 0 ? null : parts.join(", ");
}
