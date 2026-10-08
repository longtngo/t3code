import { closestCenter, type CollisionDetection, type Modifier } from "@dnd-kit/core";
import { verticalListSortingStrategy, type SortingStrategy } from "@dnd-kit/sortable";
import {
  customSidebarSection,
  isCustomSidebarSection,
  resolveSidebarDropTarget,
  sidebarListItemId,
  sidebarMarkerId,
  type CustomSidebarSection,
  type SidebarListItem,
  type SidebarListMarker,
  type SidebarSection,
} from "./Sidebar.logic";

const stationary = { x: 0, y: 0, scaleX: 1, scaleY: 1 };
/** The empty Snoozed shelf's placeholder, by sortable id. */
export const SNOOZED_PLACEHOLDER_ID = sidebarMarkerId("snoozed-placeholder");
const hidden = { ...stationary, scaleY: 0 };
type ThreadItem = Extract<SidebarListItem, { kind: "thread" }>;
type Layout = Parameters<SortingStrategy>[0];
/** Where the shelves start (the auto margin): a shelf header, or the empty Snoozed shelf's
 * placeholder. A custom-section header is not a shelf: its block sits in the list flow under
 * Active and carries no auto margin. */
const isShelfHeader = (item: SidebarListItem | undefined) =>
  item?.kind === "marker" &&
  (item.marker === "working-header" ||
    item.marker === "snoozed-header" ||
    item.marker === "snoozed-placeholder" ||
    item.marker === "settled-header");

/** How far a previewing drag moves every row below the Pins boundaries: each boundary opens its
 * label (scaled by the measured root scale) plus one gap, and rests at zero height with `-mb-px`.
 * The strategy applies exactly this to every row the shelves' free space does not absorb; the
 * empty Snoozed shelf's hint needs the same room (`sidebarSnoozeHintState`). */
export function sidebarDragLabelsShift(boundaryLabelHeight: number, scale = 1): number {
  return 2 * (boundaryLabelHeight * scale + 1);
}

/** Where the empty Snoozed shelf shows its hint for this drag. One call decides it for the
 * strategy, the hint's paint and its place among the drop zones, so they never disagree.
 * - `closed`: the lifted row may not be snoozed; no hint, no target.
 * - `in-place`: the 36px box resting above the placeholder's li opens in the free space without
 *   pushing the shelves: it clears whatever renders above the li (the whole docked Queue block
 *   when there is one, else the row above) by two gaps plus the label space the same free space
 *   must also give the Pins labels (`labelsShift`).
 * - `at-end`: no such room (a crowded or scrolling list, Working rows right above it, or a free
 *   space the labels need). The box renders out of flow below everything in the list, reached by
 *   autoscroll: opening it moves no row at pickup, and every source keeps a snooze target. */
export type SidebarSnoozeHint = "closed" | "in-place" | "at-end";

export function sidebarSnoozeHintState(input: {
  readonly snoozeAllowed: boolean;
  /** The placeholder's measured box at rest, in its slot. */
  readonly hint: { readonly top: number } | undefined;
  /** The element rendered right before the placeholder's li: the whole docked Queue block (header
   * and rows) when it docks there, else the row above. */
  readonly above: { readonly bottom: number } | undefined;
  /** `sidebarDragLabelsShift` for a main-list drag; 0 for a Queue drag, which never previews. */
  readonly labelsShift: number;
}): SidebarSnoozeHint {
  if (!input.snoozeAllowed || input.hint === undefined) return "closed";
  // Opened, the box sits one gap above its li: it needs its height plus two gaps of free space,
  // on top of what the labels take from the same margin.
  return input.above === undefined || input.hint.top >= input.above.bottom + 2 + input.labelsShift
    ? "in-place"
    : "at-end";
}

/** Keep the lifted card below the Pins label, including when Pins is empty.
 * The container rect follows scrolling; the offset is measured once at pickup. */
export function restrictBelowSidebarLabel(
  { transform, containerNodeRect, draggingNodeRect }: Parameters<Modifier>[0],
  offset: number,
) {
  if (!containerNodeRect || !draggingNodeRect) return transform;
  const minimumY = containerNodeRect.top + offset - draggingNodeRect.top;
  return transform.y < minimumY ? { ...transform, y: minimumY } : transform;
}

