// The pointer sweeps through the Snoozed shelf's zones with the real detector, strategy,
// drag-over reducer and pickup rules, wired as Sidebar.tsx wires them:
// - the strategy is rebuilt on every over change (handleThreadDragOver -> dragState -> the
//   sidebarSortingStrategy useMemo), with the sticky over read from the drag state, and one
//   replay leaves the drag state a frame behind dnd-kit's over (the intermediate frame);
// - each sample is judged against the paint the detector saw: the previous frame;
// - the DOM around the sortable list is laid out too: the Queue block where
//   sidebarQueuePlacement puts it (docked, collapsed, before the sections or after every row),
//   "Show N more", the at-end hint target, and the auto margins that share the free space;
// - the pickup values (hint state, docked Queue height, trailing height) are read off that layout
//   the way measureSidebarPickup reads the DOM, and the Queue count is frozen at pickup.
import type { CollisionDetection } from "@dnd-kit/core";
import type { SortingStrategy } from "@dnd-kit/sortable";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createSidebarCollisionDetection,
  createSidebarSortingStrategy,
  SHOW_MORE_ID,
  sidebarDragLabelsShift,
  sidebarQueueBoundary,
  sidebarSnoozeHintState,
  sidebarSortableIds,
  sidebarStrategyDragInput,
} from "./Sidebar.drag";
import {
  buildSidebarListItems,
  isCustomSidebarSection,
  isSidebarDragCandidate,
  nextSidebarDragOver,
  planSidebarThreadDrop,
  sidebarDragListItems,
  sidebarDragQueueEntryCount,
  sidebarDropPlanInput,
  sidebarListedThreads,
  sidebarListItemId,
  sidebarMarkerId,
  sidebarQueuePlacement,
  sidebarSnoozeDropAllowed,
  sidebarSnoozeZoneIds,
  type SidebarDragOrigin,
  type SidebarDragOverState,
  type SidebarDropBoard,
  type SidebarListItem,
  type SidebarSection,
} from "./Sidebar.logic";
import { QUEUE_DROP_ID } from "./SidebarQueueBlock";

type Rect = {
  top: number;
  bottom: number;
  height: number;
  left: number;
  right: number;
  width: number;
};
const rect = (top: number, height: number): Rect => ({
  top,
  bottom: top + height,
  height,
  left: 0,
  right: 260,
  width: 260,
});
const overlaps = (a: Rect, b: Rect) =>
  a.height > 0 && b.height > 0 && a.top < b.bottom && b.top < a.bottom;
const CARD = 82;
const SLIM = 36;
const HEADER = 32;
/** Sidebar.tsx's SIDEBAR_DRAG_LABEL_HEIGHT and SETTLED_TAIL_INITIAL_COUNT. */
const LABEL = 24;
const SETTLED_VISIBLE = 10;
const T = "2026-10-08T00:00:00.000Z";
const PLACEHOLDER = sidebarMarkerId("snoozed-placeholder");
const SHOW_MORE = SHOW_MORE_ID;
const SHELF_MARKERS = new Set([
  sidebarMarkerId("working-header"),
  sidebarMarkerId("snoozed-header"),
  PLACEHOLDER,
  sidebarMarkerId("settled-header"),
]);
const zeroHeight = (item: SidebarListItem) =>
  item.kind === "marker" &&
  (item.marker === "pinned-header" ||
    item.marker === "pinned-divider" ||
    item.marker.endsWith("placeholder"));
const heightOf = (item: SidebarListItem) =>
  item.kind === "thread"
    ? item.section === "snoozed" || item.section === "settled"
      ? SLIM
      : CARD
    : zeroHeight(item)
      ? 0
      : HEADER;

