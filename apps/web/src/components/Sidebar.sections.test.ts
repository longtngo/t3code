import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { ProviderInstanceId } from "@t3tools/contracts";

import { makeThreadFixture } from "../test-fixtures";
import {
  applySidebarThreadDrop,
  buildSidebarListItems,
  customSectionHeaderId,
  customSidebarSection,
  isSidebarThreadWorking,
  planSidebarThreadDrop,
  resolveSidebarDropTarget,
  resolveSidebarDropVerb,
  shouldReleaseOptimisticDrop,
  sidebarListItemId,
  sidebarDropPlanInput,
  sidebarRestingSection,
  withQueuedRow,
  type SidebarListItem,
  type SidebarListMarker,
  type SidebarOptimisticDrop,
  type SidebarSection,
} from "./Sidebar.logic";

const NOW = "2026-10-07T12:00:00.000Z";
const caps = { threadSettlement: true, threadSnooze: true };
const defined = new Set(["focus"]);

describe("sidebarRestingSection with custom sections", () => {
  it("a defined membership rests in its section; an unknown one rests in Active", () => {
    expect(
      sidebarRestingSection(makeThreadFixture({ sidebarSectionId: "focus" }), caps, NOW, defined),
    ).toBe(customSidebarSection("focus"));
    expect(
      sidebarRestingSection(makeThreadFixture({ sidebarSectionId: "gone" }), caps, NOW, defined),
    ).toBe("active");
    expect(
      sidebarRestingSection(makeThreadFixture({ sidebarSectionId: "focus" }), caps, NOW, new Set()),
    ).toBe("active");
  });

  it("snooze, settle and pin outrank membership, and clearing them returns to the section", () => {
    const member = { sidebarSectionId: "focus" } as const;
    expect(
      sidebarRestingSection(
        makeThreadFixture({ ...member, snoozedUntil: "2099-01-01T00:00:00.000Z", snoozedAt: NOW }),
        caps,
        NOW,
        defined,
      ),
    ).toBe("snoozed");
    expect(
      sidebarRestingSection(
        makeThreadFixture({ ...member, settledOverride: "settled" }),
        caps,
        NOW,
        defined,
      ),
    ).toBe("settled");
    expect(
      sidebarRestingSection(makeThreadFixture({ ...member, pinnedAt: NOW }), caps, NOW, defined),
    ).toBe("pinned");
    expect(
      sidebarRestingSection(makeThreadFixture({ ...member, pinnedAt: null }), caps, NOW, defined),
    ).toBe(customSidebarSection("focus"));
  });

  it("keeps a working member in its section (the Working fold only applies to Active)", () => {
    const running = makeThreadFixture({
      sidebarSectionId: "focus",
      runtime: {
        status: "running",
        activeRunId: null,
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerName: "Codex",
        lastError: null,
        updatedAt: NOW,
      } as EnvironmentThreadShell["runtime"],
    });
    expect(isSidebarThreadWorking(running)).toBe(true);
    expect(sidebarRestingSection(running, caps, NOW, defined)).toBe(customSidebarSection("focus"));
  });
});

