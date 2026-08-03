import { memo, useState, useCallback } from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import ChatMarkdown from "./ChatMarkdown";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  EllipsisIcon,
  FileTextIcon,
  LoaderIcon,
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
import { SidebarItemRow, SidebarSection } from "./SidebarSection";
import { useSidebarViewStore } from "../sidebarViewStore";
import {
  isTerminalSidebarStatus,
  type AgentSidebarItem,
  type BackgroundSidebarItem,
} from "../sidebarSections";
import { projectEnvironment } from "~/state/projects";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useAtomCommand } from "~/state/use-atom-command";

function stepStatusIcon(status: string): React.ReactNode {
  if (status === "completed") {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-success/10 text-success-foreground">
        <CheckIcon className="size-3" />
      </span>
    );
  }
  if (status === "inProgress") {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <LoaderIcon className="size-3 animate-spin" />
      </span>
    );
  }
  return (
    <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border/60 bg-muted/30">
      <span className="size-1.5 rounded-full bg-muted-foreground/30" />
    </span>
  );
}

/**
 * Expanded detail for the selected agent: its final summary, a link to any
 * output file it wrote, and the progress log it reported while running.
 */
function AgentDetail({ item }: { item: AgentSidebarItem }) {
  return (
    <div className="mt-1 space-y-2 rounded-lg border border-border/50 bg-muted/10 p-2.5">
      {item.finalSummary ? (
        <p className="text-[12px] leading-relaxed text-foreground/80">{item.finalSummary}</p>
      ) : null}
      {item.outputFile ? (
        <a
          href={`/viewer/${item.outputFile.replace(/^\/+/, "")}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/60 px-2 py-1 text-[11px] text-foreground/80 hover:bg-accent/60"
        >
          <FileTextIcon className="size-3 shrink-0" />
          <span className="truncate">{item.outputFile}</span>
        </a>
      ) : null}
      <div className="space-y-1">
        <p className="text-[10px] font-semibold tracking-widest text-muted-foreground/40 uppercase">
          Log
        </p>
        {item.log.length === 0 ? (
          <p className="text-[11px] text-muted-foreground/40">No progress reported.</p>
        ) : (
          item.log.map((entry) => (
            <div key={entry.id} className="rounded-md bg-muted/20 px-2 py-1">
              {entry.lastToolName ? (
                <span className="mr-1.5 rounded bg-muted/50 px-1 text-[10px] text-muted-foreground/70">
                  {entry.lastToolName}
                </span>
              ) : null}
              <span className="text-[11px] text-foreground/75">{entry.text}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// Stable empty defaults so the memo above does not re-render on every parent pass.
const EMPTY_BACKGROUND_ITEMS: ReadonlyArray<BackgroundSidebarItem> = [];
const EMPTY_AGENT_ITEMS: ReadonlyArray<AgentSidebarItem> = [];

interface PlanSidebarProps {
  activePlan: ActivePlanState | null;
  activeProposedPlan: LatestProposedPlanState | null;
  label?: string;
  environmentId: EnvironmentId;
  threadRef?: ScopedThreadRef | undefined;
  markdownCwd: string | undefined;
  workspaceRoot: string | undefined;
  timestampFormat: TimestampFormat;
  mode?: "sheet" | "sidebar" | "embedded";
  /** Background-process (terminal) items for the active thread, filtered + sorted. */
  backgroundItems?: ReadonlyArray<BackgroundSidebarItem>;
  /** Agent/subagent items for the active thread, filtered + sorted. */
  agentItems?: ReadonlyArray<AgentSidebarItem>;
  /** Reveals a background terminal in the right panel's terminal surface. */
  onOpenBackgroundItem?: ((terminalId: string) => void) | undefined;
}

const PlanSidebar = memo(function PlanSidebar({
  activePlan,
  activeProposedPlan,
  label = "Plan",
  environmentId,
  threadRef,
  markdownCwd,
  workspaceRoot,
  timestampFormat,
  mode = "sidebar",
  backgroundItems = EMPTY_BACKGROUND_ITEMS,
  agentItems = EMPTY_AGENT_ITEMS,
  onOpenBackgroundItem,
}: PlanSidebarProps) {
  const collapsedSections = useSidebarViewStore((state) => state.collapsedSections);
  const toggleSection = useSidebarViewStore((state) => state.toggleSection);
  const selectedDetail = useSidebarViewStore((state) => state.selectedDetail);
  const selectDetail = useSidebarViewStore((state) => state.selectDetail);
  const clearDetail = useSidebarViewStore((state) => state.clearDetail);
  const dismissItem = useSidebarViewStore((state) => state.dismissItem);
  const [proposedPlanExpanded, setProposedPlanExpanded] = useState(false);
  const [isSavingToWorkspace, setIsSavingToWorkspace] = useState(false);
  const writeProjectFile = useAtomCommand(projectEnvironment.writeFile, {
    reportFailure: false,
  });
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "plan" });

  const selectedAgent =
    selectedDetail?.kind === "agent"
      ? (agentItems.find((item) => item.id === selectedDetail.id) ?? null)
      : null;

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
    if (!workspaceRoot || !planMarkdown) return;
    const filename = buildProposedPlanMarkdownFilename(planMarkdown);
    setIsSavingToWorkspace(true);
    void (async () => {
      const result = await writeProjectFile({
        environmentId,
        input: {
          cwd: workspaceRoot,
          relativePath: filename,
          contents: normalizePlanMarkdownForExport(planMarkdown),
        },
      });
      setIsSavingToWorkspace(false);
      if (result._tag === "Success") {
        toastManager.add({
          type: "success",
          title: "Plan saved",
          description: result.value.relativePath,
        });
        return;
      }
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not save plan",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    })();
  }, [environmentId, planMarkdown, workspaceRoot, writeProjectFile]);

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
            variant="info"
            size="sm"
            className="rounded-md px-1.5 py-0 font-semibold tracking-wide uppercase"
          >
            {label}
          </Badge>
          {activePlan ? (
            <span className="text-[11px] text-muted-foreground/60 tabular-nums">
              {formatTimestamp(activePlan.createdAt, timestampFormat)}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
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

          {/* Plan Steps */}
          {activePlan && activePlan.steps.length > 0 ? (
            <div className="space-y-1">
              <p className="mb-2 text-[10px] font-semibold tracking-widest text-muted-foreground/40 uppercase">
                Steps
              </p>
              {activePlan.steps.map((step) => (
                <div
                  key={`${step.status}:${step.step}`}
                  className={cn(
                    "flex items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors duration-200",
                    step.status === "inProgress" && "bg-blue-500/5",
                    step.status === "completed" && "bg-emerald-500/5",
                  )}
                >
                  {stepStatusIcon(step.status)}
                  <p
                    className={cn(
                      "text-[13px] leading-snug",
                      step.status === "completed"
                        ? "text-muted-foreground/50 line-through decoration-muted-foreground/20"
                        : step.status === "inProgress"
                          ? "text-foreground/90"
                          : "text-muted-foreground/70",
                    )}
                  >
                    {step.step}
                  </p>
                </div>
              ))}
            </div>
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
                  selected={false}
                  // Open the real terminal surface rather than a static buffer
                  // dump: the right panel already hosts a live xterm for it.
                  onSelect={() => onOpenBackgroundItem?.(item.id)}
                  onRemove={
                    isTerminalSidebarStatus(item.status) ? () => dismissItem(item.id) : undefined
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
                  onSelect={() =>
                    selectedDetail?.id === item.id
                      ? clearDetail()
                      : selectDetail({ kind: "agent", id: item.id })
                  }
                  onRemove={
                    isTerminalSidebarStatus(item.status) ? () => dismissItem(item.id) : undefined
                  }
                />
              ))}
              {selectedAgent ? <AgentDetail item={selectedAgent} /> : null}
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
                    threadRef={threadRef}
                    isStreaming={false}
                  />
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Empty state */}
          {!activePlan && !planMarkdown ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <p className="text-[13px] text-muted-foreground/40">No active plan yet.</p>
              <p className="mt-1 text-[11px] text-muted-foreground/30">
                Plans will appear here when generated.
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