type Shape = {
  name: string;
  active: number;
  /** Working rows shown above the shelves (0: no Working shelf). */
  working: number;
  custom: boolean;
  snoozed: string[];
  snoozedTotal: number;
  /** Total settled threads; the first SETTLED_VISIBLE render, the rest sit behind "Show N more". */
  settledTotal: number;
  settledExpanded: boolean;
  /** Queue entries besides a Queue source. */
  queue: number;
  /** The free space at pickup, or a list that scrolls. */
  free: number | "scrolls";
};
const shape = (name: string, overrides: Partial<Shape>): Shape => ({
  name,
  active: 2,
  working: 0,
  custom: false,
  snoozed: [],
  snoozedTotal: 0,
  settledTotal: 3,
  settledExpanded: true,
  queue: 0,
  free: 300,
  ...overrides,
});
const collapsedSettled = { settledExpanded: false };
const expandedShelf = { snoozed: ["z1", "z2"], snoozedTotal: 2 };
const SHAPES: readonly Shape[] = [
  shape("empty shelf, Settled collapsed (default)", collapsedSettled),
  shape("empty shelf, Settled expanded", {}),
  shape("empty shelf, custom sections", { custom: true }),
  shape("empty shelf, Working rows above", { working: 2 }),
  shape("empty shelf, Working rows above, crowded", { working: 2, active: 8, free: "scrolls" }),
  shape("empty shelf, crowded", { active: 10, free: "scrolls" }),
  shape("empty shelf, custom sections, crowded", { custom: true, active: 8, free: "scrolls" }),
  shape("shelf collapsed, Settled collapsed (default)", { snoozedTotal: 2, ...collapsedSettled }),
  shape("shelf collapsed, custom sections", { snoozedTotal: 2, custom: true }),
  shape("shelf expanded, sparse", expandedShelf),
  shape("shelf expanded, Working rows above", { ...expandedShelf, working: 2 }),
  shape("shelf expanded, custom sections, crowded", {
    ...expandedShelf,
    custom: true,
    active: 8,
    free: "scrolls",
  }),
  shape("empty shelf, Show N more", { settledTotal: 12 }),
  shape("empty shelf, Show N more, crowded", { settledTotal: 12, active: 6, free: "scrolls" }),
  shape("shelf expanded, Show N more, crowded", {
    ...expandedShelf,
    settledTotal: 12,
    active: 6,
    free: "scrolls",
  }),
  shape("empty shelf, docked Queue with entries", { queue: 2 }),
  shape("empty shelf, docked Queue with entries, crowded", {
    queue: 2,
    active: 8,
    free: "scrolls",
  }),
  shape("empty shelf, custom sections, Queue with entries", { custom: true, queue: 2 }),
  shape("shelf expanded, docked Queue with entries, crowded", {
    ...expandedShelf,
    queue: 2,
    active: 8,
    free: "scrolls",
  }),
];
/** The docked Queue against the empty shelf's hint, free space F from 30 to 110px. */
const FREE_SWEEP = Array.from({ length: 81 }, (_, index) => 30 + index);
const freeShapes = (free: number): Shape[] => [
  shape(`F=${free}, docked empty Queue`, { free }),
  shape(`F=${free}, docked Queue with entries`, { free, queue: 2 }),
];

type Source = { key: string; section: SidebarSection; fromQueue: boolean };
const settledKeys = (s: Shape) => Array.from({ length: s.settledTotal }, (_, i) => `s${i + 1}`);
const shownSettled = (s: Shape) =>
  s.settledExpanded ? settledKeys(s).slice(0, SETTLED_VISIBLE) : [];
// Every row a drag can lift (never a Working row), and Queue rows resting in Active and Snoozed.
const sourcesOf = (s: Shape): Source[] => [
  { key: "p1", section: "pinned", fromQueue: false },
  { key: "a2", section: "active", fromQueue: false },
  ...(s.custom ? [{ key: "c2", section: "custom:ideas" as const, fromQueue: false }] : []),
  ...(shownSettled(s).length > 1
    ? [{ key: "s2", section: "settled" as const, fromQueue: false }]
    : []),
  ...(s.snoozed.length > 0 ? [{ key: "z1", section: "snoozed" as const, fromQueue: false }] : []),
  { key: "qa", section: "active", fromQueue: true },
  { key: "qz", section: "snoozed", fromQueue: true },
];

