import { memo } from "react";

import { formatDuration } from "../../session-logic";
import { cn } from "~/lib/utils";
import { ComposerBanner } from "./ComposerBanner";

export interface ComposerTaskStep {
  readonly durationMs?: number;
  readonly step: string;
  readonly status: "pending" | "inProgress" | "completed";
}

const MAX_TASK_SEGMENTS = 10;

const taskStatusLabels = {
  pending: "Pending",
  inProgress: "Running",
  completed: "Completed",
} satisfies Record<ComposerTaskStep["status"], string>;

function keyedTaskSteps(steps: readonly ComposerTaskStep[]) {
  const occurrences = new Map<string, number>();
  return steps.map((step) => {
    const occurrence = occurrences.get(step.step) ?? 0;
    occurrences.set(step.step, occurrence + 1);
    return { key: `${step.step}:${occurrence}`, step };
  });
}

export function TaskSegments({
  className,
  steps,
}: {
  readonly className?: string;
  readonly steps: readonly ComposerTaskStep[];
}) {
  if (steps.length <= 1 || steps.length > MAX_TASK_SEGMENTS) return null;

  return (
    <span aria-hidden className={cn("flex w-10 shrink-0 items-center gap-0.5", className)}>
      {keyedTaskSteps(steps).map(({ key, step }) => (
        <span
          key={key}
          className={cn(
            "h-[3px] min-w-0 flex-1 rounded-full",
            step.status === "completed"
              ? "bg-success"
              : step.status === "inProgress"
                ? "bg-primary"
                : "bg-muted-foreground/25",
          )}
        />
      ))}
    </span>
  );
}

/** The task step rows shared by the composer's tasks drawer and the task list panel. */
export const TaskStepList = memo(function TaskStepList({
  steps,
}: {
  readonly steps: readonly ComposerTaskStep[];
}) {
  return (
    <>
      {keyedTaskSteps(steps).map(({ key, step }) => (
        <ComposerBanner.Row key={key} render={<li />}>
          <ComposerBanner.Icon
            className={cn(
              "font-mono text-[10px]",
              step.status === "completed"
                ? "text-success"
                : step.status === "inProgress"
                  ? "text-primary"
                  : "text-muted-foreground/40",
            )}
          >
            {step.status === "completed" ? "✓" : step.status === "inProgress" ? "●" : "○"}
          </ComposerBanner.Icon>
          <ComposerBanner.Content
            className={cn(
              step.status === "completed"
                ? "text-muted-foreground/55"
                : step.status === "inProgress"
                  ? "text-foreground/90"
                  : "text-muted-foreground/70",
            )}
          >
            {step.step}
          </ComposerBanner.Content>
          <ComposerBanner.Actions>
            <span className="text-[10px] text-muted-foreground">
              {taskStatusLabels[step.status]}
            </span>
            <span
              className="w-10 text-right text-[10px] text-muted-foreground/45 tabular-nums"
              data-composer-task-duration="true"
            >
              {step.durationMs !== undefined
                ? formatDuration(step.durationMs)
                : step.status === "inProgress"
                  ? "now"
                  : null}
            </span>
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
      ))}
    </>
  );
});
