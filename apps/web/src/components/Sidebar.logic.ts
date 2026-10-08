import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { resolveThreadWorkingStartedAt } from "@t3tools/client-runtime/state/models";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { threadPullRequestSearchTerms } from "@t3tools/shared/threadPullRequests";
import * as React from "react";
import {
  isAtomCommandInterrupted,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { defaultAnimateLayoutChanges, type AnimateLayoutChanges } from "@dnd-kit/sortable";
import { threadSearchMatchKey } from "@t3tools/client-runtime/state/thread-search";
import type { ContextMenuItem, EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { SidebarProjectSortOrder, SidebarThreadSortOrder } from "@t3tools/contracts/settings";
import type { AsyncResult } from "effect/reactivity";
import { planPinnedReorder } from "@t3tools/client-runtime/state/thread-sort";
import {
  effectiveSnoozed,
  resolveSnoozePresets,
  type ThreadSnoozeShell,
} from "@t3tools/client-runtime/state/thread-settled";
import {
  getThreadSortTimestamp,
  sortThreads,
  toSortableTimestamp,
  type ThreadSortInput,
} from "../lib/threadSort";
import type { SidebarThreadSummary, Thread } from "../types";
import { cn } from "../lib/utils";
import { threadQueueEntryKey } from "../threadQueueRules";
import { isLatestRunSettled } from "../session-logic";
import { resolveServerBackedAppStageLabel } from "../branding.logic";

export function shouldNavigateAfterThreadPark(input: {
  readonly threadKey: string;
  readonly currentThreadKey: string | null;
  readonly action: "settle" | "snooze";
  readonly now: string;
  readonly thread: (ThreadSnoozeShell & Pick<SidebarThreadSummary, "settledOverride">) | null;
}): boolean {
  return (
    input.threadKey === input.currentThreadKey &&
    input.thread !== null &&
    (input.action === "settle"
      ? input.thread.settledOverride === "settled"
      : effectiveSnoozed(input.thread, { now: input.now }))
  );
}

const THREAD_SELECTION_SAFE_SELECTOR = "[data-thread-item], [data-thread-selection-safe]";
export const THREAD_JUMP_HINT_SHOW_DELAY_MS = 200;

export function resolveSidebarRowAccessibility(input: {
  readonly title: string;
  readonly statusLabel: string | null;
  readonly projectDisplayName: string | null;
  readonly isActive: boolean;
}): { readonly label: string; readonly current: "page" | undefined } {
  return {
    // The title is the row's identity and must lead when users scan tasks.
    // Only static context belongs here; nested action labels remain separate controls.
    label: [input.title, input.statusLabel, input.projectDisplayName].filter(Boolean).join(", "),
    current: input.isActive ? "page" : undefined,
  };
}

// Visible sidebar rows are prewarmed into the thread-detail cache so opening a
// nearby thread usually reuses an already-hot subscription. Each prewarmed
// thread holds a live, fully hydrated detail subscription (all messages and
// activities, growing as agents work) for as long as the row stays visible,
// so this limit is a direct renderer-heap and server-load multiplier — keep
// it small; cold opens still render instantly from the cached snapshot.
const SIDEBAR_THREAD_PREWARM_LIMIT = 3;
// A small buffer keeps the next few rows warm without leasing every row that
// content-visibility leaves mounted below the scroll viewport.
const SIDEBAR_ROW_SUBSCRIPTION_OVERSCAN_PX = 160;

export function useSidebarRowSubscriptionLease(isActive: boolean): {
  readonly leaseLiveStatus: boolean;
  readonly rowRef: React.Dispatch<React.SetStateAction<HTMLElement | null>>;
} {
  const [row, setRow] = React.useState<HTMLElement | null>(null);
  const [isNearViewport, setIsNearViewport] = React.useState(isActive);

  React.useEffect(() => {
    if (isActive) {
      setIsNearViewport(true);
      return;
    }
    if (row === null) return;
    if (typeof IntersectionObserver === "undefined") {
      setIsNearViewport(true);
      return;
    }

    const scrollRoot = row.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
    const observer = new IntersectionObserver(
      ([entry]) => setIsNearViewport(entry?.isIntersecting === true),
      {
        root: scrollRoot,
        rootMargin: `${SIDEBAR_ROW_SUBSCRIPTION_OVERSCAN_PX}px 0px`,
      },
    );
    observer.observe(row);
    return () => observer.disconnect();
  }, [isActive, row]);

  return {
    leaseLiveStatus: isActive || isNearViewport,
    rowRef: setRow,
  };
}

// A row keeps the last live value it rendered so a released lease never
// blanks its badge. The value is bound to `key`, so a different worktree or
// linked pull request cannot reuse the previous one.
export function useRetainedValue<T>(key: string | null, value: T | null): T | null {
  const retained = React.useRef<{ readonly key: string; readonly value: T } | null>(null);
  if (key !== null && value !== null) {
    retained.current = { key, value };
  }
  if (value !== null) return value;
  return key !== null && retained.current?.key === key ? retained.current.value : null;
}

// Sidebar.motion handles ordinary section changes. Sortable transforms own
// dragging; replaying their committed DOM order would animate the drop twice.
export const animateSidebarLayoutChanges: AnimateLayoutChanges = (args) =>
  args.isSorting ? defaultAnimateLayoutChanges(args) : false;

// Rows and section markers share one sortable list. The separators resolve
// the lifecycle action; Sidebar.drag previews the resulting layout. Pinned
// and active threads keep the dragged position; settled threads use time
// order. A drop on the Snoozed shelf snoozes for an hour: the shelf is a drop
// zone like the Queue header, not a list target. The Working shelf (beta)
// follows live status, so it is neither a drag source nor a destination.

/** A user-defined section, by its settings id. */
export type CustomSidebarSection = `custom:${string}`;
export type SidebarSection =
  | "pinned"
  | "active"
  | "working"
  | "snoozed"
  | "settled"
  | CustomSidebarSection;

export function customSidebarSection(id: string): CustomSidebarSection {
  return `custom:${id}`;
}

export function isCustomSidebarSection(section: SidebarSection): section is CustomSidebarSection {
  return section.startsWith("custom:");
}

/** The settings id of a custom section (`customSidebarSection`'s inverse). */
export function customSidebarSectionId(section: CustomSidebarSection): string {
  return section.slice("custom:".length);
}

type SidebarRestingSection = "snoozed" | "settled" | "pinned" | "active" | CustomSidebarSection;

interface SidebarSectionCapabilities {
  readonly threadSettlement?: boolean;
  readonly threadSnooze?: boolean;
}

/**
 * The section a thread sits in when nothing is being dragged. Servers without
 * the settlement or snooze capability never classify a thread there: the user
 * could not bring it back.
 */
export function sidebarRestingSection(
  thread: SidebarThreadSummary,
  capabilities: SidebarSectionCapabilities | undefined,
  now: string,
  customSectionIds: ReadonlySet<string>,
): SidebarRestingSection {
  // Snooze outranks settlement and pinning until the thread wakes.
  if (capabilities?.threadSnooze === true && effectiveSnoozed(thread, { now })) return "snoozed";
  if (capabilities?.threadSettlement === true && thread.settledOverride === "settled") {
    return "settled";
  }
  if (thread.pinnedAt != null) return "pinned";
  // Membership naming no defined section rests in Active, so deleting a section needs no cascade.
  return thread.sidebarSectionId != null && customSectionIds.has(thread.sidebarSectionId)
    ? customSidebarSection(thread.sidebarSectionId)
    : "active";
}

/** How many threads the sidebar lists, custom section members included; zero shows the empty state. */
export function countSidebarThreads(input: {
  readonly lists: ReadonlyArray<ReadonlyArray<unknown>>;
  readonly customThreads: ReadonlyMap<string, ReadonlyArray<unknown>>;
}): number {
  let count = 0;
  for (const list of input.lists) count += list.length;
  for (const list of input.customThreads.values()) count += list.length;
  return count;
}

/** Resolve the shelf a visible thread belongs to. Snooze is temporary and
 * wins until its wake boundary; settlement then wins over a stale pin. */
export function resolveSidebarThreadSection(input: {
  readonly snoozed: boolean;
  readonly settled: boolean;
  readonly pinned: boolean;
}): SidebarSection {
  if (input.snoozed) return "snoozed";
  if (input.settled) return "settled";
  if (input.pinned) return "pinned";
  return "active";
}

/** Sortable ids: thread rows use their scoped key; structural items use a
    colon-free prefix: scoped thread keys always contain a colon. */
const SIDEBAR_MARKER_PREFIX = "sidebar-marker-";

export type SidebarListMarker =
  /** The top boundary is also a landing target when there are no pins. */
  | "pinned-header"
  /** Stand-in rows so an empty section has somewhere for the gap to open. */
  | "active-placeholder"
  | "settled-placeholder"
  /** The boundary between pinned and active rows. */
  | "pinned-divider"
  | "working-header"
  | "snoozed-header"
  /** The empty Snoozed shelf: zero height at rest; while a row that may be snoozed is lifted, its
      36px hint is a drop zone (the sortable node is the hint box above the li; see Sidebar.tsx). */
  | "snoozed-placeholder"
  | "settled-header";

export function sidebarMarkerId(marker: SidebarListMarker): string {
  return `${SIDEBAR_MARKER_PREFIX}${marker}`;
}

export type SidebarListItem =
  | { readonly kind: "thread"; readonly key: string; readonly section: SidebarSection }
  | { readonly kind: "marker"; readonly marker: SidebarListMarker }
  | {
      readonly kind: "marker";
      readonly marker: "custom-header";
      readonly sectionId: string;
      /** Collapsed: its header takes a drop into the section, even while the open row shows. */
      readonly collapsed: boolean;
    };

export function customSectionHeaderId(sectionId: string): string {
  return `${SIDEBAR_MARKER_PREFIX}custom-header-${sectionId}`;
}

export function sidebarListItemId(item: SidebarListItem): string {
  if (item.kind === "thread") return item.key;
  return item.marker === "custom-header"
    ? customSectionHeaderId(item.sectionId)
    : sidebarMarkerId(item.marker);
}

type SidebarShelfRows = { readonly total: number; readonly visible: readonly string[] };

/** The sortable list: rows plus the markers the drop rules and preview read sections from. */
export function buildSidebarListItems(input: {
  readonly pinned: readonly string[];
  readonly active: readonly string[];
  readonly working: SidebarShelfRows;
  readonly snoozed: SidebarShelfRows;
  readonly settled: SidebarShelfRows;
  /** Each defined section, in order, with its rendered rows (only the open thread while collapsed). */
  readonly custom: ReadonlyArray<{
    readonly id: string;
    readonly visible: readonly string[];
    readonly collapsed: boolean;
  }>;
}): SidebarListItem[] {
  const rows = (keys: readonly string[], section: SidebarSection): SidebarListItem[] =>
    keys.map((key) => ({ kind: "thread", key, section }));
  if (
    input.pinned.length +
      input.active.length +
      input.working.total +
      input.snoozed.total +
      input.settled.total ===
      0 &&
    input.custom.length === 0
  ) {
    return [];
  }
  const items: SidebarListItem[] = [{ kind: "marker", marker: "pinned-header" }];
  items.push(...rows(input.pinned, "pinned"));
  items.push({ kind: "marker", marker: "pinned-divider" });
  items.push({ kind: "marker", marker: "active-placeholder" });
  items.push(...rows(input.active, "active"));
  for (const section of input.custom) {
    items.push({
      kind: "marker",
      marker: "custom-header",
      sectionId: section.id,
      collapsed: section.collapsed,
    });
    items.push(...rows(section.visible, customSidebarSection(section.id)));
  }
  if (input.working.total > 0) {
    items.push({ kind: "marker", marker: "working-header" });
    items.push(...rows(input.working.visible, "working"));
  }
  if (input.snoozed.total > 0) {
    items.push({ kind: "marker", marker: "snoozed-header" });
    items.push(...rows(input.snoozed.visible, "snoozed"));
  } else {
    items.push({ kind: "marker", marker: "snoozed-placeholder" });
  }
  items.push({ kind: "marker", marker: "settled-header" });
  items.push({ kind: "marker", marker: "settled-placeholder" });
  items.push(...rows(input.settled.visible, "settled"));
  return items;
}

/** The Snoozed shelf as a drop zone, by sortable id: its header, the empty-shelf placeholder, and
    every shelf row but the lifted one. They are pointer zones, hit where painted (like the Queue
    header), never list targets: a snooze has no position. */
export function sidebarSnoozeZoneIds(
  items: readonly SidebarListItem[],
  activeKey: string,
): string[] {
  const ids: string[] = [];
  for (const item of items) {
    if (item.kind === "thread") {
      if (item.section === "snoozed" && item.key !== activeKey) ids.push(item.key);
    } else if (item.marker === "snoozed-header" || item.marker === "snoozed-placeholder") {
      ids.push(sidebarMarkerId(item.marker));
    }
  }
  return ids;
}

/** The section a slot belongs to, read off the markers around it: from
    the top down, everything before the pinned divider is pinned, then the
    inbox until the first custom or shelf header, each custom section and
    shelf until the next header, then settled. */
function sectionAtSidebarSlot(items: readonly SidebarListItem[], index: number): SidebarSection {
  let section: SidebarSection = "pinned";
  for (let i = 0; i < index && i < items.length; i += 1) {
    const item = items[i]!;
    if (item.kind !== "marker") continue;
    if (item.marker === "pinned-divider") section = "active";
    else if (item.marker === "custom-header") section = customSidebarSection(item.sectionId);
    else if (item.marker === "working-header") section = "working";
    else if (item.marker === "snoozed-header") section = "snoozed";
    else if (item.marker === "settled-header") section = "settled";
  }
  return section;
}

/** Resolve the destination section and manual order from an arrayMove across
 * the separators. The working and snoozed shelves are never list destinations. */
export type SidebarDropTarget = {
  readonly section: "pinned" | "active" | "settled" | CustomSidebarSection;
  readonly pinnedOrder: readonly string[];
  readonly activeOrder: readonly string[];
  /** A custom section only: the visible member the row lands right after; null at its top. */
  readonly customAfter?: string | null;
};

/** A queued thread is not a list row. Drops resolve as if it sat where the
    Queue renders, just above the custom sections and shelves, so moving up or
    down lands on the side of the target the pointer shows. `section` is its
    resting section. */
export function withQueuedRow(
  items: readonly SidebarListItem[],
  key: string,
  section: SidebarSection,
): SidebarListItem[] {
  const shelf = items.findIndex(
    (item) =>
      item.kind === "marker" &&
      (item.marker === "custom-header" ||
        item.marker === "snoozed-header" ||
        item.marker === "snoozed-placeholder" ||
        item.marker === "settled-header"),
  );
  const slot = shelf === -1 ? items.length : shelf;
  return [...items.slice(0, slot), { kind: "thread", key, section }, ...items.slice(slot)];
}

/** Where the Queue block renders during a drag, and whether a main-list drag collapses it to its
    header. An empty Queue shows only its drop zone; inline above the custom sections that zone
    would push them down at pickup, so it docks with the shelves instead. Docked above the
    shelves in a scrolling list, it would still push down the rows above a pointer that lifted a
    shelf row; then it goes after every row (`belowShelves`), reached by autoscroll. */
export function sidebarQueuePlacement(input: {
  readonly sectionCount: number;
  readonly entryCount: number;
  readonly dropShown: boolean;
  readonly listScrolls: boolean;
  /** The lifted row rests in Snoozed or Settled. */
  readonly liftedFromShelf: boolean;
}): {
  readonly docksWithShelves: boolean;
  readonly belowShelves: boolean;
  readonly collapse: boolean;
} {
  const docksWithShelves = input.sectionCount === 0 || input.entryCount === 0;
  return {
    docksWithShelves,
    belowShelves:
      input.sectionCount > 0 &&
      input.entryCount === 0 &&
      input.listScrolls &&
      input.liftedFromShelf,
    collapse: input.dropShown && !input.listScrolls && docksWithShelves,
  };
}

const NO_QUEUE_ENTRIES: readonly never[] = [];
/** The entries the Queue block renders. Below the shelves it was empty at pickup and stays its
    header alone for the drag: an entry that arrives mid-drag appears at the drop. */
export function sidebarQueueBlockEntries<E>(
  placement: { readonly belowShelves: boolean },
  shown: readonly E[],
): readonly E[] {
  return placement.belowShelves ? NO_QUEUE_ENTRIES : shown;
}

/** The Queue entry count `sidebarQueuePlacement` reads during a drag. Counted from the entries the
    Queue block shows (`sidebarShownQueueEntries`), not the store's: a join held on its way into a
    section is still in the store but renders in the section. Frozen at pickup for the
    whole drag (`pickupCount`), so the block neither appears, moves nor disappears mid-drag when
    the Queue sends or fills: an emptied Queue keeps its header until the drop. */
export function sidebarDragQueueEntryCount(
  pickupCount: number | undefined,
  shownEntries: readonly unknown[],
): number {
  return pickupCount ?? shownEntries.length;
}

/** A drag in progress, as the drop rules need it. */
export interface SidebarDragOrigin {
  readonly activeKey: string;
  /** For a Queue row, the section it rests in once unqueued. */
  readonly activeSection: SidebarSection;
  readonly fromQueue: boolean;
  /** A queued row with no thread here (a draft, or another device's entry): it can only reorder inside the Queue. */
  readonly queuedDraft: boolean;
}

/** What a drag is over, as the drag state keeps it. */
export interface SidebarDragOverState {
  /** The list section a drop would land in, or null (nothing, the Queue, or a snooze zone). */
  readonly targetSection: SidebarSection | null;
  /** Over a Snoozed-shelf zone or the Queue header: what the badge and header accents read. */
  readonly overZone: "snooze" | "queue" | null;
  /** The last `over` that was a list row or marker, never a pointer zone (a snooze zone, the
      Queue header), a Queue row or nothing. Over a zone the preview projects as this one,
      since the shelves are bottom-anchored, and a zone that moves when hit oscillates. It lives
      in the drag state because the sorting strategy is rebuilt on every over change. */
  readonly stickyOverId: string | null;
}

export function nextSidebarDragOver(input: {
  readonly current: SidebarDragOverState;
  readonly overId: string | null;
  readonly activeKey: string;
  readonly items: readonly SidebarListItem[];
  readonly queuedKeys: ReadonlySet<string>;
  readonly queueDropId: string;
}): SidebarDragOverState {
  const { overId } = input;
  if (overId !== null && sidebarSnoozeZoneIds(input.items, input.activeKey).includes(overId)) {
    return { targetSection: null, overZone: "snooze", stickyOverId: input.current.stickyOverId };
  }
  const target =
    overId === null || input.queuedKeys.has(overId)
      ? null
      : resolveSidebarDropTarget(input.items, input.activeKey, overId);
  // Over anything that is not a list item dnd-kit leaves the rows at rest; a zone hit next must
  // project as the last list over, not as the lifted row.
  const listed =
    overId !== null &&
    !input.queuedKeys.has(overId) &&
    input.items.some((item) => sidebarListItemId(item) === overId);
  return {
    targetSection: target?.section ?? null,
    overZone: overId === input.queueDropId ? "queue" : null,
    stickyOverId: listed ? overId : input.current.stickyOverId,
  };
}

/** The list a drag resolves against: a Queue row joins it at the Queue's slot. */
export function sidebarDragListItems(
  items: readonly SidebarListItem[],
  drag: SidebarDragOrigin | null,
): readonly SidebarListItem[] {
  return drag?.fromQueue ? withQueuedRow(items, drag.activeKey, drag.activeSection) : items;
}

/** A drag ends itself when its row leaves both the list and the Queue. */
export function sidebarDragLostItsRow(
  activeKey: string,
  items: readonly SidebarListItem[],
  queuedKeys: ReadonlySet<string>,
): boolean {
  return (
    !queuedKeys.has(activeKey) &&
    !items.some((item) => item.kind === "thread" && item.key === activeKey)
  );
}

/** Whether the lifted row may be dropped on the Snoozed shelf. `supportsSnooze`: the
    thread's server has `threadSnooze`; `canSnooze`: the client twin of the server's refusals
    (pending approval or user input, a queued turn start); `canOperate`: this connection has
    operate scope on the thread's environment. */
export function sidebarSnoozeDropAllowed(input: {
  readonly drag: SidebarDragOrigin;
  readonly supportsSnooze: boolean;
  readonly canSnooze: boolean;
  readonly canOperate: boolean;
}): boolean {
  const { drag } = input;
  if (drag.queuedDraft || drag.activeSection === "working" || !input.canOperate) return false;
  // Already snoozed: a main-list row has nothing to do there; a Queue row is only unqueued.
  if (drag.activeSection === "snoozed") return drag.fromQueue;
  return input.supportsSnooze && input.canSnooze;
}

/** The release's snooze gate. A thread may have moved while lifted, so `sidebarSnoozeDropAllowed`
    runs on where it rests now: a main-list row reads the section it is listed in (`listedSection`),
    a Queue row has no list row and recomputes its resting section (`restingSection`; undefined when
    the thread is not here). `liveSection` is what `runSidebarSnoozeDrop` reads. */
export function sidebarReleaseSnoozeState(input: {
  readonly drag: SidebarDragOrigin;
  readonly listedSection: SidebarSection | undefined;
  readonly restingSection: SidebarRestingSection | undefined;
  readonly supportsSnooze: boolean;
  readonly canSnooze: boolean;
  readonly canOperate: boolean;
}): { readonly liveSection: SidebarSection; readonly snoozeAllowed: boolean } {
  const { drag } = input;
  const liveSection =
    (drag.fromQueue ? input.restingSection : input.listedSection) ?? drag.activeSection;
  return {
    liveSection,
    snoozeAllowed:
      input.restingSection !== undefined &&
      sidebarSnoozeDropAllowed({
        drag: { ...drag, activeSection: liveSection },
        supportsSnooze: input.supportsSnooze,
        canSnooze: input.canSnooze,
        canOperate: input.canOperate,
      }),
  };
}

/** Whether the collision detector may pick `id`. `planKind` plans the drop
    into a resolved target; the main-list rule is "the drop changes something". */
export function isSidebarDragCandidate(input: {
  readonly id: string;
  readonly drag: SidebarDragOrigin;
  readonly items: readonly SidebarListItem[];
  readonly queuedKeys: ReadonlySet<string>;
  readonly queueDropId: string;
  /** `sidebarSnoozeDropAllowed` for this drag. The detector's pointer zones skip this gate, so
      Sidebar.tsx also leaves the zones out of `pointerDropIds` when it is false. */
  readonly snoozeAllowed?: boolean;
  readonly planKind: (target: SidebarDropTarget) => SidebarThreadDropPlan["kind"];
}): boolean {
  const { id, drag } = input;
  if (input.queuedKeys.has(id)) return drag.fromQueue;
  if (drag.queuedDraft) return false;
  if (id === input.queueDropId) return !drag.fromQueue;
  if (sidebarSnoozeZoneIds(input.items, drag.activeKey).includes(id)) {
    return input.snoozeAllowed === true;
  }
  const target = resolveSidebarDropTarget(input.items, drag.activeKey, id);
  if (target === null) return false;
  // Dropping a queued thread back on its resting section still unqueues it; a section member
  // rests below Active, so Active takes it too.
  const unqueuesInPlace =
    drag.fromQueue &&
    (target.section === drag.activeSection ||
      (isCustomSidebarSection(drag.activeSection) && target.section === "active"));
  return input.planKind(target) !== "none" || unqueuesInPlace;
}

export type SidebarDragEndRoute =
  | { readonly kind: "none" }
  /** A Queue row dropped on another: move it to that entry's index. */
  | { readonly kind: "reorder-queue"; readonly overKey: string }
  /** A main-list row dropped on the Queue header. */
  | { readonly kind: "enqueue" }
  /** On the Snoozed shelf: the menu's 1-hour snooze; a Queue row also leaves the Queue. */
  | { readonly kind: "snooze" }
  /** Into a section; `unqueue` first when the row came from the Queue. */
  | { readonly kind: "place"; readonly target: SidebarDropTarget; readonly unqueue: boolean };

export function routeSidebarDragEnd(input: {
  readonly drag: SidebarDragOrigin;
  readonly overId: string | null;
  readonly items: readonly SidebarListItem[];
  readonly queuedKeys: ReadonlySet<string>;
  readonly queueDropId: string;
  /** False while the queue is read-only. */
  readonly queueWritable?: boolean;
  /** `sidebarReleaseSnoozeState(...).snoozeAllowed`: a refused zone snoozes nothing. */
  readonly snoozeAllowed: boolean;
}): SidebarDragEndRoute {
  const { drag, overId } = input;
  if (overId === null) return { kind: "none" };
  // A read-only queue takes no drop and gives none up; a drag out would also pin or settle.
  if (input.queueWritable === false && (drag.fromQueue || overId === input.queueDropId)) {
    return { kind: "none" };
  }
  if (drag.fromQueue && input.queuedKeys.has(overId)) {
    return overId === drag.activeKey
      ? { kind: "none" }
      : { kind: "reorder-queue", overKey: overId };
  }
  if (overId === input.queueDropId) return drag.fromQueue ? { kind: "none" } : { kind: "enqueue" };
  if (drag.queuedDraft) return { kind: "none" };
  // Every zone is caught here, allowed or not, so none reaches the resolver.
  if (sidebarSnoozeZoneIds(input.items, drag.activeKey).includes(overId)) {
    if (!input.snoozeAllowed) return { kind: "none" };
    // A row a peer queued mid-drag has left the list: snoozing it would leave it snoozed and queued.
    const listed = input.items.some(
      (item) => item.kind === "thread" && item.key === drag.activeKey,
    );
    return listed ? { kind: "snooze" } : { kind: "none" };
  }
  const target = resolveSidebarDropTarget(input.items, drag.activeKey, overId);
  return target === null ? { kind: "none" } : { kind: "place", target, unqueue: drag.fromQueue };
}

/** `performSnooze`'s result. */
export type SidebarSnoozeOutcome =
  | { readonly status: "success" | "skipped" | "interrupted" }
  | { readonly status: "failure"; readonly error: unknown };

/**
 * A drop on the Snoozed shelf: the menu's 1-hour snooze, resolved at release. `liveSection`
 * is where the thread rests now, read from live state, so a thread a peer snoozed mid-drag is
 * never re-snoozed. A Queue row leaves the Queue only once the snooze succeeded, and the
 * notice's Undo puts it back.
 */
export async function runSidebarSnoozeDrop(input: {
  readonly drag: Pick<SidebarDragOrigin, "fromQueue">;
  readonly liveSection: SidebarSection;
  /** `checkThreadOperations` for the thread: false (already reported) refuses the snooze. */
  readonly checkOperate: () => boolean;
  readonly snooze: (
    snoozedUntil: string,
    undoAlso: (() => void) | undefined,
  ) => Promise<SidebarSnoozeOutcome>;
  readonly unqueue: () => void;
  readonly requeue: () => void;
  /** The snooze failed. */
  readonly reportFailure: (error: unknown) => void;
  /** Undo woke the thread but could not put it back in the Queue. */
  readonly reportRequeueFailure: (error: unknown) => void;
}): Promise<void> {
  const { fromQueue } = input.drag;
  if (input.liveSection === "snoozed") {
    if (fromQueue) input.unqueue();
    return;
  }
  // A thread this connection cannot operate says so, like every other drop, and stays queued.
  if (!input.checkOperate()) return;
  const hour = resolveSnoozePresets(new Date()).find((preset) => preset.id === "hour")!;
  // A throw out of Undo's follow-up would reject the notice's undo after the wake succeeded.
  const requeue = () => {
    try {
      input.requeue();
    } catch (error) {
      input.reportRequeueFailure(error);
    }
  };
  const outcome = await input.snooze(hour.snoozedUntil, fromQueue ? requeue : undefined);
  if (outcome.status === "success") {
    if (fromQueue) input.unqueue();
  } else if (outcome.status === "failure") {
    input.reportFailure(outcome.error);
  }
}

/** Snooze -> Queue: queue it, then wake it, or a send would find it snoozed. `enqueue` says why
    it refused and returns false; then nothing else happens. */
export async function runSidebarWakeAndQueue(input: {
  /** `checkThreadOperations` for the thread: false (already reported) refuses before queueing. */
  readonly checkOperate: () => boolean;
  readonly enqueue: () => boolean;
  readonly wake: () => Promise<unknown>;
}): Promise<void> {
  if (!input.checkOperate()) return;
  if (input.enqueue()) await input.wake();
}

export function resolveSidebarDropTarget(
  items: readonly SidebarListItem[],
  activeKey: string,
  overId: string,
): SidebarDropTarget | null {
  // The shelf's zones are caught by id before resolution (routeSidebarDragEnd).
  if (
    overId === sidebarMarkerId("snoozed-header") ||
    overId === sidebarMarkerId("snoozed-placeholder")
  )
    return null;
  const activeIndex = items.findIndex((item) => sidebarListItemId(item) === activeKey);
  const overIndex = items.findIndex((item) => sidebarListItemId(item) === overId);
  if (activeIndex === -1 || overIndex === -1 || items[activeIndex]?.kind !== "thread") return null;
  const over = items[overIndex]!;
  // A collapsed or empty custom section's header means that section, from either direction: it is
  // the only way in. From above, arrayMove already lands below the header; from below the row
  // goes right under it instead of to the end of the section above. An expanded section with
  // rows, and any other header, keeps arrayMove.
  const overHeader = over.kind === "marker" && over.marker === "custom-header" ? over : null;
  const intoSection =
    overHeader !== null &&
    (overHeader.collapsed ||
      !items.some(
        (item) =>
          item.kind === "thread" && item.section === customSidebarSection(overHeader.sectionId),
      ));
  // The open row of a collapsed section, dropped on its own header from below, goes nowhere: it
  // would only move above members the user cannot see. A queued member sits above the sections.
  const lifted = items[activeIndex];
  if (
    overHeader?.collapsed === true &&
    activeIndex > overIndex &&
    lifted.section === customSidebarSection(overHeader.sectionId)
  )
    return null;
  const slot = intoSection && activeIndex > overIndex ? overIndex + 1 : overIndex;
  const moved = items.filter((_, index) => index !== activeIndex);
  moved.splice(slot, 0, items[activeIndex]!);
  const section = sectionAtSidebarSlot(moved, slot);
  if (section === "working" || section === "snoozed") return null;
  const pinnedOrder: string[] = [];
  const activeOrder: string[] = [];
  let currentSection: SidebarSection = "pinned";
  for (const item of moved) {
    if (item.kind === "marker") {
      if (item.marker === "pinned-divider") currentSection = "active";
      else if (
        item.marker === "custom-header" ||
        item.marker === "working-header" ||
        item.marker === "snoozed-header" ||
        item.marker === "settled-header"
      )
        break;
    } else if (currentSection === "pinned") pinnedOrder.push(item.key);
    else activeOrder.push(item.key);
  }
  if (!isCustomSidebarSection(section)) return { section, pinnedOrder, activeOrder };
  // The row lands after the member above it; the zero-height placeholder is not a slot.
  let before = slot - 1;
  while (before >= 0) {
    const item = moved[before]!;
    if (item.kind !== "marker" || item.marker !== "snoozed-placeholder") break;
    before -= 1;
  }
  const above = before >= 0 ? moved[before] : undefined;
  return {
    section,
    pinnedOrder,
    activeOrder,
    customAfter: above?.kind === "thread" && above.section === section ? above.key : null,
  };
}

export type SidebarThreadDropPlan =
  | { readonly kind: "none" }
  /** Within the pinned block: the existing key writes. */
  | {
      readonly kind: "reorder-pinned";
      readonly order: readonly string[];
      readonly assignments: ReadonlyArray<{ readonly id: string; readonly orderKey: string }>;
    }
  /** From another section into the pinned block. Fresh pins take `orderKey`
      on the pin command. `extraAssignments` land afterward, including the
      moved row when it was already pinned beneath a snooze. */
  | {
      readonly kind: "pin";
      readonly order: readonly string[];
      readonly orderKey: string | undefined;
      readonly extraAssignments: ReadonlyArray<{ readonly id: string; readonly orderKey: string }>;
    }
  | {
      readonly kind: "move-active";
      /** Null when the inbox is time-ordered: the drop has no placement. */
      readonly order: readonly string[] | null;
      readonly assignments: ReadonlyArray<{ readonly id: string; readonly orderKey: string }>;
      readonly unpin: boolean;
      readonly unsettle: boolean;
      readonly unsnooze: boolean;
      /** The custom section the drag started in; the drop clears that membership. */
      readonly clearsSection?: string;
      /** A drop into a custom section: the section move (`moveThreadToSidebarSection`) sets the
          membership and clears pin, settle and snooze itself, so the clear flags stay false. */
      readonly joinsSection?: string;
    }
  /** `unsnooze`: the server's settle keeps a snooze, so a drop out of Snoozed also wakes. */
  | { readonly kind: "settle"; readonly unsnooze: boolean }
  /** A queued section member dropped on Active: clear what outranks membership, nothing else. */
  | {
      readonly kind: "unpark";
      readonly unpin: boolean;
      readonly unsettle: boolean;
      readonly unsnooze: boolean;
    };

/** What dropping in `to` does to a thread lifted from `from`, for the badge
    on the lifted row. Null while reordering inside one section and over the
    Working shelf, which is never a target. */
export type SidebarDropVerb =
  | "pin"
  | "unpin"
  | "settle"
  | "unsettle"
  | "wake"
  | "unqueue"
  | "snooze"
  | "wake-queue"
  | "move";

export function resolveSidebarDropVerb(
  fromSection: SidebarSection,
  toSection: SidebarSection | null,
  /** Lifted from the Queue: a drop always unqueues, even into its resting section. */
  fromQueue = false,
  /** The drag state's zone (`nextSidebarDragOver`): the Snoozed shelf or the Queue header. */
  zone: "snooze" | "queue" | null = null,
): SidebarDropVerb | null {
  // On the Snoozed shelf an already-snoozed thread is only unqueued, or nothing at all.
  if (zone === "snooze") return fromSection !== "snoozed" ? "snooze" : fromQueue ? "unqueue" : null;
  if (zone === "queue") return fromSection === "snoozed" && !fromQueue ? "wake-queue" : null;
  // Into a custom section, or a member out to Active: the section move.
  if (toSection !== null && isCustomSidebarSection(toSection)) {
    if (toSection !== fromSection) return "move";
    return fromQueue ? "unqueue" : null;
  }
  if (toSection === "active" && isCustomSidebarSection(fromSection) && !fromQueue) return "move";
  // A custom section behaves like Active.
  const rank = (section: SidebarSection) => (isCustomSidebarSection(section) ? "active" : section);
  const from = rank(fromSection);
  const to = toSection === null ? null : rank(toSection);
  if (to === null || to === "working" || to === "snoozed") return null;
  if (to === from) return fromQueue ? "unqueue" : null;
  if (to === "pinned") return "pin";
  if (to === "settled") return "settle";
  if (from === "pinned") return "unpin";
  if (from === "settled") return "unsettle";
  return "wake";
}

/** Eligible rows between the pressed action and the pointer, in sidebar order. */
export function resolveSidebarSweepKeys(
  orderedKeys: readonly string[],
  originKey: string,
  targetKey: string,
  canApply: (key: string) => boolean,
): string[] {
  const origin = orderedKeys.indexOf(originKey);
  const target = orderedKeys.indexOf(targetKey);
  if (origin === -1 || target === -1) return [];
  return orderedKeys.slice(Math.min(origin, target), Math.max(origin, target) + 1).filter(canApply);
}

/** The thread row at a pointer height, clamped to the rows visible in the
    sidebar's scroll viewport. A gap between rows resolves to the row above
    it. Rows carry their key in data-thread-item, which departing motion
    clones drop. */
export function sidebarThreadKeyAtY(list: HTMLElement, y: number): string | null {
  const viewport = list.closest('[data-slot="scroll-area-viewport"]')?.getBoundingClientRect();
  const visibleY = viewport ? Math.min(Math.max(y, viewport.top), viewport.bottom - 1) : y;
  let key: string | null = null;
  for (const row of list.querySelectorAll<HTMLElement>("li[data-thread-item]")) {
    if (key !== null && row.getBoundingClientRect().top > visibleY) break;
    key = row.dataset.threadItem ?? null;
  }
  return key;
}

export function planSidebarThreadDrop(input: {
  readonly activeKey: string;
  readonly activeSection: SidebarSection;
  /** Snoozed threads can retain pinning and settlement beneath the shelf. */
  readonly activePinned?: boolean;
  readonly activeSettled?: boolean;
  readonly supportsSettlement?: boolean;
  readonly target: SidebarDropTarget;
  /** All pinned keys in displayed order before the drop. */
  readonly pinnedOrder: readonly string[];
  readonly pinnedKeysById: ReadonlyMap<string, string | null | undefined>;
  readonly reorderableKeys?: ReadonlySet<string>;
  readonly activeOrder: readonly string[];
  readonly activeKeysById: ReadonlyMap<string, string | null | undefined>;
  readonly activeReorderableKeys?: ReadonlySet<string>;
  /** Working beta: the inbox sorts by time, so drops only change lifecycle. */
  readonly activeTimeOrdered?: boolean;
  /** Lifted from the Queue: a drop on Active only unqueues, so membership is kept. A section
      member's drop on Active plans at most an unpark: it leaves the
      pinned, settled or snoozed state and returns to its section. */
  readonly fromQueue?: boolean;
  /** The thread's raw membership, and the sections this client defines. */
  readonly activeSidebarSectionId?: string | null;
  readonly customSectionIds?: ReadonlySet<string>;
  /** For a drop into a custom section: each section's members in displayed order (all of them,
      not just the visible rows, so a collapsed section takes a drop at the right key). */
  readonly customOrders?: ReadonlyMap<string, readonly string[]>;
  /** The source thread's server has `threadSidebarSections`. */
  readonly supportsSections?: boolean;
}): SidebarThreadDropPlan {
  const {
    activeKey,
    activeSection,
    activePinned = activeSection === "pinned",
    activeSettled = activeSection === "settled",
    target,
    pinnedOrder,
    pinnedKeysById,
    reorderableKeys,
    activeOrder,
    activeKeysById,
    activeReorderableKeys,
  } = input;
  if (input.supportsSettlement === false && (target.section === "settled" || activeSettled)) {
    return { kind: "none" };
  }
  // A main-list drop into Active clears a membership this client defines, from any bucket. A
  // client without sections, or a deleted section, already shows the thread in Active.
  const { activeSidebarSectionId: memberOf } = input;
  const clearsSection =
    input.fromQueue !== true && memberOf != null && input.customSectionIds?.has(memberOf) === true
      ? { clearsSection: memberOf }
      : {};
  // Rows whose server cannot store an order (an older server, or a machine
  // that is offline) are never written. Keyless ones sort outside the keyed
  // run, so they leave the plan; keyed ones stay as bounds. Before, one keyless row
  // refused every drop that needed fresh keys for its neighbors.
  const arrange = (
    order: readonly string[],
    keysById: ReadonlyMap<string, string | null | undefined>,
    writable: ReadonlySet<string> | undefined,
  ) => {
    if (!writable) return planPinnedReorder({ orderedIds: order, keysById, movedId: activeKey });
    if (!writable.has(activeKey)) return null;
    const assignments = planPinnedReorder({
      orderedIds: order.filter((key) => writable.has(key) || keysById.get(key) != null),
      keysById,
      movedId: activeKey,
    });
    return assignments.every(({ id }) => writable.has(id)) ? assignments : null;
  };
  if (isCustomSidebarSection(target.section)) {
    if (input.supportsSections !== true) return { kind: "none" };
    const sectionId = customSidebarSectionId(target.section);
    const join = { unpin: false, unsettle: false, unsnooze: false, joinsSection: sectionId };
    const within = activeSection === target.section;
    // Custom sections sort like the inbox: time-ordered with the Working beta on.
    if (input.activeTimeOrdered) {
      return within
        ? { kind: "none" }
        : { kind: "move-active", order: null, assignments: [], ...join };
    }
    const members = input.customOrders?.get(sectionId) ?? [];
    const others = members.filter((key) => key !== activeKey);
    const after = target.customAfter ?? null;
    const at = after === null ? 0 : others.indexOf(after) + 1;
    const order = [...others.slice(0, at), activeKey, ...others.slice(at)];
    if (
      within &&
      order.length === members.length &&
      order.every((key, index) => key === members[index])
    ) {
      return { kind: "none" };
    }
    const assignments = arrange(order, activeKeysById, activeReorderableKeys);
    if (assignments === null) return { kind: "none" };
    return { kind: "move-active", order, assignments, ...join };
  }
  switch (target.section) {
    case "active": {
      // A queued section member dropped on Active only unqueues (the caller already did) and
      // clears what outranks its membership, so it returns to its section where it was. An Active
      // key would reorder it inside the section, and a hold would flash it in Active.
      if (input.fromQueue === true && memberOf != null && input.customSectionIds?.has(memberOf)) {
        const unpark = {
          unpin: activePinned,
          unsettle: activeSettled,
          unsnooze: activeSection === "snoozed",
        };
        return unpark.unpin || unpark.unsettle || unpark.unsnooze
          ? { kind: "unpark", ...unpark }
          : { kind: "none" };
      }
      // Like the settled tail: threads can enter a time-ordered inbox, but
      // not be arranged inside it.
      if (input.activeTimeOrdered) {
        return activeSection === "active"
          ? { kind: "none" }
          : {
              kind: "move-active",
              order: null,
              assignments: [],
              unpin: activePinned,
              unsettle: activeSettled,
              unsnooze: activeSection === "snoozed",
              ...clearsSection,
            };
      }
      const order = target.activeOrder;
      if (
        activeSection === "active" &&
        order.length === activeOrder.length &&
        order.every((key, index) => key === activeOrder[index])
      ) {
        return { kind: "none" };
      }
      const assignments = arrange(order, activeKeysById, activeReorderableKeys);
      if (assignments === null) return { kind: "none" };
      return {
        kind: "move-active",
        order,
        assignments,
        unpin: activePinned,
        unsettle: activeSettled,
        unsnooze: activeSection === "snoozed",
        ...clearsSection,
      };
    }
    case "settled":
      return activeSection === "settled"
        ? { kind: "none" }
        : { kind: "settle", unsnooze: activeSection === "snoozed" };
    case "pinned": {
      const order = target.pinnedOrder;
      // Dropped back where it started: nothing to write.
      if (
        activeSection === "pinned" &&
        order.length === pinnedOrder.length &&
        order.every((key, index) => key === pinnedOrder[index])
      ) {
        return { kind: "none" };
      }
      const assignments = arrange(order, pinnedKeysById, reorderableKeys);
      if (assignments === null) return { kind: "none" };
      if (activeSection === "pinned") {
        return assignments.length === 0
          ? { kind: "none" }
          : { kind: "reorder-pinned", order, assignments };
      }
      return {
        kind: "pin",
        order,
        orderKey: assignments.find((assignment) => assignment.id === activeKey)?.orderKey,
        extraAssignments: activePinned
          ? assignments
          : assignments.filter((assignment) => assignment.id !== activeKey),
      };
    }
  }
}

/** What every drop plan reads off the sidebar as rendered. */
export interface SidebarDropBoard {
  readonly pinnedOrder: readonly string[];
  readonly pinnedKeysById: ReadonlyMap<string, string | null | undefined>;
  readonly reorderableKeys: ReadonlySet<string>;
  readonly activeOrder: readonly string[];
  readonly activeKeysById: ReadonlyMap<string, string | null | undefined>;
  readonly activeReorderableKeys: ReadonlySet<string>;
  readonly activeTimeOrdered: boolean;
  readonly customSectionIds: ReadonlySet<string>;
  readonly customOrders: ReadonlyMap<string, readonly string[]>;
}

/** One argument builder for the drop-target check and the drop itself, so the two always plan
    the same drop. */
export function sidebarDropPlanInput(
  board: SidebarDropBoard,
  drag: Pick<SidebarDragOrigin, "activeKey" | "activeSection" | "fromQueue">,
  source: Pick<SidebarThreadSummary, "pinnedAt" | "settledOverride" | "sidebarSectionId"> & {
    readonly supportsSettlement: boolean;
    readonly supportsSections: boolean;
  },
  target: SidebarDropTarget,
): Parameters<typeof planSidebarThreadDrop>[0] {
  return {
    activeKey: drag.activeKey,
    activeSection: drag.activeSection,
    activePinned: source.pinnedAt != null,
    activeSettled: source.settledOverride === "settled",
    supportsSettlement: source.supportsSettlement,
    target,
    pinnedOrder: board.pinnedOrder,
    pinnedKeysById: board.pinnedKeysById,
    reorderableKeys: board.reorderableKeys,
    activeOrder: board.activeOrder,
    activeKeysById: board.activeKeysById,
    activeReorderableKeys: board.activeReorderableKeys,
    activeTimeOrdered: board.activeTimeOrdered,
    fromQueue: drag.fromQueue,
    activeSidebarSectionId: source.sidebarSectionId,
    customSectionIds: board.customSectionIds,
    customOrders: board.customOrders,
    supportsSections: source.supportsSections,
  };
}

/** Project a drop's lifecycle fields before sorting its destination. Reusing
    the server's re-entry rules keeps the preview in place when events arrive. */
export function applySidebarThreadDrop<
  T extends Pick<
    SidebarThreadSummary,
    | "pinnedAt"
    | "pinOrderKey"
    | "activeOrderKey"
    | "snoozedAt"
    | "snoozedUntil"
    | "settledAt"
    | "settledOverride"
    | "unsettledAt"
    | "sidebarSectionId"
  >,
>(
  thread: T,
  section: "pinned" | "active" | "settled" | CustomSidebarSection,
  now: string,
  orderKey?: string,
): T {
  const wasSettled = thread.settledOverride === "settled";
  const awake = { ...thread, snoozedAt: null, snoozedUntil: null };
  if (section === "settled") {
    return {
      ...awake,
      pinnedAt: null,
      pinOrderKey: null,
      activeOrderKey: null,
      settledOverride: "settled",
      settledAt: wasSettled ? (thread.settledAt ?? now) : now,
      unsettledAt: null,
    };
  }
  const resumed = wasSettled
    ? { ...awake, settledOverride: "active" as const, settledAt: null, unsettledAt: now }
    : awake;
  const joins = isCustomSidebarSection(section) ? customSidebarSectionId(section) : null;
  return {
    ...resumed,
    pinnedAt: section === "pinned" ? (thread.pinnedAt ?? now) : null,
    pinOrderKey: section === "pinned" ? (orderKey ?? thread.pinOrderKey) : null,
    ...((section === "active" || joins !== null) && orderKey !== undefined
      ? { activeOrderKey: orderKey }
      : {}),
    // Membership writes: a drop into Active clears it, a join sets it.
    ...(section === "active" && thread.sidebarSectionId != null ? { sidebarSectionId: null } : {}),
    ...(joins !== null ? { sidebarSectionId: joins } : {}),
  };
}

/** Where a canonical thread sits, ignoring capabilities: the hold compares server truth. */
function canonicalSidebarSection(
  thread: SidebarThreadSummary,
  now: string,
  customSectionIds: ReadonlySet<string>,
): SidebarSection {
  return sidebarRestingSection(
    thread,
    { threadSettlement: true, threadSnooze: true },
    now,
    customSectionIds,
  );
}

/** A dropped row held at its destination until the server confirms the move. */
export interface SidebarOptimisticDrop {
  readonly key: string;
  readonly sourceSection: SidebarSection;
  readonly section: "pinned" | "active" | "settled" | CustomSidebarSection;
  readonly occurredAt: string;
  readonly clearsSnooze: boolean;
  /** The membership this drop clears (a drop into Active), or null. */
  readonly clearsSection: string | null;
  /** Full destination order for pinned and active drops. */
  readonly order: readonly string[] | null;
  /** Destination order keys before the drop, to recognize concurrent writes. */
  readonly keysAtDrop: ReadonlyMap<string, string | null>;
  /** The keys this drop writes; the hold lasts until all appear in canonical state. */
  readonly assignedKeys: ReadonlyMap<string, string>;
}

/** The hold for a drop: what it projects and what `shouldReleaseOptimisticDrop` waits for. */
export function sidebarOptimisticDrop(input: {
  readonly key: string;
  readonly sourceSection: SidebarSection;
  readonly section: SidebarOptimisticDrop["section"];
  readonly plan: Exclude<SidebarThreadDropPlan, { readonly kind: "none" | "unpark" }>;
  readonly assignments: ReadonlyArray<{ readonly id: string; readonly orderKey: string }>;
  readonly occurredAt: string;
  readonly pinnedKeysById: ReadonlyMap<string, string | null>;
  readonly activeKeysById: ReadonlyMap<string, string | null>;
}): SidebarOptimisticDrop {
  const { plan } = input;
  return {
    key: input.key,
    sourceSection: input.sourceSection,
    section: input.section,
    occurredAt: input.occurredAt,
    clearsSnooze:
      plan.kind === "pin" ||
      plan.kind === "settle" ||
      // A join's section move wakes the thread itself.
      (plan.kind === "move-active" && (plan.unsnooze || plan.joinsSection !== undefined)),
    clearsSection: plan.kind === "move-active" ? (plan.clearsSection ?? null) : null,
    order: plan.kind === "settle" ? null : plan.order,
    // A custom section's rows are ordered by their active keys.
    keysAtDrop: input.section === "pinned" ? input.pinnedKeysById : input.activeKeysById,
    assignedKeys: new Map(input.assignments.map(({ id, orderKey }) => [id, orderKey])),
  };
}

/** Where the held row renders while its drop is pending, and as what. */
export function projectSidebarHeldDrop<T extends Parameters<typeof applySidebarThreadDrop>[0]>(
  thread: T,
  drop: SidebarOptimisticDrop,
): { readonly section: SidebarOptimisticDrop["section"]; readonly thread: T } {
  const projected = applySidebarThreadDrop(
    thread,
    drop.section,
    drop.occurredAt,
    drop.assignedKeys.get(drop.key),
  );
  return {
    section: drop.section,
    thread: {
      ...projected,
      ...(drop.clearsSnooze
        ? {}
        : { snoozedAt: thread.snoozedAt, snoozedUntil: thread.snoozedUntil }),
      // A join projects its new membership; into Active, only a drop that clears membership
      // projects it cleared (a Queue row keeps it).
      ...(drop.clearsSection === null && drop.section === "active"
        ? { sidebarSectionId: thread.sidebarSectionId }
        : {}),
    },
  };
}

/**
 * The entries shown in the Queue block, and so the threads the main list leaves to it. A Queue
 * row held on its way into a custom section renders in that section instead, so the hold waits
 * there for its key; when the hold ends a refused or failed join is back in the Queue.
 */
export function sidebarShownQueueEntries<E extends Parameters<typeof threadQueueEntryKey>[0]>(
  entries: readonly E[],
  drop: SidebarOptimisticDrop | null,
): readonly E[] {
  if (drop === null || !isCustomSidebarSection(drop.section)) return entries;
  return entries.filter((entry) => threadQueueEntryKey(entry) !== drop.key);
}

/** Whether a drag start must refuse `activeKey`: its drop is still held. A held Queue join renders
    in its section while the raw Queue still lists it until `joined`, so lifted again it would
    classify as a Queue drag and appear twice in the drag list. */
export function sidebarPickupRefused(
  activeKey: string,
  drop: Pick<SidebarOptimisticDrop, "key"> | null,
): boolean {
  return drop?.key === activeKey;
}

/** Whether a Queue row may not be lifted. Like a main-list row, none may while a drop is held:
    a second drop would replace the held one, and a held join's entry is still in the raw Queue,
    so a Queue row released over it would reorder the Queue against a row shown elsewhere. */
export function sidebarQueueRowDragDisabled(input: {
  readonly readOnly: boolean;
  readonly drop: SidebarOptimisticDrop | null;
}): boolean {
  return input.readOnly || input.drop !== null;
}

/** `section`'s sorted rows, with a held drop's full order on top so renumbered rows do not jump
    at release. */
export function sidebarHeldRows<T>(
  rows: readonly T[],
  section: SidebarOptimisticDrop["section"],
  drop: SidebarOptimisticDrop | null,
  keyOf: (row: T) => string,
): readonly T[] {
  if (drop === null || drop.section !== section || drop.order === null) return rows;
  return orderItemsByPreferredIds({ items: rows, preferredIds: drop.order, getId: keyOf });
}

/** The rows a held drop lands among, in displayed order. */
export function sidebarDropDestinationKeys(
  section: SidebarOptimisticDrop["section"],
  board: Pick<SidebarDropBoard, "pinnedOrder" | "activeOrder" | "customOrders">,
): readonly string[] {
  if (isCustomSidebarSection(section)) {
    return board.customOrders.get(customSidebarSectionId(section)) ?? [];
  }
  return section === "pinned" ? board.pinnedOrder : board.activeOrder;
}

/**
 * The pending-drop hold. `holdDuring` holds a drop while its command sequence runs and releases
 * it when the sequence ends, success or failure: every command updates the client
 * optimistically, so by then the view is already right. The caller `release`s it earlier when
 * `shouldReleaseOptimisticDrop` says canonical state settled the drop (or a peer moved it).
 */
export function useSidebarDropHold() {
  const [drop, setDrop] = React.useState<SidebarOptimisticDrop | null>(null);
  const holdDuring = React.useCallback(
    async (next: SidebarOptimisticDrop, sequence: () => Promise<unknown>) => {
      setDrop(next);
      try {
        await sequence();
      } finally {
        // A late end must not cancel a newer drop's hold.
        setDrop((current) => (current === next ? null : current));
      }
    },
    [],
  );
  const release = React.useCallback(() => setDrop(null), []);
  return { drop, holdDuring, release };
}

/** A drop's commands. Each resolves false on failure (already reported), which ends the drop. */
export interface SidebarDropCommands {
  readonly settle: () => Promise<boolean>;
  readonly clearSection: () => Promise<boolean>;
  readonly unpin: () => Promise<boolean>;
  readonly unsettle: () => Promise<boolean>;
  readonly unsnooze: () => Promise<boolean>;
  readonly pin: (orderKey: string | undefined) => Promise<boolean>;
  readonly reorderActive: (threadKey: string, orderKey: string) => Promise<boolean>;
  readonly reorderPinned: (threadKey: string, orderKey: string) => Promise<boolean>;
  /** The section move into a custom section; resolves whether the thread joined. */
  readonly joinSection: (sectionId: string) => Promise<boolean>;
  /** Runs once a join landed, before its key writes (a Queue row leaves the Queue here). */
  readonly joined: () => void;
}

/**
 * Hold `drop` for exactly as long as its command sequence runs. Lifecycle commands go first, the
 * clear first of all (if it fails, nothing else changed); key writes follow and stop at the first
 * failure, since each one that landed is still a valid placement.
 */
export function holdSidebarDrop(
  holdDuring: ReturnType<typeof useSidebarDropHold>["holdDuring"],
  drop: SidebarOptimisticDrop,
  plan: Exclude<SidebarThreadDropPlan, { readonly kind: "none" | "unpark" }>,
  commands: SidebarDropCommands,
): Promise<void> {
  return holdDuring(drop, () => runSidebarDropCommands(plan, commands));
}

/**
 * When a drop takes its row out of the Queue: "now", synchronously, so the row is back in its
 * resting section in the same render that projects the drop (even a drop that plans nothing);
 * "on-join" for a join into a custom section, so a refused or failed move leaves the Queue
 * untouched; null for a row that was not queued.
 */
export function sidebarDropUnqueue(
  unqueue: boolean,
  plan: SidebarThreadDropPlan,
): "now" | "on-join" | null {
  if (!unqueue) return null;
  return plan.kind === "move-active" && plan.joinsSection !== undefined ? "on-join" : "now";
}

/** A drop's commands in order. An unpark runs without a hold: its row never leaves its section. */
export async function runSidebarDropCommands(
  plan: Exclude<SidebarThreadDropPlan, { readonly kind: "none" }>,
  commands: SidebarDropCommands,
): Promise<void> {
  switch (plan.kind) {
    case "settle":
      if (!(await commands.settle())) return;
      if (plan.unsnooze) await commands.unsnooze();
      return;
    case "unpark":
      if (plan.unpin && !(await commands.unpin())) return;
      if (plan.unsettle && !(await commands.unsettle())) return;
      if (plan.unsnooze) await commands.unsnooze();
      return;
    case "move-active":
      if (plan.joinsSection !== undefined) {
        // The section move sets membership and clears what outranks it; it is the only definition
        // of those steps. A refusal or failure writes nothing else.
        if (!(await commands.joinSection(plan.joinsSection))) return;
        commands.joined();
        break;
      }
      if (plan.clearsSection !== undefined && !(await commands.clearSection())) return;
      if (plan.unpin && !(await commands.unpin())) return;
      if (plan.unsettle && !(await commands.unsettle())) return;
      if (plan.unsnooze && !(await commands.unsnooze())) return;
      break;
    case "pin":
      if (!(await commands.pin(plan.orderKey))) return;
      break;
    case "reorder-pinned":
      break;
  }
  const keyWrites = plan.kind === "pin" ? plan.extraAssignments : plan.assignments;
  const write = plan.kind === "move-active" ? commands.reorderActive : commands.reorderPinned;
  for (const { id, orderKey } of keyWrites) {
    if (!(await write(id, orderKey))) return;
  }
}

export function shouldReleaseOptimisticDrop(input: {
  readonly drop: SidebarOptimisticDrop;
  readonly thread: SidebarThreadSummary | undefined;
  readonly now: string;
  readonly customSectionIds: ReadonlySet<string>;
  /** Destination row keys in displayed order. */
  readonly destinationKeys: readonly string[];
  /** Canonical order key per destination row. */
  readonly keyByThread: ReadonlyMap<string, string | null>;
  /** The raw Queue still lists the dropped thread. */
  readonly queued: boolean;
}): boolean {
  const { drop, thread } = input;
  if (thread === undefined || thread.archivedAt !== null) return true;
  // A Queue join leaves the Queue in `joined`, after the optimistic membership write, so a hold
  // released on membership alone would show the row back in the Queue for a round trip. It ends
  // with its command sequence instead, a refused or failed join included.
  if (isCustomSidebarSection(drop.section) && input.queued) return false;
  // A peer moved the thread into another section: our clear lost, stop pretending.
  if (
    drop.clearsSection !== null &&
    thread.sidebarSectionId != null &&
    thread.sidebarSectionId !== drop.clearsSection
  ) {
    return true;
  }
  const canonicalSection = canonicalSidebarSection(thread, input.now, input.customSectionIds);
  if (canonicalSection !== drop.sourceSection && canonicalSection !== drop.section) return true;
  const clearPending = drop.clearsSection !== null && thread.sidebarSectionId != null;
  // Key writes run only after every lifecycle command (the clear included) succeeded, so once
  // they have all landed, whatever canonical state shows now is a peer's: stop holding. A key
  // the thread already held (dropped back into its old slot) proves nothing, so it never counts.
  const allAssignmentsLanded = [...drop.assignedKeys].every(
    ([threadKey, orderKey]) => input.keyByThread.get(threadKey) === orderKey,
  );
  const writesNewKey = [...drop.assignedKeys].some(
    ([threadKey, orderKey]) => (drop.keysAtDrop.get(threadKey) ?? null) !== orderKey,
  );
  if (drop.order !== null && writesNewKey && allAssignmentsLanded) return true;
  if (drop.order === null) {
    // Settle also emits unpin/unsnooze events. Wait for the entire move.
    return (
      canonicalSection === drop.section &&
      thread.pinnedAt == null &&
      (!drop.clearsSnooze || thread.snoozedUntil == null) &&
      !clearPending
    );
  }
  if (canonicalSection !== drop.section) return false;
  if (drop.clearsSnooze && thread.snoozedUntil != null) return false;
  if (clearPending) return false;
  const heldKeys = new Set(drop.order);
  const membershipChanged =
    input.destinationKeys.length !== drop.order.length ||
    input.destinationKeys.some((key) => !heldKeys.has(key));
  const foreignKeyLanded = input.destinationKeys.some((threadKey) => {
    const currentKey = input.keyByThread.get(threadKey) ?? null;
    if (currentKey === (drop.keysAtDrop.get(threadKey) ?? null)) return false;
    return currentKey !== drop.assignedKeys.get(threadKey);
  });
  return membershipChanged || foreignKeyLanded || allAssignmentsLanded;
}

type SidebarProject = {
  id: string;
  title: string;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
};

type ScopedSidebarProject = SidebarProject & {
  environmentId: string;
};

type ScopedSidebarThread = ThreadSortInput & {
  environmentId: string;
  projectId: string;
  archivedAt: string | null;
};

type LogicalSidebarProject = SidebarProject & {
  projectKey: string;
  memberProjectRefs: readonly {
    environmentId: string;
    projectId: string;
  }[];
};

export type ThreadTraversalDirection = "previous" | "next";

/**
 * Shared-worktree checks must exclude only successful deletions, never the
 * whole batch. A null result skips an entry that the caller can no longer find.
 */
export async function deleteSelectedThreadEntries<
  TEntry extends { readonly threadKey: string },
>(input: {
  entries: readonly TEntry[];
  delete: (
    entry: TEntry,
    deletedThreadKeys: ReadonlySet<string>,
  ) => Promise<AtomCommandResult<unknown, unknown> | null>;
}) {
  const deletedThreadKeys = new Set<string>();
  let firstFailure: AsyncResult.Failure<unknown, unknown> | null = null;

  for (const entry of input.entries) {
    const result = await input.delete(entry, deletedThreadKeys);
    if (result === null) continue;
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) break;
      firstFailure ??= result;
      continue;
    }
    deletedThreadKeys.add(entry.threadKey);
  }

  return { deletedThreadKeys, firstFailure };
}