/** The capability sets, built by the production helper as Sidebar.tsx calls it. */
function dropBoard(s: Shape, items: readonly SidebarListItem[], queueKeys: readonly string[]) {
  const rows = items.flatMap((item) => (item.kind === "thread" ? [item] : []));
  const names = [...rows.map((row) => row.key), ...queueKeys];
  const env = EnvironmentId.make("env-1");
  const scoped = (name: string) => scopedThreadKey(scopeThreadRef(env, ThreadId.make(name)));
  const byScoped = new Map(names.map((name) => [scoped(name), name] as const));
  const built = sidebarListedThreads({
    threads: names.map((name) => ({
      id: ThreadId.make(name),
      environmentId: env,
      projectId: "project-1",
      archivedAt: null,
      lineage: {
        relationshipToParent: null,
        parentThreadId: null,
        rootThreadId: ThreadId.make(name),
      },
    })),
    scopedProjectKeys: null,
    queuedKeys: new Set(queueKeys.map(scoped)),
    capabilitiesOf: () => ({
      threadPinning: true,
      threadPinReorder: true,
      threadActiveReorder: true,
    }),
  });
  const unscope = (set: ReadonlySet<string>) =>
    new Set(
      [...set].map((key) => {
        const name = byScoped.get(key);
        if (name === undefined) throw new Error(`unknown key ${key}`);
        return name;
      }),
    );
  const keys = new Map(
    names.map((name, index) => [name, `k${String(index).padStart(2, "0")}`] as const),
  );
  const board: SidebarDropBoard = {
    pinnedOrder: rows.filter((row) => row.section === "pinned").map((row) => row.key),
    pinnedKeysById: keys,
    reorderableKeys: unscope(built.pinned),
    activeOrder: rows.filter((row) => row.section === "active").map((row) => row.key),
    activeKeysById: keys,
    activeReorderableKeys: unscope(built.active),
    // The Working beta time-orders the inbox.
    activeTimeOrdered: s.working > 0,
    customSectionIds: new Set(s.custom ? ["later", "ideas"] : []),
    customOrders: new Map(
      s.custom
        ? [
            ["later", ["c1"]],
            ["ideas", ["c2"]],
          ]
        : [],
    ),
  };
  return board;
}

/** One element of the thread list's ul, in DOM order. */
type El = {
  id: string;
  height: number;
  /** A zero-height marker li with -mb-px: it takes no gap. */
  zero: boolean;
  /** Carries mt-auto: the free space is shared among these. */
  auto: boolean;
  /** Carries data-thread-selection-safe (a list marker), which measureSidebarPickup walks to. */
  marker: boolean;
};

type Arm = "app" | "round-2" | "strategy-held" | "rows-not-zones";
type Frame = {
  /** Painted rect and visibility of each droppable or painted element, by id. */
  paint: Map<string, { rect: Rect; visible: boolean }>;
};

