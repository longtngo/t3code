import { describe, expect, it, vi } from "vite-plus/test";
import { createSidebarCollisionDetection, pointerOverVisibleRect } from "./Sidebar.drag";

describe("pointerOverVisibleRect", () => {
  // A drop zone docked at the end of a scrolling list can be laid out past its scroller's clip:
  // measured at a 500px viewport, the Queue header sat at 428..460 for a whole drag against a clip
  // ending at 424, invisible but geometrically live. A rect-only test accepts a release there.
  const build = (options: { overflow: string; clipHeight: number }) => {
    const scroller = document.createElement("div");
    const node = document.createElement("div");
    // Three non-scrolling elements sit between the Queue header and the scroll viewport in the live
    // sidebar, at all seven measured viewport heights. Making the scroller the node's direct parent
    // leaves the WALK untested: `continue` -> `break` then passes every test here while rendering
    // the guard inert in production.
    let parent: HTMLElement = scroller;
    for (let depth = 0; depth < 3; depth++) {
      const wrapper = document.createElement("div");
      parent.appendChild(wrapper);
      parent = wrapper;
    }
    parent.appendChild(node);
    document.body.appendChild(scroller);
    scroller.style.overflowY = options.overflow;
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 100,
      right: 260,
      bottom: 100 + options.clipHeight,
      width: 260,
      height: options.clipHeight,
      x: 0,
      y: 100,
      toJSON: () => ({}),
    } as DOMRect);
    return { scroller, node };
  };
  const rect = { left: 10, top: 428, width: 240, height: 32 };

  it("accepts a point inside a zone its scroller actually paints", () => {
    const { node } = build({ overflow: "auto", clipHeight: 500 });
    expect(pointerOverVisibleRect(node, rect, { x: 128, y: 444 })).toBe(true);
  });

  it("rejects a point inside the zone but past the scroller's clip", () => {
    const { node } = build({ overflow: "auto", clipHeight: 324 });
    // Geometrically inside the zone, 20px below where the scroller stops painting.
    expect(pointerOverVisibleRect(node, rect, { x: 128, y: 444 })).toBe(false);
  });

  it("clips against an overflow-y:scroll ancestor, the value the real sidebar uses", () => {
    // `scroll` is the half that fires in production - the sidebar's ScrollArea viewport computes to
    // `scroll`, never `auto`, at all seven measured viewport heights - and every other test here
    // builds an `auto` scroller, so dropping this half disabled the whole guard live while 6031
    // tests stayed green.
    const { node } = build({ overflow: "scroll", clipHeight: 324 });
    expect(pointerOverVisibleRect(node, rect, { x: 128, y: 444 })).toBe(false);
  });

  it("rejects a point above where the scroller starts painting", () => {
    // The clip has two edges and only the bottom one had a test. Live-reachable: dragging a row
    // downward auto-scrolls the list until the header sits at 73..105 under a viewport starting at
    // 96, so its top 23px are unpainted and a release there enqueued wrongly 5 times out of 5.
    const { scroller, node } = build({ overflow: "auto", clipHeight: 400 });
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 450,
      right: 260,
      bottom: 850,
      width: 260,
      height: 400,
      x: 0,
      y: 450,
      toJSON: () => ({}),
    } as DOMRect);
    expect(pointerOverVisibleRect(node, rect, { x: 128, y: 444 })).toBe(false);
  });

  it("ignores ancestors that do not scroll", () => {
    const { node } = build({ overflow: "visible", clipHeight: 324 });
    expect(pointerOverVisibleRect(node, rect, { x: 128, y: 444 })).toBe(true);
  });

  it("ignores a clipping ancestor that has no box to clip with", () => {
    // A detached or not-yet-laid-out ancestor measures 0x0; treating that as a clip would reject
    // every legitimate point.
    const { scroller, node } = build({ overflow: "auto", clipHeight: 324 });
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    expect(pointerOverVisibleRect(node, rect, { x: 128, y: 444 })).toBe(true);
  });

  it("still clips with a zero-height but wide scroller", () => {
    // The 0x0 skip is width AND height for exactly this case: a collapsed scroller keeps its width,
    // so it is a real clip and must still reject. This is the only test that catches narrowing the
    // skip to `box.height === 0` alone; the zero-width case below catches the other operand.
    const { scroller, node } = build({ overflow: "auto", clipHeight: 324 });
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 100,
      right: 260,
      bottom: 100,
      width: 260,
      height: 0,
      x: 0,
      y: 100,
      toJSON: () => ({}),
    } as DOMRect);
    expect(pointerOverVisibleRect(node, rect, { x: 128, y: 444 })).toBe(false);
  });

  it("still clips with a zero-width but tall scroller", () => {
    // The symmetric case. Its box contains the pointer vertically, so only the width rejects - which
    // is what keeps `box.width === 0 && ...` from being narrowable to either operand alone.
    const { scroller, node } = build({ overflow: "auto", clipHeight: 400 });
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 100,
      right: 0,
      bottom: 500,
      width: 0,
      height: 400,
      x: 0,
      y: 100,
      toJSON: () => ({}),
    } as DOMRect);
    expect(pointerOverVisibleRect(node, rect, { x: 128, y: 444 })).toBe(false);
  });

  it("treats overflow:hidden as not scrolling, deliberately", () => {
    // The rule is auto|scroll ONLY, and this pins the exclusion. Measured live across seven viewport
    // sizes: nothing between the Queue header and the sidebar's scroll viewport is `hidden`, and the
    // nearest one above it has an identical box - so honouring `hidden` buys nothing today and can
    // only ever reject points.
    const { node } = build({ overflow: "hidden", clipHeight: 324 });
    expect(pointerOverVisibleRect(node, rect, { x: 128, y: 444 })).toBe(true);
  });

  it("still rejects a point outside the zone itself, on all four edges", () => {
    // All four, because no live arm can discriminate a horizontal operand: every probe fixes x at
    // the dragged row's centre and varies only y. Releasing 5px right of the header enqueued 3/3
    // once the right edge was dropped.
    const { node } = build({ overflow: "auto", clipHeight: 500 });
    expect(pointerOverVisibleRect(node, rect, { x: 128, y: 461 })).toBe(false); // below
    expect(pointerOverVisibleRect(node, rect, { x: 128, y: 427 })).toBe(false); // above
    expect(pointerOverVisibleRect(node, rect, { x: 9, y: 444 })).toBe(false); // left
    expect(pointerOverVisibleRect(node, rect, { x: 251, y: 444 })).toBe(false); // right
  });
});

