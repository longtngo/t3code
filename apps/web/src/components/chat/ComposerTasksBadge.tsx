import { ListTodoIcon } from "lucide-react";
import { memo, type ComponentProps } from "react";

import { ComposerBanner } from "./ComposerBanner";
import { TaskSegments, TaskStepList, type ComposerTaskStep } from "./TaskStepList";

export type { ComposerTaskStep };

export interface ComposerTasksProgress {
  readonly step: string;
  readonly completedSteps: number;
  readonly totalSteps: number;
}

function TaskSummary({
  expanded,
  progress,
  steps,
}: {
  readonly expanded: boolean;
  readonly progress: ComposerTasksProgress;
  readonly steps: readonly ComposerTaskStep[];
}) {
  return (
    <>
      <ComposerBanner.Icon>
        <ListTodoIcon />
      </ComposerBanner.Icon>
      <ComposerBanner.Content>
        <span className="shrink-0 text-muted-foreground">Tasks</span>
        <span
          className="min-w-0 flex-1 truncate text-left font-medium text-foreground/80"
          data-composer-task-current="true"
        >
          {progress.step}
        </span>
      </ComposerBanner.Content>
      <ComposerBanner.Actions>
        <ComposerBanner.Count
          className={progress.completedSteps >= progress.totalSteps ? "text-success" : undefined}
          data-composer-task-progress="true"
        >
          {progress.completedSteps}/{progress.totalSteps} complete
        </ComposerBanner.Count>
        <TaskSegments className="hidden w-20 sm:flex" steps={steps} />
        <ComposerBanner.ToggleIcon expanded={expanded} />
      </ComposerBanner.Actions>
    </>
  );
}

export const ComposerTasksBadge = memo(function ComposerTasksBadge({
  expanded,
  onDismiss,
  onToggle,
  placement = "tab",
  progress,
  steps,
}: {
  readonly expanded: boolean;
  /** Fork: dismisses task progress for the current turn. Omitted where there is nothing
   *  to dismiss to, e.g. the inline summary inside the drawer. */
  readonly onDismiss?: (() => void) | undefined;
  readonly onToggle: () => void;
  readonly placement?: "inline" | "tab";
  readonly progress: ComposerTasksProgress;
  readonly steps: readonly ComposerTaskStep[];
}) {
  if (progress.totalSteps <= 0) return null;

  const row = (
    <ComposerBanner.Row
      render={<button type="button" />}
      aria-expanded={expanded}
      aria-label={`${expanded ? "Collapse tasks" : "Tasks"}: ${progress.completedSteps} of ${progress.totalSteps} complete. Current task: ${progress.step}`}
      data-composer-tasks-badge="true"
      onClick={onToggle}
      onPointerDown={(event) => event.preventDefault()}
    >
      <TaskSummary expanded={expanded} progress={progress} steps={steps} />
      {onDismiss ? (
        <ComposerBanner.Actions>
          <ComposerBanner.Dismiss
            aria-label="Dismiss tasks"
            onClick={(event) => {
              event.stopPropagation();
              onDismiss();
            }}
            onPointerDown={(event) => event.preventDefault()}
          />
        </ComposerBanner.Actions>
      ) : null}
    </ComposerBanner.Row>
  );
  return placement === "inline" ? (
    row
  ) : (
    <ComposerBanner.Root density="comfortable" data-composer-shoulder-tab>
      {row}
    </ComposerBanner.Root>
  );
});

export const ComposerTasksContent = memo(function ComposerTasksContent({
  expanded,
  onToggle,
  progress,
  steps,
}: {
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly progress: ComposerTasksProgress;
  readonly steps: readonly ComposerTaskStep[];
}) {
  return (
    <div
      data-chat-composer-collapsed-controls="true"
      data-chat-composer-tasks-drawer={expanded ? "true" : undefined}
    >
      <ComposerTasksBadge
        expanded={expanded}
        onToggle={onToggle}
        placement="inline"
        progress={progress}
        steps={steps}
      />
      {expanded ? (
        <ComposerBanner.Scroll data-composer-tasks-scroll="true">
          <ComposerBanner.Children
            render={<ul />}
            aria-label={`Task list. ${progress.completedSteps} of ${progress.totalSteps} complete.`}
            data-composer-tasks-list="true"
          >
            <TaskStepList steps={steps} />
          </ComposerBanner.Children>
        </ComposerBanner.Scroll>
      ) : null}
    </div>
  );
});

export const ComposerTasksDrawer = memo(function ComposerTasksDrawer({
  onCollapse,
  onDismiss,
  ...props
}: Omit<ComponentProps<typeof ComposerTasksContent>, "expanded" | "onToggle"> & {
  readonly onCollapse: () => void;
  /** Fork: dismisses task progress for the current turn. */
  readonly onDismiss: () => void;
}) {
  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root>
        <ComposerTasksContent {...props} expanded onToggle={onCollapse} />
        <ComposerBanner.Actions>
          <ComposerBanner.Dismiss aria-label="Dismiss tasks" onClick={onDismiss} />
        </ComposerBanner.Actions>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
});