describe("buildSidebarListItems (today's layout)", () => {
  const none = { total: 0, visible: [] };
  // A row carries its section, so a row tagged into the wrong block fails too.
  const ids = (input: Parameters<typeof buildSidebarListItems>[0]) =>
    buildSidebarListItems(input).map((item) =>
      item.kind === "thread" ? `${item.key}@${item.section}` : sidebarListItemId(item),
    );

  it("is empty with no threads", () => {
    expect(
      buildSidebarListItems({
        pinned: [],
        active: [],
        working: none,
        snoozed: none,
        settled: none,
        custom: [],
      }),
    ).toEqual([]);
  });

  it("lays out every block in order, shelves only when non-empty", () => {
    expect(
      ids({
        pinned: ["p:1"],
        active: ["a:1", "a:2"],
        working: { total: 2, visible: ["w:1"] },
        snoozed: { total: 1, visible: [] },
        settled: { total: 3, visible: ["s:1"] },
        custom: [],
      }),
    ).toEqual([
      "sidebar-marker-pinned-header",
      "p:1@pinned",
      "sidebar-marker-pinned-divider",
      "sidebar-marker-active-placeholder",
      "a:1@active",
      "a:2@active",
      "sidebar-marker-working-header",
      "w:1@working",
      "sidebar-marker-snoozed-header",
      "sidebar-marker-settled-header",
      "sidebar-marker-settled-placeholder",
      "s:1@settled",
    ]);
    expect(
      ids({ pinned: [], active: ["a:1"], working: none, snoozed: none, settled: none, custom: [] }),
    ).toEqual([
      "sidebar-marker-pinned-header",
      "sidebar-marker-pinned-divider",
      "sidebar-marker-active-placeholder",
      "a:1@active",
      "sidebar-marker-settled-header",
      "sidebar-marker-settled-placeholder",
    ]);
  });
});

describe("custom sections in the sortable list", () => {
  const thread = (key: string, section: SidebarSection): SidebarListItem => ({
    kind: "thread",
    key,
    section,
  });
  const marker = (name: SidebarListMarker): SidebarListItem => ({ kind: "marker", marker: name });
  const header = (sectionId: string): SidebarListItem => ({
    kind: "marker",
    marker: "custom-header",
    sectionId,
  });
  const focus = customSidebarSection("focus");
  // Pinned p | Active a1 a2 | Focus c1 c2 | Settled s1
  const items: readonly SidebarListItem[] = [
    marker("pinned-header"),
    thread("p:1", "pinned"),
    marker("pinned-divider"),
    marker("active-placeholder"),
    thread("a:1", "active"),
    thread("a:2", "active"),
    header("focus"),
    thread("c:1", focus),
    thread("c:2", focus),
    marker("settled-header"),
    marker("settled-placeholder"),
    thread("s:1", "settled"),
  ];
  const headerId = customSectionHeaderId("focus");

  it("builds a header and rows per section after Active, empty sections included", () => {
    const built = buildSidebarListItems({
      pinned: [],
      active: [],
      working: { total: 0, visible: [] },
      snoozed: { total: 0, visible: [] },
      settled: { total: 0, visible: [] },
      custom: [
        { id: "focus", visible: ["c:1"] },
        { id: "empty", visible: [] },
      ],
    });
    expect(built.map(sidebarListItemId)).toEqual([
      "sidebar-marker-pinned-header",
      "sidebar-marker-pinned-divider",
      "sidebar-marker-active-placeholder",
      "sidebar-marker-custom-header-focus",
      "c:1",
      "sidebar-marker-custom-header-empty",
      "sidebar-marker-settled-header",
      "sidebar-marker-settled-placeholder",
    ]);
  });

  it("never resolves a drop into a custom section", () => {
    expect(resolveSidebarDropTarget(items, "a:1", "c:1")).toBeNull();
    expect(resolveSidebarDropTarget(items, "a:2", headerId)).toBeNull(); // from above: lands inside
    expect(resolveSidebarDropTarget(items, "s:1", "c:2")).toBeNull();
  });

  it("a drag out of a custom section still resolves into Active, Pinned and Settled", () => {
    expect(resolveSidebarDropTarget(items, "c:1", "a:1")).toEqual({
      section: "active",
      pinnedOrder: ["p:1"],
      activeOrder: ["c:1", "a:1", "a:2"],
    });
    expect(resolveSidebarDropTarget(items, "c:2", "p:1")?.section).toBe("pinned");
    expect(resolveSidebarDropTarget(items, "c:1", "s:1")?.section).toBe("settled");
  });

  it("dropping on the first custom header from below lands at the bottom of Active", () => {
    expect(resolveSidebarDropTarget(items, "s:1", headerId)).toEqual({
      section: "active",
      pinnedOrder: ["p:1"],
      activeOrder: ["a:1", "a:2", "s:1"],
    });
  });

  it("Active's order never includes custom rows", () => {
    // Moving down onto a:2 lands after it, and the order stops at the custom header.
    expect(resolveSidebarDropTarget(items, "p:1", "a:2")?.activeOrder).toEqual([
      "a:1",
      "a:2",
      "p:1",
    ]);
  });

  it("a Queue row joins above the first custom header", () => {
    const queued = withQueuedRow(items, "q:1", focus);
    // Index 6 is the first custom header's slot in `items`.
    expect(queued.map(sidebarListItemId).indexOf("q:1")).toBe(6);
    expect(sidebarListItemId(queued[7]!)).toBe(headerId);
    expect(resolveSidebarDropTarget(queued, "q:1", "a:2")?.section).toBe("active");
  });

  it("custom ranks as Active for the drop badge", () => {
    expect(resolveSidebarDropVerb(focus, "active")).toBeNull();
    expect(resolveSidebarDropVerb(focus, "active", true)).toBe("unqueue");
    expect(resolveSidebarDropVerb(focus, "pinned")).toBe("pin");
    expect(resolveSidebarDropVerb(focus, "settled")).toBe("settle");
  });
});