/**
 * A drop zone is only real where it is painted. A zone docked at the end of a scrolling list can be
 * laid out beyond its scroller's clip - measured at a 500px viewport, the Queue header sits at
 * 428..460 against a clip ending at 424 for a whole drag, invisible but geometrically live - and a
 * hit test reading only the element's own rect would accept a release the user aimed at whatever is
 * painted there instead.
 */
export function pointerOverVisibleRect(
  node: HTMLElement,
  rect: { left: number; top: number; width: number; height: number },
  pointer: { x: number; y: number },
): boolean {
  if (
    pointer.x < rect.left ||
    pointer.x > rect.left + rect.width ||
    pointer.y < rect.top ||
    pointer.y > rect.top + rect.height
  )
    return false;
  // Only the nearest real clip matters, and only when it has a box to clip with. Walking every
  // non-visible ancestor rejects a legitimate point whenever one of them measures 0x0 - which is
  // what a detached or not-yet-laid-out ancestor reports.
  for (let el = node.parentElement; el !== null; el = el.parentElement) {
    const style = getComputedStyle(el);
    const scrolls = style.overflowY === "auto" || style.overflowY === "scroll";
    if (!scrolls) continue;
    const box = el.getBoundingClientRect();
    // A 0x0 box is a detached or not-yet-laid-out ancestor, not a clip anyone can see through. It
    // is unsound in principle - a 0x0 overflow:auto element does genuinely clip its child - but the
    // walk stops at the sidebar's scroll viewport, which always has a box: swept across seven
    // viewport sizes and the collapsed sidebar, and counted over two live drags (112 and 64 calls),
    // this skip never fired. A collapse on ONE axis is still a real clip and is still checked -
    // narrowing this to either operand alone reddens a test.
    if (box.width === 0 && box.height === 0) continue;
    return (
      pointer.x >= box.left &&
      pointer.x <= box.right &&
      pointer.y >= box.top &&
      pointer.y <= box.bottom
    );
  }
  return true;
}

/** Reject the nearest unsupported target without selecting another section.
 * Recreate this detector when drop eligibility changes. */
