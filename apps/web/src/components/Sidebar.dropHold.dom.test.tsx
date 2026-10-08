import { act, useEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import type { SidebarThreadSummary } from "../types";
import { makeThreadFixture } from "../test-fixtures";
import { renderDom } from "../testing/renderDom";
import {
  customSidebarSection,
  holdSidebarDrop,
  runSidebarDropCommands,
  shouldReleaseOptimisticDrop,
  useSidebarDropHold,
  type SidebarOptimisticDrop,
} from "./Sidebar.logic";

const NOW = "2026-10-07T12:00:00.000Z";
const defined = new Set(["focus"]);

let startDrop: (drop: SidebarOptimisticDrop, sequence: () => Promise<unknown>) => void = () => {};
let hold: ReturnType<typeof useSidebarDropHold> | null = null;

/** Rows are draggable while nothing is held (Sidebar.tsx gates every row on the hold). */
function Harness({ thread }: { thread: SidebarThreadSummary }) {
  const { drop, release, holdDuring } = useSidebarDropHold();
  // The sidebar's landing check, fed one canonical thread.
  useEffect(() => {
    if (
      drop !== null &&
      shouldReleaseOptimisticDrop({
        drop,
        thread,
        now: NOW,
        customSectionIds: defined,
        destinationKeys: ["q:1"],
        queued: false,
        keyByThread: new Map([["q:1", thread.activeOrderKey]]),
      })
    ) {
      release();
    }
  }, [drop, release, thread]);
  useEffect(() => {
    startDrop = (next, sequence) => void holdDuring(next, sequence);
    hold = { drop, release, holdDuring };
  });
  return <div data-drags-enabled={String(drop === null)} />;
}

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function dragsEnabled(mounted: Awaited<ReturnType<typeof renderDom>>) {
  return mounted.find("[data-drags-enabled]")?.dataset.dragsEnabled === "true";
}

const baseDrop: SidebarOptimisticDrop = {
  key: "q:1",
  sourceSection: customSidebarSection("focus"),
  section: "active",
  occurredAt: NOW,
  clearsSnooze: false,
  clearsSection: "focus",
  order: ["q:1"],
  keysAtDrop: new Map([["q:1", "t"]]),
  assignedKeys: new Map([["q:1", "t"]]),
};

describe("the pending-drop hold ends with its command sequence", () => {
  it("re-enables drags once setSection succeeds, though a peer re-added the section", async () => {
    const member = makeThreadFixture({ sidebarSectionId: "focus", activeOrderKey: "t" });
    const mounted = await renderDom(<Harness thread={member} />);
    const setSection = deferred();
    await act(async () => startDrop(baseDrop, () => setSection.promise));
    expect(await dragsEnabled(mounted)).toBe(false);
    // Our clear committed, then a peer moved the thread back into Focus: canonical shows "focus"
    // again, so no landing check can tell the clear ever happened.
    await mounted.rerender(
      <Harness thread={makeThreadFixture({ sidebarSectionId: "focus", activeOrderKey: "t" })} />,
    );
    expect(await dragsEnabled(mounted)).toBe(false);
    await act(async () => setSection.resolve());
    expect(await dragsEnabled(mounted)).toBe(true);
  });

  it("re-enables drags after a time-ordered pinned-to-Active drop, though a peer re-pinned", async () => {
    const pinned = makeThreadFixture({ pinnedAt: NOW });
    const mounted = await renderDom(<Harness thread={pinned} />);
    const unpin = deferred();
    const timeOrdered: SidebarOptimisticDrop = {
      ...baseDrop,
      sourceSection: "pinned",
      clearsSection: null,
      order: null,
      keysAtDrop: new Map(),
      assignedKeys: new Map(),
    };
    await act(async () => startDrop(timeOrdered, () => unpin.promise));
    expect(await dragsEnabled(mounted)).toBe(false);
    // Our unpin committed, then a peer pinned it again.
    await mounted.rerender(<Harness thread={makeThreadFixture({ pinnedAt: NOW })} />);
    expect(await dragsEnabled(mounted)).toBe(false);
    await act(async () => unpin.resolve());
    expect(await dragsEnabled(mounted)).toBe(true);
  });

  it("still releases early when canonical state settles the drop", async () => {
    const mounted = await renderDom(
      <Harness thread={makeThreadFixture({ sidebarSectionId: "focus", activeOrderKey: "t" })} />,
    );
    const never = deferred();
    await act(async () => startDrop(baseDrop, () => never.promise));
    expect(await dragsEnabled(mounted)).toBe(false);
    await mounted.rerender(
      <Harness thread={makeThreadFixture({ sidebarSectionId: null, activeOrderKey: "t" })} />,
    );
    expect(await dragsEnabled(mounted)).toBe(true);
  });
});

describe("the drop runs its commands inside the hold", () => {
  const commands = (overrides: Partial<Parameters<typeof holdSidebarDrop>[3]> = {}) => ({
    settle: vi.fn(async () => true),
    clearSection: vi.fn(async () => true),
    unpin: vi.fn(async () => true),
    unsettle: vi.fn(async () => true),
    unsnooze: vi.fn(async () => true),
    pin: vi.fn(async (_orderKey: string | undefined) => true),
    reorderActive: vi.fn(async (_threadKey: string, _orderKey: string) => true),
    reorderPinned: vi.fn(async (_threadKey: string, _orderKey: string) => true),
    joinSection: vi.fn(async (_sectionId: string) => true),
    joined: vi.fn(() => {}),
    ...overrides,
  });
  const moveActive = {
    kind: "move-active",
    order: ["q:1"],
    assignments: [{ id: "q:1", orderKey: "u" }],
    unpin: true,
    unsettle: false,
    unsnooze: false,
    clearsSection: "focus",
  } as const;
  // Canonical state never settles the drop, so only the sequence's end can release it.
  const member = makeThreadFixture({ sidebarSectionId: "focus", activeOrderKey: "t" });

  it("holds from before the first command until the last one ends", async () => {
    const mounted = await renderDom(<Harness thread={member} />);
    const clear = deferred();
    const write = deferred();
    const fakes = commands({
      clearSection: vi.fn(async () => {
        await clear.promise;
        return true;
      }),
      reorderActive: vi.fn(async () => {
        await write.promise;
        return true;
      }),
    });
    await act(async () => void holdSidebarDrop(hold!.holdDuring, baseDrop, moveActive, fakes));
    expect(fakes.clearSection).toHaveBeenCalledOnce();
    expect(await dragsEnabled(mounted)).toBe(false);
    await act(async () => clear.resolve());
    expect(fakes.unpin).toHaveBeenCalledOnce();
    expect(fakes.reorderActive).toHaveBeenCalledWith("q:1", "u");
    expect(await dragsEnabled(mounted)).toBe(false);
    await act(async () => write.resolve());
    expect(await dragsEnabled(mounted)).toBe(true);
  });

  it("stops at the first failed command and releases", async () => {
    const mounted = await renderDom(<Harness thread={member} />);
    const fakes = commands({ unpin: vi.fn(async () => false) });
    await act(async () => holdSidebarDrop(hold!.holdDuring, baseDrop, moveActive, fakes));
    expect(fakes.clearSection).toHaveBeenCalledOnce();
    expect(fakes.reorderActive).not.toHaveBeenCalled();
    expect(await dragsEnabled(mounted)).toBe(true);
  });

  it("a refused section clear changes nothing else and releases", async () => {
    const mounted = await renderDom(<Harness thread={member} />);
    const fakes = commands({ clearSection: vi.fn(async () => false) });
    await act(async () => holdSidebarDrop(hold!.holdDuring, baseDrop, moveActive, fakes));
    expect(fakes.clearSection).toHaveBeenCalledOnce();
    expect(fakes.unpin).not.toHaveBeenCalled();
    expect(fakes.reorderActive).not.toHaveBeenCalled();
    expect(await dragsEnabled(mounted)).toBe(true);
  });

  it("a pin writes its key on the pin, then the renumbered pins through the pinned order", async () => {
    const fakes = commands();
    const pin = {
      kind: "pin",
      order: ["p:1", "q:1"],
      orderKey: "m",
      extraAssignments: [{ id: "p:1", orderKey: "g" }],
    } as const;
    await runSidebarDropCommands(pin, fakes);
    expect(fakes.pin).toHaveBeenCalledWith("m");
    expect(fakes.reorderPinned).toHaveBeenCalledWith("p:1", "g");
    expect(fakes.reorderActive).not.toHaveBeenCalled();

    const refused = commands({ pin: vi.fn(async () => false) });
    await runSidebarDropCommands(pin, refused);
    expect(refused.reorderPinned).not.toHaveBeenCalled();
  });

  it("a pinned reorder writes only pinned keys", async () => {
    const fakes = commands();
    await runSidebarDropCommands(
      { kind: "reorder-pinned", order: ["q:1"], assignments: [{ id: "q:1", orderKey: "a" }] },
      fakes,
    );
    expect(fakes.reorderPinned).toHaveBeenCalledWith("q:1", "a");
    expect(fakes.reorderActive).not.toHaveBeenCalled();
    expect(fakes.pin).not.toHaveBeenCalled();
  });

  it("a settle runs the settle alone", async () => {
    const fakes = commands();
    await runSidebarDropCommands({ kind: "settle", unsnooze: false }, fakes);
    expect(fakes.settle).toHaveBeenCalledOnce();
    for (const other of [fakes.unpin, fakes.reorderActive, fakes.reorderPinned]) {
      expect(other).not.toHaveBeenCalled();
    }
  });

  it("an unpark that succeeds runs every clear in order and nothing else", async () => {
    const calls: string[] = [];
    const step = (name: string) =>
      vi.fn(async () => {
        calls.push(name);
        return true;
      });
    const fakes = commands({
      unpin: step("unpin"),
      unsettle: step("unsettle"),
      unsnooze: step("unsnooze"),
    });
    await runSidebarDropCommands(
      { kind: "unpark", unpin: true, unsettle: true, unsnooze: true },
      fakes,
    );
    expect(calls).toEqual(["unpin", "unsettle", "unsnooze"]);
    for (const other of [fakes.clearSection, fakes.reorderActive, fakes.reorderPinned]) {
      expect(other).not.toHaveBeenCalled();
    }
  });

  it("an unpark stops when its unpin fails", async () => {
    const fakes = commands({ unpin: vi.fn(async () => false) });
    await runSidebarDropCommands(
      { kind: "unpark", unpin: true, unsettle: true, unsnooze: true },
      fakes,
    );
    expect(fakes.unsettle).not.toHaveBeenCalled();
    expect(fakes.unsnooze).not.toHaveBeenCalled();
  });

  it("an unpark clears lifecycle in order, keeps membership, writes no key", async () => {
    const calls: string[] = [];
    const step = (name: string, ok = true) =>
      vi.fn(async () => {
        calls.push(name);
        return ok;
      });
    const fakes = commands({
      unpin: step("unpin"),
      unsettle: step("unsettle", false),
      unsnooze: step("unsnooze"),
    });
    await runSidebarDropCommands(
      { kind: "unpark", unpin: true, unsettle: true, unsnooze: true },
      fakes,
    );
    // Stops at the failed unsettle.
    expect(calls).toEqual(["unpin", "unsettle"]);
    expect(fakes.clearSection).not.toHaveBeenCalled();
    expect(fakes.reorderActive).not.toHaveBeenCalled();
  });

  it("a stale sequence end does not release a newer drop's hold", async () => {
    const mounted = await renderDom(<Harness thread={member} />);
    const first = deferred();
    const second = deferred();
    await act(async () => startDrop(baseDrop, () => first.promise));
    // A landing release mid-sequence re-enables drags, and the next drop is picked up.
    await act(async () => hold!.release());
    await act(async () => startDrop({ ...baseDrop }, () => second.promise));
    await act(async () => first.resolve());
    expect(await dragsEnabled(mounted)).toBe(false);
    await act(async () => second.resolve());
    expect(await dragsEnabled(mounted)).toBe(true);
  });

  const join = {
    kind: "move-active",
    order: ["f1", "q:1"],
    assignments: [{ id: "q:1", orderKey: "e" }],
    unpin: false,
    unsettle: false,
    unsnooze: false,
    joinsSection: "later",
  } as const;

  it("a join runs the section move, then `joined`, then the keys, and never clears", async () => {
    const calls: string[] = [];
    const fakes = commands({
      joinSection: vi.fn(async (sectionId: string) => {
        calls.push(`join ${sectionId}`);
        return true;
      }),
      joined: vi.fn(() => {
        calls.push("joined");
      }),
      clearSection: vi.fn(async () => {
        calls.push("clear");
        return true;
      }),
      reorderActive: vi.fn(async (threadKey: string, orderKey: string) => {
        calls.push(`key ${threadKey}=${orderKey}`);
        return true;
      }),
    });
    await runSidebarDropCommands(join, fakes);
    expect(calls).toEqual(["join later", "joined", "key q:1=e"]);
  });

  it("a refused or failed join writes nothing else", async () => {
    const fakes = commands({ joinSection: vi.fn(async () => false) });
    await runSidebarDropCommands(join, fakes);
    expect(fakes.joined).not.toHaveBeenCalled();
    expect(fakes.reorderActive).not.toHaveBeenCalled();
    for (const other of [fakes.clearSection, fakes.unpin, fakes.unsettle, fakes.unsnooze]) {
      expect(other).not.toHaveBeenCalled();
    }
  });

  it("a settle from Snoozed wakes after the settle, and only if it landed", async () => {
    const calls: string[] = [];
    const fakes = commands({
      settle: vi.fn(async () => {
        calls.push("settle");
        return true;
      }),
      unsnooze: vi.fn(async () => {
        calls.push("unsnooze");
        return true;
      }),
    });
    await runSidebarDropCommands({ kind: "settle", unsnooze: true }, fakes);
    expect(calls).toEqual(["settle", "unsnooze"]);
    const refused = commands({ settle: vi.fn(async () => false) });
    await runSidebarDropCommands({ kind: "settle", unsnooze: true }, refused);
    expect(refused.unsnooze).not.toHaveBeenCalled();
  });
});
