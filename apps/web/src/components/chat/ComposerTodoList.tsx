import { memo } from "react";
import * as Schema from "effect/Schema";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import type { ActivePlanState } from "../../session-logic";
import { stepRowClass, stepStatusIcon, stepTextClass } from "../PlanSidebar";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";

const TODO_LIST_OPEN_KEY = "t3code:composer-todo-list-open";

interface ComposerTodoListProps {
  // Caller guarantees a non-empty plan (it also drives the composer's padding).
  readonly activePlan: ActivePlanState;
  readonly hasComposerHeader: boolean;
}

// Memoized: the composer re-renders on every keystroke, while activePlan only
// changes when a plan event lands.
export const ComposerTodoList = memo(function ComposerTodoList({
  activePlan,
  hasComposerHeader,
}: ComposerTodoListProps) {
  const [open, setOpen] = useLocalStorage(TODO_LIST_OPEN_KEY, true, Schema.Boolean);

  const completedCount = activePlan.steps.filter((step) => step.status === "completed").length;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn(
        "border-b border-border/65 bg-muted/20",
        !hasComposerHeader && "rounded-t-[19px]",
      )}
      data-chat-composer-todo-list="true"
    >
      <CollapsibleTrigger className="group/todo-trigger flex w-full items-center gap-1.5 px-3 py-2 text-left sm:px-4">
        {open ? (
          <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground/40" />
        ) : (
          <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/40" />
        )}
        <span className="text-[10px] font-semibold tracking-widest text-muted-foreground/40 uppercase group-hover/todo-trigger:text-muted-foreground/60">
          To do list {completedCount}/{activePlan.steps.length}
        </span>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="max-h-48 space-y-0.5 overflow-y-auto px-3 pb-2 sm:px-4">
          {activePlan.steps.map((step, index) => (
            <div
              key={index}
              className={cn("flex items-start gap-2 px-1.5 py-1", stepRowClass(step.status))}
            >
              <div className="mt-0.5">{stepStatusIcon(step.status)}</div>
              <p className={cn("min-w-0 flex-1", stepTextClass(step.status))}>
                <span className="mr-1.5 tabular-nums text-muted-foreground/40">{index + 1}.</span>
                {step.step}
              </p>
            </div>
          ))}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
});
