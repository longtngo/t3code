import { describe, expect, it } from "vite-plus/test";

import { buildThreadActionMenuItems, type ThreadActionMenuState } from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  branch: null,
  isPinned: false,
  isSettled: false,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  isAutoCompactArmed: false,
  autoCompactThresholdPercent: 50,
  supports: {
    settlement: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
    autoCompact: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

function ids(state: ThreadActionMenuState): string[] {
  return buildThreadActionMenuItems(state).map((item) => item.id);
}

describe("buildThreadActionMenuItems", () => {
  it("hides lifecycle items when the environment lacks the capabilities", () => {
    expect(
      ids({
        ...baseState,
        supports: {
          settlement: false,
          snooze: false,
          pinning: false,
          titleRegeneration: false,
          autoCompact: false,
        },
      }),
    ).toEqual(["rename", "mark-unread", "copy-path", "copy-thread-id", "archive", "delete"]);
  });

  it("includes branch items only for threads with a branch", () => {
    const withBranch = ids({ ...baseState, branch: "feat/menu" });
    expect(withBranch).toContain("new-thread-on-branch");
    expect(withBranch).toContain("copy-branch");
    expect(ids(baseState)).not.toContain("new-thread-on-branch");
    expect(ids(baseState)).not.toContain("copy-branch");
  });

  it("flips lifecycle labels with thread state", () => {
    expect(ids({ ...baseState, isPinned: true, isSettled: true, isSnoozed: true })).toEqual(
      expect.arrayContaining(["unpin", "unsettle", "unsnooze"]),
    );
    expect(ids(baseState)).toEqual(expect.arrayContaining(["pin", "settle", "snooze"]));
  });

  it("disables snooze when the thread cannot snooze, keeping presets visible", () => {
    const snooze = buildThreadActionMenuItems({ ...baseState, canSnoozeNow: false }).find(
      (item) => item.id === "snooze",
    );
    expect(snooze?.disabled).toBe(true);
    expect(snooze?.children?.map((child) => child.id)).toEqual(["snooze:hour"]);
  });

  it("disables title regeneration while one is in flight", () => {
    const item = buildThreadActionMenuItems({ ...baseState, isRegeneratingTitle: true }).find(
      (candidate) => candidate.id === "regenerate-title",
    );
    expect(item).toMatchObject({ label: "Regenerating…", disabled: true });
  });

  it("marks delete as destructive and keeps it last", () => {
    const items = buildThreadActionMenuItems({ ...baseState, branch: "main" });
    expect(items.at(-1)).toMatchObject({ id: "delete", destructive: true });
  });

  it("offers archive as a non-destructive action right before delete", () => {
    const items = buildThreadActionMenuItems(baseState);
    const archiveItem = items.at(-2);
    expect(archiveItem?.id).toBe("archive");
    expect(archiveItem?.destructive).toBeFalsy();
    expect(items.at(-1)?.id).toBe("delete");
  });

  it("keeps archive available even when the environment lacks every other capability", () => {
    expect(
      ids({
        ...baseState,
        supports: {
          settlement: false,
          snooze: false,
          pinning: false,
          titleRegeneration: false,
          autoCompact: false,
        },
      }),
    ).toContain("archive");
  });

  it("disables archive while the thread is running", () => {
    const archiveItem = buildThreadActionMenuItems({ ...baseState, isRunning: true }).find(
      (item) => item.id === "archive",
    );
    expect(archiveItem?.disabled).toBe(true);
  });
});

describe("buildThreadActionMenuItems — auto-compact", () => {
  const labelFor = (state: ThreadActionMenuState): string | undefined =>
    buildThreadActionMenuItems(state).find((item) => item.id === "auto-compact")?.label;

  it("omits the item on a provider that cannot compact on request", () => {
    // A switch that could only ever hold is worse than no switch.
    expect(
      labelFor({
        ...baseState,
        supports: { ...baseState.supports, autoCompact: false },
      }),
    ).toBeUndefined();
  });

  it("names the threshold while disarmed, so arming says what it will do", () => {
    expect(labelFor({ ...baseState, autoCompactThresholdPercent: 65 })).toBe("Auto-compact at 65%");
  });

  it("offers the way out once armed", () => {
    // Reverse states: every way in needs a way out in the same menu.
    expect(labelFor({ ...baseState, isAutoCompactArmed: true })).toBe("Turn off auto-compact");
  });

  it("sits next to the other per-thread actions rather than among the copy items", () => {
    const order = ids(baseState);
    expect(order.indexOf("auto-compact")).toBeGreaterThan(order.indexOf("rename"));
    expect(order.indexOf("auto-compact")).toBeLessThan(order.indexOf("archive"));
  });
});