function scenario(s: Shape, source: Source, arm: Arm, lag: 0 | 1) {
  const queueKeys = [
    ...(source.fromQueue ? [source.key] : []),
    ...Array.from({ length: s.queue }, (_, index) => `x${index + 1}`),
  ];
  const queuedKeys = new Set(queueKeys);
  const items = buildSidebarListItems({
    pinned: ["p1"],
    active: Array.from({ length: s.active }, (_, index) => `a${index + 1}`),
    working: {
      total: s.working,
      visible: Array.from({ length: s.working }, (_, index) => `w${index + 1}`),
    },
    snoozed: { total: s.snoozedTotal, visible: s.snoozed },
    settled: { total: s.settledTotal, visible: shownSettled(s) },
    custom: s.custom
      ? [
          { id: "later", visible: ["c1"], collapsed: false },
          { id: "ideas", visible: ["c2"], collapsed: false },
        ]
      : [],
  });
  const ids = items.map(sidebarListItemId);
  const activeIndex = ids.indexOf(source.key);
  if (activeIndex === -1 && !source.fromQueue) throw new Error(`${source.key} is not listed`);
  const drag: SidebarDragOrigin = {
    activeKey: source.key,
    activeSection: source.section,
    fromQueue: source.fromQueue,
    queuedDraft: false,
  };
  const dragItems = sidebarDragListItems(items, drag);
  const snoozeAllowed = sidebarSnoozeDropAllowed({
    drag,
    supportsSnooze: true,
    canSnooze: true,
    canOperate: true,
  });
  const shelfIds = snoozeAllowed ? sidebarSnoozeZoneIds(dragItems, drag.activeKey) : [];
  const listScrolls = s.free === "scrolls";
  const placement = sidebarQueuePlacement({
    sectionCount: s.custom ? 2 : 0,
    // Frozen at pickup: the shown entries then.
    entryCount: sidebarDragQueueEntryCount(queueKeys.length, queueKeys),
    dropShown: !drag.fromQueue,
    listScrolls,
    liftedFromShelf:
      !drag.fromQueue && (drag.activeSection === "snoozed" || drag.activeSection === "settled"),
  });

  // The ul as Sidebar.tsx renders it during the drag.
  const dom: El[] = [];
  let queueRendered = false;
  const pushQueue = () => {
    if (queueRendered) return;
    queueRendered = true;
    // SidebarQueueBlock renders while a main-list drag runs or entries exist: always, here.
    dom.push({
      id: QUEUE_DROP_ID,
      height: HEADER,
      zero: false,
      auto: placement.collapse,
      marker: false,
    });
    if (placement.collapse) return;
    for (const key of queueKeys)
      dom.push({ id: key, height: CARD, zero: false, auto: false, marker: false });
  };
  for (const item of items) {
    if (item.kind === "thread") {
      dom.push({ id: item.key, height: heightOf(item), zero: false, auto: false, marker: false });
      continue;
    }
    if (
      !placement.belowShelves &&
      ((item.marker === "custom-header" && !placement.docksWithShelves) ||
        SHELF_MARKERS.has(sidebarListItemId(item)))
    ) {
      pushQueue();
    }
    dom.push({
      id: sidebarListItemId(item),
      height: heightOf(item),
      zero: zeroHeight(item),
      auto:
        item.marker === "working-header" ||
        ((item.marker === "snoozed-header" || item.marker === "snoozed-placeholder") &&
          s.working === 0),
      marker: true,
    });
  }
  pushQueue();
  if (s.settledExpanded && s.settledTotal > SETTLED_VISIBLE) {
    dom.push({ id: SHOW_MORE, height: SLIM, zero: false, auto: false, marker: false });
  }
  let cursor = 100;
  const naturalTops = dom.map((el) => {
    const at = cursor;
    cursor += el.zero ? 0 : el.height + 1;
    return at;
  });
  const contentEnd = Math.max(
    ...dom.map((el, index) => naturalTops[index]! + (el.zero ? 0 : el.height)),
  );
  const free = listScrolls ? 0 : (s.free as number);
  const autoCount = dom.filter((el) => el.auto).length;
  let shared = 0;
  const domRects = dom.map((el, index) => {
    if (el.auto) shared += free / autoCount;
    return rect(naturalTops[index]! + shared, el.zero ? 0 : el.height);
  });
  const domIndex = (id: string) => dom.findIndex((el) => el.id === id);
  const placeholderLi = domIndex(PLACEHOLDER);
  // The placeholder's node is its 36px hint box, resting just above its li.
  const restingBox =
    placeholderLi === -1 ? undefined : rect(domRects[placeholderLi]!.top - SLIM, SLIM);

  // measureSidebarPickup, on this layout.
  const queueHeader = domIndex(QUEUE_DROP_ID);
  let afterQueue = queueHeader === -1 ? dom.length : queueHeader + 1;
  while (afterQueue < dom.length && !dom[afterQueue]!.marker) afterQueue += 1;
  const docked =
    queueHeader !== -1 && afterQueue < dom.length && SHELF_MARKERS.has(dom[afterQueue]!.id);
  const hint = sidebarSnoozeHintState({
    snoozeAllowed,
    hint: restingBox,
    above: placeholderLi > 0 ? domRects[placeholderLi - 1] : undefined,
    labelsShift: drag.fromQueue ? 0 : sidebarDragLabelsShift(LABEL),
  });
  const dockedQueueHeight = docked
    ? domRects[afterQueue - 1]!.bottom - domRects[queueHeader]!.top
    : undefined;
  const trailingStart = placement.belowShelves ? queueHeader : domIndex(SHOW_MORE);
  const trailingHeight =
    trailingStart > 0
      ? Math.max(0, domRects.at(-1)!.bottom - domRects[trailingStart - 1]!.bottom)
      : 0;
  // Out of flow at the end: `top-full mt-px` against the ul, which ends at the free space's end.
  const box =
    restingBox === undefined
      ? undefined
      : hint === "at-end"
        ? rect(contentEnd + free + 1, SLIM)
        : restingBox;

  // dnd-kit's transform-agnostic droppable rects, measured at pickup (the at-end box re-measured).
  // "Show N more" is no droppable, so dnd-kit neither measures nor hit-tests it.
  const droppableRects = new Map<string, Rect>();
  for (const [index, el] of dom.entries()) {
    if (el.id === SHOW_MORE) continue;
    droppableRects.set(el.id, el.id === PLACEHOLDER ? box! : domRects[index]!);
  }
  // Sidebar.tsx's SortableContext items: the rows, then the Queue header and "Show N more".
  const contextIds = sidebarSortableIds(items, QUEUE_DROP_ID);
  const rects = contextIds.map((id) => droppableRects.get(id)!);
  const queueBoundary = sidebarQueueBoundary(placement);

  // Sidebar.tsx's draggedSettledOrder / draggedActiveOrder: a Queue row never previews.
  const allSettled = settledKeys(s);
  const settledOrder = drag.fromQueue
    ? []
    : source.section === "settled"
      ? allSettled
      : [source.key, ...allSettled];
  const activeKeys = items.flatMap((item) =>
    item.kind === "thread" && item.section === "active" && item.key !== source.key
      ? [item.key]
      : [],
  );
  const activeOrder = s.working > 0 && !drag.fromQueue ? [source.key, ...activeKeys] : undefined;
  const zoneSet = new Set(shelfIds);
  const make = (stickyOverId: string | null) =>
    createSidebarSortingStrategy({
      items,
      enabled: true,
      boundaryLabelHeight: LABEL,
      settledOrder,
      ...(activeOrder === undefined ? {} : { activeOrder }),
      settledExpanded: s.settledExpanded,
      settledVisibleCount: SETTLED_VISIBLE,
      routeThreadKey: null,
      snoozedThreadCount: s.snoozedTotal,
      ...(dockedQueueHeight === undefined ? {} : { dockedQueueHeight }),
      trailingHeight,
      queueBoundary,
      ...sidebarStrategyDragInput({
        stickyOverId,
        snoozeZoneIds: snoozeAllowed ? zoneSet : null,
        hint,
      }),
    });
  // handleThreadDragStart's seed.
  let state: SidebarDragOverState = {
    targetSection: drag.fromQueue ? null : drag.activeSection,
    overZone: null,
    stickyOverId: drag.activeKey,
  };
  const build = (): SortingStrategy => {
    // Red arm: the round-2 rule, "project as over the source".
    if (arm === "round-2") return make(source.key);
    // Red arm: the sticky over kept in the strategy's own closure, which every rebuild resets.
    if (arm === "strategy-held") {
      let sticky = source.key;
      let inner = make(sticky);
      return (args) => {
        const id = contextIds[args.overIndex];
        if (id !== undefined && id !== QUEUE_DROP_ID && !zoneSet.has(id) && id !== sticky) {
          sticky = id;
          inner = make(sticky);
        }
        return inner(args);
      };
    }
    return make(state.stickyOverId);
  };
  let strategy = build();
  // dnd-kit's initial over: the lifted row.
  let over: string | null = source.key;
  let pending: string | null | undefined;

  /** What one render paints: SortableContext displaces its items (the rows, the Queue header and
      "Show N more") only while both the active and the over are its items; SidebarQueueBlock moves
      its rows with its header. */
  const frame = (): Frame => {
    const overIndex = over === null ? -1 : contextIds.indexOf(over);
    const displace = activeIndex >= 0 && overIndex >= 0;
    const transformOf = (index: number) =>
      displace
        ? strategy({ rects, activeIndex, overIndex, index, activeNodeRect: rects[activeIndex]! })
        : null;
    const paint = new Map<string, { rect: Rect; visible: boolean }>();
    for (const [index, id] of ids.entries()) {
      const transform = transformOf(index);
      const at = rects[index]!;
      const visible =
        transform?.scaleY !== 0 && (id !== PLACEHOLDER || hint !== "closed") && id !== source.key;
      paint.set(id, { rect: rect(at.top + (transform?.y ?? 0), at.height), visible });
    }
    const queueShift = transformOf(contextIds.indexOf(QUEUE_DROP_ID))?.y ?? 0;
    for (const [index, el] of dom.entries()) {
      if (paint.has(el.id)) continue;
      const contextIndex = contextIds.indexOf(el.id);
      const shift =
        contextIndex !== -1
          ? (transformOf(contextIndex)?.y ?? 0)
          : queueKeys.includes(el.id)
            ? queueShift
            : 0;
      const at = domRects[index]!;
      paint.set(el.id, { rect: rect(at.top + shift, at.height), visible: el.id !== source.key });
    }
    return { paint };
  };
  let current = frame();

  const containers = dom
    .filter((el) => el.id !== SHOW_MORE)
    .map((el) => ({
      id: el.id,
      key: el.id,
      disabled: false,
      data: { current: {} },
      rect: { current: droppableRects.get(el.id)! },
      node: {
        current: {
          parentElement: null,
          getBoundingClientRect: () => current.paint.get(el.id)!.rect,
          querySelector: () =>
            el.id === sidebarMarkerId("pinned-divider") && !drag.fromQueue
              ? // `.sidebar-drag-boundary-label`: top-1, h-4.
                { getBoundingClientRect: () => rect(current.paint.get(el.id)!.rect.top + 4, 16) }
              : null,
        },
      },
    })) as unknown as Parameters<CollisionDetection>[0]["droppableContainers"];
  const board = dropBoard(s, items, queueKeys);
  const sourceFields = {
    pinnedAt: source.section === "pinned" ? T : null,
    settledOverride: source.section === "settled" ? ("settled" as const) : null,
    sidebarSectionId: isCustomSidebarSection(source.section)
      ? source.section.slice("custom:".length)
      : null,
    supportsSettlement: true,
    supportsSections: true,
  };
  const pointerZones = shelfIds.filter((id) => id !== PLACEHOLDER || hint !== "closed");
  const sourceRect = source.fromQueue ? droppableRects.get(source.key)! : rects[activeIndex]!;
  const detect = createSidebarCollisionDetection(
    (id) =>
      isSidebarDragCandidate({
        id,
        drag,
        items: dragItems,
        queuedKeys,
        queueDropId: QUEUE_DROP_ID,
        snoozeAllowed,
        planKind: (target) =>
          planSidebarThreadDrop(sidebarDropPlanInput(board, drag, sourceFields, target)).kind,
      }),
    {
      items: dragItems,
      activationY: sourceRect.top + 10,
      pointerDropIds: [
        QUEUE_DROP_ID,
        // Red arm: shelf rows left out of the pointer zones, so closestCenter picks them on rest rects.
        ...(arm === "rows-not-zones"
          ? pointerZones.filter(
              (id) => !items.some((item) => item.kind === "thread" && item.key === id),
            )
          : pointerZones),
      ],
      ...(drag.fromQueue ? { freeIds: [...queuedKeys] } : { excludeIds: [...queuedKeys] }),
    },
  );
  const reduce = (overId: string | null) => {
    state = {
      ...state,
      ...nextSidebarDragOver({
        current: state,
        overId,
        activeKey: drag.activeKey,
        items: dragItems,
        queuedKeys,
        queueDropId: QUEUE_DROP_ID,
      }),
    };
    strategy = build();
  };
  return {
    shape: s,
    source,
    queueKeys,
    collapsed: placement.collapse,
    listIds: ids,
    snoozeAllowed,
    hint,
    shelfIds,
    pointerZones,
    sourceCenter: sourceRect.top + sourceRect.height / 2,
    restRect: (id: string) => droppableRects.get(id),
    frame: () => current,
    over: () => over,
    step(y: number) {
      const collisionRect = rect(y - CARD / 2, CARD);
      const collisions = detect({
        active: {
          id: source.key,
          data: { current: {} },
          rect: { current: { initial: sourceRect, translated: collisionRect } },
        },
        collisionRect,
        droppableRects,
        droppableContainers: containers,
        pointerCoordinates: { x: 100, y },
      } as unknown as Parameters<CollisionDetection>[0]);
      const next = collisions[0] === undefined ? null : String(collisions[0].id);
      // The intermediate frame: dnd-kit's over moved on one render before onDragOver's state
      // update rebuilt the strategy.
      if (pending !== undefined) {
        reduce(pending);
        pending = undefined;
      }
      if (next !== over) {
        over = next;
        if (lag === 0) reduce(next);
        else pending = next;
      }
      current = frame();
    },
  };
}
type Scenario = ReturnType<typeof scenario>;

