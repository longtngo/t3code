import { memo } from "react";
import { ListTodoIcon, LoaderIcon } from "lucide-react";

import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipWrapperTrigger } from "../ui/tooltip";

interface TasksPanelToggleProps {
  /** Whether the tasks/plan sidebar is currently open. */
  readonly open: boolean;
  readonly onToggle: () => void;
  /** Panel label — "Plan" or "Tasks", matching the sidebar heading. */
  readonly label: string;
  /** Completed plan steps + agents + background processes. */
  readonly completedCount: number;
  /** All tracked plan steps + agents + background processes. */
  readonly totalCount: number;
  /** Whether any tracked item is running (shows the spinner). */
  readonly hasActive: boolean;
}

/**
 * Permanent tasks-panel toggle on the composer's task bar. Aggregates the three
 * activity sources backing the panel (plan steps, agents, background processes)
 * into a `{completed}/{total}` count and a spinner that turns on whenever any of
 * them is running.
 */
export const TasksPanelToggle = memo(function TasksPanelToggle({
  open,
  onToggle,
  label,
  completedCount,
  totalCount,
  hasActive,
}: TasksPanelToggleProps) {
  const countText = `${completedCount}/${totalCount}`;
  return (
    <Tooltip>
      <TooltipWrapperTrigger className="shrink-0">
        <Toggle
          className="shrink-0 gap-1"
          pressed={open}
          onPressedChange={onToggle}
          aria-label="Toggle tasks panel"
          variant="outline"
          size="xs"
        >
          <ListTodoIcon className="size-3" />
          <span className="text-[11px] leading-none">{label}</span>
          {totalCount > 0 ? (
            <span className="text-[10px] leading-none tabular-nums text-muted-foreground">
              {countText}
            </span>
          ) : null}
          {hasActive ? (
            <LoaderIcon className="size-3 animate-spin text-blue-400" />
          ) : null}
        </Toggle>
      </TooltipWrapperTrigger>
      <TooltipPopup side="top">
        {totalCount > 0
          ? `Toggle ${label.toLowerCase()} panel (${completedCount} completed / ${totalCount} total)`
          : `Toggle ${label.toLowerCase()} panel`}
      </TooltipPopup>
    </Tooltip>
  );
});
