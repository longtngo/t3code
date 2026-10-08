import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { makeThreadFixture } from "../test-fixtures";
import {
  applySidebarThreadDrop,
  buildSidebarListItems,
  customSectionHeaderId,
  customSidebarSection,
  isSidebarDragCandidate,
  nextSidebarDragOver,
  planSidebarThreadDrop,
  projectSidebarHeldDrop,
  resolveSidebarDropTarget,
  resolveSidebarDropVerb,
  routeSidebarDragEnd,
  runSidebarSnoozeDrop,
  runSidebarWakeAndQueue,
  shouldReleaseOptimisticDrop,
  sidebarDropDestinationKeys,
  sidebarDropPlanInput,
  sidebarDragListItems,
  sidebarDropUnqueue,
  sidebarListedThreads,
  sidebarListItemId,
  sidebarHeldRows,
  sidebarMarkerId,
  sidebarOptimisticDrop,
  sidebarPickupRefused,
  sidebarQueueRowDragDisabled,
  sidebarQueueBlockEntries,
  sidebarQueuePlacement,
  sidebarDragQueueEntryCount,
  sidebarReleaseSnoozeState,
  sidebarRestingSection,
  sidebarShownQueueEntries,
  sidebarSnoozeDropAllowed,
  sidebarSnoozeZoneIds,
  sortThreadsForSidebar,
  withQueuedRow,
  type SidebarDragOrigin,
  type SidebarDragOverState,
  type SidebarDropBoard,
  type SidebarListItem,
  type SidebarOptimisticDrop,
  type SidebarSection,
  type SidebarSnoozeOutcome,
} from "./Sidebar.logic";

const none = { total: 0, visible: [] as string[] };
/** Pinned p1 | Active a1 a2 | (custom) | shelves | Settled s1: the live shape `Sidebar.tsx` builds. */
const list = (overrides: Partial<Parameters<typeof buildSidebarListItems>[0]> = {}) =>
  buildSidebarListItems({
    pinned: ["p1"],
    active: ["a1", "a2"],
    working: none,
    snoozed: none,
    settled: { total: 1, visible: ["s1"] },
    custom: [],
    ...overrides,
  });
const ids = (items: readonly SidebarListItem[]) => items.map(sidebarListItemId);
const HEADER = sidebarMarkerId("snoozed-header");
const PLACEHOLDER = sidebarMarkerId("snoozed-placeholder");

describe("the Snoozed shelf as a drop zone", () => {
  it("an empty shelf keeps a zero-height placeholder in the list at rest, right above Settled", () => {
    expect(ids(list())).toEqual([
      "sidebar-marker-pinned-header",
      "p1",
      "sidebar-marker-pinned-divider",
      "sidebar-marker-active-placeholder",
      "a1",
      "a2",
      PLACEHOLDER,
      "sidebar-marker-settled-header",
      "sidebar-marker-settled-placeholder",
      "s1",
    ]);
    // A shelf with threads has its header instead, collapsed or not.
    expect(ids(list({ snoozed: { total: 1, visible: [] } }))).not.toContain(PLACEHOLDER);
  });

  it("names the header, the placeholder and every shelf row but the lifted one as zones", () => {
    expect(sidebarSnoozeZoneIds(list(), "a1")).toEqual([PLACEHOLDER]);
    expect(sidebarSnoozeZoneIds(list({ snoozed: { total: 2, visible: [] } }), "a1")).toEqual([
      HEADER,
    ]);
    const expanded = list({ snoozed: { total: 2, visible: ["z1", "z2"] } });
    expect(sidebarSnoozeZoneIds(expanded, "a1")).toEqual([HEADER, "z1", "z2"]);
    expect(sidebarSnoozeZoneIds(expanded, "z1")).toEqual([HEADER, "z2"]);
  });

  it("never resolves a zone as a list target", () => {
    const expanded = list({ snoozed: { total: 1, visible: ["z1"] } });
    expect(resolveSidebarDropTarget(expanded, "s1", HEADER)).toBeNull();
    expect(resolveSidebarDropTarget(expanded, "a1", "z1")).toBeNull();
    expect(resolveSidebarDropTarget(list(), "s1", PLACEHOLDER)).toBeNull();
    expect(resolveSidebarDropTarget(list(), "a1", PLACEHOLDER)).toBeNull();
  });

  it("the slot after the placeholder stays the section above it (a row's own Settled header)", () => {
    expect(resolveSidebarDropTarget(list(), "s1", sidebarMarkerId("settled-header"))).toEqual({
      section: "active",
      pinnedOrder: ["p1"],
      activeOrder: ["a1", "a2", "s1"],
    });
  });

  it("a Queue row joins above the placeholder, where the Queue renders", () => {
    expect(ids(withQueuedRow(list(), "q", "active")).slice(4, 8)).toEqual([
      "a1",
      "a2",
      "q",
      PLACEHOLDER,
    ]);
  });

  it("Working stays neither source nor target", () => {
    const withWorking = list({ working: { total: 1, visible: ["w1"] } });
    expect(resolveSidebarDropTarget(withWorking, "a1", "w1")).toBeNull();
  });
});

const NOW = "2026-10-08T12:00:00.000Z";
const caps = { threadSettlement: true, threadSnooze: true };
const FOCUS = customSidebarSection("focus");
const LATER = customSidebarSection("later");
/** Focus f1 f2 (expanded) and Later (empty), between Active and the shelves. */
const sectioned = (focus: string[] = ["f1", "f2"], later: string[] = []) =>
  list({
    custom: [
      { id: "focus", visible: focus, collapsed: false },
      { id: "later", visible: later, collapsed: false },
    ],
  });
/** Focus collapsed, still showing `focus` (the open thread f2 by default); Later empty. */
const collapsedFocus = (focus: string[] = ["f2"]) =>
  list({
    custom: [
      { id: "focus", visible: focus, collapsed: true },
      { id: "later", visible: [], collapsed: false },
    ],
  });
const keys = new Map<string, string | null>([
  ["p1", "p"],
  ["a1", "a"],
  ["a2", "b"],
  ["f1", "c"],
  ["f2", "d"],
  ["s1", null],
  ["z1", null],
]);
const writable = new Set(keys.keys());
const board: SidebarDropBoard = {
  pinnedOrder: ["p1"],
  pinnedKeysById: keys,
  reorderableKeys: writable,
  activeOrder: ["a1", "a2"],
  activeKeysById: keys,
  activeReorderableKeys: writable,
  activeTimeOrdered: false,
  customSectionIds: new Set(["focus", "later"]),
  customOrders: new Map([
    ["focus", ["f1", "f2"]],
    ["later", []],
  ]),
};
type SourceFields = {
  pinnedAt: string | null;
  settledOverride: "settled" | "active" | null;
  sidebarSectionId: string | null;
};
const source = (overrides: Partial<SourceFields> = {}) => ({
  pinnedAt: null,
  settledOverride: null,
  sidebarSectionId: null,
  supportsSettlement: true,
  supportsSections: true,
  ...overrides,
});
const at = (activeKey: string, activeSection: SidebarSection, fromQueue = false) => ({
  activeKey,
  activeSection,
  fromQueue,
});
const plan = (
  drag: Pick<SidebarDragOrigin, "activeKey" | "activeSection" | "fromQueue">,
  src: ReturnType<typeof source>,
  target: Parameters<typeof sidebarDropPlanInput>[3],
  onBoard: SidebarDropBoard = board,
) => planSidebarThreadDrop(sidebarDropPlanInput(onBoard, drag, src, target));