/** The opaque z-20 Queue header and the "Show N more" li, as painted. */
const trailingBoxes = (frame: Frame) =>
  [QUEUE_DROP_ID, SHOW_MORE].flatMap((id) => {
    const painted = frame.paint.get(id);
    return painted === undefined ? [] : [{ id, rect: painted.rect }];
  });

/** Every visible zone is clear of the Queue header and "Show N more"; the hint box also of every
    visible row and header. */
function zoneOverlaps(run: Scenario, frame: Frame): string[] {
  const found: string[] = [];
  for (const zone of run.pointerZones) {
    const painted = frame.paint.get(zone)!;
    if (!painted.visible) continue;
    for (const other of trailingBoxes(frame)) {
      if (overlaps(painted.rect, other.rect)) found.push(`${zone} under ${other.id}`);
    }
    if (zone !== PLACEHOLDER) continue;
    for (const [id, other] of frame.paint) {
      if (id === zone || !other.visible || run.shelfIds.includes(id)) continue;
      if (overlaps(painted.rect, other.rect)) found.push(`hint box over ${id}`);
    }
  }
  return found;
}

/** At pickup, no visible list row or header paints under the Queue block. A header collapsed into
    the free space keeps its place: rows the labels push past its margin paint under it,
    opaque, and the Queue-hit check below holds paint and hit-test together there instead. */
