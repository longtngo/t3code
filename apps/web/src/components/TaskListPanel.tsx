/**
 * Task list right-panel surface: the thread's primary task list expanded at the top, earlier
 * turns' lists collapsed below it. Reuses the composer drawer's step rows so the two readings
 * never disagree.
 *
 * Props arrive separately rather than as one `TaskListState`, which is a new object every render
 * and would defeat `memo`. Relative times follow the minute clock; nothing animates continuously.
 */
import { ChevronRightIcon, ListTodoIcon } from "lucide-react";
import { memo } from "react";

import { Button } from "~/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { ScrollArea } from "~/components/ui/scroll-area";
import { cn } from "~/lib/utils";
import type { TaskListState } from "../hooks/useTaskList";
import { useNowMinute } from "../hooks/useNowMinute";
import type { ActivePlanState } from "../session-logic";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { ComposerBanner } from "./chat/ComposerBanner";
import { TaskSegments, TaskStepList } from "./chat/TaskStepList";
import {
  taskListCurrentStep,
  taskListHeaderState,
  taskListPanelState,
  type TaskListHeaderChip,
} from "./TaskListPanel.logic";

/**
 * The step rows' grid reads these from `ComposerBanner.Root`, which the panel does not use: Root
 * and Scroll carry the composer's attachment overlap and a height cap a full-height panel must not
 * inherit. Keep in step with Root's own values.
 */
const STEP_ROW_VARIABLES =
  "text-xs/4 [--composer-banner-icon-column:--spacing(7)] [--composer-banner-padding-block:--spacing(1)] sm:[--composer-banner-icon-column:--spacing(6)]";

const CHIP_TONE_CLASSES = {
  live: "border-primary/40 text-primary",
  finished: "border-success/30 text-success",
  stopped: "border-border/60 text-muted-foreground",
  promoted: "border-border/60 text-muted-foreground",
} satisfies Record<TaskListHeaderChip["tone"], string>;

function completedCount(plan: ActivePlanState): number {
  return plan.steps.filter((step) => step.status === "completed").length;
}

function StepList({ plan }: { plan: ActivePlanState }) {
  const completed = completedCount(plan);
  return (
    <ComposerBanner.Children
      render={<ul />}
      aria-label={`Task list. ${completed} of ${plan.steps.length} complete.`}
    >
      <TaskStepList steps={plan.steps} />
    </ComposerBanner.Children>
  );
}

function PanelMessage({
  title,
  detail,
  onRetry,
}: {
  title: string;
  detail?: string;
  onRetry?: (() => void) | undefined;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <ListTodoIcon aria-hidden className="size-6 text-muted-foreground/60" />
      <p className="text-sm font-medium">{title}</p>
      {detail ? <p className="max-w-56 text-xs text-muted-foreground">{detail}</p> : null}
      {onRetry ? (
        <Button size="xs" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

function TaskListHeader({
  primary,
  chip,
}: {
  primary: ActivePlanState;
  chip: TaskListHeaderChip | null;
}) {
  const completed = completedCount(primary);
  const total = primary.steps.length;
  return (
    <header className="flex flex-col gap-1.5 border-b border-border/60 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <ListTodoIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {taskListCurrentStep(primary.steps)?.step}
        </span>
        <span
          className={cn(
            "shrink-0 font-mono text-[.7rem] tabular-nums text-muted-foreground",
            total > 0 && completed === total && "text-success",
          )}
        >
          {completed}/{total} complete
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-2 text-[.7rem] text-muted-foreground">
        {chip ? (
          <span
            className={cn(
              "shrink-0 rounded-sm border px-1.5 py-px font-medium",
              CHIP_TONE_CLASSES[chip.tone],
            )}
          >
            {chip.label}
            {chip.tone === "promoted" && chip.time ? ` · ${chip.time}` : null}
          </span>
        ) : null}
        <TaskSegments className="ml-auto w-20" steps={primary.steps} />
      </div>
    </header>
  );
}

/** One earlier turn's task list, collapsed to its first step, final fraction, and age. */
const TaskHistoryGroup = memo(function TaskHistoryGroup({
  group,
  nowMs,
}: {
  group: ActivePlanState;
  nowMs: number;
}) {
  const completed = completedCount(group);
  const total = group.steps.length;
  return (
    <Collapsible>
      <CollapsibleTrigger className="group/history flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs hover:bg-accent/40">
        <ChevronRightIcon
          aria-hidden
          className="size-3 shrink-0 text-muted-foreground/60 group-data-[panel-open]/history:rotate-90"
        />
        <span className="min-w-0 flex-1 truncate">{group.steps[0]?.step}</span>
        <span
          className={cn(
            "shrink-0 font-mono text-[.7rem] tabular-nums",
            completed === total ? "text-muted-foreground" : "text-muted-foreground/60",
          )}
        >
          {completed}/{total}
        </span>
        <span className="w-14 shrink-0 text-right text-[.7rem] text-muted-foreground/70">
          {formatRelativeTimeLabel(group.createdAt, nowMs)}
        </span>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <StepList plan={group} />
      </CollapsiblePanel>
    </Collapsible>
  );
});

export const TaskListPanel = memo(function TaskListPanel({
  primary,
  primaryKind,
  history,
  historyStatus,
  onRetry,
  latestTurnRunning,
}: {
  primary: TaskListState["primary"];
  primaryKind: TaskListState["primaryKind"];
  history: TaskListState["history"];
  historyStatus: TaskListState["historyStatus"];
  onRetry: () => void;
  /** Whether the thread's latest turn is still running; only the latest turn's plan can be live. */
  latestTurnRunning: boolean;
}) {
  const nowMinute = useNowMinute();
  const nowMs = Date.parse(`${nowMinute}:00.000Z`);
  const state = taskListPanelState(primary, historyStatus);

  if (state.kind === "unavailable") {
    return (
      <PanelMessage
        title="Task history unavailable"
        detail="This thread's task lists could not be loaded."
        onRetry={state.canRetry ? onRetry : undefined}
      />
    );
  }
  if (state.kind === "loading") {
    return <PanelMessage title="Loading task lists…" />;
  }
  if (state.kind === "empty" || primary === null) {
    return (
      <PanelMessage
        title="No task list yet"
        detail="The agent hasn't written a plan for this thread."
      />
    );
  }

  const chip = taskListHeaderState(primary, primaryKind, latestTurnRunning, nowMs);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <TaskListHeader primary={primary} chip={chip} />
      <ScrollArea className="min-h-0 flex-1">
        <div className={cn("flex flex-col gap-2 p-2", STEP_ROW_VARIABLES)}>
          <StepList plan={primary} />
          {history.length > 0 ? (
            <section className="flex flex-col gap-0.5 pt-2">
              <div className="px-1.5 pb-1 text-[.65rem] font-medium uppercase tracking-wider text-muted-foreground">
                Earlier in this thread
              </div>
              {history.map((group) => (
                <TaskHistoryGroup
                  key={group.turnId ?? group.createdAt}
                  group={group}
                  nowMs={nowMs}
                />
              ))}
              <p className="px-1.5 pt-1 text-[.7rem] text-muted-foreground/70">
                Earlier turns are kept for 3 hours.
              </p>
            </section>
          ) : null}
          {state.historyFailed ? (
            <div className="flex items-center gap-2 px-1.5 pt-2 text-xs text-muted-foreground">
              <span className="min-w-0 flex-1">Couldn't load earlier task lists</span>
              <Button size="xs" variant="outline" onClick={onRetry}>
                Retry
              </Button>
            </div>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
});