describe("custom sections take drops", () => {
  it("a row dropped among a section's rows lands after the row above it", () => {
    expect(resolveSidebarDropTarget(sectioned(), "a1", "f1")).toEqual({
      section: FOCUS,
      pinnedOrder: ["p1"],
      activeOrder: ["a2"],
      customAfter: "f1",
    });
    expect(resolveSidebarDropTarget(sectioned(), "f1", "f2")).toMatchObject({
      section: FOCUS,
      customAfter: "f2",
    });
    expect(resolveSidebarDropTarget(sectioned(), "f2", "f1")).toMatchObject({
      section: FOCUS,
      customAfter: null,
    });
  });

  it("any header drop from above lands at the top, even past a collapsed section's open row", () => {
    const header = customSectionHeaderId("focus");
    expect(resolveSidebarDropTarget(sectioned(), "a1", header)).toMatchObject({
      section: FOCUS,
      customAfter: null,
    });
    // Collapsed Focus still shows the open thread f2.
    expect(resolveSidebarDropTarget(collapsedFocus(), "a1", header)).toMatchObject({
      section: FOCUS,
      customAfter: null,
    });
  });

  it("a collapsed or empty section's header joins it from either direction", () => {
    const later = customSectionHeaderId("later");
    const focus = customSectionHeaderId("focus");
    // Empty Later, expanded: its header is the only way in, from below and from above.
    expect(resolveSidebarDropTarget(sectioned(), "s1", later)).toEqual({
      section: LATER,
      pinnedOrder: ["p1"],
      activeOrder: ["a1", "a2"],
      customAfter: null,
    });
    expect(resolveSidebarDropTarget(sectioned(), "a1", later)).toEqual({
      section: LATER,
      pinnedOrder: ["p1"],
      activeOrder: ["a2"],
      customAfter: null,
    });
    // Collapsed Focus still shows the open thread f2; its header joins Focus from below too.
    expect(resolveSidebarDropTarget(collapsedFocus(), "s1", focus)).toEqual({
      section: FOCUS,
      pinnedOrder: ["p1"],
      activeOrder: ["a1", "a2"],
      customAfter: null,
    });
    // A collapsed section showing no row is joined the same way.
    expect(resolveSidebarDropTarget(collapsedFocus([]), "s1", focus)?.section).toBe(FOCUS);
  });

  it("over a collapsed section's header from below, the badge and the drop both join it", () => {
    const items = collapsedFocus();
    const overId = customSectionHeaderId("focus");
    const over = nextSidebarDragOver({
      current: { targetSection: null, overZone: null, stickyOverId: null },
      overId,
      activeKey: "s1",
      items,
      queuedKeys: new Set(),
      queueDropId: "queue",
    });
    expect(over.targetSection).toBe(FOCUS);
    expect(resolveSidebarDropVerb("settled", over.targetSection)).toBe("move");
    expect(
      routeSidebarDragEnd({
        drag: { activeKey: "s1", activeSection: "settled", fromQueue: false, queuedDraft: false },
        overId,
        items,
        queuedKeys: new Set(),
        queueDropId: "queue",
        snoozeAllowed: true,
      }),
    ).toMatchObject({ kind: "place", target: { section: FOCUS, customAfter: null } });
  });

  it("the open row dropped on its own collapsed header does nothing: no target, badge or route", () => {
    const items = collapsedFocus();
    const overId = customSectionHeaderId("focus");
    expect(resolveSidebarDropTarget(items, "f2", overId)).toBeNull();
    const over = nextSidebarDragOver({
      current: { targetSection: null, overZone: null, stickyOverId: null },
      overId,
      activeKey: "f2",
      items,
      queuedKeys: new Set(),
      queueDropId: "queue",
    });
    expect(over.targetSection).toBeNull();
    expect(resolveSidebarDropVerb(FOCUS, over.targetSection)).toBeNull();
    expect(
      routeSidebarDragEnd({
        drag: { activeKey: "f2", activeSection: FOCUS, fromQueue: false, queuedDraft: false },
        overId,
        items,
        queuedKeys: new Set(),
        queueDropId: "queue",
        snoozeAllowed: true,
      }),
    ).toEqual({ kind: "none" });
    // A queued member, lifted from the Queue above the sections, still drops back to unqueue.
    const fromQueue = withQueuedRow(items, "q", FOCUS);
    const back = resolveSidebarDropTarget(fromQueue, "q", overId);
    expect(back?.section).toBe(FOCUS);
    expect(resolveSidebarDropVerb(FOCUS, back!.section, true)).toBe("unqueue");
  });

  it("the end of Active stays reachable from above, over the last Active row, past a collapsed first section", () => {
    // Focus, right under Active, is collapsed and shows the open thread f2.
    const items = collapsedFocus();
    expect(resolveSidebarDropTarget(items, "p1", "a2")).toEqual({
      section: "active",
      pinnedOrder: [],
      activeOrder: ["a1", "a2", "p1"],
    });
    expect(resolveSidebarDropTarget(items, "a1", "a2")).toEqual({
      section: "active",
      pinnedOrder: ["p1"],
      activeOrder: ["a2", "a1"],
    });
  });

  it("an expanded section with rows keeps the boundary: from below its header is the section above", () => {
    expect(resolveSidebarDropTarget(sectioned(), "s1", customSectionHeaderId("focus"))).toEqual({
      section: "active",
      pinnedOrder: ["p1"],
      activeOrder: ["a1", "a2", "s1"],
    });
    // One row shown, not collapsed: still the boundary.
    expect(
      resolveSidebarDropTarget(sectioned(["f2"]), "s1", customSectionHeaderId("focus"))?.section,
    ).toBe("active");
  });

  it("the slot above a placeholder is the end of the section above it, not its top", () => {
    // Nothing snoozed: the placeholder sits between Focus's last row and Settled.
    const items = list({ custom: [{ id: "focus", visible: ["f1"], collapsed: false }] });
    expect(resolveSidebarDropTarget(items, "s1", sidebarMarkerId("settled-header"))).toMatchObject({
      section: FOCUS,
      customAfter: "f1",
    });
  });

  it("the end of Active stays reachable from Settled and from a member (no Snoozed shelf)", () => {
    const items = list({ custom: [{ id: "focus", visible: ["f1", "f2"], collapsed: false }] });
    const reachable = (key: string) =>
      items
        .map((item) => resolveSidebarDropTarget(items, key, sidebarListItemId(item)))
        .filter((target) => target?.section === "active")
        .map((target) => target!.activeOrder.join(","));
    expect(reachable("s1")).toContain("a1,a2,s1");
    expect(reachable("f1")).toContain("a1,a2,f1");
  });

  it("a header that no longer exists resolves nothing", () => {
    expect(resolveSidebarDropTarget(sectioned(), "a1", customSectionHeaderId("gone"))).toBeNull();
  });

  it("joins a section with the move planner and never clears membership", () => {
    const joined = plan(
      at("a1", "active"),
      source(),
      resolveSidebarDropTarget(sectioned(), "a1", "f1")!,
    );
    expect(joined).toMatchObject({
      kind: "move-active",
      order: ["f1", "a1", "f2"],
      joinsSection: "focus",
      unpin: false,
      unsettle: false,
      unsnooze: false,
    });
    expect(joined).not.toHaveProperty("clearsSection");
    expect(joined.kind === "move-active" && joined.assignments.map(({ id }) => id)).toContain("a1");
  });

  it("a Focus member dropped into Later moves there with no setSection(null)", () => {
    const moved = plan(
      at("f1", FOCUS),
      source({ sidebarSectionId: "focus" }),
      resolveSidebarDropTarget(sectioned(), "f1", customSectionHeaderId("later"))!,
    );
    expect(moved).toMatchObject({ kind: "move-active", order: ["f1"], joinsSection: "later" });
    expect(moved).not.toHaveProperty("clearsSection");
  });

  it("reorders within a section, and a drop back in place writes nothing", () => {
    expect(
      plan(
        at("f2", FOCUS),
        source({ sidebarSectionId: "focus" }),
        resolveSidebarDropTarget(sectioned(), "f2", "f1")!,
      ),
    ).toMatchObject({ kind: "move-active", order: ["f2", "f1"], joinsSection: "focus" });
    expect(
      plan(at("f1", FOCUS), source({ sidebarSectionId: "focus" }), {
        section: FOCUS,
        pinnedOrder: [],
        activeOrder: [],
        customAfter: null,
      }),
    ).toEqual({ kind: "none" });
  });

  it("a pinned, settled or snoozed source joins too: the section move clears those itself", () => {
    const target = resolveSidebarDropTarget(sectioned(), "s1", customSectionHeaderId("later"))!;
    const cases = [
      ["pinned", { pinnedAt: NOW }],
      ["settled", { settledOverride: "settled" }],
      ["snoozed", {}],
    ] as const;
    for (const [section, fields] of cases) {
      expect(plan(at("s1", section), source(fields), target)).toMatchObject({
        kind: "move-active",
        joinsSection: "later",
        unpin: false,
        unsettle: false,
        unsnooze: false,
      });
    }
  });

  it("time-ordered (Working beta): a join writes no key, and within a section is no move", () => {
    const timed = { ...board, activeTimeOrdered: true };
    expect(
      plan(at("a1", "active"), source(), resolveSidebarDropTarget(sectioned(), "a1", "f1")!, timed),
    ).toEqual({
      kind: "move-active",
      order: null,
      assignments: [],
      unpin: false,
      unsettle: false,
      unsnooze: false,
      joinsSection: "focus",
    });
    expect(
      plan(
        at("f2", FOCUS),
        source({ sidebarSectionId: "focus" }),
        resolveSidebarDropTarget(sectioned(), "f2", "f1")!,
        timed,
      ),
    ).toEqual({ kind: "none" });
  });

  it("a source whose server cannot store membership never joins", () => {
    expect(
      plan(
        at("a1", "active"),
        { ...source(), supportsSections: false },
        resolveSidebarDropTarget(sectioned(), "a1", "f1")!,
      ),
    ).toEqual({ kind: "none" });
  });

  it("a member on an older server stays a bound and is never written", () => {
    const withOld: SidebarDropBoard = {
      ...board,
      activeKeysById: new Map([...keys, ["old", null]]),
      customOrders: new Map([
        ["focus", ["f1", "old", "f2"]],
        ["later", []],
      ]),
    };
    const joined = plan(
      at("a1", "active"),
      source(),
      { section: FOCUS, pinnedOrder: [], activeOrder: [], customAfter: "old" },
      withOld,
    );
    expect(joined).toMatchObject({ kind: "move-active", order: ["f1", "old", "a1", "f2"] });
    expect(joined.kind === "move-active" && joined.assignments.map(({ id }) => id)).not.toContain(
      "old",
    );
  });

  it("projects a join: membership set, pin, settle and snooze cleared, the new key applied", () => {
    const thread = makeThreadFixture({
      pinnedAt: NOW,
      pinOrderKey: "p",
      settledOverride: "settled",
      settledAt: NOW,
      snoozedAt: NOW,
      snoozedUntil: "2099-01-01T00:00:00.000Z",
      sidebarSectionId: "focus",
    });
    const joined = applySidebarThreadDrop(thread, LATER, NOW, "k");
    expect(joined).toMatchObject({
      sidebarSectionId: "later",
      pinnedAt: null,
      pinOrderKey: null,
      settledOverride: "active",
      snoozedUntil: null,
      activeOrderKey: "k",
    });
    expect(sidebarRestingSection(joined, caps, NOW, new Set(["focus", "later"]))).toBe(LATER);
  });

  it("holds a join until its key lands, then releases", () => {
    const drop: SidebarOptimisticDrop = {
      key: "s1",
      sourceSection: "settled",
      section: LATER,
      occurredAt: NOW,
      clearsSnooze: true,
      clearsSection: null,
      order: ["s1"],
      keysAtDrop: new Map([["s1", null]]),
      assignedKeys: new Map([["s1", "k"]]),
    };
    const check = (fields: Parameters<typeof makeThreadFixture>[0]) => {
      const thread = makeThreadFixture(fields);
      return shouldReleaseOptimisticDrop({
        drop,
        thread,
        now: NOW,
        customSectionIds: new Set(["later"]),
        destinationKeys: ["s1"],
        queued: false,
        keyByThread: new Map([["s1", thread.activeOrderKey ?? null]]),
      });
    };
    expect(check({ settledOverride: "settled" })).toBe(false);
    expect(check({ settledOverride: "settled", sidebarSectionId: "later" })).toBe(false);
    expect(check({ settledOverride: "active", sidebarSectionId: "later" })).toBe(false);
    expect(
      check({ settledOverride: "active", sidebarSectionId: "later", activeOrderKey: "k" }),
    ).toBe(true);
  });

  it("a Queue row joining a section leaves the Queue only once it joined; elsewhere at once", () => {
    const items = withQueuedRow(sectioned(), "q1", "active");
    const later = resolveSidebarDropTarget(items, "q1", customSectionHeaderId("later"))!;
    const queuedKeys = new Map([...keys, ["q1", "e"]]);
    const onBoard = {
      ...board,
      activeKeysById: queuedKeys,
      activeReorderableKeys: new Set(queuedKeys.keys()),
    };
    const joins = plan(at("q1", "active", true), source(), later, onBoard);
    expect(joins).toMatchObject({ kind: "move-active", joinsSection: "later" });
    expect(sidebarDropUnqueue(true, joins)).toBe("on-join");
    const active = resolveSidebarDropTarget(items, "q1", "a2")!;
    expect(
      sidebarDropUnqueue(true, plan(at("q1", "active", true), source(), active, onBoard)),
    ).toBe("now");
    // Back on its resting section the plan is empty, and the drop still unqueues.
    expect(sidebarDropUnqueue(true, { kind: "none" })).toBe("now");
    expect(sidebarDropUnqueue(false, joins)).toBeNull();
  });

  it("a settle from Snoozed plans the wake the server's settle does not do", () => {
    const settled = { section: "settled", pinnedOrder: ["p1"], activeOrder: ["a1", "a2"] } as const;
    expect(plan(at("z1", "snoozed"), source(), settled)).toEqual({
      kind: "settle",
      unsnooze: true,
    });
    expect(plan(at("a1", "active"), source(), settled)).toEqual({
      kind: "settle",
      unsnooze: false,
    });
    expect(plan(at("s1", "settled"), source({ settledOverride: "settled" }), settled)).toEqual({
      kind: "none",
    });
  });
});

