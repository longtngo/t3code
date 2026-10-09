/**
 * Tasks section of the thread details card: the thread's primary task list windowed to the
 * card's row limit, earlier runs' lists folded below it. Step rows come from `TaskStepList`;
 * data comes from `deriveTaskListView` over the thread's v2 plans.
 *
 * Relative times follow the minute clock; nothing animates continuously.
 */
import { ChevronRightIcon } from "lucide-react";
import { memo } from "react";

import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { cn } from "~/lib/utils";
import { useNowMinute } from "../hooks/useNowMinute";
import type { ActivePlanState } from "../session-logic";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { ComposerBanner } from "./chat/ComposerBanner";
import { TaskSegments, TaskStepList } from "./chat/TaskStepList";
import { ThreadDetailsRowGroup } from "./chat/ThreadDetailsRowGroup";
import { ThreadDetailsSection } from "./chat/ThreadDetailsSection";
import {
  taskListHeaderState,
  type TaskListEntry,
  type TaskListHeaderChip,
  type TaskListView,
} from "./TaskListPanel.logic";

/**
 * The step rows' grid reads these from `ComposerBanner.Root`, which the panel does not use: Root
 * and Scroll carry the composer's attachment overlap and a height cap a card section must not
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

/** `steps` are the rows to show; the label counts the whole of `plan`. */
function StepList({
  plan,
  steps = plan.steps,
}: {
  plan: ActivePlanState;
  steps?: ReadonlyArray<ActivePlanState["steps"][number]>;
}) {
  return (
    <ComposerBanner.Children
      render={<ul />}
      aria-label={`Task list. ${completedCount(plan)} of ${plan.steps.length} complete.`}
    >
      <TaskStepList steps={steps} />
    </ComposerBanner.Children>
  );
}

/** One earlier run's task list, collapsed to its first step, final fraction, and age. */
const TaskHistoryGroup = memo(function TaskHistoryGroup({
  group,
  nowMs,
}: {
  group: TaskListEntry;
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
            "shrink-0 font-mono text-2xs tabular-nums",
            completed === total ? "text-muted-foreground" : "text-muted-foreground/60",
          )}
        >
          {completed}/{total}
        </span>
        <span className="w-14 shrink-0 text-right text-2xs text-muted-foreground/70">
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
  threadKey,
  primary,
  primaryKind,
  history,
  latestRunActive,
}: {
  threadKey: string;
  primary: TaskListEntry | null;
  primaryKind: TaskListView["primaryKind"];
  history: ReadonlyArray<TaskListEntry>;
  /** Whether the thread's activity run is still working; only its own list can be live. */
  latestRunActive: boolean;
}) {
  const nowMinute = useNowMinute();
  const nowMs = Date.parse(`${nowMinute}:00.000Z`);
  if (primary === null) return null;
  const chip = taskListHeaderState(primary, primaryKind, latestRunActive, nowMs);
  const completed = completedCount(primary);
  const runningIndex = primary.steps.findIndex((step) => step.status === "inProgress");
  const currentIndex =
    runningIndex >= 0 ? runningIndex : primary.steps.findIndex((step) => step.status === "pending");
  return (
    <ThreadDetailsSection
      headingId="thread-details-tasks-heading"
      title={`Tasks · ${completed}/${primary.steps.length}`}
      data-thread-details-activity
      actions={
        <>
          {chip ? (
            <span
              className={cn(
                "shrink-0 rounded-sm border px-1.5 py-px text-2xs font-medium",
                CHIP_TONE_CLASSES[chip.tone],
              )}
            >
              {chip.label}
              {chip.tone === "promoted" && chip.time ? ` · ${chip.time}` : null}
            </span>
          ) : null}
          <TaskSegments className="w-16" steps={primary.steps} />
        </>
      }
    >
      <div className={cn("flex flex-col gap-1", STEP_ROW_VARIABLES)}>
        <ThreadDetailsRowGroup
          key={`${threadKey}:${primary.groupKey}`}
          rows={primary.steps}
          minVisible={currentIndex + 1}
        >
          {(steps) => <StepList plan={primary} steps={steps} />}
        </ThreadDetailsRowGroup>
        <ThreadDetailsRowGroup
          key={`${threadKey}:history`}
          label="Previous task lists"
          rows={history}
        >
          {(groups) =>
            groups.map((group) => (
              <TaskHistoryGroup key={group.groupKey} group={group} nowMs={nowMs} />
            ))
          }
        </ThreadDetailsRowGroup>
      </div>
    </ThreadDetailsSection>
  );
});
