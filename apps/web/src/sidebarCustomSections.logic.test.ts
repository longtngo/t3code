import { SIDEBAR_SECTION_ID_PATTERN } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { makeThreadFixture } from "./test-fixtures";
import {
  newSidebarSectionId,
  planSidebarSectionMove,
  planSidebarSectionRename,
  runSidebarSectionMove,
  sidebarSectionMoveFailureTitle,
  sidebarSectionMoveState,
  resolveSidebarSections,
  sidebarSectionDeleteMessage,
  sidebarSectionGone,
  sidebarSectionMoveTargets,
  sidebarSectionPatchLanded,
} from "./sidebarCustomSections.logic";

const at = (minute: number) => `2026-10-07T12:${String(minute).padStart(2, "0")}:00.000Z`;
const config = (
  sidebarSections: boolean | undefined,
  sections: Record<string, { name: string; createdAt: string }>,
) => ({
  environment: { capabilities: sidebarSections === undefined ? {} : { sidebarSections } },
  settings: { sidebarSections: sections },
});

describe("resolveSidebarSections", () => {
  it("hides sections without a primary or without the capability", () => {
    expect(resolveSidebarSections(null)).toBeNull();
    expect(
      resolveSidebarSections(config(undefined, { a: { name: "A", createdAt: at(1) } })),
    ).toBeNull();
    expect(resolveSidebarSections(config(false, {}))).toBeNull();
  });

  it("lists definitions in creation order, ties by id", () => {
    expect(
      resolveSidebarSections(
        config(true, {
          late: { name: "Late", createdAt: at(5) },
          b: { name: "B", createdAt: at(1) },
          a: { name: "A", createdAt: at(1) },
        }),
      )?.map((section) => section.id),
    ).toEqual(["a", "b", "late"]);
    expect(resolveSidebarSections(config(true, {}))).toEqual([]);
  });
});

describe("sidebarSectionPatchLanded", () => {
  const entry = { name: "A", createdAt: at(1) };
  it("needs every upsert stored and every delete gone", () => {
    expect(sidebarSectionPatchLanded({ a: entry }, { a: entry })).toBe(true);
    expect(sidebarSectionPatchLanded({}, { a: entry })).toBe(false);
    expect(sidebarSectionPatchLanded({ a: { ...entry, name: "Old" } }, { a: entry })).toBe(false);
    expect(sidebarSectionPatchLanded({}, { a: null })).toBe(true);
    expect(sidebarSectionPatchLanded({ a: entry }, { a: null })).toBe(false);
    expect(sidebarSectionPatchLanded(undefined, { a: entry })).toBe(false);
  });

  it("does not read an inherited Object.prototype member as a stored section", () => {
    expect(sidebarSectionPatchLanded({}, { constructor: null, toString: null })).toBe(true);
    expect(sidebarSectionPatchLanded({}, { constructor: { ...entry, name: "Object" } })).toBe(
      false,
    );
  });
});

describe("planSidebarSectionRename", () => {
  const live = [{ id: "s1", name: "Focus", createdAt: "2026-10-07T00:00:00.000Z" }];

  it("writes the new name over the live entry", () => {
    expect(planSidebarSectionRename(live, "s1", "Focus", "Deep work")).toEqual({
      s1: { name: "Deep work", createdAt: "2026-10-07T00:00:00.000Z" },
    });
  });

  it("a section deleted while the dialog was open stays deleted", () => {
    expect(planSidebarSectionRename([], "s1", "Focus", "Deep work")).toBeNull();
    expect(planSidebarSectionRename(null, "s1", "Focus", "Deep work")).toBeNull();
  });

  it("skips a name the live entry already has", () => {
    expect(planSidebarSectionRename(live, "s1", "Old", "Focus")).toBeNull();
  });

  it("an unchanged submit does not revert a peer's rename made while the dialog was open", () => {
    // Opened on "Old"; a peer renamed it to "Focus"; the user submitted "Old" untouched.
    expect(planSidebarSectionRename(live, "s1", "Old", "Old")).toBeNull();
  });
});

describe("sidebarSectionGone", () => {
  const live = [{ id: "focus", name: "Focus", createdAt: at(1) }];
  it("is true only for a section the live list no longer has", () => {
    expect(sidebarSectionGone(live, "focus")).toBe(false);
    expect(sidebarSectionGone(live, "deleted")).toBe(true);
    expect(sidebarSectionGone(null, "focus")).toBe(true);
  });
  it("never blocks Move to Active", () => {
    expect(sidebarSectionGone([], null)).toBe(false);
    expect(sidebarSectionGone(null, null)).toBe(false);
  });
});

describe("planSidebarSectionMove", () => {
  const now = at(30);
  it("moves into a section and clears the states that would outrank it", () => {
    expect(
      planSidebarSectionMove(
        makeThreadFixture({
          pinnedAt: at(1),
          settledOverride: "settled",
          snoozedUntil: "2099-01-01T00:00:00.000Z",
          snoozedAt: at(2),
        }),
        "focus",
        now,
      ),
    ).toEqual({ sectionId: "focus", unpin: true, unsettle: true, unsnooze: true });
  });
  it("Move to Active sends null and only clears what is set", () => {
    expect(
      planSidebarSectionMove(makeThreadFixture({ sidebarSectionId: "focus" }), null, now),
    ).toEqual({
      sectionId: null,
      unpin: false,
      unsettle: false,
      unsnooze: false,
    });
  });
  it("is a no-op when nothing would change", () => {
    expect(
      planSidebarSectionMove(makeThreadFixture({ sidebarSectionId: "focus" }), "focus", now),
    ).toBeNull();
    expect(planSidebarSectionMove(makeThreadFixture(), null, now)).toBeNull();
  });
});