describe("a held shelf drop", () => {
  const ids = new Set(["focus", "later"]);
  const settled = { section: "settled", pinnedOrder: ["p1"], activeOrder: ["a1", "a2"] } as const;

  it("Snoozed -> Settled shows the row awake in Settled until the wake lands", () => {
    const planned = plan(at("z1", "snoozed"), source(), settled);
    if (planned.kind !== "settle") throw new Error(planned.kind);
    const drop = sidebarOptimisticDrop({
      key: "z1",
      sourceSection: "snoozed",
      section: "settled",
      plan: planned,
      assignments: [],
      occurredAt: NOW,
      pinnedKeysById: new Map(),
      activeKeysById: keys,
    });
    const snoozed = { snoozedAt: NOW, snoozedUntil: "2026-10-09T12:00:00.000Z" };
    const shown = projectSidebarHeldDrop(makeThreadFixture(snoozed), drop);
    expect(shown.thread.snoozedUntil).toBeNull();
    expect(sidebarRestingSection(shown.thread, caps, NOW, ids)).toBe("settled");
    const release = (fields: Parameters<typeof makeThreadFixture>[0]) =>
      shouldReleaseOptimisticDrop({
        drop,
        thread: makeThreadFixture(fields),
        now: NOW,
        customSectionIds: ids,
        destinationKeys: [],
        queued: false,
        keyByThread: new Map(),
      });
    // Settled landed, the wake not yet: still held.
    expect(release({ ...snoozed, settledOverride: "settled", settledAt: NOW })).toBe(false);
    expect(release({ settledOverride: "settled", settledAt: NOW })).toBe(true);
  });

  it("a pinned reorder is held until its own key lands, not released by the pins' existing keys", () => {
    // Pin keys and active keys differ, as they do live.
    const pinnedKeysById = new Map<string, string | null>([
      ["p1", "m"],
      ["p2", "t"],
    ]);
    const onBoard: SidebarDropBoard = {
      ...board,
      pinnedOrder: ["p1", "p2"],
      pinnedKeysById,
      reorderableKeys: new Set(["p1", "p2"]),
    };
    const target = {
      section: "pinned",
      pinnedOrder: ["p2", "p1"],
      activeOrder: ["a1", "a2"],
    } as const;
    const planned = plan(at("p2", "pinned"), source({ pinnedAt: NOW }), target, onBoard);
    if (planned.kind !== "reorder-pinned") throw new Error(planned.kind);
    const drop = sidebarOptimisticDrop({
      key: "p2",
      sourceSection: "pinned",
      section: "pinned",
      plan: planned,
      assignments: planned.assignments,
      occurredAt: NOW,
      pinnedKeysById,
      activeKeysById: keys,
    });
    const p2Key = drop.assignedKeys.get("p2")!;
    const release = (key: string) =>
      shouldReleaseOptimisticDrop({
        drop,
        thread: makeThreadFixture({ pinnedAt: NOW, pinOrderKey: key }),
        now: NOW,
        customSectionIds: ids,
        destinationKeys: ["p1", "p2"],
        queued: false,
        keyByThread: new Map([
          ["p1", "m"],
          ["p2", key],
        ]),
      });
    // One write, to the moved row.
    expect([...drop.assignedKeys.keys()]).toEqual(["p2"]);
    expect(release("t")).toBe(false);
    expect(release(p2Key)).toBe(true);
  });
});