export function createSidebarCollisionDetection(
  isValidTarget: (id: string) => boolean,
  options: {
    items?: readonly SidebarListItem[];
    activationY?: number | null;
    /** Drop zones outside the sortable list that win whenever the pointer is inside them. */
    pointerDropIds?: readonly string[];
    /** Sortable ids removed from collision candidates (e.g. queue rows during main-list drags). */
    excludeIds?: readonly string[];
    /** Queue row ids during a Queue drag. While one is nearest, the Pinned/Active switch keeps
     * distance order; a drag from one starts in Active, whatever section it rests in. */
    freeIds?: readonly string[];
  } = {},
): CollisionDetection {
  const validity = new Map<string, boolean>();
  const sections = new Map<string, SidebarSection | null>();
  let previousPointerY = options.activationY;
  let boundarySection: "pinned" | "active" | undefined;
  return (args) => {
    const pointer = args.pointerCoordinates;
    if (pointer && options.pointerDropIds) {
      for (const container of args.droppableContainers) {
        if (!options.pointerDropIds.includes(String(container.id))) continue;
        // Hit-test what is DRAWN, not what was measured. dnd-kit measures droppable rects once per
        // drag, and this test has no tolerance, so any movement afterwards makes the two disagree
        // and the drop lands somewhere the pointer visibly was not. The sidebar list sits within a
        // pixel of its scroll threshold, and rows flipping between their content-visibility
        // intrinsic size and their real height carry it across, which lets the list scroll a couple
        // of pixels mid-drag. The boundary label below is read live for the same reason.
        const node = container.node.current;
        const rect = node?.getBoundingClientRect() ?? args.droppableRects.get(container.id);
        // With no node there is nothing to ask about clipping, so fall back to plain containment
        // rather than making the zone unreachable.
        const inside =
          rect === undefined
            ? false
            : node
              ? pointerOverVisibleRect(node, rect, pointer)
              : pointer.x >= rect.left &&
                pointer.x <= rect.left + rect.width &&
                pointer.y >= rect.top &&
                pointer.y <= rect.top + rect.height;
        if (inside) {
          return [{ id: container.id, data: { droppableContainer: container, value: 0 } }];
        }
      }
    }
    // The empty shelf's placeholder is a zone or nothing, never a list target: its resting box
    // lies over the row above it when there is no free space.
    let collisions = closestCenter(args).filter(
      (collision) =>
        collision.id !== SNOOZED_PLACEHOLDER_ID &&
        !options.pointerDropIds?.includes(String(collision.id)) &&
        !options.excludeIds?.includes(String(collision.id)),
    );
    const items = options.items;
    const source = items?.find((item) => item.kind === "thread" && item.key === args.active.id);
    const boundary = args.droppableContainers
      .find((container) => container.id === sidebarMarkerId("pinned-divider"))
      ?.node.current?.querySelector(".sidebar-drag-boundary-label")
      ?.getBoundingClientRect();
    const overFreeRow =
      collisions[0] !== undefined && options.freeIds?.includes(String(collisions[0].id)) === true;
    if (items && boundary && source?.kind === "thread" && pointer) {
      boundarySection ??=
        source.section === "pinned" && !options.freeIds?.includes(source.key) ? "pinned" : "active";
      // Use the visible divider row, including its sortable translation.
      // Only pointer movement can change sections: opening the destination
      // moves this row, but must not toggle a stationary gesture back.
      const previousY = previousPointerY ?? pointer.y;
      previousPointerY = pointer.y;
      if (pointer.x >= boundary.left && pointer.x <= boundary.right) {
        if (pointer.y < previousY && pointer.y <= boundary.bottom) boundarySection = "pinned";
        else if (pointer.y > previousY && pointer.y >= boundary.top) boundarySection = "active";
        // Active ends at the first block below it: a custom section or a shelf. With that header's
        // node missing (transient), skip the re-rank: a lower header would bound Active below a
        // custom section and let a pointer over it resolve to Active.
        // Not the empty shelf's placeholder: its node is a hint box that can rest over the last
        // row, and its li ends where the Settled header starts anyway.
        const activeEnd = items.find(
          (item) =>
            item.kind === "marker" &&
            (item.marker === "custom-header" ||
              item.marker === "working-header" ||
              item.marker === "snoozed-header" ||
              item.marker === "settled-header"),
        );
        const nextHeader =
          activeEnd === undefined
            ? undefined
            : args.droppableContainers.find(
                (container) => container.id === sidebarListItemId(activeEnd),
              );
        const activeBottom = nextHeader?.node.current?.getBoundingClientRect().top;
        if (
          !overFreeRow &&
          (boundarySection === "pinned" || (activeBottom != null && pointer.y < activeBottom))
        ) {
          const target = collisions.find((collision) => {
            const id = String(collision.id);
            if (!sections.has(id)) {
              sections.set(
                id,
                resolveSidebarDropTarget(items, String(args.active.id), id)?.section ?? null,
              );
            }
            return sections.get(id) === boundarySection;
          });
          if (target)
            collisions = [target, ...collisions.filter((collision) => collision !== target)];
        }
      }
    }
    const nearest = collisions[0];
    if (!nearest || nearest.id === args.active.id) {
      return collisions;
    }
    const id = String(nearest.id);
    const valid = validity.get(id) ?? isValidTarget(id);
    validity.set(id, valid);
    return valid ? collisions : collisions.filter((collision) => collision.id === args.active.id);
  };
}

/** Preview the committed section layout without moving or mounting DOM nodes.
 * A zero scaleY marks rows/markers to hide while retaining their measured nodes. */