describe("runSidebarSectionMove", () => {
  const ok = AsyncResult.success(undefined);
  const failed = AsyncResult.failure(Cause.fail("refused"));
  const all = { sectionId: "focus", unpin: true, unsettle: true, unsnooze: true };

  it("runs section, unpin, unsettle, unsnooze in that order", async () => {
    const calls: string[] = [];
    const step = (name: string) => async () => {
      calls.push(name);
      return ok;
    };
    const failure = await runSidebarSectionMove(all, {
      section: step("section"),
      unpin: step("unpin"),
      unsettle: step("unsettle"),
      unsnooze: step("unsnooze"),
    });
    expect(failure).toBeNull();
    expect(calls).toEqual(["section", "unpin", "unsettle", "unsnooze"]);
  });

  it("skips the steps the plan does not need", async () => {
    const unpin = vi.fn(async () => ok);
    await runSidebarSectionMove(
      { ...all, unpin: false },
      { section: async () => ok, unpin, unsettle: async () => ok, unsnooze: async () => ok },
    );
    expect(unpin).not.toHaveBeenCalled();
  });

  it("stops at the first failure and names its step", async () => {
    const unsnooze = vi.fn(async () => ok);
    const failure = await runSidebarSectionMove(all, {
      section: async () => ok,
      unpin: async () => ok,
      unsettle: async () => failed,
      unsnooze,
    });
    expect(failure).toEqual({ step: "unsettle", result: failed });
    expect(unsnooze).not.toHaveBeenCalled();
  });

  it("a failed membership write runs nothing else", async () => {
    const unpin = vi.fn(async () => ok);
    const failure = await runSidebarSectionMove(all, {
      section: async () => failed,
      unpin,
      unsettle: async () => ok,
      unsnooze: async () => ok,
    });
    expect(failure?.step).toBe("section");
    expect(unpin).not.toHaveBeenCalled();
  });
});

describe("sidebarSectionMoveFailureTitle", () => {
  it("names the step that failed after the move landed", () => {
    expect(sidebarSectionMoveFailureTitle("section", "Focus")).toBe("Failed to move thread");
    expect(sidebarSectionMoveFailureTitle("section", null)).toBe("Failed to move thread to Active");
    expect(sidebarSectionMoveFailureTitle("unpin", "Focus")).toBe(
      "Moved to Focus, but couldn't unpin",
    );
    expect(sidebarSectionMoveFailureTitle("unsettle", null)).toBe(
      "Moved to Active, but couldn't un-settle",
    );
    expect(sidebarSectionMoveFailureTitle("unsnooze", "Focus")).toBe(
      "Moved to Focus, but couldn't wake it",
    );
  });
});

describe("sidebarSectionMoveTargets", () => {
  const sections = [
    { id: "a", name: "A", createdAt: at(1) },
    { id: "b", name: "B", createdAt: at(2) },
  ];
  it("offers the other sections, and Active only from a defined section", () => {
    expect(sidebarSectionMoveTargets(sections, "a")).toEqual({
      sections: [sections[1]],
      canMoveToActive: true,
    });
    expect(sidebarSectionMoveTargets(sections, null)).toEqual({ sections, canMoveToActive: false });
    // A membership naming a deleted section already renders in Active.
    expect(sidebarSectionMoveTargets(sections, "gone")).toEqual({
      sections,
      canMoveToActive: false,
    });
  });
});

describe("sidebarSectionMoveState", () => {
  const sections = [{ id: "a", name: "A", createdAt: at(1) }];
  const movable = {
    sections,
    thread: { archivedAt: null, sidebarSectionId: "a" },
    supportsSections: true,
  };

  it("offers the primary's sections with the thread's current one", () => {
    expect(sidebarSectionMoveState(movable)).toEqual({ sections, currentSectionId: "a" });
    expect(sidebarSectionMoveState({ ...movable, canOperate: true })).not.toBeNull();
  });

  it("offers nothing without sections on the primary", () => {
    expect(sidebarSectionMoveState({ ...movable, sections: null })).toBeNull();
  });

  it("offers nothing when the thread's own server cannot store membership", () => {
    expect(sidebarSectionMoveState({ ...movable, supportsSections: false })).toBeNull();
  });

  it("offers nothing for an archived thread", () => {
    const archived = { archivedAt: at(3), sidebarSectionId: "a" };
    expect(sidebarSectionMoveState({ ...movable, thread: archived })).toBeNull();
  });

  it("offers nothing to a caller that hides operate actions when it cannot operate", () => {
    expect(sidebarSectionMoveState({ ...movable, canOperate: false })).toBeNull();
  });
});

describe("sidebarSectionDeleteMessage", () => {
  it("names the count of threads that return to Active", () => {
    expect(sidebarSectionDeleteMessage("Focus", 0)).toBe(
      'Delete section "Focus"?\nIt has no threads.',
    );
    expect(sidebarSectionDeleteMessage("Focus", 1)).toBe(
      'Delete section "Focus"?\nIts 1 thread returns to Active.',
    );
    expect(sidebarSectionDeleteMessage("Focus", 3)).toBe(
      'Delete section "Focus"?\nIts 3 threads return to Active.',
    );
  });
});

describe("newSidebarSectionId", () => {
  it("mints an id the settings schema accepts", () => {
    expect(newSidebarSectionId()).toMatch(SIDEBAR_SECTION_ID_PATTERN);
  });
});