describe("sidebar collision detection, pointer drop zone visibility", () => {
  // The existing pointerDropIds test stubs `node: { current: null }`, which takes the fallback
  // branch, so the detector's own use of the visibility rule was covered by nothing.
  const zone = { left: 0, top: 428, width: 260, height: 32, right: 260, bottom: 460 };
  const buildArgs = (clipHeight: number, nodeRect = zone) => {
    const scroller = document.createElement("div");
    const node = document.createElement("div");
    scroller.appendChild(node);
    document.body.appendChild(scroller);
    scroller.style.overflowY = "auto";
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 100,
      right: 260,
      bottom: 100 + clipHeight,
      width: 260,
      height: clipHeight,
      x: 0,
      y: 100,
      toJSON: () => ({}),
    } as DOMRect);
    vi.spyOn(node, "getBoundingClientRect").mockReturnValue({
      ...nodeRect,
      toJSON: () => ({}),
    } as DOMRect);
    return {
      active: {
        id: "row",
        data: { current: {} },
        rect: { current: { initial: null, translated: null } },
      },
      collisionRect: zone,
      droppableRects: new Map([["queue", zone]]),
      droppableContainers: [
        {
          id: "queue",
          key: "queue",
          disabled: false,
          data: { current: {} },
          node: { current: node },
          rect: { current: zone },
        },
      ],
      pointerCoordinates: { x: 128, y: 444 },
    } as unknown as Parameters<ReturnType<typeof createSidebarCollisionDetection>>[0];
  };

  it("picks the zone when the pointer is over a part its scroller paints", () => {
    const detector = createSidebarCollisionDetection(() => true, { pointerDropIds: ["queue"] });
    expect(detector(buildArgs(500))[0]?.id).toBe("queue");
  });

  it("does not pick the zone where the scroller does not paint it", () => {
    const detector = createSidebarCollisionDetection(() => true, { pointerDropIds: ["queue"] });
    expect(detector(buildArgs(324)).map((c) => c.id)).not.toContain("queue");
  });

  // dnd-kit measures droppables once per drag, so `droppableRects` holds where the header WAS at
  // pickup. Both tests above keep the two rects identical, which leaves the live read unpinned:
  // here the cached rect is 200px stale and only the live one contains the pointer.
  it("resolves against the node's live rect, not the rect cached at pickup", () => {
    const detector = createSidebarCollisionDetection(() => true, { pointerDropIds: ["queue"] });
    const live = { ...zone, top: 228, bottom: 260 };
    expect(detector(buildArgs(500, live)).map((c) => c.id)).not.toContain("queue");
    expect(
      detector({ ...buildArgs(500, live), pointerCoordinates: { x: 128, y: 244 } })[0]?.id,
    ).toBe("queue");
  });
});