describe("a join is held in its section until it lands", () => {
  const ids = new Set(["focus", "later"]);
  const held = (
    drag: ReturnType<typeof at>,
    src: ReturnType<typeof source>,
    overId: string,
    onBoard: SidebarDropBoard = board,
  ) => {
    const target = resolveSidebarDropTarget(sectioned(), drag.activeKey, overId)!;
    const planned = plan(drag, src, target, onBoard);
    if (planned.kind === "none" || planned.kind === "unpark") throw new Error(planned.kind);
    return sidebarOptimisticDrop({
      key: drag.activeKey,
      sourceSection: drag.activeSection,
      section: target.section,
      plan: planned,
      assignments: planned.kind === "move-active" ? planned.assignments : [],
      occurredAt: NOW,
      pinnedKeysById: onBoard.pinnedKeysById as ReadonlyMap<string, string | null>,
      activeKeysById: onBoard.activeKeysById as ReadonlyMap<string, string | null>,
    });
  };

  it("shows a pinned, settled or snoozed row in the section it joined, cleared", () => {
    const header = customSectionHeaderId("later");
    const cases = [
      ["pinned", { pinnedAt: NOW }, { pinnedAt: NOW }],
      ["settled", { settledOverride: "settled" }, { settledOverride: "settled", settledAt: NOW }],
      ["snoozed", {}, { snoozedAt: NOW, snoozedUntil: "2026-10-09T12:00:00.000Z" }],
    ] as const;
    for (const [section, src, fields] of cases) {
      const drop = held(at("s1", section), source(src), header);
      const shown = projectSidebarHeldDrop(makeThreadFixture(fields), drop);
      expect(shown.section, section).toBe(LATER);
      expect(shown.thread.sidebarSectionId, section).toBe("later");
      expect(sidebarRestingSection(shown.thread, caps, NOW, ids), section).toBe(LATER);
    }
  });

  it("waits for the joined row's key, not for keys the section's rows already held", () => {
    // Pin keys differ from active keys, as they do live: a section row has an active key only.
    const onBoard = { ...board, pinnedKeysById: new Map([["p1", "p"]]) };
    const drop = held(at("a1", "active"), source(), "f1", onBoard);
    expect(drop.order).toEqual(["f1", "a1", "f2"]);
    const joinedKey = drop.assignedKeys.get("a1")!;
    // Canonical state once the section move landed and the board re-rendered the held row there.
    const landed = { ...board, customOrders: new Map([["focus", ["f1", "a1", "f2"]]]) };
    const check = (a1Key: string) =>
      shouldReleaseOptimisticDrop({
        drop,
        thread: makeThreadFixture({ sidebarSectionId: "focus", activeOrderKey: a1Key }),
        now: NOW,
        customSectionIds: ids,
        destinationKeys: sidebarDropDestinationKeys(drop.section, landed),
        queued: false,
        keyByThread: new Map([
          ["f1", "c"],
          ["a1", a1Key],
          ["f2", "d"],
        ]),
      });
    expect(check("a")).toBe(false);
    expect(check(joinedKey)).toBe(true);
  });

  it("refuses to lift the held row again until its drop lands", () => {
    const drop = held(at("a1", "active"), source(), "f1");
    // Lifted while held, a Queue join's row would classify as a Queue drag (the raw Queue still
    // lists it until `joined`) and appear twice in the drag list.
    const duplicated = sidebarDragListItems(
      buildSidebarListItems({
        pinned: [],
        active: [],
        working: none,
        snoozed: none,
        settled: none,
        custom: [{ id: "focus", visible: ["a1", "f1"], collapsed: false }],
      }),
      { activeKey: "a1", activeSection: "active", fromQueue: true, queuedDraft: false },
    ).filter((item) => item.kind === "thread" && item.key === "a1");
    expect(duplicated).toHaveLength(2);
    expect(sidebarPickupRefused("a1", drop)).toBe(true);
    expect(sidebarPickupRefused("f1", drop)).toBe(false);
    expect(sidebarPickupRefused("a1", null)).toBe(false);
  });

  it("locks every Queue row while a drop is held, as it locks main-list rows", () => {
    const drop = held(at("a1", "active"), source(), "f1");
    // A second Queue row released over the held join's row would route a Queue reorder against
    // an entry the Queue no longer shows, and a second drop would replace the held one.
    const route = routeSidebarDragEnd({
      drag: { activeKey: "q2", activeSection: "active", fromQueue: true, queuedDraft: false },
      overId: "a1",
      items: buildSidebarListItems({
        pinned: [],
        active: [],
        working: none,
        snoozed: none,
        settled: none,
        custom: [{ id: "focus", visible: ["a1", "f1"], collapsed: false }],
      }),
      queuedKeys: new Set(["a1", "q2"]),
      queueDropId: "queue",
      snoozeAllowed: false,
    });
    expect(route).toEqual({ kind: "reorder-queue", overKey: "a1" });
    expect(sidebarQueueRowDragDisabled({ readOnly: false, drop })).toBe(true);
    expect(sidebarQueueRowDragDisabled({ readOnly: false, drop: null })).toBe(false);
    expect(sidebarQueueRowDragDisabled({ readOnly: true, drop: null })).toBe(true);
  });

  const thread = (id: string, fields: Parameters<typeof makeThreadFixture>[0] = {}) =>
    makeThreadFixture({ id: ThreadId.make(id), ...fields });
  const rowKey = (row: ReturnType<typeof thread>) =>
    scopedThreadKey(scopeThreadRef(row.environmentId, row.id));

  const entryKeys = (
    entries: ReadonlyArray<{ environmentId: EnvironmentId; threadId: ThreadId }>,
  ) =>
    new Set(
      entries.map((entry) => scopedThreadKey(scopeThreadRef(entry.environmentId, entry.threadId))),
    );

  it("a Queue row joining a section is held there until its key lands", () => {
    const queuedRow = thread("q");
    const q = rowKey(queuedRow);
    const entries = [{ environmentId: queuedRow.environmentId, threadId: queuedRow.id }];
    const items = withQueuedRow(sectioned(), q, "active");
    const onBoard = {
      ...board,
      activeKeysById: new Map([...keys, [q, "e"]]),
      activeReorderableKeys: new Set([...writable, q]),
    };
    const target = resolveSidebarDropTarget(items, q, customSectionHeaderId("later"))!;
    const planned = plan(at(q, "active", true), source(), target, onBoard);
    if (planned.kind !== "move-active") throw new Error(planned.kind);
    const drop = sidebarOptimisticDrop({
      key: q,
      sourceSection: "active",
      section: target.section,
      plan: planned,
      assignments: planned.assignments,
      occurredAt: NOW,
      pinnedKeysById: new Map(),
      activeKeysById: onBoard.activeKeysById,
    });
    const joinedKey = drop.assignedKeys.get(q)!;
    // Canonical state once the membership write landed: the row is still queued (`joined` runs
    // after the move), and the board lists Later from the threads the memo shows.
    const check = (activeOrderKey: string) => {
      const canonical = thread("q", { sidebarSectionId: "later", activeOrderKey });
      const { visible } = sidebarListedThreads({
        threads: [canonical],
        scopedProjectKeys: null,
        queuedKeys: entryKeys(sidebarShownQueueEntries(entries, drop)),
        capabilitiesOf: () => undefined,
      });
      return shouldReleaseOptimisticDrop({
        drop,
        thread: canonical,
        now: NOW,
        customSectionIds: ids,
        destinationKeys: sidebarDropDestinationKeys(drop.section, {
          ...board,
          customOrders: new Map([["later", visible.map(rowKey)]]),
        }),
        queued: false,
        keyByThread: new Map([[q, activeOrderKey]]),
      });
    };
    expect(check("e")).toBe(false);
    expect(check(joinedKey)).toBe(true);
    // The hold ended (a refused or failed join included): the row is back in the Queue.
    expect(entryKeys(sidebarShownQueueEntries(entries, null)).has(q)).toBe(true);
    // Only a join leaves it: a Queue row held on its way to Active stays in the filter.
    expect(
      entryKeys(sidebarShownQueueEntries(entries, { ...drop, section: "active" })).has(q),
    ).toBe(true);
  });

  it("a Queue join stays held while the raw Queue still lists it, time-ordered or manual", () => {
    const queuedRow = thread("q");
    const q = rowKey(queuedRow);
    const items = withQueuedRow(sectioned(), q, "active");
    const target = resolveSidebarDropTarget(items, q, customSectionHeaderId("later"))!;
    const heldJoin = (activeTimeOrdered: boolean) => {
      const onBoard = {
        ...board,
        activeTimeOrdered,
        activeKeysById: new Map([...keys, [q, "e"]]),
        activeReorderableKeys: new Set([...writable, q]),
      };
      const planned = plan(at(q, "active", true), source(), target, onBoard);
      if (planned.kind !== "move-active") throw new Error(planned.kind);
      return sidebarOptimisticDrop({
        key: q,
        sourceSection: "active",
        section: target.section,
        plan: planned,
        assignments: planned.assignments,
        occurredAt: NOW,
        pinnedKeysById: new Map(),
        activeKeysById: onBoard.activeKeysById,
      });
    };
    // Membership is optimistic, so canonical shows Later at dispatch; `joined` (the unqueue) runs
    // only after the ack, and the key writes after that.
    const release = (drop: SidebarOptimisticDrop, activeOrderKey: string, queued: boolean) =>
      shouldReleaseOptimisticDrop({
        drop,
        thread: thread("q", { sidebarSectionId: "later", activeOrderKey }),
        now: NOW,
        customSectionIds: ids,
        destinationKeys: [q],
        keyByThread: new Map([[q, activeOrderKey]]),
        queued,
      });
    // Working (beta) on: no order, no key; membership alone used to release it.
    const timeOrdered = heldJoin(true);
    expect(timeOrdered.order).toBeNull();
    expect(release(timeOrdered, "e", true)).toBe(false);
    expect(release(timeOrdered, "e", false)).toBe(true);
    // Manual order: still waits for its key, and releases once it landed and the Queue let go.
    const manual = heldJoin(false);
    const joinedKey = manual.assignedKeys.get(q)!;
    expect(release(manual, joinedKey, true)).toBe(false);
    expect(release(manual, "e", false)).toBe(false);
    expect(release(manual, joinedKey, false)).toBe(true);
    // Only a join waits on the Queue: a Queue row held on its way to Active releases as before.
    expect(
      shouldReleaseOptimisticDrop({
        drop: { ...timeOrdered, section: "active" },
        thread: thread("q", { activeOrderKey: "e" }),
        now: NOW,
        customSectionIds: ids,
        destinationKeys: [q],
        keyByThread: new Map([[q, "e"]]),
        queued: true,
      }),
    ).toBe(true);
  });

  it("the Queue block lists a held join nowhere, and a refused one once", () => {
    const [q, r] = [thread("q"), thread("r")];
    const entries = [q, r].map((row) => ({ environmentId: row.environmentId, threadId: row.id }));
    const drop = (section: SidebarOptimisticDrop["section"]): SidebarOptimisticDrop => ({
      key: rowKey(q),
      sourceSection: "active",
      section,
      occurredAt: NOW,
      clearsSnooze: true,
      clearsSection: null,
      order: [rowKey(q)],
      keysAtDrop: new Map(),
      assignedKeys: new Map([[rowKey(q), "e"]]),
    });
    // Where q shows: the Queue block's entries, plus the main list fed the same filter. The
    // target section's collapse state is not an input: a collapsed Later (no rows shown) and an
    // expanded Focus get the same entries.
    const shows = (held: SidebarOptimisticDrop | null) => {
      const queued = sidebarShownQueueEntries(entries, held);
      const { visible } = sidebarListedThreads({
        threads: [thread("q", { sidebarSectionId: "later" }), r],
        scopedProjectKeys: null,
        queuedKeys: entryKeys(queued),
        capabilitiesOf: () => undefined,
      });
      return {
        queue: [...entryKeys(queued)],
        list: visible.map(rowKey),
      };
    };
    for (const section of [LATER, FOCUS]) {
      expect(shows(drop(section))).toEqual({ queue: [rowKey(r)], list: [rowKey(q)] });
    }
    // The hold ended on a refused or failed join: q is back in the Queue, exactly once.
    expect(shows(null)).toEqual({ queue: [rowKey(q), rowKey(r)], list: [] });
    // A Queue row held on its way to Active stays in the Queue block.
    expect(shows(drop("active")).queue).toEqual([rowKey(q), rowKey(r)]);
  });

  it("a held join keeps its drop order among keyless rows", () => {
    const [f1, f2, a1] = [thread("f1"), thread("f2"), thread("a1", { activeOrderKey: "a" })];
    const sorted = sortThreadsForSidebar([f1, f2]).map(rowKey);
    const [first, second] = sorted as [string, string];
    const onBoard: SidebarDropBoard = {
      ...board,
      activeOrder: [rowKey(a1)],
      activeKeysById: new Map([
        [first, null],
        [second, null],
        [rowKey(a1), "a"],
      ]),
      activeReorderableKeys: new Set([first, second, rowKey(a1)]),
      customOrders: new Map([
        ["focus", sorted],
        ["later", []],
      ]),
    };
    const shown = list({
      active: [rowKey(a1)],
      custom: [
        { id: "focus", visible: sorted, collapsed: false },
        { id: "later", visible: [], collapsed: false },
      ],
    });
    const target = resolveSidebarDropTarget(shown, rowKey(a1), first)!;
    const planned = plan(at(rowKey(a1), "active"), source(), target, onBoard);
    if (planned.kind !== "move-active") throw new Error(planned.kind);
    expect(planned.order).toEqual([first, rowKey(a1), second]);
    const drop = sidebarOptimisticDrop({
      key: rowKey(a1),
      sourceSection: "active",
      section: FOCUS,
      plan: planned,
      assignments: planned.assignments,
      occurredAt: NOW,
      pinnedKeysById: new Map(),
      activeKeysById: onBoard.activeKeysById as ReadonlyMap<string, string | null>,
    });
    const held = projectSidebarHeldDrop(a1, drop).thread;
    const rows = sortThreadsForSidebar([f1, f2, held]);
    expect(sidebarHeldRows(rows, FOCUS, drop, rowKey).map(rowKey)).toEqual(planned.order);
    // Another section, or no hold, keeps the sort.
    expect(sidebarHeldRows(rows, LATER, drop, rowKey)).toEqual(rows);
    expect(sidebarHeldRows(rows, FOCUS, null, rowKey)).toEqual(rows);
  });
});