export async function archiveSelectedThreadEntries<
  TEntry extends { readonly threadKey: string },
  TResult extends { readonly _tag: "Success" | "Failure" },
>(input: {
  entries: readonly TEntry[];
  archive: (entry: TEntry, onArchived: () => void) => Promise<TResult>;
}): Promise<{
  archivedThreadKeys: readonly string[];
  mutationFailure: Extract<TResult, { readonly _tag: "Failure" }> | null;
  followupFailures: readonly Extract<TResult, { readonly _tag: "Failure" }>[];
}> {
  const archivedThreadKeys: string[] = [];
  const followupFailures: Extract<TResult, { readonly _tag: "Failure" }>[] = [];

  for (const entry of input.entries) {
    let didArchive = false;
    const result = await input.archive(entry, () => {
      didArchive = true;
    });
    if (didArchive || result._tag === "Success") archivedThreadKeys.push(entry.threadKey);
    if (result._tag === "Success") continue;
    const failure = result as Extract<TResult, { readonly _tag: "Failure" }>;
    if (didArchive) {
      followupFailures.push(failure);
      continue;
    }
    return { archivedThreadKeys, mutationFailure: failure, followupFailures };
  }

  return { archivedThreadKeys, mutationFailure: null, followupFailures };
}

export function buildMultiSelectThreadContextMenuItems(input: {
  count: number;
  hasRunningThread: boolean;
}): readonly ContextMenuItem<"mark-unread" | "archive" | "delete">[] {
  return [
    { id: "mark-unread", label: `Mark unread (${input.count})` },
    {
      id: "archive",
      label: `Archive (${input.count})`,
      disabled: input.hasRunningThread,
    },
    { id: "delete", label: `Delete (${input.count})`, destructive: true },
  ];
}