function rowsUnderQueue(run: Scenario, frame: Frame): string[] {
  const queue = frame.paint.get(QUEUE_DROP_ID);
  if (queue === undefined || run.collapsed) return [];
  const block = [...frame.paint.keys()].filter(
    (id) => id === QUEUE_DROP_ID || run.queueKeys.includes(id),
  );
  const found: string[] = [];
  for (const [id, painted] of frame.paint) {
    if (block.includes(id) || id === SHOW_MORE || !painted.visible) continue;
    for (const other of block) {
      const blockRect = frame.paint.get(other)!.rect;
      if (overlaps(painted.rect, blockRect)) {
        found.push(
          `${id} under ${other} by ${Math.min(painted.rect.bottom, blockRect.bottom) - Math.max(painted.rect.top, blockRect.top)}px`,
        );
      }
    }
  }
  return found;
}

type Result = {
  hits: string[];
  reentries: string[];
  zoneOverlaps: string[];
  pickup: string[];
  unreached: string[];
  snoozeSamples: number;
  /** Samples on a collapsed Queue header with a list row painted under it (the accepted overlap). */
  coveredQueueSamples: number;
};
const emptyResult = (): Result => ({
  hits: [],
  reentries: [],
  zoneOverlaps: [],
  pickup: [],
  unreached: [],
  snoozeSamples: 0,
  coveredQueueSamples: 0,
});