describe("a drop into Active clears membership", () => {
  const target = { section: "active" as const, pinnedOrder: [], activeOrder: ["a:1", "q:1"] };
  const base = {
    target,
    pinnedOrder: [],
    pinnedKeysById: new Map(),
    activeOrder: ["a:1"],
    activeKeysById: new Map([["a:1", "m"]]),
    customSectionIds: defined,
  };

  it("clears a membership this client defines", () => {
    const plan = planSidebarThreadDrop({
      ...base,
      activeKey: "q:1",
      activeSection: customSidebarSection("focus"),
      activeSidebarSectionId: "focus",
    });
    expect(plan).toMatchObject({ kind: "move-active", clearsSection: "focus", unpin: false });
    const timeOrdered = planSidebarThreadDrop({
      ...base,
      activeKey: "q:1",
      activeSection: customSidebarSection("focus"),
      activeSidebarSectionId: "focus",
      activeTimeOrdered: true,
    });
    expect(timeOrdered).toMatchObject({ kind: "move-active", order: null, clearsSection: "focus" });
    const plain = planSidebarThreadDrop({ ...base, activeKey: "q:1", activeSection: "settled" });
    expect(plain.kind === "move-active" && "clearsSection" in plain).toBe(false);
  });

  it("a pinned member dropped on Active lands in Active, not back in its section", () => {
    const plan = planSidebarThreadDrop({
      ...base,
      activeKey: "q:1",
      activeSection: "pinned",
      activeSidebarSectionId: "focus",
    });
    expect(plan).toMatchObject({ kind: "move-active", clearsSection: "focus", unpin: true });
  });

  it("a section-less client never clears", () => {
    const plan = planSidebarThreadDrop({
      ...base,
      activeKey: "q:1",
      activeSection: "pinned",
      activeSidebarSectionId: "focus",
      customSectionIds: new Set(),
    });
    expect(plan.kind).toBe("move-active");
    expect("clearsSection" in plan).toBe(false);
  });

  it("a reorder within Active keeps a membership naming a deleted section", () => {
    const orphan = makeThreadFixture({ sidebarSectionId: "gone" });
    const plan = planSidebarThreadDrop({
      ...base,
      activeKey: "q:1",
      activeSection: sidebarRestingSection(orphan, caps, NOW, defined),
      activeSidebarSectionId: orphan.sidebarSectionId,
      activeOrder: ["q:1", "a:1"],
      activeKeysById: new Map([
        ["q:1", "a"],
        ["a:1", "m"],
      ]),
    });
    expect(plan.kind).toBe("move-active");
    expect("clearsSection" in plan).toBe(false);
  });

  it("a Queue row dropped on Active only unqueues: no key write, no hold", () => {
    // The unqueue happens before the plan; any plan here would write the section's own order key
    // from an Active slot and hold the row in Active.
    for (const activeTimeOrdered of [false, true]) {
      const plan = planSidebarThreadDrop({
        ...base,
        activeKey: "q:1",
        activeSection: customSidebarSection("focus"),
        activeSidebarSectionId: "focus",
        fromQueue: true,
        activeTimeOrdered,
      });
      expect(plan).toEqual({ kind: "none" });
    }
    // A Queue row resting in Active still takes its Active slot.
    const plain = planSidebarThreadDrop({
      ...base,
      activeKey: "q:1",
      activeSection: "active",
      fromQueue: true,
    });
    expect(plain.kind).toBe("move-active");
  });

  it("a pinned, settled or snoozed queued member dropped on Active only unparks", () => {
    const cases = [
      { activeSection: "pinned", activePinned: true, expected: { unpin: true } },
      { activeSection: "settled", activeSettled: true, expected: { unsettle: true } },
      { activeSection: "snoozed", expected: { unsnooze: true } },
    ] as const;
    for (const { expected, ...lifecycle } of cases) {
      for (const activeTimeOrdered of [false, true]) {
        const plan = planSidebarThreadDrop({
          ...base,
          ...lifecycle,
          activeKey: "q:1",
          activeSidebarSectionId: "focus",
          fromQueue: true,
          activeTimeOrdered,
        });
        // No Active key and no hold: it returns to its section at its old position.
        expect(plan).toEqual({
          kind: "unpark",
          unpin: false,
          unsettle: false,
          unsnooze: false,
          ...expected,
        });
      }
    }
    // A queued thread of no defined section still takes its Active slot.
    const plain = planSidebarThreadDrop({
      ...base,
      activeKey: "q:1",
      activeSection: "pinned",
      activeSidebarSectionId: "gone",
      fromQueue: true,
    });
    expect(plain).toMatchObject({ kind: "move-active", unpin: true });
  });

  it("W1: the drop-target check plans the same unpark as the drop (working shelf off)", () => {
    // Live shape: queued rows are not in the Active order nor its writable set.
    const board = {
      pinnedOrder: [],
      pinnedKeysById: new Map(),
      reorderableKeys: new Set<string>(),
      activeOrder: ["a:1"],
      activeKeysById: new Map([["a:1", "m"]]),
      activeReorderableKeys: new Set(["a:1"]),
      activeTimeOrdered: false,
      customSectionIds: defined,
    };
    const queued = { activeKey: "q:1", fromQueue: true } as const;
    const cases = [
      ["pinned", { pinnedAt: NOW }],
      ["settled", { settledOverride: "settled" }],
      ["snoozed", {}],
    ] as const;
    for (const [activeSection, lifecycle] of cases) {
      const source = {
        ...makeThreadFixture({ sidebarSectionId: "focus", ...lifecycle }),
        supportsSettlement: true,
      };
      const plan = planSidebarThreadDrop(
        sidebarDropPlanInput(board, { ...queued, activeSection }, source, target),
      );
      expect(plan.kind).toBe("unpark");
    }
  });

  it("projects the cleared field optimistically, and only for Active", () => {
    const thread = makeThreadFixture({ sidebarSectionId: "focus" });
    expect(applySidebarThreadDrop(thread, "active", NOW).sidebarSectionId).toBeNull();
    expect(applySidebarThreadDrop(thread, "pinned", NOW).sidebarSectionId).toBe("focus");
    expect(applySidebarThreadDrop(thread, "settled", NOW).sidebarSectionId).toBe("focus");
  });
});