export function isSidebarSubagentThread(thread: Pick<SidebarThreadSummary, "lineage">): boolean {
  return thread.lineage.relationshipToParent === "subagent";
}

export function filterSidebarV2VisibleThreads<
  T extends Pick<SidebarThreadSummary, "archivedAt" | "lineage"> & {
    environmentId: string;
    projectId: string;
  },
>(threads: readonly T[], scopedProjectKeys: ReadonlySet<string> | null): T[] {
  return threads.filter(
    (thread) =>
      thread.archivedAt === null &&
      !isSidebarSubagentThread(thread) &&
      (scopedProjectKeys === null ||
        scopedProjectKeys.has(`${thread.environmentId}:${thread.projectId}`)),
  );
}

/** The threads the sidebar lists in their sections, and the rows a drop may write keys for, by
    capability. The key sets are built before the queued filter: a Queue row dropped into Pinned
    or Active writes its key too. */
export function sidebarListedThreads<
  T extends Parameters<typeof filterSidebarV2VisibleThreads>[0][number] & {
    environmentId: EnvironmentId;
    id: ThreadId;
  },
>(input: {
  readonly threads: readonly T[];
  readonly scopedProjectKeys: ReadonlySet<string> | null;
  readonly queuedKeys: ReadonlySet<string>;
  readonly capabilitiesOf: (environmentId: EnvironmentId) =>
    | {
        readonly threadPinning?: boolean;
        readonly threadPinReorder?: boolean;
        readonly threadActiveReorder?: boolean;
      }
    | undefined;
}): { readonly visible: T[]; readonly pinned: Set<string>; readonly active: Set<string> } {
  const visible: T[] = [];
  const pinned = new Set<string>();
  const active = new Set<string>();
  for (const thread of filterSidebarV2VisibleThreads(input.threads, input.scopedProjectKeys)) {
    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    const capabilities = input.capabilitiesOf(thread.environmentId);
    if (capabilities?.threadActiveReorder === true) active.add(key);
    // Older servers retain their existing drag actions. Active placement
    // additionally requires its own ordering capability at the drop target.
    if (capabilities?.threadPinning === true && capabilities.threadPinReorder === true) {
      pinned.add(key);
    }
    if (!input.queuedKeys.has(key)) visible.push(thread);
  }
  return { visible, pinned, active };
}