describe("queued threads in the capability sets", () => {
  const capable = { threadPinning: true, threadPinReorder: true, threadActiveReorder: true };
  const ENV = EnvironmentId.make("environment-test");
  const keyOf = (id: string) => scopedThreadKey(scopeThreadRef(ENV, ThreadId.make(id)));
  const queueKeys = new Map<string, string | null>(
    (
      [
        ["p1", "p"],
        ["a1", "a"],
        ["a2", "b"],
        ["q", "q"],
        ["qp", "r"],
        ["qs", null],
        ["qz", null],
      ] as const
    ).map(([id, key]) => [keyOf(id), key]),
  );
  const queued = new Set(["q", "qp", "qs", "qz"].map(keyOf));
  const threads = ["p1", "a1", "a2", "q", "qp", "qs", "qz"].map((id) =>
    makeThreadFixture({ id: ThreadId.make(id) }),
  );
  // The live call: every thread the sidebar knows, with the Queue's keys. Queued rows render in
  // the Queue, so they are in neither displayed order.
  const listed = (capabilitiesOf: (environmentId: EnvironmentId) => typeof capable | undefined) =>
    sidebarListedThreads({ threads, scopedProjectKeys: null, queuedKeys: queued, capabilitiesOf });
  const onBoard = (sets: { readonly pinned: Set<string>; readonly active: Set<string> }) =>
    ({
      pinnedOrder: [keyOf("p1")],
      pinnedKeysById: queueKeys,
      reorderableKeys: sets.pinned,
      activeOrder: [keyOf("a1"), keyOf("a2")],
      activeKeysById: queueKeys,
      activeReorderableKeys: sets.active,
      activeTimeOrdered: false,
      customSectionIds: new Set(),
      customOrders: new Map(),
    }) satisfies SidebarDropBoard;
  const live = onBoard(listed(() => capable));
  const queuedDrop = (
    id: string,
    section: SidebarSection,
    fields: Parameters<typeof source>[0],
    overId: string,
  ) => {
    const drag = {
      activeKey: keyOf(id),
      activeSection: section,
      fromQueue: true,
      queuedDraft: false,
    };
    const items = list({ pinned: [keyOf("p1")], active: [keyOf("a1"), keyOf("a2")] });
    const target = resolveSidebarDropTarget(
      sidebarDragListItems(items, drag),
      keyOf(id),
      keyOf(overId),
    )!;
    return plan(drag, source(fields), target, live);
  };

  it("lists only unqueued threads, but builds each key set over queued ones too", () => {
    const result = listed(() => capable);
    expect(result.visible.map((thread) => thread.id)).toEqual(["p1", "a1", "a2"]);
    expect(result.pinned).toEqual(new Set(threads.map((thread) => keyOf(thread.id))));
    expect(result.active).toEqual(result.pinned);
  });

  it("builds each set by capability alone", () => {
    const only = (capabilities: Record<string, boolean> | undefined) =>
      listed(() => capabilities as typeof capable | undefined);
    expect(only(capable).pinned.size).toBe(7);
    expect(only({ threadActiveReorder: true })).toMatchObject({ pinned: new Set() });
    expect(only({ threadActiveReorder: true }).active.size).toBe(7);
    expect(
      only({ threadPinning: true, threadPinReorder: true, threadActiveReorder: false }),
    ).toMatchObject({ active: new Set() });
    expect(only({ threadPinning: true, threadActiveReorder: true }).pinned.size).toBe(0);
    expect(only(undefined)).toMatchObject({ pinned: new Set(), active: new Set() });
  });

  it("a queued pinned, settled or snoozed thread dropped on Active becomes active where it was dropped", () => {
    expect(queuedDrop("qp", "pinned", { pinnedAt: NOW }, "a1")).toMatchObject({
      kind: "move-active",
      order: [keyOf("qp"), keyOf("a1"), keyOf("a2")],
      unpin: true,
    });
    expect(queuedDrop("qs", "settled", { settledOverride: "settled" }, "a1")).toMatchObject({
      kind: "move-active",
      unsettle: true,
    });
    expect(queuedDrop("qz", "snoozed", {}, "a1")).toMatchObject({
      kind: "move-active",
      unsnooze: true,
    });
  });

  it("a queued thread dropped on Pinned pins", () => {
    expect(queuedDrop("q", "active", {}, "p1")).toMatchObject({ kind: "pin" });
  });

  it("a Queue row resting in Active writes its key at the drop slot", () => {
    const placed = queuedDrop("q", "active", {}, "a1");
    expect(placed).toMatchObject({
      kind: "move-active",
      order: [keyOf("q"), keyOf("a1"), keyOf("a2")],
    });
    expect(
      placed.kind === "move-active" && placed.assignments.some(({ id }) => id === keyOf("q")),
    ).toBe(true);
  });
});

