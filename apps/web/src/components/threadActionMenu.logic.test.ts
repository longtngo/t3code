import { describe, expect, it } from "vite-plus/test";

import {
  buildDraftActionMenuItems,
  buildThreadActionMenuItems,
  resolveSidebarSectionMoveAction,
  type ThreadActionMenuState,
} from "./threadActionMenu.logic";
import { sidebarSectionMoveFailureTitle } from "../sidebarCustomSections.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

function ids(state: ThreadActionMenuState): string[] {
  return buildThreadActionMenuItems(state).map((item) => item.id);
}

function allIds(state: ThreadActionMenuState): string[] {
  const flatten = (items: ReturnType<typeof buildThreadActionMenuItems>): string[] =>
    items.flatMap((item) => [item.id, ...(item.children ? flatten(item.children) : [])]);
  return flatten(buildThreadActionMenuItems(state));
}

describe("buildThreadActionMenuItems", () => {
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            // FORK: the Queue toggle is a thread operation too.
            "queue",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            // FORK: the Queue toggle is a thread operation too.
            "queue",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  // A read-only queue disables both queue menu items.
  it("disables Add to queue / Remove from queue while the queue is read-only", () => {
    const item = (state: Partial<typeof baseState>) =>
      buildThreadActionMenuItems({ ...baseState, ...state }).find(
        (i) => i.id === "queue" || i.id === "unqueue",
      );
    expect(item({ queueWritable: false })?.disabled).toBe(true);
    expect(item({ isQueued: true, queueWritable: false })?.disabled).toBe(true);
    expect(item({})?.disabled).toBeFalsy();
    const draft = { isQueued: false, hasPath: true, hasBranch: true, hasProject: true };
    expect(buildDraftActionMenuItems({ ...draft, queueWritable: false })[0]?.disabled).toBe(true);
    expect(buildDraftActionMenuItems(draft)[0]?.disabled).toBeFalsy();
  });

  it("offers adding to the queue, or removing a queued thread", () => {
    expect(ids(baseState)).toContain("queue");
    expect(ids({ ...baseState, isQueued: true })).toEqual(expect.arrayContaining(["unqueue"]));
    expect(ids({ ...baseState, isQueued: true })).not.toContain("queue");
  });

  it("disables archive and turning into a project while the thread is running", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      canTurnIntoProject: true,
    });
    expect(items.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "turn-into-project")?.disabled).toBe(true);
  });
});

describe("sidebar section items", () => {
  const sections = [
    { id: "a", name: "Alpha", createdAt: "2026-10-07T00:00:00.000Z" },
    { id: "b", name: "Beta", createdAt: "2026-10-07T00:01:00.000Z" },
  ];

  it("offers the other sections and Move to Active from a section", () => {
    const menu = allIds({ ...baseState, sidebarSections: { sections, currentSectionId: "a" } });
    expect(menu).toContain("move-to-section:b");
    expect(menu).not.toContain("move-to-section:a");
    expect(menu).toContain("move-to-active");
  });

  it("offers every section but not Move to Active from Active", () => {
    const menu = allIds({ ...baseState, sidebarSections: { sections, currentSectionId: null } });
    expect(menu).toEqual(expect.arrayContaining(["move-to-section:a", "move-to-section:b"]));
    expect(menu).not.toContain("move-to-active");
  });

  it("offers no Move to Active for a thread naming a deleted or unknown section", () => {
    const menu = allIds({ ...baseState, sidebarSections: { sections, currentSectionId: "gone" } });
    expect(menu).not.toContain("move-to-active");
    expect(menu).toEqual(expect.arrayContaining(["move-to-section:a", "move-to-section:b"]));
  });

  it("shows nothing when the thread's server or the primary lacks sections", () => {
    expect(
      allIds({ ...baseState, sidebarSections: null }).some((id) => id.startsWith("move-to-")),
    ).toBe(false);
    expect(allIds(baseState).some((id) => id.startsWith("move-to-"))).toBe(false);
  });

  it("disables the moves for a read-only connection", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      canOperate: false,
      sidebarSections: { sections, currentSectionId: "a" },
    });
    const move = items.find((item) => item.id === "move-to-section");
    expect(move?.disabled).toBe(true);
    expect(move?.children?.every((child) => child.disabled)).toBe(true);
    expect(items.find((item) => item.id === "move-to-active")?.disabled).toBe(true);
  });

  it("resolves a clicked move id to its section, round-tripping the built ids", () => {
    const menu = allIds({ ...baseState, sidebarSections: { sections, currentSectionId: "a" } });
    const resolved = menu.map((id) => resolveSidebarSectionMoveAction(id, sections));
    expect(resolved.filter((target) => target !== null)).toEqual([
      { sectionId: "b", sectionName: "Beta" },
      { sectionId: null, sectionName: null },
    ]);
    // The submenu parent and every other action are not moves.
    expect(resolveSidebarSectionMoveAction("move-to-section", sections)).toBeNull();
    expect(resolveSidebarSectionMoveAction("rename", sections)).toBeNull();
  });

  it("a move to a section deleted since the menu opened never reports Active", () => {
    const target = resolveSidebarSectionMoveAction("move-to-section:gone", sections);
    expect(target).toEqual({ sectionId: "gone", sectionName: "section" });
    for (const step of ["section", "unpin", "unsettle", "unsnooze"] as const) {
      expect(sidebarSectionMoveFailureTitle(step, target!.sectionName)).not.toContain("Active");
    }
  });
});

describe("buildDraftActionMenuItems", () => {
  const base = { isQueued: false, hasPath: true, hasBranch: true, hasProject: true };

  it("offers queueing, or removal for a queued draft, first", () => {
    expect(buildDraftActionMenuItems(base)[0]?.id).toBe("queue");
    expect(buildDraftActionMenuItems({ ...base, isQueued: true })[0]?.id).toBe("unqueue");
    expect(buildDraftActionMenuItems(base).map((item) => item.id)).toEqual([
      "queue",
      "copy",
      "project-settings",
      "discard",
    ]);
  });

  it("drops project settings without a project and keeps discard last, set apart", () => {
    const items = buildDraftActionMenuItems({ ...base, hasBranch: false, hasProject: false });
    expect(items.map((item) => item.id)).toEqual(["queue", "copy", "discard"]);
    expect(items.at(-1)).toMatchObject({
      label: "Discard draft",
      destructive: true,
      separatorBefore: true,
    });
  });
});
