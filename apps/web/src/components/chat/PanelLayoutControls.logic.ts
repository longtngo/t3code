export interface PanelToggleLabelInput {
  readonly liveAgentCount: number;
  readonly liveBackgroundCount?: number | undefined;
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
  liveBackgroundCount = 0,
  taskCompletedCount,
  taskTotalCount,
}: PanelToggleLabelInput): string | null {
  const parts: Array<string> = [];
  if (liveAgentCount > 0) {
    parts.push(`${liveAgentCount} ${liveAgentCount === 1 ? "agent" : "agents"} working`);
  }
  if (liveBackgroundCount > 0) {
    parts.push(backgroundTaskCountLabel(liveBackgroundCount));
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

/** "1 background task" / "2 background tasks", shared by the toggle label and the composer banner. */
export function backgroundTaskCountLabel(count: number): string {
  return `${count} background ${count === 1 ? "task" : "tasks"}`;
}

export interface LiveWorkBannerPart {
  readonly label: string;
  /** The right-panel surface the part opens. */
  readonly target: "agents" | "background";
}

/**
 * The composer's live-work banner title, one clickable part per kind of work: "3 agents ·
 * 2 background tasks". Falls back to a single uncounted part when liveness says something runs
 * but neither count does (a workflow run with no roster agent; an older server with no count).
 */
export function liveWorkBannerParts(input: {
  readonly liveness: "working" | "monitoring";
  readonly liveAgentCount: number;
  readonly liveBackgroundCount: number;
}): ReadonlyArray<LiveWorkBannerPart> {
  const parts: Array<LiveWorkBannerPart> = [];
  if (input.liveAgentCount > 0) {
    parts.push({
      label: `${input.liveAgentCount} ${input.liveAgentCount === 1 ? "agent" : "agents"}`,
      target: "agents",
    });
  }
  if (input.liveBackgroundCount > 0) {
    parts.push({
      label: backgroundTaskCountLabel(input.liveBackgroundCount),
      target: "background",
    });
  }
  if (parts.length > 0) return parts;
  return input.liveness === "working"
    ? [{ label: "Background work", target: "agents" }]
    : [{ label: "Background tasks", target: "background" }];
}