describe("the Snoozed shelf gate and route", () => {
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
  const queuedKeys = new Set(["q", "qz", "d"]);
  const expanded = list({ snoozed: { total: 2, visible: ["z1", "z2"] } });
  const ok = { supportsSnooze: true, canSnooze: true, canOperate: true };
  const candidate = (
    items: readonly SidebarListItem[],
    drag: SidebarDragOrigin,
    id: string,
    snoozeAllowed: boolean,
  ) =>
    isSidebarDragCandidate({
      id,
      drag,
      items: sidebarDragListItems(items, drag),
      queuedKeys,
      queueDropId: "queue",
      snoozeAllowed,
      planKind: () => "none",
    });
  const route = (
    items: readonly SidebarListItem[],
    drag: SidebarDragOrigin,
    overId: string,
    snoozeAllowed = true,
  ) =>
    routeSidebarDragEnd({
      drag,
      overId,
      items: sidebarDragListItems(items, drag),
      queuedKeys,
      queueDropId: "queue",
      snoozeAllowed,
    });

  it("offers the shelf only to a row that may be snoozed", () => {
    expect(sidebarSnoozeDropAllowed({ drag: main("a1", "active"), ...ok })).toBe(true);
    expect(
      sidebarSnoozeDropAllowed({
        drag: main("a1", "active"),
        supportsSnooze: false,
        canSnooze: true,
        canOperate: true,
      }),
    ).toBe(false);
    expect(
      sidebarSnoozeDropAllowed({
        drag: main("a1", "active"),
        supportsSnooze: true,
        canSnooze: false,
        canOperate: true,
      }),
    ).toBe(false);
    expect(sidebarSnoozeDropAllowed({ drag: main("z1", "snoozed"), ...ok })).toBe(false);
    // A Queue row whose thread is already snoozed is only unqueued there.
    expect(
      sidebarSnoozeDropAllowed({
        drag: queued("qz", "snoozed"),
        supportsSnooze: false,
        canSnooze: false,
        canOperate: true,
      }),
    ).toBe(true);
    expect(
      sidebarSnoozeDropAllowed({ drag: { ...queued("d", "active"), queuedDraft: true }, ...ok }),
    ).toBe(false);
    expect(sidebarSnoozeDropAllowed({ drag: main("w1", "working"), ...ok })).toBe(false);
  });

  it("a thread this connection cannot operate lights no zone, from the main list or the Queue", () => {
    const off = { ...ok, canOperate: false };
    for (const drag of [main("a1", "active"), queued("q", "active"), queued("qz", "snoozed")]) {
      expect([drag.activeKey, sidebarSnoozeDropAllowed({ drag, ...ok })]).toEqual([
        drag.activeKey,
        true,
      ]);
      expect([drag.activeKey, sidebarSnoozeDropAllowed({ drag, ...off })]).toEqual([
        drag.activeKey,
        false,
      ]);
    }
    // The release reads the same gate.
    expect(
      sidebarReleaseSnoozeState({
        drag: queued("q", "active"),
        listedSection: undefined,
        restingSection: "active",
        ...off,
      }).snoozeAllowed,
    ).toBe(false);
  });

  it("the gate admits each zone only when allowed, and only while it is listed", () => {
    for (const id of [HEADER, "z1"]) {
      expect(candidate(expanded, main("a1", "active"), id, true)).toBe(true);
      expect(candidate(expanded, main("a1", "active"), id, false)).toBe(false);
    }
    expect(candidate(list(), main("a1", "active"), PLACEHOLDER, true)).toBe(true);
    // A shelf with threads has no placeholder, so its id is offered nowhere.
    expect(candidate(expanded, main("a1", "active"), PLACEHOLDER, true)).toBe(false);
  });

  it("routes every zone to snooze, from the main list and from the Queue", () => {
    expect(route(expanded, main("a1", "active"), HEADER)).toEqual({ kind: "snooze" });
    expect(route(expanded, main("a1", "active"), "z2")).toEqual({ kind: "snooze" });
    expect(route(list(), main("p1", "pinned"), PLACEHOLDER)).toEqual({ kind: "snooze" });
    expect(route(expanded, queued("q", "active"), HEADER)).toEqual({ kind: "snooze" });
    // The handler only unqueues this one.
    expect(route(expanded, queued("qz", "snoozed"), "z1")).toEqual({ kind: "snooze" });
  });

  it("a release the gate refuses snoozes nothing, on every zone", () => {
    // A snoozed row over another shelf row, a Working row over the header, an unsnoozable row.
    expect(route(expanded, main("z1", "snoozed"), "z2", false)).toEqual({ kind: "none" });
    expect(route(expanded, main("a1", "active"), HEADER, false)).toEqual({ kind: "none" });
    expect(route(list(), main("p1", "pinned"), PLACEHOLDER, false)).toEqual({ kind: "none" });
    expect(route(expanded, queued("q", "active"), "z1", false)).toEqual({ kind: "none" });
  });

  it("the release gate reads where the thread rests now, not at pickup", () => {
    const release = (
      drag: SidebarDragOrigin,
      listedSection: SidebarSection | undefined,
      restingSection: Parameters<typeof sidebarReleaseSnoozeState>[0]["restingSection"],
      can = ok,
    ) => sidebarReleaseSnoozeState({ drag, listedSection, restingSection, ...can });
    // A main-list row: the section its row is listed in now.
    expect(release(main("a1", "active"), "active", "active")).toEqual({
      liveSection: "active",
      snoozeAllowed: true,
    });
    // A peer snoozed it mid-drag: never snoozed again.
    expect(release(main("a1", "active"), "snoozed", "snoozed")).toEqual({
      liveSection: "snoozed",
      snoozeAllowed: false,
    });
    // It started working mid-drag.
    expect(release(main("a1", "active"), "working", "active")).toEqual({
      liveSection: "working",
      snoozeAllowed: false,
    });
    // Gone from the list (a peer queued it): the pickup section stands; the route refuses it.
    expect(release(main("a1", "active"), undefined, "active").liveSection).toBe("active");
    // A Queue row has no list row: its resting section, recomputed. A peer snoozed it while it
    // was lifted, so the shelf only unqueues it.
    expect(release(queued("q", "active"), undefined, "snoozed")).toEqual({
      liveSection: "snoozed",
      snoozeAllowed: true,
    });
    expect(release(queued("qz", "snoozed"), undefined, "active")).toEqual({
      liveSection: "active",
      snoozeAllowed: true,
    });
    expect(
      release(queued("qz", "snoozed"), undefined, "active", {
        supportsSnooze: true,
        canSnooze: false,
        canOperate: true,
      }).snoozeAllowed,
    ).toBe(false);
    // No thread here to snooze.
    expect(release(queued("q", "active"), undefined, undefined).snoozeAllowed).toBe(false);
  });

  it("a snoozed row over its own slot is not a snooze", () => {
    expect(route(expanded, main("z1", "snoozed"), "z1")).toEqual({ kind: "none" });
  });

  it("a row a peer queued mid-drag has left the list, so nothing is snoozed", () => {
    expect(route(list({ active: ["a2"] }), main("a1", "active"), PLACEHOLDER)).toEqual({
      kind: "none",
    });
  });

  it("a read-only Queue and a queued draft route nothing to the shelf", () => {
    const drag = queued("q", "active");
    expect(
      routeSidebarDragEnd({
        drag,
        overId: HEADER,
        items: sidebarDragListItems(expanded, drag),
        queuedKeys,
        queueDropId: "queue",
        queueWritable: false,
        snoozeAllowed: true,
      }),
    ).toEqual({ kind: "none" });
    expect(route(expanded, { ...queued("d", "active"), queuedDraft: true }, HEADER)).toEqual({
      kind: "none",
    });
  });
});