function sweep(s: Shape, source: Source, arm: Arm, lag: 0 | 1): Result {
  const result = emptyResult();
  const label = `${s.name} | ${source.fromQueue ? "Queue " : ""}${source.key} lag ${lag}`;
  const probe = scenario(s, source, arm, lag);
  const pickup = probe.frame();
  result.pickup.push(...rowsUnderQueue(probe, pickup).map((line) => `${label}: ${line}`));
  result.zoneOverlaps.push(
    ...[...new Set(zoneOverlaps(probe, pickup))].map((line) => `${label} pickup: ${line}`),
  );
  // The sweep covers the shelf's extent at rest and at pickup.
  const band = probe.shelfIds.flatMap((id) => {
    const painted = pickup.paint.get(id)!;
    const rest = probe.restRect(id)!;
    return [rest, ...(painted.visible ? [painted.rect] : [])].filter((zone) => zone.height > 0);
  });
  // A header collapsed into the free space can cover rows the labels push past its margin:
  // cross it too, so the paint/hit check samples that overlap.
  const collapsedQueue = probe.collapsed ? pickup.paint.get(QUEUE_DROP_ID)?.rect : undefined;
  if (collapsedQueue !== undefined) band.push(collapsedQueue);
  if (band.length === 0) return result;
  const lo = Math.min(...band.map((zone) => zone.top));
  const hi = Math.max(...band.map((zone) => zone.bottom));
  for (const stepPx of [1, 2, 3]) {
    for (const direction of ["down", "up"] as const) {
      const run = scenario(s, source, arm, lag);
      const from = direction === "down" ? lo - 80 : hi + 80;
      const to = direction === "down" ? hi + 80 : lo - 80;
      const path: number[] = [];
      const approach = Math.sign(from - run.sourceCenter) || 1;
      for (let y = run.sourceCenter; approach > 0 ? y < from : y > from; y += 3 * approach) {
        path.push(Math.round(y));
      }
      const sweepFrom = path.length;
      const d = Math.sign(to - from);
      for (let y = from; d > 0 ? y <= to : y >= to; y += stepPx * d) path.push(y);
      let entries = 0;
      let wasSnooze = false;
      const overlapsSeen = new Set<string>();
      for (const [index, y] of path.entries()) {
        // The paint the detector sees on this sample: the previous frame's. Where the opaque
        // Queue header covers a zone, the zone is not what the user sees.
        const seen = run.frame();
        const queue = seen.paint.get(QUEUE_DROP_ID)?.rect;
        const onQueue = queue !== undefined && y >= queue.top && y <= queue.bottom;
        if (
          onQueue &&
          run.collapsed &&
          run.listIds.some((id) => {
            const painted = seen.paint.get(id)!;
            return painted.visible && y >= painted.rect.top && y <= painted.rect.bottom;
          })
        ) {
          result.coveredQueueSamples += 1;
        }
        const inside =
          run.pointerZones.some((id) => {
            const painted = seen.paint.get(id)!;
            return painted.visible && y >= painted.rect.top && y <= painted.rect.bottom;
          }) && !onQueue;
        run.step(y);
        for (const line of zoneOverlaps(run, run.frame())) overlapsSeen.add(line);
        const over = run.over();
        const isSnooze = over !== null && run.shelfIds.includes(over);
        if (index < sweepFrom) {
          wasSnooze = isSnooze;
          continue;
        }
        if (isSnooze) result.snoozeSamples += 1;
        if (isSnooze && !wasSnooze) entries += 1;
        wasSnooze = isSnooze;
        // The Queue header is hit exactly where it is painted (it is opaque, on top).
        if (onQueue !== (over === QUEUE_DROP_ID)) {
          result.hits.push(
            `${label} | ${direction} ${stepPx}px y=${y}: ${
              onQueue ? `on the painted Queue header, over ${over}` : "Queue hit off its paint"
            }`,
          );
        }
        if (inside !== isSnooze) {
          result.hits.push(
            `${label} | ${direction} ${stepPx}px y=${y}: ${
              inside
                ? `inside the painted zone, over ${over}`
                : `snooze at ${over}, outside every painted zone`
            }`,
          );
        }
      }
      if (entries > 1) {
        result.reentries.push(
          `${label} | ${direction} ${stepPx}px: entered the zone ${entries} times`,
        );
      }
      result.zoneOverlaps.push(
        ...[...overlapsSeen].map((line) => `${label} | ${direction} ${stepPx}px: ${line}`),
      );
    }
  }
  if (probe.snoozeAllowed && result.snoozeSamples === 0) {
    result.unreached.push(`${label}: never reached the zone`);
  }
  return result;
}