export function getSidebarForkParentThreadId(
  thread: Pick<SidebarThreadSummary, "forkedFrom" | "lineage">,
) {
  if (thread.lineage.relationshipToParent !== "fork") {
    return null;
  }
  return thread.forkedFrom?.type === "run"
    ? thread.forkedFrom.threadId
    : thread.lineage.parentThreadId;
}

export function buildBulkTitleRegenerationContextMenuItem(input: {
  supportedCount: number;
  actionableCount: number;
}): ContextMenuItem<"regenerate-title"> | null {
  if (input.supportedCount === 0) return null;
  if (input.actionableCount === 0) {
    return {
      id: "regenerate-title",
      label: `Regenerating… (${input.supportedCount})`,
      disabled: true,
    };
  }
  return {
    id: "regenerate-title",
    label: `Regenerate titles (${input.actionableCount})`,
  };
}

/**
 * Bulk unpin follows the same "count only what the action will touch" rule
 * as title regeneration: on a mixed selection the label counts the pinned
 * rows alone, and the item disappears when nothing selected is pinned.
 */
export function buildBulkUnpinContextMenuItem(input: {
  pinnedCount: number;
}): ContextMenuItem<"unpin"> | null {
  if (input.pinnedCount === 0) return null;
  return { id: "unpin", label: `Unpin (${input.pinnedCount})` };
}

