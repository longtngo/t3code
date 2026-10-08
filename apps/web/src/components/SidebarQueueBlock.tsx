import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronDownIcon, PauseIcon, PlayIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../lib/utils";
import {
  animateSidebarLayoutChanges,
  sidebarQueueRowDragDisabled,
  type SidebarOptimisticDrop,
} from "./Sidebar.logic";
import { threadQueueEntryKey, type ThreadQueueEntry } from "../threadQueueRules";
import { queueDeviceId, useThreadQueueStore } from "../threadQueueStore";
import { QueueSlotsControl, useQueueSlots } from "./QueueSlotsControl";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export const QUEUE_DROP_ID = "sidebar-queue-drop";
export const QUEUE_EXPANDED_KEY = "t3code:sidebar:queue-expanded";
/** Only the device that queued an entry holds its draft, so only it sends. */
const QUEUED_ON_ANOTHER_DEVICE = "Queued on another device";
/** The same note where it shares a thread row with the branch; the full one is its tooltip. */
export const QUEUED_ON_ANOTHER_DEVICE_SHORT = "Other device";

export const queuedOnAnotherDevice = (entry: ThreadQueueEntry) =>
  entry.ownerId === queueDeviceId() ? null : QUEUED_ON_ANOTHER_DEVICE;

export type QueueRowSortableBag = Pick<
  ReturnType<typeof useSortable>,
  "listeners" | "setNodeRef" | "transform" | "transition" | "isDragging"
>;

function SortableQueueRow(props: {
  id: string;
  /** The header's preview shift, added to the row's own sortable transform. */
  shiftY: number;
  heldDrop: SidebarOptimisticDrop | null;
  children: (bag: QueueRowSortableBag) => ReactNode;
}) {
  const readOnly = useThreadQueueStore((state) => state.readOnly);
  const disabled = sidebarQueueRowDragDisabled({ readOnly, drop: props.heldDrop });
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.id,
    disabled,
  });
  const shifted =
    props.shiftY === 0
      ? transform
      : { x: 0, scaleX: 1, scaleY: 1, ...transform, y: (transform?.y ?? 0) + props.shiftY };
  return props.children({ listeners, setNodeRef, transform: shifted, transition, isDragging });
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
  /** Show the header alone: the drag preview needs the room the rows occupy. */
  collapse: boolean;
  /** The sidebar drop still waiting to land, or null. */
  heldDrop: SidebarOptimisticDrop | null;
  /** `note` is a line the row shows under its title, or null. */
  renderEntry: (
    entry: ThreadQueueEntry,
    sortable: QueueRowSortableBag,
    note: string | null,
  ) => ReactNode;
}) {
  const paused = useThreadQueueStore((state) => state.paused);
  const lastFailure = useThreadQueueStore((state) => state.lastFailure);
  const setPaused = useThreadQueueStore((state) => state.setPaused);
  const readOnly = useThreadQueueStore((state) => state.readOnly);
  const queueSlots = useQueueSlots();
  const { expanded, onToggleExpanded: toggleExpanded } = props;
  // A drop zone listed after the rows in the main sortable context (`sidebarSortableIds`), never
  // lifted. The drag preview moves it with the content above it, and the rows below follow it, or
  // previewed rows cover its zone.
  const {
    setNodeRef: setDropRef,
    isOver,
    transform,
    transition,
  } = useSortable({
    id: QUEUE_DROP_ID,
    disabled: { draggable: true, droppable: readOnly },
    animateLayoutChanges: animateSidebarLayoutChanges,
  });
  const shiftY = transform?.y ?? 0;
  const keys = props.entries.map(threadQueueEntryKey);

  // A paused Queue keeps its header even when empty: a thread queued later waits under the pause.
  if (props.entries.length === 0 && !props.dragging && !paused) return null;
  const routeEntry = (entry: ThreadQueueEntry) =>
    threadQueueEntryKey(entry) === props.routeKey ||
    (entry.draftId !== null && entry.draftId === props.routeDraftId);
  // A main-list drag collapses the Queue to its header: the rows would otherwise sit under the
  // space the drag preview opens above them, and the freed height keeps the header clear. The open
  // thread keeps its row, as it does in a collapsed Queue.
  const visibleEntries =
    props.collapse || !expanded ? props.entries.filter(routeEntry) : props.entries;
  // The count stands in for the rows whenever they are not all on screen — collapsed by the user,
  // or collapsed for the drag.
  const label =
    (expanded && !props.collapse) || props.entries.length === 0
      ? "Queue"
      : `Queue (${props.entries.length})`;

  return (
    <>
      <li
        ref={setDropRef}
        className={cn(
          // The header is the drop target for a drag from the main list, matched by a strict
          // pointer-inside-its-rect test with no tolerance. That test resolves against the LIVE
          // rect (see Sidebar.drag.ts), so a stale or short measurement cannot decide it, and a
          // shrink-0 guard tried here measured inert: the column's height is content-driven and the
          // scroller absorbs the overflow, so the header holds 32px at every viewport height
          // sampled, at rest and mid-drag.
          "mx-0.5 h-8 list-none rounded-md",
          // Pushed into the empty space below the rows while a main-list drag runs: the preview
          // opens space where the Queue sits, and a zone that moves with it is a target the
          // pointer chases. It shares the free space with the shelves' own auto margin.
          // Above the sorting preview AND opaque. The preview moves rows by TRANSFORM, which cannot
          // push this header aside: it only takes the shift of the content above it, never a row's
          // room. So whenever the list already scrolls at drag start the collapse below is skipped, the header
          // stays inline under the last Active row, and a shifted row lands on top of it - covering
          // 810 of 810 sampled header pixels and 100% of the Queue toggle.
          //
          // `z-20` beats the transformed li, which is its own stacking context (NOT the row card's
          // `z-10`, which that context already caps). But z alone only wins the HIT TEST: both
          // elements are transparent, so the row's title still rendered across the drop zone and the
          // leaked ink barely moved. `bg-sidebar` is what actually hides it - and it must stay a
          // whole token, since `bg-sidebar/50` is see-through and defeated both gates written for
          // this.
          props.dragging &&
            "relative z-20 border border-dashed border-sidebar-foreground/25 bg-sidebar",
          props.collapse && "mt-auto",
          isOver && "border-primary/40 bg-primary/5",
        )}
        data-testid="sidebar-queue-header"
        style={{ transform: CSS.Translate.toString(transform), transition }}
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
            {paused || queueSlots.total === 0 ? (
              <span className="min-w-0 truncate text-warning-foreground">
                {lastFailure ? `Paused: ${lastFailure.title} failed` : "Paused"}
              </span>
            ) : null}
            <span aria-hidden className="h-px min-w-2 flex-1 bg-sidebar-border/60" />
            <ChevronDownIcon
              aria-hidden
              className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-180")}
            />
          </button>
          <QueueSlotsControl {...queueSlots} />
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={paused ? "Resume queue" : "Pause queue"}
                  data-testid="sidebar-queue-pause"
                  disabled={readOnly}
                  onClick={() => setPaused(!paused)}
                  className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md hover:bg-sidebar-row-hover hover:text-sidebar-foreground disabled:pointer-events-none disabled:opacity-50"
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
              <SortableQueueRow key={key} id={key} shiftY={shiftY} heldDrop={props.heldDrop}>
                {(bag) => props.renderEntry(entry, bag, queuedOnAnotherDevice(entry))}
              </SortableQueueRow>
            );
          })}
        </SortableContext>
      ) : null}
    </>
  );
}