describe("a drop on the Snoozed shelf", () => {
  const PICKUP = "2026-10-08T12:00:00.000Z";
  const RELEASE = "2026-10-08T12:10:00.000Z";
  const RELEASE_PLUS_HOUR = "2026-10-08T13:10:00.000Z";
  afterEach(() => vi.useRealTimers());

  /** The handler as Sidebar.tsx calls it; every effect is recorded in order. */
  function snoozeDrop(input: {
    fromQueue: boolean;
    liveSection?: SidebarSection;
    outcome?: SidebarSnoozeOutcome;
    operable?: boolean;
  }) {
    const calls: string[] = [];
    const drag = { fromQueue: input.fromQueue };
    const run = () =>
      runSidebarSnoozeDrop({
        drag,
        liveSection: input.liveSection ?? "active",
        // `checkThreadOperations`: false after it said "Thread action unavailable".
        checkOperate: () => input.operable ?? true,
        snooze: async (snoozedUntil, undoAlso) => {
          calls.push(`snooze ${snoozedUntil}${undoAlso === undefined ? "" : " +requeue on undo"}`);
          return input.outcome ?? { status: "success" };
        },
        unqueue: () => calls.push("unqueue"),
        requeue: () => calls.push("requeue"),
        reportFailure: (error) => calls.push(`failed: ${String(error)}`),
        reportRequeueFailure: (error) => calls.push(`requeue failed: ${String(error)}`),
      });
    return { calls, run };
  }

  it("wakes an hour after the release, not the pickup", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(PICKUP));
    const drop = snoozeDrop({ fromQueue: false });
    vi.setSystemTime(Date.parse(RELEASE));
    await drop.run();
    expect(drop.calls).toEqual([`snooze ${RELEASE_PLUS_HOUR}`]);
  });

  it("a Queue row leaves the Queue only after the snooze succeeded, and Undo re-queues it", async () => {
    const drop = snoozeDrop({ fromQueue: true });
    await drop.run();
    expect(drop.calls).toHaveLength(2);
    expect(drop.calls[0]).toMatch(/^snooze .* \+requeue on undo$/);
    expect(drop.calls[1]).toBe("unqueue");
  });

  it.each([
    [{ status: "failure", error: "offline" }, ["failed: offline"]],
    [{ status: "skipped" }, []],
    [{ status: "interrupted" }, []],
  ] as const)("a %j snooze leaves the Queue entry where it was", async (outcome, after) => {
    const drop = snoozeDrop({ fromQueue: true, outcome });
    await drop.run();
    expect(drop.calls.slice(1)).toEqual(after);
  });

  it("an already-snoozed thread is never snoozed again: a Queue row is only unqueued", async () => {
    const queuedDrop = snoozeDrop({ fromQueue: true, liveSection: "snoozed" });
    await queuedDrop.run();
    expect(queuedDrop.calls).toEqual(["unqueue"]);
    const mainDrop = snoozeDrop({ fromQueue: false, liveSection: "snoozed" });
    await mainDrop.run();
    expect(mainDrop.calls).toEqual([]);
  });

  it("a thread this connection cannot operate is neither snoozed nor unqueued", async () => {
    for (const fromQueue of [true, false]) {
      const drop = snoozeDrop({ fromQueue, operable: false });
      await drop.run();
      expect([fromQueue, drop.calls]).toEqual([fromQueue, []]);
    }
  });

  it("a main-list row snoozes with no Queue follow-up", async () => {
    const drop = snoozeDrop({ fromQueue: false });
    await drop.run();
    expect(drop.calls).toHaveLength(1);
    expect(drop.calls[0]).not.toContain("requeue");
  });

  it("an Undo whose re-queue throws still settles, and reports it as a re-queue failure", async () => {
    let undoAlso: (() => void) | undefined;
    const failures: unknown[] = [];
    const snoozeFailures: unknown[] = [];
    await runSidebarSnoozeDrop({
      drag: { fromQueue: true },
      liveSection: "active",
      checkOperate: () => true,
      snooze: async (_snoozedUntil, also) => {
        undoAlso = also;
        return { status: "success" };
      },
      unqueue: () => {},
      requeue: () => {
        throw new Error("queue store gone");
      },
      // The wake succeeded, so this is not "Failed to snooze thread".
      reportFailure: (error) => snoozeFailures.push(error),
      reportRequeueFailure: (error) => failures.push(error),
    });
    expect(() => undoAlso?.()).not.toThrow();
    expect(failures).toEqual([new Error("queue store gone")]);
    expect(snoozeFailures).toEqual([]);
  });
});

describe("Snooze -> Queue", () => {
  it("wakes only after the Queue took it", async () => {
    const calls: string[] = [];
    await runSidebarWakeAndQueue({
      checkOperate: () => true,
      enqueue: () => {
        calls.push("enqueue");
        return true;
      },
      wake: async () => {
        calls.push("wake");
      },
    });
    expect(calls).toEqual(["enqueue", "wake"]);
  });

  it("a full Queue changes nothing", async () => {
    const wake = vi.fn(async () => {});
    await runSidebarWakeAndQueue({ enqueue: () => false, checkOperate: () => true, wake });
    expect(wake).not.toHaveBeenCalled();
  });

  it("a thread this connection cannot operate is neither queued nor woken", async () => {
    const calls: string[] = [];
    await runSidebarWakeAndQueue({
      // `checkThreadOperations`: false after it said "Thread action unavailable".
      checkOperate: () => false,
      enqueue: () => {
        calls.push("enqueue");
        return true;
      },
      wake: async () => {
        calls.push("wake");
      },
    });
    expect(calls).toEqual([]);
  });
});