export interface ThreadStatusPill {
  label:
    | "Working"
    | "Connecting"
    | "Completed"
    | "Pending Approval"
    | "Awaiting Input"
    | "Waiting"
    | "Plan Ready";
  colorClass: string;
  dotClass: string;
  pulse: boolean;
}

const THREAD_STATUS_PRIORITY: Record<ThreadStatusPill["label"], number> = {
  "Pending Approval": 5,
  "Awaiting Input": 4,
  Working: 3,
  Connecting: 3,
  Waiting: 2.5,
  "Plan Ready": 2,
  Completed: 1,
};

type ThreadStatusInput = Pick<
  SidebarThreadSummary,
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "interactionMode"
  | "latestRun"
  | "runtime"
> & {
  lastVisitedAt?: string | null | undefined;
  pendingBackgroundTasks?: SidebarThreadSummary["pendingBackgroundTasks"] | undefined;
};

export interface ThreadJumpHintVisibilityController {
  sync: (shouldShow: boolean) => void;
  dispose: () => void;
}

export function resolveSidebarStageBadgeLabel(input: {
  primaryServerVersion: string | null | undefined;
  fallbackStageLabel: string;
}): string {
  return resolveServerBackedAppStageLabel(input);
}

export function createThreadJumpHintVisibilityController(input: {
  delayMs: number;
  onVisibilityChange: (visible: boolean) => void;
  setTimeoutFn?: typeof globalThis.setTimeout;
  clearTimeoutFn?: typeof globalThis.clearTimeout;
}): ThreadJumpHintVisibilityController {
  const setTimeoutFn = input.setTimeoutFn ?? globalThis.setTimeout;
  const clearTimeoutFn = input.clearTimeoutFn ?? globalThis.clearTimeout;
  let isVisible = false;
  let timeoutId: NodeJS.Timeout | null = null;

  const clearPendingShow = () => {
    if (timeoutId === null) {
      return;
    }
    clearTimeoutFn(timeoutId);
    timeoutId = null;
  };

  return {
    sync: (shouldShow) => {
      if (!shouldShow) {
        clearPendingShow();
        if (isVisible) {
          isVisible = false;
          input.onVisibilityChange(false);
        }
        return;
      }

      if (isVisible || timeoutId !== null) {
        return;
      }

      timeoutId = setTimeoutFn(() => {
        timeoutId = null;
        isVisible = true;
        input.onVisibilityChange(true);
      }, input.delayMs);
    },
    dispose: () => {
      clearPendingShow();
    },
  };
}

