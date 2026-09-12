import { Maximize2Icon, Minimize2Icon, PanelBottomIcon, PanelRightIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";

import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { panelToggleLabel } from "./PanelLayoutControls.logic";

interface PanelLayoutControlsProps {
  showTerminalControl?: boolean;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  terminalShortcutLabel: string | null;
  rightPanelAvailable: boolean;
  rightPanelOpen: boolean;
  rightPanelShortcutLabel: string | null;
  rightPanelUnavailableLabel?: string;
  /** Running + waiting subagents in this thread; badges the right panel toggle. */
  liveAgentCount: number;
  /** Latest turn's own task list only; a second, independent badge. Absent renders neither. */
  taskCompletedCount?: number | undefined;
  taskTotalCount?: number | undefined;
  onToggleTerminal: () => void;
  onToggleRightPanel: () => void;
}

export const PanelLayoutControls = memo(function PanelLayoutControls({
  showTerminalControl = true,
  terminalAvailable,
  terminalOpen,
  terminalShortcutLabel,
  rightPanelAvailable,
  rightPanelOpen,
  rightPanelShortcutLabel,
  rightPanelUnavailableLabel = "Right panel is unavailable",
  liveAgentCount,
  taskCompletedCount,
  taskTotalCount,
  onToggleTerminal,
  onToggleRightPanel,
}: PanelLayoutControlsProps) {
  const taskBadgeVisible = taskCompletedCount !== undefined && taskTotalCount !== undefined;
  const taskComplete = taskBadgeVisible && taskCompletedCount === taskTotalCount;
  const statusSuffix = panelToggleLabel({ liveAgentCount, taskCompletedCount, taskTotalCount });
  return (
    <div
      className="flex h-full shrink-0 items-center gap-1 [-webkit-app-region:no-drag]"
      data-panel-layout-controls
    >
      {showTerminalControl ? (
        <Tooltip>
          <TooltipTrigger render={<span className="flex shrink-0" />}>
            <Toggle
              className="shrink-0 [-webkit-app-region:no-drag]"
              pressed={terminalOpen}
              onPressedChange={onToggleTerminal}
              aria-label="Toggle terminal drawer"
              variant="ghost"
              size="sm"
              disabled={!terminalAvailable}
            >
              <PanelBottomIcon className="size-4" />
            </Toggle>
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            {terminalAvailable
              ? `Toggle terminal drawer${terminalShortcutLabel ? ` (${terminalShortcutLabel})` : ""}`
              : "Terminal drawer is unavailable"}
          </TooltipPopup>
        </Tooltip>
      ) : null}
      <Tooltip>
        <TooltipTrigger render={<span className="flex shrink-0" />}>
          <Toggle
            className="shrink-0 [-webkit-app-region:no-drag]"
            pressed={rightPanelOpen}
            onPressedChange={onToggleRightPanel}
            aria-label={statusSuffix ? `Toggle right panel, ${statusSuffix}` : "Toggle right panel"}
            variant="ghost"
            size="sm"
            disabled={!rightPanelAvailable}
          >
            <PanelRightIcon className="size-4" />
            {liveAgentCount > 0 ? (
              <span
                aria-hidden
                data-panel-badge="agents"
                className="absolute -top-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-info px-1 text-[9px] font-semibold tabular-nums text-white"
              >
                {liveAgentCount}
              </span>
            ) : null}
            {taskBadgeVisible ? (
              <span
                aria-hidden
                data-panel-badge="tasks"
                className={cn(
                  "absolute -bottom-1 -left-0.5 flex h-3 min-w-3 items-center justify-center rounded-full bg-success px-[3px] text-[8px] font-bold leading-none tabular-nums text-white",
                  taskComplete && "w-3 px-0",
                )}
              >
                {taskComplete ? "✓" : `${taskCompletedCount}/${taskTotalCount}`}
              </span>
            ) : null}
          </Toggle>
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          {rightPanelAvailable
            ? `Toggle right panel${rightPanelShortcutLabel ? ` (${rightPanelShortcutLabel})` : ""}${
                statusSuffix ? ` · ${statusSuffix}` : ""
              }`
            : rightPanelUnavailableLabel}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
});

export const RightPanelMaximizeControl = memo(function RightPanelMaximizeControl({
  maximized,
  onToggle,
}: {
  maximized: boolean;
  onToggle: () => void;
}) {
  const label = maximized ? "Restore panel size" : "Maximize panel";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            className="shrink-0 [-webkit-app-region:no-drag]"
            pressed={maximized}
            onPressedChange={onToggle}
            aria-label={label}
            variant="ghost"
            size="sm"
          >
            {maximized ? (
              <Minimize2Icon className="size-4" />
            ) : (
              <Maximize2Icon className="size-4" />
            )}
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
});