describe("drag-over state", () => {
  const items = list({ snoozed: { total: 1, visible: [] } });
  const start: SidebarDragOverState = {
    targetSection: "active",
    overZone: null,
    stickyOverId: "a1",
  };
  const over = (current: SidebarDragOverState, overId: string | null) =>
    nextSidebarDragOver({
      current,
      overId,
      activeKey: "a1",
      items,
      queuedKeys: new Set(["q"]),
      queueDropId: "queue",
    });

  it("a snooze zone keeps the last other over; leaving it clears the zone", () => {
    const onA2 = over(start, "a2");
    expect(onA2).toEqual({ targetSection: "active", overZone: null, stickyOverId: "a2" });
    const onShelf = over(onA2, HEADER);
    expect(onShelf).toEqual({ targetSection: null, overZone: "snooze", stickyOverId: "a2" });
    const back = over(onShelf, "p1");
    expect(back).toEqual({ targetSection: "pinned", overZone: null, stickyOverId: "p1" });
    // The release follows that last over: it pins, it does not snooze.
    expect(
      routeSidebarDragEnd({
        drag: { activeKey: "a1", activeSection: "active", fromQueue: false, queuedDraft: false },
        overId: "p1",
        items,
        queuedKeys: new Set(),
        queueDropId: "queue",
        snoozeAllowed: true,
      }),
    ).toMatchObject({ kind: "place", target: { section: "pinned" } });
  });

  it("names the Queue header as a zone, and nothing as no target", () => {
    expect(over(start, "queue")).toEqual({
      targetSection: null,
      overZone: "queue",
      stickyOverId: "a1",
    });
    expect(over(start, null)).toEqual({ targetSection: null, overZone: null, stickyOverId: "a1" });
  });

  it("keeps only list rows and markers as the sticky over: never the Queue, a Queue row or nothing", () => {
    // Over the Queue header dnd-kit leaves the rows at rest; a sticky Queue id would make the next
    // zone project as over the lifted row, so the zone jumps away from the pointer.
    const onA2 = over(start, "a2");
    for (const zone of ["queue", "q", null, HEADER]) {
      expect([zone, over(onA2, zone).stickyOverId]).toEqual([zone, "a2"]);
    }
    expect(over(over(onA2, "queue"), "p1").stickyOverId).toBe("p1");
  });
});

describe("drop badges", () => {
  it("names every drop the badge can show", () => {
    expect(resolveSidebarDropVerb("active", null, false, "snooze")).toBe("snooze");
    expect(resolveSidebarDropVerb(FOCUS, null, false, "snooze")).toBe("snooze");
    expect(resolveSidebarDropVerb("active", null, true, "snooze")).toBe("snooze");
    expect(resolveSidebarDropVerb("snoozed", null, true, "snooze")).toBe("unqueue");
    expect(resolveSidebarDropVerb("snoozed", null, false, "snooze")).toBeNull();
    expect(resolveSidebarDropVerb("snoozed", null, false, "queue")).toBe("wake-queue");
    // A snoozed Queue row over its own Queue header: the drop does nothing, so no badge.
    expect(resolveSidebarDropVerb("snoozed", null, true, "queue")).toBeNull();
    expect(resolveSidebarDropVerb("active", null, false, "queue")).toBeNull();
    for (const from of ["active", "pinned", "settled", "snoozed", LATER] as const) {
      expect(resolveSidebarDropVerb(from, FOCUS)).toBe("move");
    }
    expect(resolveSidebarDropVerb("active", FOCUS, true)).toBe("move");
    expect(resolveSidebarDropVerb(FOCUS, FOCUS)).toBeNull();
    expect(resolveSidebarDropVerb(FOCUS, FOCUS, true)).toBe("unqueue");
    expect(resolveSidebarDropVerb(FOCUS, "active")).toBe("move"); // Move to Active
    // A Queue row resting in a custom section only leaves the Queue.
    expect(resolveSidebarDropVerb(FOCUS, "active", true)).toBe("unqueue");
    // A Queue row resting in Snoozed wakes into Active: Wake, not Unqueue.
    expect(resolveSidebarDropVerb("snoozed", "active", true)).toBe("wake");
  });
});

describe("where the Queue sits during a drag", () => {
  it("counts the entries the Queue block shows, frozen at pickup", () => {
    const queued = makeThreadFixture({ id: ThreadId.make("q") });
    const q = scopedThreadKey(scopeThreadRef(queued.environmentId, queued.id));
    const entries = [{ environmentId: queued.environmentId, threadId: queued.id }];
    // A Queue row dropped into a section, its unqueue still in flight: the store holds 1 entry, the
    // Queue block shows none (the row renders in the section).
    const pending: SidebarOptimisticDrop = {
      key: q,
      sourceSection: "active",
      section: LATER,
      occurredAt: NOW,
      clearsSnooze: false,
      clearsSection: null,
      order: [q],
      keysAtDrop: new Map([[q, null]]),
      assignedKeys: new Map([[q, "k"]]),
    };
    const shown = sidebarShownQueueEntries(entries, pending);
    expect(shown).toHaveLength(0);
    const placed = (entryCount: number) =>
      sidebarQueuePlacement({
        sectionCount: 1,
        entryCount,
        dropShown: true,
        listScrolls: true,
        liftedFromShelf: true,
      });
    // Lifting a Settled row at pickup: the empty block goes after every row, as a real empty Queue.
    const atPickup = sidebarDragQueueEntryCount(undefined, shown);
    expect(placed(atPickup)).toEqual(placed(0));
    expect(placed(atPickup).belowShelves).toBe(true);
    // The store's count would put the header above the custom sections and move them 33px.
    expect(placed(entries.length).belowShelves).toBe(false);
    // Frozen for the drag: a Queue that empties mid-drag keeps its header where it was, and one
    // that fills does not move it either.
    expect(sidebarDragQueueEntryCount(1, [])).toBe(1);
    expect(sidebarDragQueueEntryCount(0, entries)).toBe(0);
  });

  it("below the shelves the Queue shows its header only, though an entry arrives mid-drag", () => {
    const queued = makeThreadFixture({ id: ThreadId.make("q") });
    const entries = [{ environmentId: queued.environmentId, threadId: queued.id }];
    const placed = (listScrolls: boolean) =>
      sidebarQueuePlacement({
        sectionCount: 1,
        // Frozen at pickup: the Queue was empty then.
        entryCount: sidebarDragQueueEntryCount(0, entries),
        dropShown: true,
        listScrolls,
        liftedFromShelf: true,
      });
    expect(placed(true).belowShelves).toBe(true);
    expect(sidebarQueueBlockEntries(placed(true), entries)).toEqual([]);
    // Anywhere else the block shows the live entries.
    expect(placed(false).belowShelves).toBe(false);
    expect(sidebarQueueBlockEntries(placed(false), entries)).toBe(entries);
  });

  it("an empty Queue docks with the shelves, and goes after every row only for a shelf row in a scrolling list with sections", () => {
    const at = (
      sectionCount: number,
      entryCount: number,
      dropShown: boolean,
      listScrolls: boolean,
      liftedFromShelf = false,
    ) =>
      sidebarQueuePlacement({ sectionCount, entryCount, dropShown, listScrolls, liftedFromShelf });
    const placed = (docksWithShelves: boolean, belowShelves: boolean, collapse: boolean) => ({
      docksWithShelves,
      belowShelves,
      collapse,
    });
    expect(at(2, 0, true, false)).toEqual(placed(true, false, true));
    expect(at(2, 3, true, false)).toEqual(placed(false, false, false));
    expect(at(0, 3, true, false)).toEqual(placed(true, false, true));
    expect(at(0, 0, false, false)).toEqual(placed(true, false, false));
    // A scrolling list has no free space. Docked above the shelves, the header that appears at
    // pickup pushes down the rows above a pointer that lifted a shelf row.
    expect(at(2, 0, true, true, true)).toEqual(placed(true, true, false));
    // Any other source: the header lands below the pointer and stays docked.
    expect(at(2, 0, true, true, false)).toEqual(placed(true, false, false));
    // No sections: unchanged.
    expect(at(0, 0, true, true, true)).toEqual(placed(true, false, false));
    expect(at(0, 3, true, true, true)).toEqual(placed(true, false, false));
  });
});
