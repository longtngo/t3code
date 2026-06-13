import { memo, useState, useCallback, useMemo } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import ChatMarkdown from "./ChatMarkdown";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  EllipsisIcon,
  EraserIcon,
  LoaderIcon,
  PanelRightCloseIcon,
} from "lucide-react";
import { cn } from "~/lib/utils";
import type { ActivePlanState } from "../session-logic";
import type { LatestProposedPlanState } from "../session-logic";
import { formatTimestamp } from "../timestampFormat";
import {
  proposedPlanTitle,
  buildProposedPlanMarkdownFilename,
  normalizePlanMarkdownForExport,
  downloadPlanAsTextFile,
  stripDisplayedPlanMarkdown,
} from "../proposedPlan";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { readEnvironmentApi } from "~/environmentApi";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { SidebarItemRow, SidebarSection, statusGlyph } from "./SidebarSection";
import { useSidebarViewStore } from "../sidebarViewStore";
import {
  isTerminalSidebarStatus,
  planStepDismissKey,
  type AgentSidebarItem,
  type BackgroundSidebarItem,
} from "../sidebarSections";

// Plan steps render active-first, completed sunk to the bottom (stable within
// each group), matching the background/agent sections.
function orderPlanSteps<T extends { status: string }>(steps: ReadonlyArray<T>): T[] {
  const active = steps.filter((step) => step.status !== "completed");
  const completed = steps.filter((step) => step.status === "completed");
  return [...active, ...completed];
}

// Row chrome for plan steps, kept as standalone helpers for reuse and testing.
export function stepRowClass(status: string): string {
  return cn(
    "rounded-lg transition-colors duration-200",
    status === "inProgress" && "bg-blue-500/5",
    status === "completed" && "bg-emerald-500/5",
  );
}

export function stepTextClass(status: string): string {
  return cn(
    "text-[13px] leading-snug",
    status === "completed"
      ? "text-muted-foreground/50 line-through decoration-muted-foreground/20"
      : status === "inProgress"
        ? "text-foreground/90"
        : "text-muted-foreground/70",
  );
}

export function stepStatusIcon(status: string): React.ReactNode {
  return statusGlyph(
    status === "completed" ? "completed" : status === "inProgress" ? "running" : "idle",
  );
}

interface PlanSidebarProps {
  activePlan: ActivePlanState | null;
  activeProposedPlan: LatestProposedPlanState | null;
  /** Background-process (terminal) items for the active thread, already filtered + sorted. */
  backgroundItems: ReadonlyArray<BackgroundSidebarItem>;
  /** Agent/subagent items for the active thread, already filtered + sorted. */
  agentItems: ReadonlyArray<AgentSidebarItem>;
  label?: string;
  environmentId: EnvironmentId;
  markdownCwd: string | undefined;
  workspaceRoot: string | undefined;
  timestampFormat: TimestampFormat;
  mode?: "sheet" | "sidebar";
  onClose: () => void;
}

