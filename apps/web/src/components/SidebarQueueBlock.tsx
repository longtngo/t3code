import { useDroppable } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { ChevronDownIcon, PauseIcon, PlayIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../lib/utils";
import {
  threadQueueEntryKey,
  useThreadQueueStore,
  type ThreadQueueEntry,
} from "../threadQueueStore";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export const QUEUE_DROP_ID = "sidebar-queue-drop";
export const QUEUE_EXPANDED_KEY = "t3code:sidebar:queue-expanded";

export type QueueRowSortableBag = Pick<
  ReturnType<typeof useSortable>,
  "listeners" | "setNodeRef" | "transform" | "transition" | "isDragging"
>;

function SortableQueueRow(props: {
  id: string;
  children: (bag: QueueRowSortableBag) => ReactNode;
}) {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.id,
  });
  return props.children({ listeners, setNodeRef, transform, transition, isDragging });
}

/**
 * The Queue section: threads waiting to send once Active is done. Rows reorder
 * in the parent drag context; a row dragged from Active drops on the header.
 */
export function SidebarQueueBlock(props: {
  /** Entries in queue order, already filtered to those this sidebar can show. */
  entries: ReadonlyArray<ThreadQueueEntry>;
  routeKey: string | null;
  routeDraftId: string | null;
  expanded: boolean;
  onToggleExpanded: () => void;
  /** True while a thread from the main list is being dragged. */
  dragging: boolean;
  renderEntry: (entry: ThreadQueueEntry, sortable: QueueRowSortableBag) => ReactNode;
}) {
  const paused = useThreadQueueStore((state) => state.paused);
  const lastFailure = useThreadQueueStore((state) => state.lastFailure);
  const setPaused = useThreadQueueStore((state) => state.setPaused);
  const { expanded, onToggleExpanded: toggleExpanded } = props;
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: QUEUE_DROP_ID });
  const keys = props.entries.map(threadQueueEntryKey);

  if (props.entries.length === 0 && !props.dragging) return null;
  const visibleEntries = expanded
    ? props.entries
    : props.entries.filter(
        (entry) =>
          threadQueueEntryKey(entry) === props.routeKey ||
          (entry.draftId !== null && entry.draftId === props.routeDraftId),
      );
  const label =
    expanded || props.entries.length === 0 ? "Queue" : `Queue (${props.entries.length})`;

  return (
    <>
      <li
        ref={setDropRef}
        className={cn(
          "mx-0.5 h-8 list-none rounded-md",
          props.dragging && "border border-dashed border-sidebar-foreground/25",
          isOver && "border-primary/40 bg-primary/5",
        )}
        data-testid="sidebar-queue-header"
      >
        <div className="flex h-full w-full items-center gap-2 px-2 text-xs font-medium text-sidebar-muted-foreground/60">
          <button
            type="button"
            onClick={toggleExpanded}
            aria-expanded={expanded}
            data-testid="sidebar-queue-toggle"
            className={cn(
              "flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left",
              isOver && "text-primary",
            )}
          >
            <span className="shrink-0">{label}</span>
            {paused ? (
              <span className="min-w-0 truncate text-amber-600 dark:text-amber-400">
                {lastFailure ? `Paused: ${lastFailure.title} failed` : "Paused"}
              </span>
            ) : null}
            <span aria-hidden className="h-px min-w-2 flex-1 bg-sidebar-border/60" />
            <ChevronDownIcon
              aria-hidden
              className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-180")}
            />
          </button>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={paused ? "Resume queue" : "Pause queue"}
                  data-testid="sidebar-queue-pause"
                  onClick={() => setPaused(!paused)}
                  className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                >
                  {paused ? <PlayIcon className="size-3" /> : <PauseIcon className="size-3" />}
                </button>
              }
            />
            <TooltipPopup side="top">
              {paused && lastFailure
                ? lastFailure.message
                : paused
                  ? "Resume queue"
                  : "Pause queue"}
            </TooltipPopup>
          </Tooltip>
        </div>
      </li>
      {visibleEntries.length > 0 ? (
        <SortableContext items={keys} strategy={verticalListSortingStrategy}>
          {visibleEntries.map((entry) => {
            const key = threadQueueEntryKey(entry);
            return (
              <SortableQueueRow key={key} id={key}>
                {(bag) => props.renderEntry(entry, bag)}
              </SortableQueueRow>
            );
          })}
        </SortableContext>
      ) : null}
    </>
  );
}