/**
 * A queued row this device cannot open: a draft on another device, or a thread it cannot see (its
 * own entry while shells load, or one in a disconnected environment).
 */
export function ForeignQueueRow(props: {
  entry: ThreadQueueEntry;
  sortable: QueueRowSortableBag;
  isOverlayCopy?: boolean | undefined;
}) {
  const readOnly = useThreadQueueStore((state) => state.readOnly);
  const remove = useThreadQueueStore((state) => state.remove);
  const { sortable } = props;
  return (
    <li
      className={cn(
        "list-none py-0.5",
        props.isOverlayCopy === true && "relative z-20 rounded-md bg-sidebar shadow-lg",
      )}
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Translate.toString(sortable.transform),
        transition: sortable.transition,
      }}
      {...sortable.listeners}
      data-testid="sidebar-queue-foreign-row"
    >
      <div
        className={cn(
          "flex items-center gap-2 rounded-md px-2 py-1 text-sidebar-foreground",
          sortable.isDragging && props.isOverlayCopy !== true && "opacity-40",
        )}
      >
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm">{props.entry.label ?? "Untitled"}</div>
          <div className="truncate text-xs text-sidebar-muted-foreground/60">
            {queuedOnAnotherDevice(props.entry) ?? "Not available on this device"}
          </div>
        </div>
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label="Remove from queue"
          disabled={readOnly}
          onClick={() => remove(threadQueueEntryKey(props.entry))}
        >
          <XIcon />
        </Button>
      </div>
    </li>
  );
}