function sweepAll(shapes: readonly Shape[], arm: Arm, lags: ReadonlyArray<0 | 1> = [0, 1]) {
  const total = emptyResult();
  for (const s of shapes) {
    for (const source of sourcesOf(s)) {
      for (const lag of lags) {
        const result = sweep(s, source, arm, lag);
        total.hits.push(...result.hits);
        total.reentries.push(...result.reentries);
        total.zoneOverlaps.push(...result.zoneOverlaps);
        total.pickup.push(...result.pickup);
        total.unreached.push(...result.unreached);
        total.snoozeSamples += result.snoozeSamples;
        total.coveredQueueSamples += result.coveredQueueSamples;
      }
    }
  }
  return total;
}

const failures = (result: Result) => ({
  hits: result.hits,
  reentries: result.reentries,
  zoneOverlaps: result.zoneOverlaps,
  pickup: result.pickup,
  unreached: result.unreached,
});
const clean = { hits: [], reentries: [], zoneOverlaps: [], pickup: [], unreached: [] };

describe("the Snoozed shelf's zones under a pointer sweep, wired as the app wires them", () => {
  it("every sample inside a painted zone snoozes, none outside does, no sweep re-enters, nothing covers a zone or slides under the Queue", () => {
    const result = sweepAll(SHAPES, "app");
    expect(result.snoozeSamples).toBeGreaterThan(0);
    expect(failures(result)).toEqual(clean);
  });

  it("with 30-110px of free space beside a docked Queue, the same holds", () => {
    const result = sweepAll(FREE_SWEEP.flatMap(freeShapes), "app");
    expect(result.snoozeSamples).toBeGreaterThan(0);
    // The accepted overlap is crossed, so the Queue paint/hit check is not vacuous there.
    expect(result.coveredQueueSamples).toBeGreaterThan(0);
    expect(failures(result)).toEqual(clean);
  });

  it.each(["round-2", "strategy-held", "rows-not-zones"] as const)(
    "the %s arm is caught",
    (arm) => {
      // Counted against the app's own count, so a red app arm cannot make a dead arm look caught.
      const count = (result: Result) => result.hits.length + result.reentries.length;
      expect(count(sweepAll(SHAPES, arm, [0]))).toBeGreaterThan(
        count(sweepAll(SHAPES, "app", [0])),
      );
    },
  );
});