describe("the pending-drop hold", () => {
  const defined = new Set(["focus", "other"]);
  const drop = (overrides: Partial<SidebarOptimisticDrop> = {}): SidebarOptimisticDrop => ({
    key: "q:1",
    sourceSection: customSidebarSection("focus"),
    section: "active",
    occurredAt: NOW,
    clearsSnooze: false,
    clearsSection: "focus",
    order: ["a:1", "q:1"],
    keysAtDrop: new Map([["a:1", "m"]]),
    assignedKeys: new Map(),
    ...overrides,
  });
  const release = (
    thread: Parameters<typeof shouldReleaseOptimisticDrop>[0]["thread"],
    held = drop(),
  ) =>
    shouldReleaseOptimisticDrop({
      drop: held,
      thread,
      now: NOW,
      customSectionIds: defined,
      destinationKeys: ["a:1", "q:1"],
      keyByThread: new Map([
        ["a:1", "m"],
        ["q:1", null],
      ]),
    });

  it("holds while the clear is in flight, so the row never shows back in its section", () => {
    expect(release(makeThreadFixture({ sidebarSectionId: "focus" }))).toBe(false);
  });

  it("releases once the clear has landed and the drop is complete", () => {
    expect(release(makeThreadFixture({ sidebarSectionId: null }))).toBe(true);
  });

  it("a key write waits for the clear, then for itself", () => {
    const keyed = drop({ assignedKeys: new Map([["q:1", "z"]]) });
    const landed = (orderKey: string | null, sidebarSectionId: string | null) =>
      shouldReleaseOptimisticDrop({
        drop: keyed,
        thread: makeThreadFixture({ sidebarSectionId }),
        now: NOW,
        customSectionIds: defined,
        destinationKeys: ["a:1", "q:1"],
        keyByThread: new Map([
          ["a:1", "m"],
          ["q:1", orderKey],
        ]),
      });
    // The clear has landed but the key has not: hold.
    expect(landed(null, null)).toBe(false);
    expect(landed("z", null)).toBe(true);
    // The key is written only after the clear succeeded, so a landed key with the field set
    // again means a peer re-added the section: release, or the hold (and every drag) strands.
    expect(landed("z", "focus")).toBe(true);
  });

  it("keeps today's release when the thread is gone", () => {
    expect(release(undefined)).toBe(true);
  });

  it("time-ordered inbox: waits for the clear too", () => {
    const timeOrdered = drop({ order: null });
    expect(release(makeThreadFixture({ sidebarSectionId: "focus" }), timeOrdered)).toBe(false);
    expect(release(makeThreadFixture({ sidebarSectionId: null }), timeOrdered)).toBe(true);
  });

  it("a pinned member dropped back into its old Active slot holds until the move lands", () => {
    // `activeOrderKey` survives pin and unpin, and the planner re-derives the same key between the
    // same neighbours, so the planned key "t" is the one the thread already holds.
    const sameSlot = drop({
      sourceSection: "pinned",
      keysAtDrop: new Map([
        ["a:1", "m"],
        ["q:1", "t"],
      ]),
      assignedKeys: new Map([["q:1", "t"]]),
    });
    const check = (thread: ReturnType<typeof makeThreadFixture>) =>
      shouldReleaseOptimisticDrop({
        drop: sameSlot,
        thread,
        now: NOW,
        customSectionIds: defined,
        destinationKeys: ["a:1", "q:1"],
        keyByThread: new Map([
          ["a:1", "m"],
          ["q:1", "t"],
        ]),
      });
    const member = { activeOrderKey: "t", pinnedAt: NOW };
    expect(check(makeThreadFixture({ ...member, sidebarSectionId: "focus" }))).toBe(false);
    // The clear landed; the unpin has not.
    expect(check(makeThreadFixture({ ...member, sidebarSectionId: null }))).toBe(false);
    expect(check(makeThreadFixture({ ...member, sidebarSectionId: null, pinnedAt: null }))).toBe(
      true,
    );
  });

  it("a peer's move to another section releases the hold", () => {
    // A section this client does not define rests in Active, so only the peer rule can see it.
    expect(release(makeThreadFixture({ sidebarSectionId: "unknown" }))).toBe(true);
  });
});