const PlanSidebar = memo(function PlanSidebar({
  activePlan,
  activeProposedPlan,
  backgroundItems,
  agentItems,
  label = "Plan",
  environmentId,
  markdownCwd,
  workspaceRoot,
  timestampFormat,
  mode = "sidebar",
  onClose,
}: PlanSidebarProps) {
  const [proposedPlanExpanded, setProposedPlanExpanded] = useState(false);
  const [isSavingToWorkspace, setIsSavingToWorkspace] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const collapsedSections = useSidebarViewStore((state) => state.collapsedSections);
  const toggleSection = useSidebarViewStore((state) => state.toggleSection);
  const selectedDetail = useSidebarViewStore((state) => state.selectedDetail);
  const selectDetail = useSidebarViewStore((state) => state.selectDetail);
  const dismissItem = useSidebarViewStore((state) => state.dismissItem);
  const dismissItems = useSidebarViewStore((state) => state.dismissItems);
  const clearDetail = useSidebarViewStore((state) => state.clearDetail);
  const dismissedIds = useSidebarViewStore((state) => state.dismissedIds);
  const orderedSteps = activePlan ? orderPlanSteps(activePlan.steps) : [];
  const visibleSteps = useMemo(
    () => orderedSteps.filter((step) => !dismissedIds[planStepDismissKey(step.step)]),
    [dismissedIds, orderedSteps],
  );
  const hasAnyContent =
    visibleSteps.length > 0 ||
    backgroundItems.length > 0 ||
    agentItems.length > 0 ||
    activeProposedPlan != null;

  const planMarkdown = activeProposedPlan?.planMarkdown ?? null;
  const displayedPlanMarkdown = planMarkdown ? stripDisplayedPlanMarkdown(planMarkdown) : null;
  const planTitle = planMarkdown ? proposedPlanTitle(planMarkdown) : null;

  const handleCopyPlan = useCallback(() => {
    if (!planMarkdown) return;
    copyToClipboard(planMarkdown);
  }, [planMarkdown, copyToClipboard]);

  const handleDownload = useCallback(() => {
    if (!planMarkdown) return;
    const filename = buildProposedPlanMarkdownFilename(planMarkdown);
    downloadPlanAsTextFile(filename, normalizePlanMarkdownForExport(planMarkdown));
  }, [planMarkdown]);

  const handleSaveToWorkspace = useCallback(() => {
    const api = readEnvironmentApi(environmentId);
    if (!api || !workspaceRoot || !planMarkdown) return;
    const filename = buildProposedPlanMarkdownFilename(planMarkdown);
    setIsSavingToWorkspace(true);
    void api.projects
      .writeFile({
        cwd: workspaceRoot,
        relativePath: filename,
        contents: normalizePlanMarkdownForExport(planMarkdown),
      })
      .then((result) => {
        toastManager.add({
          type: "success",
          title: "Plan saved",
          description: result.relativePath,
        });
      })
      .catch((error) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not save plan",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      })
      .then(
        () => setIsSavingToWorkspace(false),
        () => setIsSavingToWorkspace(false),
      );
  }, [environmentId, planMarkdown, workspaceRoot]);

  const handleClearCompleted = useCallback(() => {
    const ids: string[] = [
      ...backgroundItems
        .filter((item) => isTerminalSidebarStatus(item.status))
        .map((item) => item.id),
      ...agentItems.filter((item) => isTerminalSidebarStatus(item.status)).map((item) => item.id),
      ...visibleSteps
        .filter((step) => step.status === "completed")
        .map((step) => planStepDismissKey(step.step)),
    ];
    dismissItems(ids);
  }, [agentItems, backgroundItems, dismissItems, visibleSteps]);

  const handleForceClearAll = useCallback(() => {
    const ids: string[] = [
      ...backgroundItems.map((item) => item.id),
      ...agentItems.map((item) => item.id),
      ...visibleSteps.map((step) => planStepDismissKey(step.step)),
    ];
    dismissItems(ids);
    clearDetail();
  }, [agentItems, backgroundItems, clearDetail, dismissItems, visibleSteps]);

  const showClearControls =
    backgroundItems.length > 0 || agentItems.length > 0 || visibleSteps.length > 0;

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col bg-card/50",
        mode === "sidebar"
          ? "h-full w-[340px] shrink-0 border-l border-border/70"
          : "h-full w-full",
      )}
    >
      {/* Header */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/60 px-3">
        <div className="flex items-center gap-2">
          <Badge
            variant="secondary"
            className="rounded-md bg-blue-500/10 px-1.5 py-0 text-[10px] font-semibold tracking-wide text-blue-400 uppercase"
          >
            {label}
          </Badge>
          {activePlan?.steps.some((step) => step.status === "inProgress") ? (
            <LoaderIcon className="size-3 animate-spin text-blue-400" aria-label="Task in progress" />
          ) : null}
          {activePlan ? (
            <span className="text-[11px] text-muted-foreground/60">
              {formatTimestamp(activePlan.createdAt, timestampFormat)}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          {showClearControls ? (
            <div className="flex items-center">
              <Button
                size="xs"
                variant="ghost"
                onClick={handleClearCompleted}
                aria-label="Clear completed items"
                className="h-7 rounded-r-none px-2 text-[11px] text-muted-foreground/50 hover:text-foreground/70"
              >
                <EraserIcon className="size-3" />
                Clear
              </Button>
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      className="h-7 w-5 rounded-l-none border-l border-border/40 text-muted-foreground/50 hover:text-foreground/70"
                      aria-label="More clear options"
                    />
                  }
                >
                  <ChevronDownIcon className="size-3" />
                </MenuTrigger>
                <MenuPopup align="end">
                  <MenuItem onClick={handleForceClearAll}>Force clear all</MenuItem>
                </MenuPopup>
              </Menu>
            </div>
          ) : null}
          {planMarkdown ? (
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="text-muted-foreground/50 hover:text-foreground/70"
                    aria-label="Plan actions"
                  />
                }
              >
                <EllipsisIcon className="size-3.5" />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem onClick={handleCopyPlan}>
                  {isCopied ? "Copied!" : "Copy to clipboard"}
                </MenuItem>
                <MenuItem onClick={handleDownload}>Download as markdown</MenuItem>
                <MenuItem
                  onClick={handleSaveToWorkspace}
                  disabled={!workspaceRoot || isSavingToWorkspace}
                >
                  Save to workspace
                </MenuItem>
              </MenuPopup>
            </Menu>
          ) : null}
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={onClose}
            aria-label={`Close ${label.toLowerCase()} sidebar`}
            className="text-muted-foreground/50 hover:text-foreground/70"
          >
            <PanelRightCloseIcon className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* Content */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-3 space-y-4">
          {/* Explanation */}
          {activePlan?.explanation ? (
            <p className="text-[13px] leading-relaxed text-muted-foreground/80">
              {activePlan.explanation}
            </p>
          ) : null}

          {/* Tasks */}
          {visibleSteps.length > 0 ? (
            <SidebarSection
              title="Tasks"
              count={visibleSteps.length}
              collapsed={collapsedSections.tasks}
              onToggle={() => toggleSection("tasks")}
            >
              {visibleSteps.map((step) => (
                <div
                  key={`${step.status}:${step.step}`}
                  className={cn("flex items-start gap-2.5 px-2.5 py-2", stepRowClass(step.status))}
                >
                  <div className="mt-0.5">{stepStatusIcon(step.status)}</div>
                  <p className={stepTextClass(step.status)}>{step.step}</p>
                </div>
              ))}
            </SidebarSection>
          ) : null}

          {/* Background processes (terminal sessions) */}
          {backgroundItems.length > 0 ? (
            <SidebarSection
              title="Background processes"
              count={backgroundItems.length}
              collapsed={collapsedSections.background}
              onToggle={() => toggleSection("background")}
            >
              {backgroundItems.map((item) => (
                <SidebarItemRow
                  key={item.id}
                  status={item.status}
                  label={item.label}
                  detail={item.cwd}
                  selected={selectedDetail?.id === item.id}
                  onSelect={() => selectDetail({ kind: "background", id: item.id })}
                  onRemove={
                    isTerminalSidebarStatus(item.status)
                      ? () => dismissItem(item.id)
                      : undefined
                  }
                />
              ))}
            </SidebarSection>
          ) : null}

          {/* Agents / subagents */}
          {agentItems.length > 0 ? (
            <SidebarSection
              title="Agents"
              count={agentItems.length}
              collapsed={collapsedSections.agents}
              onToggle={() => toggleSection("agents")}
            >
              {agentItems.map((item) => (
                <SidebarItemRow
                  key={item.id}
                  status={item.status}
                  label={item.label}
                  detail={item.finalSummary ?? item.log.at(-1)?.text}
                  selected={selectedDetail?.id === item.id}
                  onSelect={() => selectDetail({ kind: "agent", id: item.id })}
                  onRemove={
                    isTerminalSidebarStatus(item.status)
                      ? () => dismissItem(item.id)
                      : undefined
                  }
                />
              ))}
            </SidebarSection>
          ) : null}

          {/* Proposed Plan Markdown */}
          {planMarkdown ? (
            <div className="space-y-2">
              <button
                type="button"
                className="group flex w-full items-center gap-1.5 text-left"
                onClick={() => setProposedPlanExpanded((v) => !v)}
              >
                {proposedPlanExpanded ? (
                  <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground/40 transition-transform" />
                ) : (
                  <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/40 transition-transform" />
                )}
                <span className="text-[10px] font-semibold tracking-widest text-muted-foreground/40 uppercase group-hover:text-muted-foreground/60">
                  {planTitle ?? "Full Plan"}
                </span>
              </button>
              {proposedPlanExpanded ? (
                <div className="rounded-lg border border-border/50 bg-background/50 p-3">
                  <ChatMarkdown
                    text={displayedPlanMarkdown ?? ""}
                    cwd={markdownCwd}
                    isStreaming={false}
                  />
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Empty state */}
          {!hasAnyContent ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <p className="text-[13px] text-muted-foreground/40">Nothing active yet.</p>
              <p className="mt-1 text-[11px] text-muted-foreground/30">
                Plans, background processes, and agents will appear here.
              </p>
            </div>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
});

export default PlanSidebar;
export type { PlanSidebarProps };
