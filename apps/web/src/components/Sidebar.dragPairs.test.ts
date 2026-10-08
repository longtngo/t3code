// Every drag-between-sections pair through the live pure pipeline.
// Models Sidebar.tsx: the detector reports a pointer zone (the Queue header, and the Snoozed
// shelf's zones when the gate allows) where it is painted, before any gate; any other id must be
// a listed item the collision gate accepts. Then routeSidebarDragEnd routes it.
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildSidebarListItems,
  customSectionHeaderId,
  isSidebarDragCandidate,
  planSidebarThreadDrop,
  sidebarListedThreads,
  routeSidebarDragEnd,
  sidebarDragListItems,
  sidebarDropPlanInput,
  sidebarListItemId,
  sidebarMarkerId,
  sidebarSnoozeDropAllowed,
  sidebarSnoozeZoneIds,
  type SidebarDragOrigin,
  type SidebarDropBoard,
  type SidebarListItem,
  type SidebarSection,
} from "./Sidebar.logic";
import { QUEUE_DROP_ID } from "./SidebarQueueBlock";

type Source = {
  pinnedAt: string | null;
  settledOverride: "settled" | "active" | null;
  sidebarSectionId: string | null;
};
const plain: Source = { pinnedAt: null, settledOverride: null, sidebarSectionId: null };
const T = "2026-10-08T00:00:00.000Z";
const sources: Record<string, Source> = {
  p1: { ...plain, pinnedAt: T },
  a1: plain,
  a2: plain,
  c1: { ...plain, sidebarSectionId: "focus" },
  z1: plain,
  s1: { ...plain, settledOverride: "settled" },
  q: plain,
  qp: { ...plain, pinnedAt: T },
  qs: { ...plain, settledOverride: "settled" },
  qz: plain,
};
const queuedKeys = new Set(["q", "qp", "qs", "qz"]);
// The capability sets come from the production builder, called as Sidebar.tsx calls it: every
// listed thread, queued ones included. Its keys are scoped; map them back to the short names.
const env = EnvironmentId.make("env-1");
const scopedKey = (name: string) => scopedThreadKey(scopeThreadRef(env, ThreadId.make(name)));
const names = new Map(Object.keys(sources).map((name) => [scopedKey(name), name] as const));
const built = sidebarListedThreads({
  threads: Object.keys(sources).map((name) => ({
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
  queuedKeys: new Set([...queuedKeys].map(scopedKey)),
  capabilitiesOf: () => ({
    threadPinning: true,
    threadPinReorder: true,
    threadActiveReorder: true,
  }),
});
const nameOf = (key: string) => {
  const name = names.get(key);
  if (name === undefined) throw new Error(`no fixture thread for key ${key}`);
  return name;
};
const nameSet = (set: ReadonlySet<string>) => new Set([...set].map(nameOf));
const sets = { pinned: nameSet(built.pinned), active: nameSet(built.active) };
const keys = new Map(Object.keys(sources).map((key) => [key, `k-${key}`] as const));
const board: SidebarDropBoard = {
  pinnedOrder: ["p1"],
  pinnedKeysById: keys,
  reorderableKeys: sets.pinned,
  activeOrder: ["a1", "a2"],
  activeKeysById: keys,
  activeReorderableKeys: sets.active,
  activeTimeOrdered: false,
  customSectionIds: new Set(["focus", "later"]),
  customOrders: new Map([
    ["focus", ["c1"]],
    ["later", []],
  ]),
};

const listItems = (
  snoozed: { total: number; visible: string[] },
  custom: Array<{ id: string; visible: string[]; collapsed: boolean }> = [
    { id: "focus", visible: ["c1"], collapsed: false },
  ],
) =>
  buildSidebarListItems({
    pinned: ["p1"],
    active: ["a1", "a2"],
    working: { total: 0, visible: [] },
    snoozed,
    settled: { total: 1, visible: ["s1"] },
    custom,
  });
// Snoozed is collapsed by default: header, no rows.
const collapsed = listItems({ total: 1, visible: [] });
const expanded = listItems({ total: 1, visible: ["z1"] });
const empty = listItems({ total: 0, visible: [] });
const emptyNoCustom = listItems({ total: 0, visible: [] }, []);
const withLater = (snoozed: { total: number; visible: string[] }) =>
  listItems(snoozed, [
    { id: "focus", visible: ["c1"], collapsed: false },
    { id: "later", visible: [], collapsed: false },
  ]);

const main = (activeKey: string, activeSection: SidebarSection): SidebarDragOrigin => ({
  activeKey,
  activeSection,
  fromQueue: false,
  queuedDraft: false,
});
const queued = (activeKey: string, activeSection: SidebarSection): SidebarDragOrigin => ({
  ...main(activeKey, activeSection),
  fromQueue: true,
});
const ok = { supportsSnooze: true, canSnooze: true, canOperate: true };

function liveRoute(
  items: readonly SidebarListItem[],
  drag: SidebarDragOrigin,
  overId: string,
  snooze = ok,
) {
  const dragItems = sidebarDragListItems(items, drag);
  const snoozeAllowed = sidebarSnoozeDropAllowed({ drag, ...snooze });
  const pointerZones = drag.queuedDraft
    ? []
    : [QUEUE_DROP_ID, ...(snoozeAllowed ? sidebarSnoozeZoneIds(dragItems, drag.activeKey) : [])];
  const listed = dragItems.some((item) => sidebarListItemId(item) === overId);
  const source = sources[drag.activeKey]!;
  const offered =
    pointerZones.includes(overId) ||
    (listed &&
      isSidebarDragCandidate({
        id: overId,
        drag,
        items: dragItems,
        queuedKeys,
        queueDropId: QUEUE_DROP_ID,
        snoozeAllowed,
        planKind: (target) =>
          planSidebarThreadDrop(
            sidebarDropPlanInput(
              board,
              drag,
              { ...source, supportsSettlement: true, supportsSections: true },
              target,
            ),
          ).kind,
      }));
  return routeSidebarDragEnd({
    drag,
    overId: offered ? overId : null,
    snoozeAllowed,
    items: dragItems,
    queuedKeys,
    queueDropId: QUEUE_DROP_ID,
    queueWritable: true,
  });
}
const outcome = (route: ReturnType<typeof liveRoute>) =>
  route.kind === "place" ? String(route.target.section) : route.kind;

const SNOOZE = sidebarMarkerId("snoozed-header");
const PLACEHOLDER = sidebarMarkerId("snoozed-placeholder");

// [pair, items, drag, overId, expected: "snooze" | "enqueue" | "none" | the place section]
const pairs = [
  ["into Snooze: Active -> collapsed shelf", collapsed, main("a1", "active"), SNOOZE, "snooze"],
  ["into Snooze: Pinned -> collapsed shelf", collapsed, main("p1", "pinned"), SNOOZE, "snooze"],
  [
    "into Snooze: Settled -> shelf (from below)",
    collapsed,
    main("s1", "settled"),
    SNOOZE,
    "snooze",
  ],
  ["into Snooze: custom section -> shelf", collapsed, main("c1", "custom:focus"), SNOOZE, "snooze"],
  ["into Snooze: Queue -> shelf", collapsed, queued("q", "active"), SNOOZE, "snooze"],
  ["into Snooze: Active -> empty shelf", empty, main("a1", "active"), PLACEHOLDER, "snooze"],
  ["Snooze -> Active (wake)", expanded, main("z1", "snoozed"), "a1", "active"],
  ["Snooze -> Pinned (wake)", expanded, main("z1", "snoozed"), "p1", "pinned"],
  [
    "Snooze -> Settled (wake)",
    expanded,
    main("z1", "snoozed"),
    sidebarMarkerId("settled-header"),
    "settled",
  ],
  ["Snooze -> custom section (wake)", expanded, main("z1", "snoozed"), "c1", "custom:focus"],
  ["Active -> Queue (queue)", collapsed, main("a1", "active"), QUEUE_DROP_ID, "enqueue"],
  ["Queue -> Active (rests in Active)", collapsed, queued("q", "active"), "a1", "active"],
  ["Queue -> Active (rests in Pinned)", collapsed, queued("qp", "pinned"), "a1", "active"],
  ["Queue -> Active (rests in Settled)", collapsed, queued("qs", "settled"), "a1", "active"],
  ["Queue -> Active (rests in Snoozed)", collapsed, queued("qz", "snoozed"), "a1", "active"],
  [
    "Snooze -> Queue (wake and queue; route only)",
    expanded,
    main("z1", "snoozed"),
    QUEUE_DROP_ID,
    "enqueue",
  ],
  [
    "into custom section: Active -> member row",
    collapsed,
    main("a1", "active"),
    "c1",
    "custom:focus",
  ],
  [
    "into custom section: Active -> header",
    collapsed,
    main("a1", "active"),
    customSectionHeaderId("focus"),
    "custom:focus",
  ],
  ["Queue -> Pinned", collapsed, queued("q", "active"), "p1", "pinned"],
  // Already snoozed: unqueued only (the handler re-reads the section)
  ["Queue row resting in Snoozed -> shelf", collapsed, queued("qz", "snoozed"), SNOOZE, "snooze"],
  // A header approached from below means its own section only when it shows no rows.
  [
    "Snooze -> collapsed custom header Later from below",
    withLater({ total: 1, visible: ["z1"] }),
    main("z1", "snoozed"),
    customSectionHeaderId("later"),
    "custom:later",
  ],
  [
    "Settled -> collapsed custom header from below",
    withLater({ total: 1, visible: [] }),
    main("s1", "settled"),
    customSectionHeaderId("later"),
    "custom:later",
  ],
  [
    "Settled row -> its own Settled header (nothing snoozed, no custom section)",
    emptyNoCustom,
    main("s1", "settled"),
    sidebarMarkerId("settled-header"),
    "active",
  ],
  // With Focus above the shelves, arrayMove takes the end of Focus.
  [
    "Settled row -> its own Settled header (nothing snoozed, Focus above)",
    empty,
    main("s1", "settled"),
    sidebarMarkerId("settled-header"),
    "custom:focus",
  ],
] as const;

// A refused source never reaches the shelf, and an unlisted zone is offered nowhere.
const blocked = [
  [
    "blocked source (canSnooze false) -> collapsed shelf",
    collapsed,
    main("a1", "active"),
    SNOOZE,
    { supportsSnooze: true, canSnooze: false, canOperate: true },
  ],
  [
    "old server (no threadSnooze) -> empty shelf",
    empty,
    main("a1", "active"),
    PLACEHOLDER,
    { supportsSnooze: false, canSnooze: true, canOperate: true },
  ],
  [
    "blocked source -> expanded shelf row",
    expanded,
    main("a1", "active"),
    "z1",
    { supportsSnooze: true, canSnooze: false, canOperate: true },
  ],
  [
    "Queue row this connection cannot operate -> shelf",
    collapsed,
    queued("q", "active"),
    SNOOZE,
    { ...ok, canOperate: false },
  ],
  ["snoozed main-list row -> its own shelf header", expanded, main("z1", "snoozed"), SNOOZE, ok],
  [
    "empty-shelf placeholder while the shelf has threads",
    collapsed,
    main("a1", "active"),
    PLACEHOLDER,
    ok,
  ],
] as const;

describe("sidebar drag pairs", () => {
  it.each(pairs)("%s", (_pair, items, drag, overId, expected) => {
    expect(outcome(liveRoute(items, drag, overId))).toBe(expected);
  });
  it.each(blocked)("%s routes nothing", (_pair, items, drag, overId, snooze) => {
    expect(outcome(liveRoute(items, drag, overId, snooze))).toBe("none");
  });
});