export function useThreadJumpHintVisibility(): {
  showThreadJumpHints: boolean;
  updateThreadJumpHintsVisibility: (shouldShow: boolean) => void;
} {
  const [showThreadJumpHints, setShowThreadJumpHints] = React.useState(false);
  const controllerRef = React.useRef<ThreadJumpHintVisibilityController | null>(null);

  React.useEffect(() => {
    const controller = createThreadJumpHintVisibilityController({
      delayMs: THREAD_JUMP_HINT_SHOW_DELAY_MS,
      onVisibilityChange: (visible) => {
        setShowThreadJumpHints(visible);
      },
      setTimeoutFn: window.setTimeout.bind(window),
      clearTimeoutFn: window.clearTimeout.bind(window),
    });
    controllerRef.current = controller;

    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, []);

  const updateThreadJumpHintsVisibility = React.useCallback((shouldShow: boolean) => {
    controllerRef.current?.sync(shouldShow);
  }, []);

  return {
    showThreadJumpHints,
    updateThreadJumpHintsVisibility,
  };
}

/**
 * Effective visited watermark for a thread. Servers with visited tracking
 * project `lastVisitedAt` on the shell and are authoritative — that value is
 * shared across every device connected to the environment. Pre-tracking
 * servers omit the field, and the browser's locally persisted watermark keeps
 * working as before.
 */
export function resolveThreadLastVisitedAt(
  serverLastVisitedAt: string | null | undefined,
  localLastVisitedAt: string | undefined,
): string | undefined {
  // When the server tracks visits it is authoritative — including explicit
  // rewinds from mark-unread, which a newer browser-local watermark must not
  // mask. The local value only carries servers without visited tracking.
  if (serverLastVisitedAt === undefined) return localLastVisitedAt;
  return serverLastVisitedAt ?? undefined;
}

export function hasUnseenCompletion(thread: ThreadStatusInput): boolean {
  if (!thread.latestRun?.completedAt) return false;
  const completedAt = Date.parse(thread.latestRun.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!thread.lastVisitedAt) return false;

  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

export function shouldClearThreadSelectionOnMouseDown(target: HTMLElement | null): boolean {
  if (target === null) return true;
  return !target.closest(THREAD_SELECTION_SAFE_SELECTOR);
}

// A double-click dispatches two `click` events before `dblclick`: the first has
// `detail === 1`, the second `detail === 2`. The second click must not run the
// row's single-click navigation, otherwise double-click-to-rename would also
// navigate. `MouseEvent.detail` is 0 for synthetic/keyboard activations, which
// still count as a normal single activation.
export function isTrailingDoubleClick(detail: number): boolean {
  return detail > 1;
}

function nodeClosest(node: object | null, selector: string): unknown {
  if (node === null || !("closest" in node) || typeof node.closest !== "function") return null;
  return node.closest(selector);
}

/** Clicks on a nested link keep the link's meaning. The row must not treat them as multi-select. */
export function isSidebarNestedLinkClick(target: EventTarget | null): boolean {
  if (target == null || typeof target !== "object") return false;
  if (nodeClosest(target, "a[href]") !== null) return true;
  const parent =
    "parentElement" in target &&
    target.parentElement !== null &&
    typeof target.parentElement === "object"
      ? target.parentElement
      : null;
  return nodeClosest(parent, "a[href]") !== null;
}

// Shift+click on the new thread button creates directly in the current
// project, skipping the command palette's project picker. With a single
// project there is nothing to pick, so a plain click already creates
// immediately and the modifier changes nothing.
export function shouldCreateNewThreadInCurrentProject(
  shiftKey: boolean,
  projectGroupCount: number,
): boolean {
  return shiftKey || projectGroupCount <= 1;
}

export function orderItemsByPreferredIds<TItem, TId>(input: {
  items: readonly TItem[];
  preferredIds: readonly TId[];
  getId: (item: TItem) => TId;
  getPreferenceIds?: (item: TItem) => readonly TId[];
}): TItem[] {
  const { getId, getPreferenceIds, items, preferredIds } = input;
  if (preferredIds.length === 0) {
    return [...items];
  }

  const indexesByPreferenceId = new Map<TId, number[]>();
  for (const [index, item] of items.entries()) {
    const preferenceIds = getPreferenceIds?.(item) ?? [getId(item)];
    for (const preferenceId of new Set(preferenceIds)) {
      const indexes = indexesByPreferenceId.get(preferenceId);
      if (indexes) {
        indexes.push(index);
      } else {
        indexesByPreferenceId.set(preferenceId, [index]);
      }
    }
  }

  const emittedIndexes = new Set<number>();
  const ordered = preferredIds.flatMap((id) => {
    const index = indexesByPreferenceId
      .get(id)
      ?.find((candidate) => !emittedIndexes.has(candidate));
    if (index === undefined) {
      return [];
    }
    emittedIndexes.add(index);
    return [items[index]!];
  });
  const remaining = items.filter((_, index) => !emittedIndexes.has(index));
  return [...ordered, ...remaining];
}

export function getSidebarThreadIdsToPrewarm<TThreadId>(
  visibleThreadIds: readonly TThreadId[],
  limit = SIDEBAR_THREAD_PREWARM_LIMIT,
): TThreadId[] {
  return visibleThreadIds.slice(0, Math.max(0, limit));
}

export function resolveAdjacentThreadId<T>(input: {
  threadIds: readonly T[];
  currentThreadId: T | null;
  direction: ThreadTraversalDirection;
}): T | null {
  const { currentThreadId, direction, threadIds } = input;

  if (threadIds.length === 0) {
    return null;
  }

  if (currentThreadId === null) {
    return direction === "previous" ? (threadIds.at(-1) ?? null) : (threadIds[0] ?? null);
  }

  const currentIndex = threadIds.indexOf(currentThreadId);
  if (currentIndex === -1) {
    return null;
  }

  if (direction === "previous") {
    return currentIndex > 0 ? (threadIds[currentIndex - 1] ?? null) : null;
  }

  return currentIndex < threadIds.length - 1 ? (threadIds[currentIndex + 1] ?? null) : null;
}

export function isContextMenuPointerDown(input: {
  button: number;
  ctrlKey: boolean;
  isMac: boolean;
}): boolean {
  if (input.button === 2) return true;
  return input.isMac && input.button === 0 && input.ctrlKey;
}

export function resolveThreadRowClassName(input: {
  isActive: boolean;
  isSelected: boolean;
}): string {
  const baseClassName =
    "h-8 w-full translate-x-0 cursor-pointer justify-start rounded-md px-2 text-left text-sm select-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";

  if (input.isSelected && input.isActive) {
    return cn(
      baseClassName,
      "bg-sidebar-row-active text-sidebar-foreground font-medium hover:bg-sidebar-row-active hover:text-sidebar-foreground",
    );
  }

  if (input.isSelected) {
    return cn(
      baseClassName,
      "bg-sidebar-row-selected text-sidebar-foreground hover:bg-sidebar-row-active hover:text-sidebar-foreground",
    );
  }

  if (input.isActive) {
    return cn(
      baseClassName,
      "bg-sidebar-row-active text-sidebar-foreground font-medium hover:bg-sidebar-row-active hover:text-sidebar-foreground",
    );
  }

  return cn(
    baseClassName,
    "text-sidebar-muted-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
  );
}

// ── Sidebar v2 status model ─────────────────────────────────────────
// Six visual states, three colors: color is reserved for "act now"
// (approval), "in motion" (working), and "broken" (failed). Ready is the
// unlabeled resting state — the agent stopped and is waiting on the user,
// whether it finished, asked a question, or proposed a plan. Waiting
// (runtime status "idle") is the agent stopped with background work that will
// wake it (subagents, monitors): not the user's turn yet, so it renders grey
// like working, not as a false Done. Commands it left running, such as a dev
// server, do not hold the thread; it reads as ready.
// Unread completion is tracked separately: it describes whether a ready
// thread needs attention, not what the thread is currently doing.
export type SidebarThreadStatus =
  | "approval"
  | "input"
  | "working"
  | "waiting"
  | "failed"
  | "limited"
  | "ready";

export function shouldRecedeSidebarThread(input: {
  status: SidebarThreadStatus;
  isUnread: boolean;
  isWoke: boolean;
  isActive: boolean;
  isSelected: boolean;
}): boolean {
  if (input.isActive || input.isSelected || input.status === "input") return false;
  if (input.status === "working" || input.status === "waiting") return true;
  if (input.status === "ready" || input.status === "approval") {
    return !input.isUnread && !input.isWoke;
  }
  return false;
}

type SidebarThreadStatusInput = Pick<
  SidebarThreadSummary,
  "hasPendingApprovals" | "hasPendingUserInput" | "runtime"
>;

export function resolveSidebarThreadStatus(thread: SidebarThreadStatusInput): SidebarThreadStatus {
  if (thread.hasPendingApprovals) {
    return "approval";
  }
  if (thread.hasPendingUserInput) {
    return "input";
  }
  if (
    thread.runtime !== null &&
    ["preparing", "queued", "starting", "running", "waiting"].includes(thread.runtime.status)
  ) {
    return "working";
  }
  if (thread.runtime?.status === "idle") {
    return "waiting";
  }
  if (thread.runtime?.status === "failed") {
    return thread.runtime.lastErrorClass === "usage_limit" ? "limited" : "failed";
  }
  return "ready";
}

export type SidebarV2TopStatusKind =
  | "approval"
  | "done"
  | "failed"
  | "limited"
  | "input"
  | "waiting"
  | "woke"
  | "working";

export function resolveSidebarV2TopStatus(input: {
  readonly status: SidebarThreadStatus;
  readonly isUnread: boolean;
  readonly isWoke: boolean;
}): SidebarV2TopStatusKind | null {
  if (input.status === "working") {
    return "working";
  }
  if (input.status === "waiting") {
    return "waiting";
  }
  if (input.status === "approval") {
    return "approval";
  }
  if (input.status === "input") {
    return "input";
  }
  if (input.status === "failed" || input.status === "limited") {
    return input.status;
  }
  if (input.isWoke) {
    return "woke";
  }
  return input.isUnread ? "done" : null;
}

export function shouldShowSidebarV2Duration(status: SidebarThreadStatus): boolean {
  return status === "working";
}

/** First VALID timestamp wins: `a ?? b` falls through on null, but a present-
    yet-malformed string must also fall through to the next candidate rather
    than sink the row to the epoch. */
export function firstValidTimestampMs(
  ...candidates: ReadonlyArray<string | null | undefined>
): number {
  for (const candidate of candidates) {
    if (candidate == null) continue;
    const parsed = Date.parse(candidate);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

export { sortActiveThreadsByOrderKey as sortThreadsForSidebar } from "@t3tools/client-runtime/state/thread-sort";
// The Working section beta folds and orders the inbox the same way on mobile.
export {
  isThreadWorking as isSidebarThreadWorking,
  sortInboxThreadsByReturn,
  sortWorkingThreadsBySend,
} from "@t3tools/client-runtime/state/thread-inbox";

// Pinned-reorder key math and the keyed sort live in client-runtime
// (state/thread-sort) so web and mobile compute identical pinned orders.
export { pinOrderKeyBetween } from "@t3tools/client-runtime/state/thread-sort";
export { sortPinnedThreadsByOrderKey as sortPinnedThreadsForSidebar } from "@t3tools/client-runtime/state/thread-sort";

const EMPTY_CONTENT_MATCH_KEYS: ReadonlySet<string> = new Set<string>();

/**
 * Search the already-ordered sidebar thread collection by title or linked PR,
 * plus any thread whose messages the server matched (`contentMatchKeys`, keyed
 * by `threadSearchMatchKey`). Keeping the input order means lifecycle ordering
 * (active, snoozed, settled) remains stable while the user narrows the list.
 */
export function searchSidebarThreads<
  T extends {
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
    readonly title: string;
  } & Parameters<typeof threadPullRequestSearchTerms>[0],
>(
  threads: readonly T[],
  query: string,
  contentMatchKeys: ReadonlySet<string> = EMPTY_CONTENT_MATCH_KEYS,
): T[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) return [];
  const titleMatches: T[] = [];
  const contentMatches: T[] = [];
  for (const thread of threads) {
    const matchesTitle = [thread.title, ...threadPullRequestSearchTerms(thread)].some((term) =>
      term.toLowerCase().includes(normalizedQuery),
    );
    if (matchesTitle) {
      titleMatches.push(thread);
    } else if (
      contentMatchKeys.size > 0 &&
      contentMatchKeys.has(
        threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
      )
    ) {
      contentMatches.push(thread);
    }
  }
  return [...titleMatches, ...contentMatches];
}

export function filterSidebarProjectScopeItems<TItem extends { readonly value: string }>(input: {
  items: readonly TItem[];
  query: string;
  matches: (item: TItem, query: string) => boolean;
}): readonly TItem[] {
  const query = input.query.trim();
  if (query.length === 0) return input.items;
  return input.items.filter((item) => item.value !== "all" && input.matches(item, query));
}

export interface SidebarProjectScopeMenuState {
  readonly open: boolean;
  readonly query: string;
}

export type SidebarProjectScopeMenuAction =
  | { readonly type: "query-changed"; readonly query: string }
  | { readonly type: "open-changed"; readonly open: boolean }
  | { readonly type: "project-settings-opened" };

export function reduceSidebarProjectScopeMenuState(
  state: SidebarProjectScopeMenuState,
  action: SidebarProjectScopeMenuAction,
): SidebarProjectScopeMenuState {
  switch (action.type) {
    case "query-changed":
      return { ...state, query: action.query };
    case "open-changed":
      return { open: action.open, query: "" };
    case "project-settings-opened":
      return { open: false, query: "" };
  }
}

/** The timestamp a working thread's elapsed label counts from: when its
    current work started (request time until adoption). Background wakes do
    not reset it. Malformed timestamps fall through to the next candidate. */
export function resolveWorkingStartedAt(
  thread: Pick<SidebarThreadSummary, "latestRun" | "runtime">,
): string | null {
  return resolveThreadWorkingStartedAt(thread);
}

export function formatWorkingDurationLabel(elapsedMs: number): string {
  const seconds = Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs / 1000)) : 0;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function resolveThreadStatusPill(input: {
  thread: ThreadStatusInput;
}): ThreadStatusPill | null {
  const { thread } = input;

  if (thread.hasPendingApprovals) {
    return {
      label: "Pending Approval",
      colorClass: "text-amber-600 dark:text-amber-300/90",
      dotClass: "bg-amber-500 dark:bg-amber-300/90",
      pulse: false,
    };
  }

  if (thread.hasPendingUserInput) {
    return {
      label: "Awaiting Input",
      colorClass: "text-indigo-600 dark:text-indigo-300/90",
      dotClass: "bg-indigo-500 dark:bg-indigo-300/90",
      pulse: false,
    };
  }

  if (thread.runtime?.status === "running" || thread.runtime?.status === "waiting") {
    return {
      label: "Working",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  if (
    thread.runtime?.status === "preparing" ||
    thread.runtime?.status === "starting" ||
    thread.runtime?.status === "queued"
  ) {
    return {
      label: "Connecting",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  if (backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? [])) {
    return {
      label: "Waiting",
      colorClass: "text-sidebar-muted-foreground",
      dotClass: "bg-sidebar-muted-foreground",
      pulse: false,
    };
  }

  const hasPlanReadyPrompt =
    !thread.hasPendingUserInput &&
    thread.interactionMode === "plan" &&
    isLatestRunSettled(thread.latestRun, thread.runtime) &&
    thread.hasActionableProposedPlan;
  if (hasPlanReadyPrompt) {
    return {
      label: "Plan Ready",
      colorClass: "text-violet-600 dark:text-violet-300/90",
      dotClass: "bg-violet-500 dark:bg-violet-300/90",
      pulse: false,
    };
  }

  if (hasUnseenCompletion(thread)) {
    return {
      label: "Completed",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      dotClass: "bg-emerald-500 dark:bg-emerald-300/90",
      pulse: false,
    };
  }

  return null;
}

export function resolveProjectStatusIndicator(
  statuses: ReadonlyArray<ThreadStatusPill | null>,
): ThreadStatusPill | null {
  let highestPriorityStatus: ThreadStatusPill | null = null;

  for (const status of statuses) {
    if (status === null) continue;
    if (
      highestPriorityStatus === null ||
      THREAD_STATUS_PRIORITY[status.label] > THREAD_STATUS_PRIORITY[highestPriorityStatus.label]
    ) {
      highestPriorityStatus = status;
    }
  }

  return highestPriorityStatus;
}

export function getFallbackThreadIdAfterDelete<
  T extends Pick<Thread, "id" | "projectId" | "createdAt" | "updatedAt"> & ThreadSortInput,
>(input: {
  threads: readonly T[];
  deletedThreadId: T["id"];
  sortOrder: SidebarThreadSortOrder;
  deletedThreadIds?: ReadonlySet<T["id"]>;
}): T["id"] | null {
  const { deletedThreadId, deletedThreadIds, sortOrder, threads } = input;
  const deletedThread = threads.find((thread) => thread.id === deletedThreadId);
  if (!deletedThread) {
    return null;
  }

  return (
    sortThreads(
      threads.filter(
        (thread) =>
          thread.projectId === deletedThread.projectId &&
          thread.id !== deletedThreadId &&
          !deletedThreadIds?.has(thread.id),
      ),
      sortOrder,
    )[0]?.id ?? null
  );
}
export function getProjectSortTimestamp(
  project: SidebarProject,
  projectThreads: readonly ThreadSortInput[],
  sortOrder: Exclude<SidebarProjectSortOrder, "manual">,
): number {
  if (projectThreads.length > 0) {
    return projectThreads.reduce(
      (latest, thread) => Math.max(latest, getThreadSortTimestamp(thread, sortOrder)),
      Number.NEGATIVE_INFINITY,
    );
  }

  if (sortOrder === "created_at") {
    return toSortableTimestamp(project.createdAt) ?? Number.NEGATIVE_INFINITY;
  }
  return toSortableTimestamp(project.updatedAt ?? project.createdAt) ?? Number.NEGATIVE_INFINITY;
}

function sortProjectsByActivity<TProject extends SidebarProject>(
  projects: readonly TProject[],
  sortOrder: SidebarProjectSortOrder,
  getProjectThreads: (project: TProject) => readonly ThreadSortInput[],
  compareTies: (left: TProject, right: TProject) => number,
): TProject[] {
  if (sortOrder === "manual") {
    return [...projects];
  }

  // Each project's timestamp walks all of its threads, so compute it once
  // per project instead of once per comparison.
  return projects
    .map((project) => ({
      project,
      timestamp: getProjectSortTimestamp(project, getProjectThreads(project), sortOrder),
    }))
    .sort((left, right) => {
      const byTimestamp =
        right.timestamp === left.timestamp ? 0 : right.timestamp > left.timestamp ? 1 : -1;
      return byTimestamp || compareTies(left.project, right.project);
    })
    .map(({ project }) => project);
}

export function sortProjectsForSidebar<
  TProject extends SidebarProject,
  TThread extends Pick<Thread, "projectId" | "createdAt" | "updatedAt"> & ThreadSortInput,
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: SidebarProjectSortOrder,
): TProject[] {
  const threadsByProjectId = new Map<string, TThread[]>();
  for (const thread of threads) {
    const existing = threadsByProjectId.get(thread.projectId) ?? [];
    existing.push(thread);
    threadsByProjectId.set(thread.projectId, existing);
  }

  return sortProjectsByActivity(
    projects,
    sortOrder,
    (project) => threadsByProjectId.get(project.id) ?? [],
    (left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id),
  );
}

export function sortLogicalProjectsForSidebar<
  TProject extends LogicalSidebarProject,
  TThread extends ScopedSidebarThread,
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: SidebarProjectSortOrder,
): TProject[] {
  const groupKeyByProjectRef = new Map(
    projects.flatMap((project) =>
      project.memberProjectRefs.map(
        (projectRef) =>
          [`${projectRef.environmentId}\0${projectRef.projectId}`, project.projectKey] as const,
      ),
    ),
  );
  const threadsByProjectKey = new Map<string, TThread[]>();
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    const projectKey = groupKeyByProjectRef.get(`${thread.environmentId}\0${thread.projectId}`);
    if (!projectKey) continue;
    const existing = threadsByProjectKey.get(projectKey);
    if (existing) {
      existing.push(thread);
    } else {
      threadsByProjectKey.set(projectKey, [thread]);
    }
  }

  return sortProjectsByActivity(
    projects,
    sortOrder,
    (project) => threadsByProjectKey.get(project.projectKey) ?? [],
    (left, right) =>
      left.title.localeCompare(right.title) || left.projectKey.localeCompare(right.projectKey),
  );
}

export function sortSidebarV2ProjectGroups<
  TProject extends LogicalSidebarProject,
  TThread extends ScopedSidebarThread & Pick<SidebarThreadSummary, "lineage">,
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: SidebarProjectSortOrder,
): TProject[] {
  return sortLogicalProjectsForSidebar(
    projects,
    filterSidebarV2VisibleThreads(threads, null),
    sortOrder,
  );
}

/**
 * Sorts the cross-environment project collection used by landing surfaces.
 * Project ids are only unique within an environment, and archived threads
 * must not make a project appear recently active.
 */
export function sortScopedProjectsForSidebar<
  TProject extends ScopedSidebarProject,
  TThread extends ScopedSidebarThread,
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: SidebarProjectSortOrder,
): TProject[] {
  const scopedKey = (environmentId: string, projectId: string) =>
    `${environmentId}\u0000${projectId}`;
  const threadsByProject = new Map<string, TThread[]>();
  for (const thread of threads) {
    if (thread.archivedAt !== null) {
      continue;
    }
    const key = scopedKey(thread.environmentId, thread.projectId);
    const existing = threadsByProject.get(key) ?? [];
    existing.push(thread);
    threadsByProject.set(key, existing);
  }

  return sortProjectsByActivity(
    projects,
    sortOrder,
    (project) => threadsByProject.get(scopedKey(project.environmentId, project.id)) ?? [],
    (left, right) =>
      left.title.localeCompare(right.title) ||
      left.environmentId.localeCompare(right.environmentId) ||
      left.id.localeCompare(right.id),
  );
}