export function createSidebarSortingStrategy(input: {
  items: readonly SidebarListItem[];
  /** Suspend the reorder preview while the thread is dragged out as context. */
  enabled?: boolean;
  settledOrder: readonly string[];
  /** Time-ordered inbox (Working beta): where the lifted row would land. */
  activeOrder?: readonly string[];
  settledExpanded: boolean;
  settledVisibleCount?: number;
  routeThreadKey?: string | null;
  snoozedThreadCount?: number;
  cardHeight?: number;
  slimHeight?: number;
  /** Space each pinned boundary opens for its label while dragging. The
   * markers stay zero height at rest, so nothing is reserved until pickup. */
  boundaryLabelHeight?: number;
  /** The measured height of the whole Queue block (header and rows) when it docks right above the
   * first shelf. */
  dockedQueueHeight?: number;
  /** At-end hint only: the measured distance from the last row's bottom to the bottom of the
   * content rendered after the rows (the "Show N more" li, the Queue block placed after every row);
   * 0 when there is none. The end target sits below it. */
  trailingHeight?: number;
  /** Where the Queue block renders (`sidebarQueueBoundary`): the Queue header moves with it. */
  queueBoundary?: SidebarBoundary | null;
  /** While the lifted row may be snoozed: the shelf's drop zones (`sidebarSnoozeZoneIds`).
   * Over a zone the preview projects as `stickyOverId`, so the bottom-anchored zone does not move
   * under the pointer. `hint` is
   * `sidebarSnoozeHintState`'s answer for this drag. Unset: the empty-shelf placeholder stays
   * closed. */
  snooze?: {
    readonly zoneIds: ReadonlySet<string>;
    readonly hint: SidebarSnoozeHint;
  };
  /** The drag state's last list over, the projection over a snooze zone. Sidebar.tsx lists the Queue header in the SortableContext
   * after the rows, so dnd-kit keeps the preview running while it is the over (it rests every row
   * for an over outside the context); such an over, not a list item, projects as this one. Rows
   * that snapped back to rest over the Queue would move a zone next to it when the pointer left. */
  stickyOverId?: string | null;
}): SortingStrategy {
  if (input.enabled === false) return () => stationary;
  const { items } = input;
  const indices = new Map(items.map((item, index) => [sidebarListItemId(item), index]));
  const placeholder = indices.get(SNOOZED_PLACEHOLDER_ID) ?? -1;
  const hint = input.snooze?.hint ?? "closed";
  let previous: Pick<Layout, "rects" | "activeIndex" | "overIndex"> | undefined;
  let transforms: ReturnType<SortingStrategy>[] | null = [];
  const still: ReturnType<SortingStrategy>[] = [];

  function project({
    rects,
    activeIndex,
    overIndex,
  }: Pick<Layout, "rects" | "activeIndex" | "overIndex">): ReturnType<SortingStrategy>[] {
    const active = items[activeIndex];
    const over = items[overIndex] ?? active;
    if (active?.kind !== "thread" || !over || !rects[0]) return still;
    const target = resolveSidebarDropTarget(items, active.key, sidebarListItemId(over));
    if (!target) return still;
    const groups: Record<Exclude<SidebarSection, CustomSidebarSection>, ThreadItem[]> = {
      pinned: [],
      active: [],
      working: [],
      snoozed: [],
      settled: [],
    };
    // Each custom section in list order with its rows; a drop into one lands after `customAfter`.
    const customBlocks: Array<{
      readonly header: SidebarListItem;
      readonly section: CustomSidebarSection;
      readonly rows: ThreadItem[];
    }> = [];
    let cardHeight = input.cardHeight;
    let slimHeight = input.slimHeight;
    let headerScale: number | undefined;
    for (const [index, item] of items.entries()) {
      if (item.kind === "marker") {
        if (isShelfHeader(item) && item.marker !== "snoozed-placeholder") {
          const height = rects[index]?.height;
          if (height) headerScale ??= height / 32;
        }
        if (item.marker === "custom-header")
          customBlocks.push({
            header: item,
            section: customSidebarSection(item.sectionId),
            rows: [],
          });
        continue;
      }
      // A custom row moves with its section's block; a drop into a section opens its slot there.
      if (isCustomSidebarSection(item.section)) {
        cardHeight ??= rects[index]?.height;
        const section = item.section;
        if (item.key !== active.key)
          customBlocks.find((block) => block.section === section)?.rows.push(item);
        continue;
      }
      if (item.section === "pinned" || item.section === "active" || item.section === "working")
        cardHeight ??= rects[index]?.height;
      else slimHeight ??= rects[index]?.height;
      if (item.key !== active.key) groups[item.section].push(item);
    }
    // Cards are 4.875rem + 0.25rem padding; slim rows/placeholders are h-9.
    const scale =
      slimHeight !== undefined ? slimHeight / 36 : (headerScale ?? (cardHeight ?? 82) / 82);
    cardHeight ??= 82 * scale;
    slimHeight ??= 36 * scale;
    const labelHeight = (input.boundaryLabelHeight ?? 0) * scale;
    const moved: ThreadItem = { ...active, section: target.section };
    if (isCustomSidebarSection(target.section)) {
      const block = customBlocks.find((candidate) => candidate.section === target.section);
      const after = target.customAfter ?? null;
      block?.rows.splice(
        after === null ? 0 : block.rows.findIndex((row) => row.key === after) + 1,
        0,
        moved,
      );
    } else {
      const group = groups[target.section];
      const order =
        target.section === "pinned"
          ? target.pinnedOrder
          : target.section === "settled"
            ? input.settledOrder
            : (input.activeOrder ?? target.activeOrder);
      const ranks = new Map(order.map((key, index) => [key, index]));
      const rank = ranks.get(active.key) ?? Number.POSITIVE_INFINITY;
      const index = group.findIndex(
        (item) => (ranks.get(item.key) ?? Number.POSITIVE_INFINITY) > rank,
      );
      group.splice(index < 0 ? group.length : index, 0, moved);
    }
    const settledOrder = (
      input.settledOrder.length > 0 ? input.settledOrder : groups.settled.map((item) => item.key)
    ).filter((key) => key !== active.key || target.section === "settled");
    const visible = input.settledExpanded
      ? settledOrder.slice(0, input.settledVisibleCount ?? settledOrder.length)
      : [];
    const routeKey = input.routeThreadKey;
    if (routeKey && settledOrder.includes(routeKey) && !visible.includes(routeKey)) {
      visible.push(routeKey);
    }
    groups.settled = visible.map((key) => ({ kind: "thread", key, section: "settled" }));
    const projected: SidebarListItem[] = [];
    const marker = (name: SidebarListMarker) => projected.push({ kind: "marker", marker: name });
    const section = (name: "active" | "settled") => {
      if (groups[name].length > 0) projected.push(...groups[name]);
      else marker(`${name}-placeholder`);
    };
    marker("pinned-header");
    projected.push(...groups.pinned);
    marker("pinned-divider");
    section("active");
    for (const block of customBlocks) projected.push(block.header, ...block.rows);
    if (items.some((item) => item.kind === "marker" && item.marker === "working-header")) {
      marker("working-header");
      projected.push(...groups.working);
    }
    if (
      groups.snoozed.length > 0 ||
      ((active.section !== "snoozed" || (input.snoozedThreadCount ?? 0) > 1) &&
        items.some((item) => item.kind === "marker" && item.marker === "snoozed-header"))
    ) {
      marker("snoozed-header");
      projected.push(...groups.snoozed);
    }
    // The empty shelf opens its 36px hint in place only while the lifted row may be snoozed
    // and the hint fits there; at the end it keeps its own measured place.
    if (hint === "in-place" && placeholder !== -1) marker("snoozed-placeholder");
    marker("settled-header");
    section("settled");
    // At the end it is out of the flow, right below the last row, and moves with it.
    const atEnd = hint === "at-end" && placeholder !== -1;
    if (atEnd) marker("snoozed-placeholder");
    const heights = projected.map((item) => {
      const index = indices.get(sidebarListItemId(item));
      const rect = index === undefined ? undefined : rects[index];
      const fallback =
        item.kind === "thread" &&
        (item.section === "pinned" ||
          item.section === "active" ||
          item.section === "working" ||
          isCustomSidebarSection(item.section))
          ? cardHeight
          : slimHeight;
      const moved = item.kind === "thread" && item.key === active.key;
      return item.kind === "marker" &&
        (item.marker === "pinned-header" || item.marker === "pinned-divider")
        ? labelHeight
        : item.kind === "marker" && item.marker.endsWith("placeholder")
          ? slimHeight
          : moved
            ? fallback
            : (rect?.height ?? fallback);
    });
    // A placeholder rendered at the end is out of the flow: it neither starts the shelves nor
    // sits above them.
    const inFlow = (index: number) => hint !== "at-end" || index !== placeholder;
    const firstShelf = items.findIndex((item, index) => isShelfHeader(item) && inFlow(index));
    const shelfItem = items[firstShelf];
    const shelfRect = rects[firstShelf];
    const beforeShelf = rects[inFlow(firstShelf - 1) ? firstShelf - 1 : firstShelf - 2];
    const lastRect = rects.at(-1);
    // Consume the shelf's auto margin as drag labels and resized rows need
    // room, keeping the combined shelves at their measured bottom.
    let shelfSpace =
      shelfRect &&
      beforeShelf &&
      lastRect &&
      // The placeholder's measured node is its hint box above the li; the margin ends at the li.
      (shelfItem?.kind === "marker" && shelfItem.marker === "snoozed-placeholder"
        ? shelfRect.top + shelfRect.height
        : shelfRect.top) >
        beforeShelf.bottom + 1
        ? Math.max(
            0,
            lastRect.bottom -
              rects[0].top -
              (atEnd ? heights.slice(0, -1) : heights).reduce(
                (sum, height) => sum + height + 1,
                -1,
              ),
          )
        : 0;
    // The Queue drop zone renders above the first custom header, outside the
    // sortable list; carry its measured gap so the custom block stays below it.
    const firstCustom = items.findIndex(
      (item) => item.kind === "marker" && item.marker === "custom-header",
    );
    const customRect = rects[firstCustom];
    const beforeCustom = rects[firstCustom - 1];
    let customGap =
      customRect && beforeCustom ? Math.max(0, customRect.top - beforeCustom.bottom - 1) : 0;
    // A Queue header docked right above the shelves is outside the sortable list too: its measured
    // height is not free space, so rows that grow push the shelves down instead of painting
    // under it.
    let queueGap = input.dockedQueueHeight === undefined ? 0 : input.dockedQueueHeight + 1;
    shelfSpace = Math.max(0, shelfSpace - customGap - queueGap);
    const result = items.map(() => hidden);
    // Where the in-flow content above an item ends at rest: one gap below the item before it, or at
    // its bottom when that is a zero-height marker (its -mb-px cancels the gap).
    const restEndAbove = (index: number) => {
      const above = rects[index - 1];
      return above === undefined ? undefined : above.bottom + (above.height === 0 ? 0 : 1);
    };
    const firstShelfRestEnd = restEndAbove(inFlow(firstShelf - 1) ? firstShelf : firstShelf - 1);
    const firstCustomRestEnd = restEndAbove(firstCustom);
    const shifts = { custom: 0, shelf: 0, trailing: 0 };
    let shelfReached = false;
    let customReached = false;
    let top = rects[0].top;
    // Where the in-flow content ends: the top of whatever renders after the last row.
    let end: number | undefined;
    for (const [projectedIndex, item] of projected.entries()) {
      if (item.kind === "marker" && item.marker === "custom-header") {
        // The Queue block rendered above the custom sections moves with the content above it.
        if (!customReached && firstCustomRestEnd !== undefined)
          shifts.custom = top - firstCustomRestEnd;
        customReached = true;
        top += customGap;
        customGap = 0;
      }
      if (isShelfHeader(item)) {
        // The Queue block docked above the shelves moves with the content above it, so
        // the gap carried below it holds whether the preview grows or shrinks that content.
        if (!shelfReached && firstShelfRestEnd !== undefined)
          shifts.shelf = top - firstShelfRestEnd;
        shelfReached = true;
        top += shelfSpace + queueGap;
        shelfSpace = 0;
        queueGap = 0;
      }
      if (atEnd && sidebarListItemId(item) === SNOOZED_PLACEHOLDER_ID) {
        end = top;
        top += input.trailingHeight ?? 0;
      }
      const index = indices.get(sidebarListItemId(item));
      const rect = index === undefined ? undefined : rects[index];
      if (index !== undefined && rect) result[index] = { ...stationary, y: top - rect.top };
      top += heights[projectedIndex]! + 1;
    }
    result[activeIndex] = stationary;
    shifts.trailing = (end ?? top) - (restEndAbove(rects.length) ?? end ?? top);
    // The content after the list in `sidebarSortableIds`: the Queue header, then "Show N more".
    const boundary = input.queueBoundary ?? null;
    result.push(
      { ...stationary, y: boundary === null ? 0 : shifts[boundary] },
      { ...stationary, y: shifts.trailing },
    );
    return result;
  }

  const ids = items.map(sidebarListItemId);
  // Over a snooze zone, project as the drag state's last other over. A rebuilt strategy
  // reads it from its input, so a stale render between dnd-kit's over and the drag state
  // update still lands on the previous over.
  const projectedOver = ({ activeIndex, overIndex }: Pick<Layout, "activeIndex" | "overIndex">) => {
    const overId = ids[overIndex];
    const sticky =
      overId === undefined ? overIndex >= 0 : input.snooze?.zoneIds.has(overId) === true;
    return sticky ? (indices.get(input.stickyOverId ?? "") ?? activeIndex) : overIndex;
  };
  // The context's rects run past the list (the content after the rows): project the rows'.
  const listRects = (rects: Layout["rects"]) =>
    rects.length > items.length ? rects.slice(0, items.length) : rects;
  return (args) => {
    const overIndex = projectedOver(args);
    if (
      previous?.rects !== args.rects ||
      previous.activeIndex !== args.activeIndex ||
      previous.overIndex !== overIndex
    ) {
      previous = { rects: args.rects, activeIndex: args.activeIndex, overIndex };
      transforms = project({ ...args, rects: listRects(args.rects), overIndex });
    }
    return transforms === null
      ? verticalListSortingStrategy(args)
      : (transforms[args.index] ?? stationary);
  };
}

/** "Show N more" below the expanded Settled rows, by sortable id. */
export const SHOW_MORE_ID = "sidebar-settled-show-more";

/** The main SortableContext's items: the list, then the content rendered after it, which can never
 * be lifted. Listed last, they keep every row's index, and the strategy hands them the
 * shift of the content above them, so they move with the rows and with the rows' transition:
 * - the Queue header, a drop zone: it keeps dnd-kit displacing the rows while it is the over, which
 *   otherwise snap to rest and move the zones beside it. The strategy projects it as the sticky over;
 * - "Show N more", which is no drop target at all. */
export function sidebarSortableIds(
  items: readonly SidebarListItem[],
  queueDropId: string,
): string[] {
  return [...items.map(sidebarListItemId), queueDropId, SHOW_MORE_ID];
}

/** The drag-state part of the strategy input: the sticky over, for an over outside the list (the
 * Queue header) and, while the lifted row may be snoozed, for the shelf's zones. */
export function sidebarStrategyDragInput(input: {
  readonly stickyOverId: string | null;
  /** `sidebarSnoozeZoneIds` as a set, or null when the lifted row may not be snoozed. */
  readonly snoozeZoneIds: ReadonlySet<string> | null;
  readonly hint: SidebarSnoozeHint;
}): Pick<Parameters<typeof createSidebarSortingStrategy>[0], "stickyOverId" | "snooze"> {
  return {
    stickyOverId: input.stickyOverId,
    ...(input.snoozeZoneIds === null
      ? {}
      : { snooze: { zoneIds: input.snoozeZoneIds, hint: input.hint } }),
  };
}

/** Content after the sortable list's items that renders in the flow below rows:
 * - `custom`: the Queue block rendered above the first custom header;
 * - `shelf`: the Queue block docked right above the first shelf;
 * - `trailing`: what renders after the last row (the Queue placed after every row, "Show N more"). */
export type SidebarBoundary = "custom" | "shelf" | "trailing";

/** Which boundary the Queue block renders at for this placement, or null when it does not move with
 * the preview: collapsed to its header with its own auto margin, it sits in the free space the
 * shelves' margin shares, and rows the labels push past that margin paint under the opaque header
 * (accepted: paint and hit-test still agree there). */
export function sidebarQueueBoundary(placement: {
  readonly docksWithShelves: boolean;
  readonly belowShelves: boolean;
  readonly collapse: boolean;
}): SidebarBoundary | null {
  if (placement.belowShelves) return "trailing";
  if (placement.collapse) return null;
  return placement.docksWithShelves ? "shelf" : "custom";
}
