import { describe, expect, it, vi } from "vite-plus/test";
import { closestCenter, type CollisionDetection } from "@dnd-kit/core";
import { verticalListSortingStrategy, type SortingStrategy } from "@dnd-kit/sortable";
import {
  createSidebarCollisionDetection,
  createSidebarSortingStrategy,
  restrictBelowSidebarLabel,
  sidebarDragLabelsShift,
  sidebarQueueBoundary,
  sidebarSnoozeHintState,
  sidebarSortableIds,
  SHOW_MORE_ID,
  type SidebarSnoozeHint,
} from "./Sidebar.drag";
import {
  buildSidebarListItems,
  customSectionHeaderId,
  customSidebarSection,
  isCustomSidebarSection,
  resolveSidebarDropTarget,
  sidebarListItemId,
  sidebarMarkerId,
  type SidebarListItem,
  type SidebarListMarker,
  type SidebarSection,
  routeSidebarDragEnd,
  sidebarDragListItems,
  sidebarQueuePlacement,
  sidebarSnoozeDropAllowed,
  sidebarSnoozeZoneIds,
  withQueuedRow,
} from "./Sidebar.logic";
import { QUEUE_DROP_ID } from "./SidebarQueueBlock";

const thread = (key: string, section: SidebarSection): SidebarListItem => ({
  kind: "thread",
  key,
  section,
});
const marker = (marker: SidebarListMarker): SidebarListItem => ({ kind: "marker", marker });
const pinnedHeader = marker("pinned-header");
const divider = marker("pinned-divider");
const settledHeader = marker("settled-header");
const stationary = { x: 0, y: 0, scaleX: 1, scaleY: 1 };
/** What dnd-kit's useSortable hands an item listed after the rows (`sidebarSortableIds`): the
 * strategy's transform while both the active and the over are context items, none otherwise. */
function afterRowsShift(
  strategy: SortingStrategy,
  items: readonly SidebarListItem[],
  layout: Pick<Parameters<SortingStrategy>[0], "rects" | "activeIndex" | "overIndex">,
  id: typeof QUEUE_DROP_ID | typeof SHOW_MORE_ID,
): number {
  if (layout.activeIndex < 0 || layout.overIndex < 0) return 0;
  const index = sidebarSortableIds(items, QUEUE_DROP_ID).indexOf(id);
  return strategy({ ...layout, index, activeNodeRect: null })?.y ?? 0;
}

function layout(
  items: readonly SidebarListItem[],
  active: string,
  over: string,
  scale = 1,
  cardHeight = 82,
) {
  let top = 100;
  const rects = items.map((item) => {
    const height =
      item.kind === "thread"
        ? (item.section === "pinned" ||
          item.section === "active" ||
          isCustomSidebarSection(item.section)
            ? cardHeight
            : 36) * scale
        : item.marker === "pinned-header" || item.marker === "pinned-divider"
          ? 0
          : (item.marker.endsWith("placeholder") ? 0 : 32) * scale;
    const rect = { top, height, bottom: top + height, left: 0, right: 260, width: 260 };
    top += height + 1;
    return rect;
  });
  const activeIndex = items.findIndex((item) => sidebarListItemId(item) === active);
  return {
    activeIndex,
    overIndex: items.findIndex((item) => sidebarListItemId(item) === over),
    activeNodeRect: rects[activeIndex]!,
    rects,
    index: 0,
  } satisfies Parameters<SortingStrategy>[0];
}

function preview(
  input: Parameters<typeof createSidebarSortingStrategy>[0],
  active: string,
  over: string,
  scale = 1,
) {
  const strategy = createSidebarSortingStrategy(input);
  const args = layout(input.items, active, over, scale);
  return new Map(
    input.items.map((item, index) => [sidebarListItemId(item), strategy({ ...args, index })]),
  );
}

describe("sidebar collision detection", () => {
  function collisionArgs(blockedAboveSource = false) {
    const rows = [thread("source", "active"), thread("blocked", "active")];
    const items = [
      pinnedHeader,
      divider,
      ...(blockedAboveSource ? rows.toReversed() : rows),
      settledHeader,
      marker("settled-placeholder"),
    ];
    const { rects, activeIndex, overIndex } = layout(items, "source", "blocked");
    const collisionRect = rects[overIndex]!;
    return {
      active: {
        id: "source",
        data: { current: {} },
        rect: { current: { initial: rects[activeIndex]!, translated: collisionRect } },
      },
      collisionRect,
      droppableRects: new Map(items.map((item, index) => [sidebarListItemId(item), rects[index]!])),
      droppableContainers: items.map((item, index) => ({
        id: sidebarListItemId(item),
        key: sidebarListItemId(item),
        disabled: false,
        data: { current: {} },
        node: { current: null },
        rect: { current: rects[index]! },
      })),
      pointerCoordinates: null,
    } satisfies Parameters<CollisionDetection>[0];
  }

  it.each([
    [false, sidebarMarkerId("settled-header")],
    [true, sidebarMarkerId("pinned-divider")],
  ] as const)(
    "rejects unsupported Active instead of selecting %s / %s",
    (blockedAboveSource, nearbyTarget) => {
      const args = collisionArgs(blockedAboveSource);
      const detector = createSidebarCollisionDetection((id) => id !== "blocked");
      const filtered = closestCenter({
        ...args,
        droppableContainers: args.droppableContainers.filter(
          (container) => container.id !== "blocked",
        ),
      });
      expect(filtered[0]?.id).toBe(nearbyTarget);
      expect(detector(args).map((collision) => collision.id)).toEqual(["source"]);
    },
  );

  it("a pointer inside a queue drop zone picks it, and elsewhere the zone never competes", () => {
    const args = collisionArgs();
    const zone = { top: 1_000, left: 0, width: 200, height: 32, bottom: 1_032, right: 200 };
    const withZone = {
      ...args,
      droppableRects: new Map([...args.droppableRects, ["queue", zone]]),
      droppableContainers: [
        ...args.droppableContainers,
        {
          id: "queue",
          key: "queue",
          disabled: false,
          data: { current: {} },
          node: { current: null },
          rect: { current: zone },
        },
      ],
    };
    const detector = createSidebarCollisionDetection(() => true, { pointerDropIds: ["queue"] });
    expect(detector({ ...withZone, pointerCoordinates: { x: 10, y: 1_010 } })[0]?.id).toBe("queue");
    const outside = detector({ ...withZone, pointerCoordinates: { x: 10, y: 5_000 } });
    expect(outside.map((collision) => collision.id)).not.toContain("queue");
  });

  it("drops excluded ids before choosing, so a nearer one never blocks a valid target", () => {
    const args = collisionArgs();
    const nearest = closestCenter(args)[0]!.id;
    const detector = createSidebarCollisionDetection((id) => id !== nearest, {
      excludeIds: [String(nearest)],
    });
    const ids = detector(args).map((collision) => collision.id);
    expect(ids).not.toContain(nearest);
    expect(ids[0]).not.toBe("source");
  });

  it("selects the nearest supported target", () => {
    const detector = createSidebarCollisionDetection(() => true);
    expect(detector(collisionArgs())[0]?.id).toBe("blocked");
  });

  it.each([
    { sourceSection: "active", pins: 0 },
    { sourceSection: "active", pins: 1 },
    { sourceSection: "pinned", pins: 1 },
    { sourceSection: "settled", pins: 1 },
  ] as const)(
    "switches on crossing the divider row from $sourceSection with $pins pins",
    ({ sourceSection, pins }) => {
      const items = [
        pinnedHeader,
        ...(pins ? [thread("p", "pinned")] : []),
        ...(sourceSection === "pinned" ? [thread("source", "pinned")] : []),
        divider,
        thread("a", "active"),
        ...(sourceSection === "active" ? [thread("source", "active")] : []),
        settledHeader,
        ...(sourceSection === "settled" ? [thread("source", "settled")] : []),
      ];
      const { rects, activeIndex } = layout(items, "source", "a");
      const sourceRect = rects[activeIndex]!;
      let boundaryTop = 300;
      const boundaryNode = {
        querySelector: () => ({
          getBoundingClientRect: () => ({
            top: boundaryTop,
            bottom: boundaryTop + 16,
            left: 0,
            right: 260,
          }),
        }),
      } as unknown as HTMLElement;
      const detector = createSidebarCollisionDetection(() => true, {
        items,
        activationY: sourceSection === "pinned" ? 200 : 600,
      });
      const at = (center: number) => {
        const collisionRect = {
          ...sourceRect,
          top: center - sourceRect.height / 2,
          bottom: center + sourceRect.height / 2,
        };
        const args = {
          ...collisionArgs(),
          active: {
            id: "source",
            data: { current: {} },
            rect: { current: { initial: sourceRect, translated: collisionRect } },
          },
          collisionRect,
          pointerCoordinates: { x: 130, y: center },
          droppableRects: new Map(
            items.map((item, index) => [sidebarListItemId(item), rects[index]!]),
          ),
          droppableContainers: items.map((item, index) => ({
            id: sidebarListItemId(item),
            key: sidebarListItemId(item),
            disabled: false,
            data: { current: {} },
            node: {
              current:
                item === divider
                  ? boundaryNode
                  : item === settledHeader
                    ? ({ getBoundingClientRect: () => ({ top: 600 }) } as unknown as HTMLElement)
                    : null,
            },
            rect: { current: rects[index]! },
          })),
        };
        const over = detector(args)[0];
        return over ? resolveSidebarDropTarget(items, "source", String(over.id))?.section : null;
      };
      expect(at(330)).toBe("active");
      expect(at(317)).toBe("active");
      expect(at(316)).toBe("pinned");
      // The preview moves the divider; a stationary pointer must not undo the drop target.
      boundaryTop = 400;
      expect(at(316)).toBe("pinned");
      expect(at(399)).toBe("pinned");
      expect(at(400)).toBe("active");
      boundaryTop = 300;
      expect(at(400)).toBe("active");
      expect(at(317)).toBe("active");
      expect(at(316)).toBe("pinned");
    },
  );

  describe("a drag that starts in the Queue", () => {
    // Pins, the divider, one Active row, three queue rows, then Settled. Only
    // the dragged queue row is in `items`, at the Queue's slot.
    const geometry = [
      pinnedHeader,
      thread("p", "pinned"),
      divider,
      marker("active-placeholder"),
      thread("a", "active"),
      thread("q1", "active"),
      thread("q2", "active"),
      thread("q3", "active"),
      settledHeader,
    ];
    const { rects } = layout(geometry, "q1", "q1");
    const rectOf = (id: string) =>
      rects[geometry.findIndex((item) => sidebarListItemId(item) === id)]!;
    const nodes: Record<string, HTMLElement> = {
      [sidebarListItemId(divider)]: {
        querySelector: () => ({
          getBoundingClientRect: () => ({ ...rectOf(sidebarListItemId(divider)), bottom: 200 }),
        }),
      } as unknown as HTMLElement,
      [sidebarListItemId(settledHeader)]: {
        getBoundingClientRect: () => rectOf(sidebarListItemId(settledHeader)),
      } as unknown as HTMLElement,
    };
    /** `grab` offsets the card's centre below the pointer, as when a row is held off-centre. */
    function drag(restingSection: SidebarSection, freeIds?: readonly string[], grab = 0) {
      const items = withQueuedRow(
        [
          pinnedHeader,
          thread("p", "pinned"),
          divider,
          marker("active-placeholder"),
          thread("a", "active"),
          settledHeader,
        ],
        "q1",
        restingSection,
      );
      const detector = createSidebarCollisionDetection(() => true, {
        items,
        activationY: 310,
        ...(freeIds ? { freeIds } : {}),
      });
      const initial = rectOf("q1");
      return (pointerY: number) => {
        const top = pointerY - initial.height / 2 + grab;
        const collisionRect = { ...initial, top, bottom: top + initial.height };
        const over = detector({
          active: {
            id: "q1",
            data: { current: {} },
            rect: { current: { initial, translated: collisionRect } },
          },
          collisionRect,
          pointerCoordinates: { x: 130, y: pointerY },
          droppableRects: new Map(
            geometry.map((item, index) => [sidebarListItemId(item), rects[index]!]),
          ),
          droppableContainers: geometry.map((item, index) => ({
            id: sidebarListItemId(item),
            key: sidebarListItemId(item),
            disabled: false,
            data: { current: {} },
            node: { current: nodes[sidebarListItemId(item)] ?? null },
            rect: { current: rects[index]! },
          })),
        })[0];
        return over === undefined ? null : String(over.id);
      };
    }
    const queueIds = ["q1", "q2", "q3"];

    it.each(["active", "pinned", "snoozed", "settled"] as const)(
      "picks the nearest queue row inside the divider label's width (rests in %s)",
      (restingSection) => {
        const at = drag(restingSection, queueIds);
        expect(at(400)).toBe("q2");
        expect(at(475)).toBe("q3");
        expect(at(392)).toBe("q2");
      },
    );

    it("without free ids, the Pinned/Active switch holds the row on itself", () => {
      expect(drag("active")(475)).toBe("q1");
    });

    it("starts in Active even when the thread rests in Pinned", () => {
      expect(drag("pinned", queueIds)(226)).toBe("a");
    });

    it("still switches to Pinned when the pointer crosses the divider", () => {
      // Held 30px below centre, nearest-centre alone would pick the Active row.
      const at = drag("active", queueIds, 30);
      expect(at(226)).toBe("a");
      expect(at(196)).toBe(sidebarListItemId(divider));
    });

    it("keeps tracking the pointer while a queue row is nearest", () => {
      const at = drag("active", queueIds);
      expect(at(226)).toBe("a");
      expect(at(150)).toBe("p");
      expect(at(400)).toBe("q2");
      expect(at(230)).toBe("a");
      expect(at(195)).toBe(sidebarListItemId(divider));
    });
  });

  it("returns no collision if an unsupported target has no source fallback", () => {
    const args = collisionArgs();
    const detector = createSidebarCollisionDetection(() => false);
    expect(
      detector({
        ...args,
        droppableContainers: args.droppableContainers.filter(
          (container) => container.id !== "source",
        ),
      }),
    ).toEqual([]);
  });

  it("validates each hovered target once and always allows returning to the source", () => {
    const args = collisionArgs();
    const isValid = vi.fn((id: string) => id !== "blocked");
    const detector = createSidebarCollisionDetection(isValid);
    expect(detector(args)[0]?.id).toBe("source");
    expect(
      detector({
        ...args,
        collisionRect: {
          ...args.collisionRect,
          top: args.collisionRect.top + 3,
          bottom: args.collisionRect.bottom + 3,
        },
      })[0]?.id,
    ).toBe("source");
    expect(detector({ ...args, collisionRect: args.droppableRects.get("source")! })[0]?.id).toBe(
      "source",
    );
    expect(
      detector({
        ...args,
        collisionRect: args.droppableRects.get(sidebarMarkerId("settled-placeholder"))!,
      })[0]?.id,
    ).toBe(sidebarMarkerId("settled-placeholder"));
    expect(isValid.mock.calls).toEqual([["blocked"], [sidebarMarkerId("settled-placeholder")]]);
  });
});

describe("sidebar drag projection", () => {
  it.each([
    ["a2", "a1"],
    ["p", "a1"],
    ["s", sidebarMarkerId("pinned-header")],
    ["z", sidebarMarkerId("settled-header")],
  ])("restores every row and marker when dragging %s out after hovering %s", (active, over) => {
    const items = [
      pinnedHeader,
      thread("p", "pinned"),
      divider,
      marker("active-placeholder"),
      thread("a1", "active"),
      thread("a2", "active"),
      marker("snoozed-header"),
      thread("z", "snoozed"),
      settledHeader,
      marker("settled-placeholder"),
      thread("s", "settled"),
    ];
    const input = {
      items,
      settledOrder: ["z", "s"],
      settledExpanded: true,
      boundaryLabelHeight: 24,
      snoozedThreadCount: 1,
    };
    const reordered = preview(input, active, over);
    expect([...reordered.values()].some((transform) => transform?.y !== 0)).toBe(true);

    const restored = preview({ ...input, enabled: false }, active, over);
    for (const transform of restored.values()) expect(transform).toEqual(stationary);

    // Returning to the sidebar resumes the same live reorder preview.
    expect(preview({ ...input, enabled: true }, active, over)).toEqual(reordered);
  });

  it.each([
    ["a1", "a2"],
    ["a1", sidebarMarkerId("settled-header")],
    ["z", "a2"],
  ])("keeps sparse shelves at the bottom when dragging %s over %s", (active, over) => {
    const items = [
      pinnedHeader,
      divider,
      thread("a1", "active"),
      thread("a2", "active"),
      marker("snoozed-header"),
      thread("z", "snoozed"),
      settledHeader,
      thread("s", "settled"),
    ];
    const strategy = createSidebarSortingStrategy({
      items,
      settledOrder: over === sidebarMarkerId("settled-header") ? ["a1", "s"] : ["s"],
      settledExpanded: true,
      boundaryLabelHeight: 24,
      snoozedThreadCount: 1,
    });
    const args = layout(items, active, over);
    for (const rect of args.rects.slice(4)) {
      rect.top += 400;
      rect.bottom += 400;
    }
    const lastIndex = items.length - 1;
    expect(strategy({ ...args, index: lastIndex })).toEqual(stationary);
  });

  const pinned = [
    pinnedHeader,
    thread("p1", "pinned"),
    thread("p2", "pinned"),
    divider,
    thread("a1", "active"),
    settledHeader,
    thread("s1", "settled"),
  ];

  it.each([
    ["p1", "p2"],
    ["p2", "p1"],
  ])("preserves existing pinned transforms from %s to %s", (active, over) => {
    const strategy = createSidebarSortingStrategy({
      items: pinned,
      settledOrder: [],
      settledExpanded: true,
    });
    const args = layout(pinned, active, over);
    // dnd-kit moves the lifted row by the pointer delta, so only peers matter.
    for (let index = 0; index < pinned.length; index += 1) {
      if (index === args.activeIndex) continue;
      expect(strategy({ ...args, index })).toEqual(verticalListSortingStrategy({ ...args, index }));
    }
  });

  it("keeps the pinned header above the gap when a lower pin moves to the top", () => {
    const result = preview(
      { items: pinned, settledOrder: [], settledExpanded: true },
      "p2",
      sidebarMarkerId("pinned-header"),
    );
    expect(result.get(sidebarMarkerId("pinned-header"))).toEqual(stationary);
    expect(result.get("p1")).toEqual({ ...stationary, y: 83 });
    expect(result.get(sidebarMarkerId("pinned-divider"))).toEqual(stationary);
    expect(result.get("a1")).toEqual(stationary);
  });

  it.each([
    ["a1", "a2"],
    ["a2", "a1"],
  ])("uses pinned dragging behavior for Active from %s to %s", (active, over) => {
    const items = [
      pinnedHeader,
      thread("p", "pinned"),
      divider,
      thread("a1", "active"),
      thread("a2", "active"),
      settledHeader,
      thread("s", "settled"),
    ];
    const strategy = createSidebarSortingStrategy({
      items,
      settledOrder: [],
      settledExpanded: true,
    });
    const args = layout(items, active, over);
    for (let index = 0; index < items.length; index += 1) {
      if (index === args.activeIndex) continue;
      expect(strategy({ ...args, index })).toEqual(verticalListSortingStrategy({ ...args, index }));
    }
  });

  it("preserves settled order while opening the zero-height Active target", () => {
    const items = [
      pinnedHeader,
      divider,
      marker("active-placeholder"),
      settledHeader,
      thread("first", "settled"),
      thread("second", "settled"),
    ];
    const result = preview(
      { items, settledOrder: ["first", "second"], settledExpanded: true },
      "second",
      "first",
    );
    expect(result.get(sidebarMarkerId("active-placeholder"))).toEqual(stationary);
    expect(result.get(sidebarMarkerId("settled-header"))).toEqual({ ...stationary, y: 36 });
    expect(result.get("first")).toEqual({ ...stationary, y: 36 });
    expect(result.get("second")).toEqual(stationary);
  });

  it.each([
    [sidebarMarkerId("pinned-divider"), 0, 0],
    ["a1", -83, 0],
    ["a2", -83, -83],
  ] as const)(
    "opens the active pointer slot over %s without adding an empty pinned row",
    (over, a1Offset, a2Offset) => {
      const items = [
        pinnedHeader,
        thread("p", "pinned"),
        divider,
        thread("a1", "active"),
        thread("a2", "active"),
        settledHeader,
        thread("s", "settled"),
      ];
      const result = preview({ items, settledOrder: [], settledExpanded: true }, "p", over);
      expect(result.get(sidebarMarkerId("pinned-header"))).toEqual(stationary);
      expect(result.get(sidebarMarkerId("pinned-divider"))?.y).toBe(-83);
      expect(result.get("a1")?.y).toBe(a1Offset);
      expect(result.get("a2")?.y).toBe(a2Offset);
      expect(result.get(sidebarMarkerId("settled-header"))?.y).toBe(0);
    },
  );

  it("opens label space below each pinned boundary while dragging", () => {
    const items = [
      pinnedHeader,
      thread("p", "pinned"),
      divider,
      thread("a1", "active"),
      thread("a2", "active"),
      settledHeader,
      thread("s", "settled"),
    ];
    // Reorder inside active: the header gap shifts every row, the divider
    // gap shifts the active rows and the shelf below by a second label.
    const result = preview(
      { items, settledOrder: [], settledExpanded: true, boundaryLabelHeight: 16 },
      "a2",
      "a1",
    );
    expect(result.get(sidebarMarkerId("pinned-header"))).toEqual(stationary);
    expect(result.get("p")?.y).toBe(16);
    expect(result.get(sidebarMarkerId("pinned-divider"))?.y).toBe(16);
    expect(result.get("a2")).toEqual(stationary);
    expect(result.get("a1")?.y).toBe(32 + 83);
    expect(result.get(sidebarMarkerId("settled-header"))?.y).toBe(32);
    expect(result.get("s")?.y).toBe(32);
  });

  it.each(["s1", "missing-target"])(
    "keeps label clearance when a settled drag is over %s",
    (over) => {
      const items = [
        pinnedHeader,
        thread("p", "pinned"),
        divider,
        thread("a", "active"),
        settledHeader,
        thread("s1", "settled"),
        thread("s2", "settled"),
      ];
      const result = preview(
        {
          items,
          settledOrder: ["s1", "s2"],
          settledExpanded: true,
          boundaryLabelHeight: 24,
        },
        "s2",
        over,
      );
      expect(result.get("p")?.y).toBe(24);
      expect(result.get(sidebarMarkerId("pinned-divider"))?.y).toBe(24);
      expect(result.get("a")?.y).toBe(48);
      expect(result.get("s1")?.y).toBe(48);
      expect(result.get("s2")).toEqual(stationary);
    },
  );

  it("stacks the labels with their gaps when the pinned section is empty", () => {
    const items = [
      pinnedHeader,
      divider,
      thread("a1", "active"),
      thread("a2", "active"),
      settledHeader,
      thread("s", "settled"),
    ];
    const result = preview(
      { items, settledOrder: [], settledExpanded: true, boundaryLabelHeight: 16 },
      "a2",
      "a1",
    );
    expect(result.get(sidebarMarkerId("pinned-header"))).toEqual(stationary);
    expect(result.get(sidebarMarkerId("pinned-divider"))?.y).toBe(16);
    expect(result.get("a1")?.y).toBe(32 + 83);
    expect(result.get(sidebarMarkerId("settled-header"))?.y).toBe(32);
  });

  it("scales the label space with the measured root scale", () => {
    const items = [pinnedHeader, thread("p", "pinned"), divider, thread("a1", "active")];
    const result = preview(
      { items, settledOrder: [], settledExpanded: true, boundaryLabelHeight: 16 },
      "a1",
      "p",
      2,
    );
    expect(result.get(sidebarMarkerId("pinned-divider"))?.y).toBe(32 + 165);
  });

  it("keeps the pinned header above the first arriving pin", () => {
    const items = [
      pinnedHeader,
      divider,
      thread("a1", "active"),
      thread("a2", "active"),
      settledHeader,
      thread("s", "settled"),
    ];
    const result = preview(
      { items, settledOrder: [], settledExpanded: true },
      "a2",
      sidebarMarkerId("pinned-header"),
    );
    expect(result.get(sidebarMarkerId("pinned-header"))).toEqual(stationary);
    expect(result.get(sidebarMarkerId("pinned-divider"))?.y).toBe(83);
    expect(result.get("a1")?.y).toBe(83);
    expect(result.get(sidebarMarkerId("settled-header"))?.y).toBe(0);
  });

  it.each([
    ["p", -83, -1],
    ["s", 0, 82],
  ] as const)(
    "replaces the empty Active target when %s enters",
    (active, dividerOffset, settledOffset) => {
      const items = [
        pinnedHeader,
        thread("p", "pinned"),
        divider,
        marker("active-placeholder"),
        settledHeader,
        thread("s", "settled"),
      ];
      const result = preview(
        { items, settledOrder: [], settledExpanded: true },
        active,
        sidebarMarkerId("active-placeholder"),
      );
      expect(result.get(sidebarMarkerId("active-placeholder"))?.scaleY).toBe(0);
      expect(result.get(sidebarMarkerId("pinned-divider"))?.y).toBe(dividerOffset);
      expect(result.get(sidebarMarkerId("settled-header"))?.y).toBe(settledOffset);
    },
  );

  it("uses the canonical settled rank and the destination's slim height", () => {
    const items = [
      pinnedHeader,
      thread("p", "pinned"),
      divider,
      thread("a", "active"),
      settledHeader,
      thread("s1", "settled"),
      thread("s2", "settled"),
    ];
    const result = preview(
      { items, settledOrder: ["s1", "a", "s2"], settledExpanded: true },
      "a",
      "s2",
    );
    expect(result.get(sidebarMarkerId("settled-header"))?.y).toBe(-46);
    expect(result.get("s1")?.y).toBe(-46);
    expect(result.get("s2")?.y).toBe(-9);
  });

  it.each([
    ["a1", 83],
    ["a2", 0],
  ] as const)(
    "reserves a full card at the pointer slot over %s when a slim row enters Active",
    (over, firstOffset) => {
      const items = [
        pinnedHeader,
        thread("p", "pinned"),
        divider,
        thread("a1", "active"),
        thread("a2", "active"),
        settledHeader,
        thread("s", "settled"),
      ];
      const result = preview({ items, settledOrder: [], settledExpanded: true }, "s", over);
      expect(result.get("a1")?.y).toBe(firstOffset);
      expect(result.get("a2")?.y).toBe(83);
      expect(result.get(sidebarMarkerId("settled-header"))?.y).toBe(83);
    },
  );

  it("removes the snoozed header when its last row leaves", () => {
    const items = [
      pinnedHeader,
      thread("p", "pinned"),
      divider,
      thread("a", "active"),
      marker("snoozed-header"),
      thread("z", "snoozed"),
      settledHeader,
      thread("s", "settled"),
    ];
    const result = preview({ items, settledOrder: [], settledExpanded: true }, "z", "a");
    expect(result.get(sidebarMarkerId("snoozed-header"))?.scaleY).toBe(0);
    expect(result.get(sidebarMarkerId("settled-header"))?.y).toBe(13);
    expect(result.get("s")?.y).toBe(13);
  });

  it("keeps a collapsed settled target without inserting a hidden row", () => {
    const items = [
      pinnedHeader,
      thread("p", "pinned"),
      divider,
      thread("a1", "active"),
      thread("a2", "active"),
      settledHeader,
      marker("settled-placeholder"),
    ];
    const result = preview(
      { items, settledOrder: [], settledExpanded: false },
      "a2",
      sidebarMarkerId("settled-placeholder"),
    );
    expect(result.get(sidebarMarkerId("settled-header"))?.y).toBe(-83);
    expect(result.get(sidebarMarkerId("settled-placeholder"))).toEqual({ ...stationary, y: -83 });
  });

  it("preserves a collapsed snoozed header while another section changes", () => {
    const items = [
      pinnedHeader,
      thread("p", "pinned"),
      divider,
      thread("a", "active"),
      marker("snoozed-header"),
      settledHeader,
      marker("settled-placeholder"),
    ];
    const result = preview(
      { items, settledOrder: [], settledExpanded: false },
      "a",
      sidebarMarkerId("settled-placeholder"),
    );
    expect(result.get(sidebarMarkerId("snoozed-header"))).toEqual({ ...stationary, y: -46 });
  });

  it("previews a time-ordered inbox drop at its time slot, above the Working shelf", () => {
    const items = [
      pinnedHeader,
      thread("p", "pinned"),
      divider,
      thread("a1", "active"),
      thread("a2", "active"),
      marker("working-header"),
      thread("w", "working"),
      settledHeader,
      marker("settled-placeholder"),
    ];
    const input = { items, settledOrder: [], settledExpanded: false };
    // By pointer, the unpinned row lands between a1 and a2.
    expect(preview(input, "p", "a1").get("a2")?.y).toBe(0);
    // By time, it lands below a2, and the shelf does not move.
    const byTime = preview({ ...input, activeOrder: ["a1", "a2", "p"] }, "p", "a1");
    expect(byTime.get("a2")?.y).toBe(-83);
    expect(byTime.get(sidebarMarkerId("working-header"))).toEqual(stationary);
    expect(byTime.get("w")).toEqual(stationary);
  });

  it("derives missing card geometry from the measured root scale", () => {
    const items = [
      pinnedHeader,
      divider,
      marker("active-placeholder"),
      settledHeader,
      thread("s", "settled"),
    ];
    const result = preview(
      { items, settledOrder: [], settledExpanded: true },
      "s",
      sidebarMarkerId("pinned-header"),
      0.75,
    );
    expect(result.get(sidebarMarkerId("pinned-header"))).toEqual(stationary);
    expect(result.get(sidebarMarkerId("pinned-divider"))?.y).toBe(62.5);
    expect(result.get(sidebarMarkerId("active-placeholder"))?.y).toBe(62.5);
  });

  it("updates the projection when the target or measured geometry changes", () => {
    const strategy = createSidebarSortingStrategy({
      items: pinned,
      settledOrder: [],
      settledExpanded: true,
    });
    const args = layout(pinned, "p1", "p1");
    expect(strategy({ ...args, index: 2 })?.y).toBe(0);
    expect(strategy({ ...args, index: 2, overIndex: 4 })?.y).toBe(-83);
    const smaller = layout(pinned, "p1", "a1", 0.75);
    expect(strategy({ ...smaller, index: 2 })?.y).toBe(-62.5);
  });

  it.each(["active", "settled"] as const)(
    "reveals the mounted empty %s target when its last row leaves and hides it on return",
    (section) => {
      const items = [
        pinnedHeader,
        thread("p", "pinned"),
        divider,
        marker("active-placeholder"),
        thread("a", "active"),
        settledHeader,
        marker("settled-placeholder"),
        thread("s", "settled"),
      ];
      const active = section === "active" ? "a" : "s";
      const input = { items, settledOrder: ["s"], settledExpanded: true };
      const placeholderId = sidebarMarkerId(`${section}-placeholder`);
      const resting = preview(input, active, active);
      expect(resting.get(placeholderId)?.scaleY).toBe(0);
      const leaving = preview(input, active, sidebarMarkerId("pinned-header"));
      expect(leaving.get(placeholderId)?.scaleY).toBe(1);
      const returning = preview(input, active, active);
      expect(returning.get(placeholderId)?.scaleY).toBe(0);
    },
  );

  it("uses shelf height for empty target sizing when card height differs from its default", () => {
    const items = [
      pinnedHeader,
      thread("p", "pinned"),
      divider,
      thread("a", "active"),
      settledHeader,
      marker("settled-placeholder"),
    ];
    const strategy = createSidebarSortingStrategy({
      items,
      settledOrder: [],
      settledExpanded: false,
    });
    const args = layout(items, "a", sidebarMarkerId("settled-placeholder"), 1, 78);
    expect(strategy({ ...args, index: 4 })?.y).toBe(-42);
  });

  it("keeps the route row visible after a settled drop pushes it beyond the page", () => {
    const items = [
      pinnedHeader,
      thread("p", "pinned"),
      divider,
      thread("a", "active"),
      settledHeader,
      thread("s", "settled"),
    ];
    const input = {
      items,
      settledOrder: ["a", "s", "hidden"],
      settledExpanded: true,
      settledVisibleCount: 1,
    };
    const withRoute = preview({ ...input, routeThreadKey: "s" }, "a", "s");
    const withoutRoute = preview(input, "a", "s");
    expect(withRoute.get("s")).toEqual({ ...stationary, y: -9 });
    expect(withoutRoute.get("s")?.scaleY).toBe(0);
  });

  it("reserves the next page row when a visible settled thread leaves", () => {
    const items = [
      pinnedHeader,
      thread("p", "pinned"),
      divider,
      thread("a", "active"),
      settledHeader,
      thread("s1", "settled"),
      thread("route", "settled"),
    ];
    const result = preview(
      {
        items,
        settledOrder: ["s1", "hidden", "route"],
        settledExpanded: true,
        settledVisibleCount: 1,
        routeThreadKey: "route",
      },
      "s1",
      "a",
    );
    expect(result.get(sidebarMarkerId("settled-header"))?.y).toBe(83);
    expect(result.get("route")?.y).toBe(83);
  });

  it("keeps the dropped route thread visible in a collapsed settled shelf", () => {
    const items = [
      pinnedHeader,
      thread("p", "pinned"),
      divider,
      thread("a", "active"),
      settledHeader,
      marker("settled-placeholder"),
    ];
    const result = preview(
      {
        items,
        settledOrder: ["a", "hidden"],
        settledExpanded: false,
        settledVisibleCount: 1,
        routeThreadKey: "a",
      },
      "a",
      sidebarMarkerId("settled-placeholder"),
    );
    expect(result.get(sidebarMarkerId("settled-placeholder"))?.scaleY).toBe(0);
    expect(result.get(sidebarMarkerId("settled-header"))?.y).toBe(-46);
  });

  it("preserves hidden snoozed membership when the only rendered route row leaves", () => {
    const items = [
      pinnedHeader,
      thread("p", "pinned"),
      divider,
      thread("a", "active"),
      marker("snoozed-header"),
      thread("z", "snoozed"),
      settledHeader,
      thread("s", "settled"),
    ];
    const result = preview(
      {
        items,
        settledOrder: ["s"],
        settledExpanded: true,
        snoozedThreadCount: 2,
      },
      "z",
      "a",
    );
    expect(result.get(sidebarMarkerId("snoozed-header"))).toEqual({ ...stationary, y: 83 });
    expect(result.get(sidebarMarkerId("settled-header"))?.y).toBe(46);
  });
});

describe("lifted card clearance", () => {
  const rect = (top: number, height: number) => ({
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 260,
    width: 260,
  });
  const apply = (cardTop: number, cardHeight: number, y: number, listTop = 136, offset = 32) =>
    restrictBelowSidebarLabel(
      {
        transform: { ...stationary, y },
        containerNodeRect: rect(listTop, 500),
        draggingNodeRect: rect(cardTop, cardHeight),
        activatorEvent: null,
        active: null,
        activeNodeRect: null,
        over: null,
        overlayNodeRect: null,
        scrollableAncestors: [],
        scrollableAncestorRects: [],
        windowRect: null,
      },
      offset,
    );

  it.each([36, 82])("keeps a %ipx row below empty Pins even past the top edge", (height) => {
    for (const pointerY of [150, 136, 100, 0]) {
      const transform = apply(511, height, pointerY - 529);
      expect(511 + transform.y).toBe(168);
    }
  });

  it("preserves pointer movement below the label", () => {
    expect(apply(511, 36, -200).y).toBe(-200);
  });

  it("follows the list when it scrolls and includes content preceding Pins", () => {
    expect(511 + apply(511, 36, -500, 96).y).toBe(128);
    expect(511 + apply(511, 36, -500, 136, 114).y).toBe(250);
  });
});

describe("custom sections during a drag", () => {
  const focus = customSidebarSection("focus");
  const customHeader: SidebarListItem = {
    kind: "marker",
    marker: "custom-header",
    sectionId: "focus",
    collapsed: false,
  };
  const items: SidebarListItem[] = [
    pinnedHeader,
    divider,
    thread("a", "active"),
    thread("source", "active"),
    customHeader,
    thread("c1", focus),
    thread("c2", focus),
    settledHeader,
  ];

  it("a row from below over a collapsed section's header previews it at that section's top", () => {
    const collapsed: SidebarListItem = { ...customHeader, collapsed: true };
    // Collapsed Focus still shows the open thread c2.
    const rows: SidebarListItem[] = [
      pinnedHeader,
      divider,
      thread("a", "active"),
      collapsed,
      thread("c2", focus),
      settledHeader,
      marker("settled-placeholder"),
      thread("s", "settled"),
    ];
    const transforms = preview(
      { items: rows, settledOrder: ["s"], settledExpanded: true },
      "s",
      sidebarListItemId(collapsed),
    );
    // The header stays put (Active does not grow); the open row opens the slot above it.
    expect(transforms.get(sidebarListItemId(collapsed))).toMatchObject({ y: 0 });
    expect(transforms.get("c2")?.y).toBeGreaterThan(0);
  });

  it("reordering inside Active neither throws nor moves the custom block", () => {
    const transforms = preview({ items, settledOrder: [], settledExpanded: false }, "source", "a");
    for (const id of [sidebarListItemId(customHeader), "c1", "c2"]) {
      expect(transforms.get(id)).toMatchObject({ y: 0, scaleY: 1 });
    }
  });

  it.each([0, 200])(
    "keeps the custom block below the Queue drop zone that sits above it (shelf margin %i)",
    (shelfMargin) => {
      const strategy = createSidebarSortingStrategy({
        items,
        settledOrder: [],
        settledExpanded: false,
      });
      const header = items.indexOf(customHeader);
      const measure = (queue: number) => {
        const args = layout(items, "source", "a");
        // The Queue renders between Active and the first custom header, outside the sortable list.
        for (const [index, rect] of args.rects.entries()) {
          const shift =
            index < header ? 0 : queue + (items[index] === settledHeader ? shelfMargin : 0);
          rect.top += shift;
          rect.bottom += shift;
        }
        return (item: SidebarListItem) => strategy({ ...args, index: items.indexOf(item) });
      };
      const withQueue = measure(120);
      for (const item of [customHeader, items[header + 1]!, items[header + 2]!]) {
        expect(withQueue(item)).toMatchObject({ y: 0 });
      }
      // The shelves move exactly as they would with no Queue in the way.
      expect(withQueue(settledHeader)).toEqual(measure(0)(settledHeader));
    },
  );

  it("a Queue with entries above the custom sections moves with them, not with the shelves", () => {
    // Sections and Queue entries: the Queue renders above the first custom header, not docked.
    const placement = sidebarQueuePlacement({
      sectionCount: 1,
      entryCount: 2,
      dropShown: false,
      listScrolls: false,
      liftedFromShelf: false,
    });
    const strategy = createSidebarSortingStrategy({
      items,
      settledOrder: [],
      settledExpanded: false,
      queueBoundary: sidebarQueueBoundary(placement),
    });
    const header = items.indexOf(customHeader);
    const args = layout(items, "c1", "a");
    for (const [index, rect] of args.rects.entries()) {
      if (index < header) continue;
      rect.top += 120;
      rect.bottom += 120;
    }
    // c1 lifted into Active: the custom block moves down a card, the shelves do not move.
    const customShift = strategy({ ...args, index: header })?.y;
    expect(customShift).toBe(82 + 1);
    expect(strategy({ ...args, index: items.indexOf(settledHeader) })?.y).toBe(0);
    expect(afterRowsShift(strategy, items, args, QUEUE_DROP_ID)).toBe(customShift);
  });

  it("lifting a custom row into Active closes its slot and moves the block as one", () => {
    const transforms = preview({ items, settledOrder: [], settledExpanded: false }, "c1", "a");
    // The lifted card joins Active above the block, so the header shifts down by one card...
    const card = 82 + 1;
    expect(transforms.get(sidebarListItemId(customHeader))).toMatchObject({ y: card, scaleY: 1 });
    // ...and c2, a card like the lifted row, closes up behind it by exactly that much.
    expect(transforms.get("c2")).toMatchObject({ y: 0, scaleY: 1 });
  });

  it("sizes the lifted row from a custom card when Pinned and Active have none", () => {
    const onlyCustom: SidebarListItem[] = [
      pinnedHeader,
      divider,
      marker("active-placeholder"),
      customHeader,
      thread("c1", focus),
      thread("c2", focus),
      settledHeader,
    ];
    const strategy = createSidebarSortingStrategy({
      items: onlyCustom,
      settledOrder: [],
      settledExpanded: false,
    });
    // Measured cards are 90px here; the default would be 82.
    const args = layout(onlyCustom, "c1", sidebarMarkerId("active-placeholder"), 1, 90);
    const header = onlyCustom.indexOf(customHeader);
    expect(strategy({ ...args, index: header })).toMatchObject({ y: 90 });
  });

  it("a pointer over a custom section never resolves to an Active target", () => {
    const { rects, activeIndex } = layout(items, "source", "a");
    const sourceRect = rects[activeIndex]!;
    const rectOf = (item: SidebarListItem) => rects[items.indexOf(item)]!;
    const nodes = new Map<SidebarListItem, HTMLElement>([
      [
        divider,
        {
          querySelector: () => ({
            getBoundingClientRect: () => ({
              ...rectOf(divider),
              top: rectOf(divider).top,
              bottom: rectOf(divider).top + 16,
            }),
          }),
        } as unknown as HTMLElement,
      ],
      [
        customHeader,
        { getBoundingClientRect: () => rectOf(customHeader) } as unknown as HTMLElement,
      ],
      [
        settledHeader,
        { getBoundingClientRect: () => rectOf(settledHeader) } as unknown as HTMLElement,
      ],
    ]);
    const detector = createSidebarCollisionDetection(() => true, {
      items,
      activationY: sourceRect.top + sourceRect.height / 2,
    });
    const at = (y: number) => {
      const collisionRect = {
        ...sourceRect,
        top: y - sourceRect.height / 2,
        bottom: y + sourceRect.height / 2,
      };
      const over = detector({
        active: {
          id: "source",
          data: { current: {} },
          rect: { current: { initial: sourceRect, translated: collisionRect } },
        },
        collisionRect,
        pointerCoordinates: { x: 130, y },
        droppableRects: new Map(
          items.map((item, index) => [sidebarListItemId(item), rects[index]!]),
        ),
        droppableContainers: items.map((item, index) => ({
          id: sidebarListItemId(item),
          key: sidebarListItemId(item),
          disabled: false,
          data: { current: {} },
          node: { current: nodes.get(item) ?? null },
          rect: { current: rects[index]! },
        })),
      })[0];
      return over
        ? (resolveSidebarDropTarget(items, "source", String(over.id))?.section ?? null)
        : null;
    };
    // Control arm: the detector can still report an Active hit (y 150 sits on row "a",
    // below the divider label, so the Pinned switch does not fire).
    expect(at(150)).toBe("active");
    // Over the first custom row (301..383): never Active. The old bound (the Settled header at
    // 467) re-ranks this pointer onto an Active-resolving candidate.
    expect(at(356)).not.toBe("active");
    expect(at(356)).toBe(customSidebarSection("focus"));
    // A custom header whose node is missing (a transient list/DOM mismatch) must not hand the
    // bound to a lower header: that is the same wrong bound.
    nodes.delete(customHeader);
    expect(at(356)).not.toBe("active");
  });
});

describe("custom destinations, the empty-shelf hint, and a still preview over a zone", () => {
  const CARD = 82;
  const SLIM = 36;
  /** The app's Pins boundary label height (SIDEBAR_DRAG_LABEL_HEIGHT). */
  const LABEL = 24;
  /** The Pins labels open at pickup, a behaviour that predates these drop targets: every row
      below them moves down by this much unless the shelves' free space absorbs it. The tests
      below assert pickup net of it. */
  const LABELS_SHIFT = sidebarDragLabelsShift(LABEL);
  type Rect = ReturnType<typeof rect>;
  const rect = (top: number, height: number) => ({
    top,
    height,
    bottom: top + height,
    left: 0,
    right: 260,
    width: 260,
  });
  const zero = (item: SidebarListItem) =>
    item.kind === "marker" &&
    (item.marker === "pinned-header" ||
      item.marker === "pinned-divider" ||
      item.marker.endsWith("placeholder"));
  const height = (item: SidebarListItem) =>
    item.kind === "thread"
      ? item.section === "settled" || item.section === "snoozed"
        ? SLIM
        : CARD
      : zero(item)
        ? 0
        : 32;
  const isShelf = (item: SidebarListItem) =>
    item.kind === "marker" &&
    (item.marker === "working-header" ||
      item.marker === "snoozed-header" ||
      item.marker === "snoozed-placeholder" ||
      item.marker === "settled-header");
  const PLACEHOLDER = sidebarMarkerId("snoozed-placeholder");
  const isPlaceholder = (item: SidebarListItem) => sidebarListItemId(item) === PLACEHOLDER;
  /** Geometry as the DOM lays it out: gap-px, -mb-px on zero-height markers, the free space above
      the first shelf, and the placeholder measured as its 36px hint box above its li.
      - `queueBefore`: the Queue's 32px header renders in the flow before that item (the list
        length: after every row). With `queueShares` it carries its own auto margin (`collapse`)
        and takes half the free space above it.
      - `hintAtEnd`: the placeholder's box renders out of flow below the last row. */
  function layoutOf(
    items: readonly SidebarListItem[],
    bottom: number,
    options: {
      queueBefore?: number;
      queueShares?: boolean;
      /** The whole Queue block: its header alone, or header and rows. */
      queueHeight?: number;
      /** The disabled "Show N more" li after the last row. */
      trailing?: number;
      hintAtEnd?: boolean;
    } = {},
  ): { rects: Rect[]; queue: Rect | undefined; trailing: Rect | undefined } {
    const queueHeight = options.queueHeight ?? 32;
    let top = 100;
    let queueTop: number | undefined;
    let trailingTop: number | undefined;
    const tops = items.map((item, index) => {
      if (index === options.queueBefore) {
        queueTop = top;
        top += queueHeight + 1;
      }
      const at = top;
      top += height(item) + (zero(item) ? 0 : 1);
      return at;
    });
    if (options.trailing !== undefined) {
      trailingTop = top;
      top += options.trailing + 1;
    }
    if (options.queueBefore === items.length) {
      queueTop = top;
      top += queueHeight + 1;
    }
    const first = items.findIndex(isShelf);
    const free = Math.max(0, bottom - (top - 1));
    const rects = items.map((item, index) => {
      const at = tops[index]! + (first !== -1 && index >= first ? free : 0);
      return isPlaceholder(item) ? rect(at - SLIM, SLIM) : rect(at, height(item));
    });
    const queue =
      queueTop === undefined
        ? undefined
        : rect(
            queueTop + (options.queueBefore! > first ? free : options.queueShares ? free / 2 : 0),
            queueHeight,
          );
    const trailing =
      trailingTop === undefined ? undefined : rect(trailingTop + free, options.trailing!);
    if (options.hintAtEnd) {
      const p = items.findIndex(isPlaceholder);
      const last = Math.max(
        queue?.bottom ?? 0,
        trailing?.bottom ?? 0,
        ...rects.filter((_, index) => index !== p).map((r) => r.bottom),
      );
      rects[p] = rect(last + 1, SLIM);
    }
    return { rects, queue, trailing };
  }
  const restLayout = (items: readonly SidebarListItem[], bottom: number) =>
    layoutOf(items, bottom).rects;
  /** Painted top per id (null when hidden) for one strategy, lifted row and over. */
  function painted(
    input: Parameters<typeof createSidebarSortingStrategy>[0],
    active: string,
    over: string,
    rects = restLayout(input.items, 900),
  ) {
    const strategy = createSidebarSortingStrategy(input);
    const ids = input.items.map(sidebarListItemId);
    const activeIndex = ids.indexOf(active);
    return (id: string) => {
      const index = ids.indexOf(id);
      const transform = strategy({
        rects,
        activeIndex,
        overIndex: ids.indexOf(over),
        index,
        activeNodeRect: rects[activeIndex]!,
      });
      return transform?.scaleY === 0 ? null : rects[index]!.top + (transform?.y ?? 0);
    };
  }
  const list = (
    snoozed: { readonly total: number; readonly visible: readonly string[] },
    options: { working?: boolean; custom?: boolean; settled?: string[] } = {},
  ) =>
    buildSidebarListItems({
      pinned: [],
      active: ["a1", "a2"],
      working: options.working ? { total: 1, visible: ["w1"] } : { total: 0, visible: [] },
      snoozed,
      settled: {
        total: (options.settled ?? ["s1"]).length,
        visible: options.settled ?? ["s1"],
      },
      custom:
        options.custom === false ? [] : [{ id: "focus", visible: ["f1", "f2"], collapsed: false }],
    });
  const items = list({ total: 0, visible: [] });
  const base = {
    items,
    settledOrder: ["s1"],
    settledExpanded: true,
    cardHeight: CARD,
    slimHeight: SLIM,
    boundaryLabelHeight: LABEL,
  };
  const SETTLED = sidebarMarkerId("settled-header");
  const HEADER = customSectionHeaderId("focus");
  const snooze = (stickyOverId: string | null, hint: SidebarSnoozeHint = "in-place") => ({
    snooze: { zoneIds: new Set([PLACEHOLDER]), hint },
    stickyOverId,
  });
  /** The one hint decision, from the placeholder's resting box and what renders above its li. */
  const hintFor = (
    entries: readonly SidebarListItem[],
    rects: readonly Rect[],
    queue?: Rect,
    labelsShift = LABELS_SHIFT,
  ) => {
    const p = entries.findIndex(isPlaceholder);
    return sidebarSnoozeHintState({
      snoozeAllowed: true,
      hint: rects[p],
      above: queue ?? rects[p - 1],
      labelsShift,
    });
  };
  /** Rects never overlap (touching edges do not count). */
  const disjoint = (a: { top: number; bottom: number }, b: { top: number; bottom: number }) =>
    a.bottom <= b.top || b.bottom <= a.top;
  const allIds = items.map(sidebarListItemId);

  function expectStillAtPickup(
    entries: readonly SidebarListItem[],
    rest: readonly Rect[],
    pickup: (id: string) => number | null,
    lifted: string,
    shelvesAbsorb: boolean,
    labels = LABELS_SHIFT,
  ) {
    const firstShelf = entries.findIndex(isShelf);
    for (const [index, item] of entries.entries()) {
      const id = sidebarListItemId(item);
      // The lifted row travels as the overlay; its own node stays where it was measured.
      if (zero(item) || id === lifted) continue;
      const shift = shelvesAbsorb && index >= firstShelf ? 0 : labels;
      expect([id, pickup(id)]).toEqual([id, rest[index]!.top + shift]);
    }
  }
  /** The real detector with every snooze zone a pointer zone, no DOM nodes (rect containment). */
  function overAt(
    entries: readonly SidebarListItem[],
    rects: readonly Rect[],
    activeKey: string,
    y: number,
  ) {
    const ids = entries.map(sidebarListItemId);
    const source = rects[ids.indexOf(activeKey)] ?? rect(y - SLIM / 2, SLIM);
    const collisionRect = { ...source, top: y - SLIM / 2, bottom: y + SLIM / 2 };
    const detector = createSidebarCollisionDetection(
      (id) => resolveSidebarDropTarget(entries, activeKey, id) !== null,
      { pointerDropIds: sidebarSnoozeZoneIds(entries, activeKey) },
    );
    const over = detector({
      active: {
        id: activeKey,
        data: { current: {} },
        rect: { current: { initial: source, translated: collisionRect } },
      },
      collisionRect,
      pointerCoordinates: { x: 130, y },
      droppableRects: new Map(ids.map((id, index) => [id, rects[index]!])),
      droppableContainers: ids.map((id, index) => ({
        id,
        key: id,
        disabled: false,
        data: { current: {} },
        node: { current: null },
        rect: { current: rects[index]! },
      })),
    })[0];
    return over === undefined ? null : String(over.id);
  }

  it("opens a slot inside a custom section where the row will land", () => {
    const amongRows = painted(base, "a1", "f1");
    expect(amongRows("f2")! - amongRows("f1")!).toBe(2 * (CARD + 1));
    const onHeader = painted(base, "a1", HEADER);
    expect(onHeader("f1")! - onHeader(HEADER)!).toBe(32 + 1 + CARD + 1);
  });

  it("draws the empty-shelf hint right above Settled while the row may be snoozed, else nothing", () => {
    const open = painted({ ...base, ...snooze("a1") }, "a1", "a1");
    expect(open(SETTLED)! - open(PLACEHOLDER)!).toBe(SLIM + 1);
    expect(open("s1")! + SLIM).toBe(900); // the shelves stay at the bottom
    const closed = painted(base, "a1", "a1");
    expect(closed(PLACEHOLDER)).toBeNull();
    expect(closed("s1")! + SLIM).toBe(900);
  });

  it("a row that may not be snoozed gets no hint, however roomy the list", () => {
    const p = items.findIndex(isPlaceholder);
    const rest = restLayout(items, 900);
    const roomy = { hint: rest[p], above: rest[p - 1], labelsShift: LABELS_SHIFT };
    const allowed = (activeSection: SidebarSection, canOperate = true) =>
      sidebarSnoozeDropAllowed({
        drag: { activeKey: "x", activeSection, fromQueue: false, queuedDraft: false },
        supportsSnooze: true,
        canSnooze: true,
        canOperate,
      });
    expect(sidebarSnoozeHintState({ snoozeAllowed: allowed("active"), ...roomy })).toBe("in-place");
    // A Working row, or one this connection cannot operate: no hint is painted or hit.
    expect(sidebarSnoozeHintState({ snoozeAllowed: allowed("working"), ...roomy })).toBe("closed");
    expect(sidebarSnoozeHintState({ snoozeAllowed: allowed("active", false), ...roomy })).toBe(
      "closed",
    );
  });

  it("over a snooze zone the preview stays as it was over the last other target", () => {
    const viaZone = painted({ ...base, ...snooze("f1") }, "a1", PLACEHOLDER);
    const overF1 = painted({ ...base, ...snooze("f1") }, "a1", "f1");
    for (const id of allIds) expect(viaZone(id)).toBe(overF1(id));
    // No other over yet: as over the source.
    const fresh = painted({ ...base, ...snooze(null) }, "a1", PLACEHOLDER);
    const overSource = painted({ ...base, ...snooze(null) }, "a1", "a1");
    for (const id of allIds) expect(fresh(id)).toBe(overSource(id));
  });

  it("the placeholder adds nothing above the shelves at pickup, net of the Pins labels", () => {
    const rest = restLayout(items, 900);
    expect(hintFor(items, rest)).toBe("in-place");
    expectStillAtPickup(items, rest, painted({ ...base, ...snooze("a1") }, "a1", "a1"), "a1", true);
  });

  it("free space too small for a hint still lets the shelves absorb what it can", () => {
    // A refused row (no snooze): 20px of slack and labels of one gap each. The shelf margin ends at
    // the placeholder's li, not at its taller hint box.
    const bottom = restLayout(items, 0).at(-1)!.bottom + 20;
    const rest = restLayout(items, bottom);
    expectStillAtPickup(
      items,
      rest,
      painted({ ...base, boundaryLabelHeight: 0 }, "s1", "s1", rest),
      "s1",
      true,
      2,
    );
  });

  it("the hint box does not set the shelf scale: it opens 36px tall with no slim row measured", () => {
    const noSlim = buildSidebarListItems({
      pinned: [],
      active: ["a1", "a2"],
      working: { total: 0, visible: [] },
      snoozed: { total: 0, visible: [] },
      settled: { total: 0, visible: [] },
      custom: [],
    });
    const open = painted(
      { items: noSlim, settledOrder: [], settledExpanded: true, ...snooze("a1") },
      "a1",
      "a1",
    );
    expect(open(SETTLED)! - open(PLACEHOLDER)!).toBe(SLIM + 1);
  });

  it.each([
    ["Snoozed", "z1", { total: 2, visible: ["z1", "z2"] }],
    ["Settled", "s2", { total: 2, visible: ["z1", "z2"] }],
    ["Settled, with the Snoozed shelf empty", "s2", { total: 0, visible: [] }],
  ] as const)(
    "with sections, an empty Queue and a scrolling list, a row lifted from %s moves nothing at pickup, net of the Pins labels",
    (_, source, snoozed) => {
      const entries = list(snoozed, { settled: ["s1", "s2", "s3"] });
      const placement = sidebarQueuePlacement({
        sectionCount: 1,
        entryCount: 0,
        dropShown: true,
        listScrolls: true,
        liftedFromShelf: true,
      });
      // Where Sidebar.tsx renders the Queue header for this placement.
      const queueBefore = placement.belowShelves
        ? entries.length
        : entries.findIndex(
            (item) =>
              isShelf(item) ||
              (!placement.docksWithShelves &&
                item.kind === "marker" &&
                item.marker === "custom-header"),
          );
      const viewportBottom = 300; // the content runs past it: the list scrolls, no free space
      const rest = restLayout(entries, viewportBottom);
      expect(rest.at(-1)!.bottom).toBeGreaterThan(viewportBottom);
      const shelfEmpty = snoozed.total === 0;
      const hint = shelfEmpty ? hintFor(entries, rest) : "closed";
      const pickupLayout = layoutOf(entries, viewportBottom, {
        queueBefore,
        hintAtEnd: hint === "at-end",
      });
      const pickupRects = pickupLayout.rects;
      const queue = pickupLayout.queue!;
      const lastRowBottom = Math.max(
        ...pickupRects.filter((_, index) => !isPlaceholder(entries[index]!)).map((r) => r.bottom),
      );
      const pickup = painted(
        {
          items: entries,
          settledOrder: ["s1", "s2", "s3"],
          settledExpanded: true,
          cardHeight: CARD,
          slimHeight: SLIM,
          boundaryLabelHeight: LABEL,
          ...(placement.belowShelves
            ? { trailingHeight: queue.bottom - lastRowBottom }
            : { dockedQueueHeight: 32 }),
          snoozedThreadCount: snoozed.total,
          // A snoozed row may not be snoozed again; a settled one may.
          ...(source === "z1"
            ? {}
            : {
                snooze: { zoneIds: new Set(sidebarSnoozeZoneIds(entries, source)), hint },
                stickyOverId: source,
              }),
        },
        source,
        source,
        pickupRects,
      );
      // A snoozed row over itself resolves to no target, so nothing previews: no labels either.
      const shift = source === "z1" ? 0 : LABELS_SHIFT;
      expectStillAtPickup(entries, rest, pickup, source, false, shift);
      // The Queue block after every row moves by the same label shift, so no
      // row and not the end target paints over it.
      expect(placement.belowShelves).toBe(true);
      const queuePainted = rect(queue.top + shift, queue.height);
      for (const item of entries) {
        const id = sidebarListItemId(item);
        if (id === source || (zero(item) && !isPlaceholder(item))) continue;
        const top = pickup(id);
        if (top === null) continue;
        const box = rect(top, isPlaceholder(item) ? SLIM : height(item));
        expect([id, disjoint(box, queuePainted)]).toEqual([id, true]);
      }
      if (shelfEmpty) {
        expect(hint).toBe("at-end");
        // The target is painted, below every row.
        const end = pickup(PLACEHOLDER)!;
        for (const id of entries.filter((item) => !zero(item)).map(sidebarListItemId)) {
          expect(end).toBeGreaterThan(pickup(id)!);
        }
      }
    },
  );

  it("Settled to an empty Snoozed shelf in a scrolling list snoozes at the end target", () => {
    const entries = list({ total: 0, visible: [] }, { settled: ["s1", "s2", "s3"] });
    const rest = restLayout(entries, 300);
    expect(hintFor(entries, rest)).toBe("at-end");
    const rects = layoutOf(entries, 300, { hintAtEnd: true }).rects;
    const end = rects[entries.findIndex(isPlaceholder)]!;
    const over = overAt(entries, rects, "s2", end.top + SLIM / 2);
    expect(over).toBe(PLACEHOLDER);
    const drag = {
      activeKey: "s2",
      activeSection: "settled",
      fromQueue: false,
      queuedDraft: false,
    } as const;
    expect(
      routeSidebarDragEnd({
        drag,
        overId: over,
        items: entries,
        queuedKeys: new Set(),
        queueDropId: "queue",
        snoozeAllowed: true,
      }),
    ).toEqual({ kind: "snooze" });
  });

  it.each([
    ["Settled", false],
    ["the Queue", true],
  ] as const)(
    "with Working shown, %s to an empty Snoozed shelf snoozes at the end target, and nothing moves",
    (_, fromQueue) => {
      const entries = list({ total: 0, visible: [] }, { working: true });
      // A roomy list: the free space sits above the Working header, not above the placeholder.
      const rest = restLayout(entries, 1200);
      expect(hintFor(entries, rest)).toBe("at-end");
      const rects = layoutOf(entries, 1200, { hintAtEnd: true }).rects;
      const end = rects[entries.findIndex(isPlaceholder)]!;
      const drag = fromQueue
        ? ({
            activeKey: "q",
            activeSection: "active",
            fromQueue: true,
            queuedDraft: false,
          } as const)
        : ({
            activeKey: "s1",
            activeSection: "settled",
            fromQueue: false,
            queuedDraft: false,
          } as const);
      const dragItems = sidebarDragListItems(entries, drag);
      const over = overAt(entries, rects, drag.activeKey, end.top + SLIM / 2);
      expect(over).toBe(PLACEHOLDER);
      expect(
        routeSidebarDragEnd({
          drag,
          overId: over,
          items: dragItems,
          queuedKeys: new Set(fromQueue ? ["q"] : []),
          queueDropId: "queue",
          snoozeAllowed: true,
        }),
      ).toEqual({ kind: "snooze" });
      if (!fromQueue) {
        // A Queue drag never projects; a Settled one must leave every row where it rested.
        expectStillAtPickup(
          entries,
          rest,
          painted({ ...base, items: entries, ...snooze("s1", "at-end") }, "s1", "s1", rects),
          "s1",
          true,
        );
      }
    },
  );

  it.each([33, 60, 90, 106, 250])(
    "the hint never overlaps a docked Queue header (%ipx of free space)",
    (slack) => {
      // The Queue header docks before the placeholder and shares the free space (collapse).
      const bottom = restLayout(items, 0).at(-1)!.bottom + slack;
      const docked = layoutOf(items, bottom, {
        queueBefore: items.findIndex(isPlaceholder),
        queueShares: true,
      });
      const queue = docked.queue!;
      const hint = hintFor(items, docked.rects, queue);
      if (slack === 250) expect(hint).toBe("in-place"); // the rule can still open in place
      const rects =
        hint === "at-end"
          ? layoutOf(items, bottom, {
              queueBefore: items.findIndex(isPlaceholder),
              queueShares: true,
              hintAtEnd: true,
            }).rects
          : docked.rects;
      const at = painted(
        { ...base, dockedQueueHeight: 32, ...snooze("a1", hint) },
        "a1",
        "a1",
        rects,
      );
      const top = at(PLACEHOLDER)!;
      expect(top + SLIM <= queue.top || top >= queue.bottom).toBe(true);
      // The header's height is not free space: the shelves start at least a header below the
      // last row, wherever the grown rows end.
      expect(at(SETTLED)! - (at("f2")! + CARD)).toBeGreaterThanOrEqual(32 + 1);
      if (hint === "in-place") expect(at(SETTLED)! - top).toBe(SLIM + 1);
      // With room for the labels beside the header, the shelves stay where they rested.
      if (slack - 33 >= LABELS_SHIFT) expect(at("s1")).toBe(rects[allIds.indexOf("s1")]!.top);
    },
  );

  it.each([38, 50, 60, 70, 86, 87, 90])(
    "with %ipx of free space and no Queue, the hint moves no shelf row beyond what the labels already do",
    (slack) => {
      const entries = list({ total: 0, visible: [] }, { settled: ["s1", "s2", "s3"] });
      const bottom = restLayout(entries, 0).at(-1)!.bottom + slack;
      const rest = restLayout(entries, bottom);
      const hint = hintFor(entries, rest);
      const rects = hint === "at-end" ? layoutOf(entries, bottom, { hintAtEnd: true }).rects : rest;
      const input = {
        items: entries,
        settledOrder: ["s1", "s2", "s3"],
        settledExpanded: true,
        cardHeight: CARD,
        slimHeight: SLIM,
        boundaryLabelHeight: LABEL,
      };
      // Pre-C baseline: the same pickup with no hint at all (the labels' own shift).
      const before = painted(input, "s2", "s2", rest);
      const after = painted(
        { ...input, snooze: { zoneIds: new Set([PLACEHOLDER]), hint }, stickyOverId: "s2" },
        "s2",
        "s2",
        rects,
      );
      for (const id of [SETTLED, "s1", "s3"]) expect([id, after(id)]).toEqual([id, before(id)]);
      expect(hint).toBe(slack >= 37 + LABELS_SHIFT ? "in-place" : "at-end");
    },
  );

  it.each([
    ["the whole block", true],
    ["only its header (the old contract)", false],
  ] as const)(
    "a non-empty docked Queue block: measured as %s, the hint stays clear of its rows",
    (_, wholeBlock) => {
      // No sections and a scrolling list: B docks the full Queue block (header and 3 rows) right
      // above the first shelf, in the flow.
      const entries = list(
        { total: 0, visible: [] },
        { custom: false, settled: ["s1", "s2", "s3"] },
      );
      const block = 32 + 3 * (36 + 1);
      const placeholder = entries.findIndex(isPlaceholder);
      const docked = layoutOf(entries, 300, { queueBefore: placeholder, queueHeight: block });
      const queue = docked.queue!;
      const measured = wholeBlock ? queue : rect(queue.top, 32);
      const hint = hintFor(entries, docked.rects, measured);
      const rects =
        hint === "at-end"
          ? layoutOf(entries, 300, {
              queueBefore: placeholder,
              queueHeight: block,
              hintAtEnd: true,
            }).rects
          : docked.rects;
      const at = painted(
        {
          ...base,
          items: entries,
          settledOrder: ["s1", "s2", "s3"],
          dockedQueueHeight: measured.height,
          ...snooze("a1", hint),
        },
        "a1",
        "a1",
        rects,
      );
      const top = at(PLACEHOLDER)!;
      if (wholeBlock) {
        expect(disjoint(rect(top, SLIM), queue)).toBe(true);
        // The shelves never paint under the block either.
        expect(at(SETTLED)!).toBeGreaterThanOrEqual(queue.bottom + 1);
      } else {
        // The header alone hides the block's rows from the rule: the hint lands on them.
        expect(disjoint(rect(top, SLIM), queue)).toBe(false);
      }
    },
  );

  it("with Working shown and a Show-more row, the end target sits below that row", () => {
    const entries = list({ total: 0, visible: [] }, { working: true });
    const rest = layoutOf(entries, 1200, { trailing: SLIM });
    expect(hintFor(entries, rest.rects)).toBe("at-end");
    const end = layoutOf(entries, 1200, { trailing: SLIM, hintAtEnd: true });
    const showMore = end.trailing!;
    const lastRowBottom = Math.max(
      ...end.rects.filter((_, index) => !isPlaceholder(entries[index]!)).map((r) => r.bottom),
    );
    const at = painted(
      {
        ...base,
        items: entries,
        trailingHeight: showMore.bottom - lastRowBottom,
        ...snooze("s1", "at-end"),
      },
      "s1",
      "s1",
      end.rects,
    );
    // The shelves absorb the labels here, so the Show-more row stays where it rested.
    expect(at(SETTLED)).toBe(
      end.rects[entries.findIndex((item) => sidebarListItemId(item) === SETTLED)]!.top,
    );
    expect(disjoint(rect(at(PLACEHOLDER)!, SLIM), showMore)).toBe(true);
  });

  it("in a crowded list the hint goes to the end, clear of every painted row, for any over", () => {
    const crowded = restLayout(items, 300);
    expect(hintFor(items, crowded)).toBe("at-end");
    const rects = layoutOf(items, 300, { hintAtEnd: true }).rects;
    const visible = items.filter((item) => !zero(item)).map(sidebarListItemId);
    for (const over of ["a2", "f2", HEADER, "a1"]) {
      const at = painted({ ...base, ...snooze(over, "at-end") }, "a1", over, rects);
      const hint = at(PLACEHOLDER)!;
      for (const id of visible) {
        if (id === "a1") continue; // the lifted row travels as the overlay
        const top = at(id)!;
        const bottom = top + height(items[allIds.indexOf(id)]!);
        expect([over, id, hint + SLIM <= top || hint >= bottom]).toEqual([over, id, true]);
      }
    }
  });

  it("content after the rows moves by the projected end of the flow, also when the lifted row is the last row", () => {
    // Sections, an empty Queue and a scrolling list: the Queue goes after every row, the empty
    // shelf's target after it. s3, the last row, is lifted into Active.
    const entries = list({ total: 0, visible: [] }, { settled: ["s1", "s2", "s3"] });
    const placement = sidebarQueuePlacement({
      sectionCount: 1,
      entryCount: 0,
      dropShown: true,
      listScrolls: true,
      liftedFromShelf: true,
    });
    expect(placement.belowShelves).toBe(true);
    expect(hintFor(entries, restLayout(entries, 300))).toBe("at-end");
    const pickup = layoutOf(entries, 300, {
      queueBefore: entries.length,
      hintAtEnd: true,
    });
    const queue = pickup.queue!;
    const ids = entries.map(sidebarListItemId);
    const lastRowBottom = Math.max(
      ...pickup.rects.filter((_, index) => !isPlaceholder(entries[index]!)).map((r) => r.bottom),
    );
    const input = {
      ...base,
      items: entries,
      settledOrder: ["s1", "s2", "s3"],
      trailingHeight: queue.bottom - lastRowBottom,
      queueBoundary: sidebarQueueBoundary(placement),
      snooze: {
        zoneIds: new Set(sidebarSnoozeZoneIds(entries, "s3")),
        hint: "at-end" as const,
      },
      stickyOverId: "a2",
    };
    const layout = {
      rects: pickup.rects,
      activeIndex: ids.indexOf("s3"),
      overIndex: ids.indexOf("a2"),
    };
    expect(sidebarQueueBoundary(placement)).toBe("trailing");
    const shift = afterRowsShift(
      createSidebarSortingStrategy(input),
      entries,
      layout,
      QUEUE_DROP_ID,
    );
    const at = painted(input, "s3", "a2", pickup.rects);
    const rowBottoms = entries.flatMap((item) => {
      const id = sidebarListItemId(item);
      const top = at(id);
      return id === "s3" || zero(item) || top === null ? [] : [top + height(item)];
    });
    const moved = rect(queue.top + shift, queue.height);
    // The Queue abuts the last painted row, and the end target sits right below it.
    expect(moved.top).toBe(Math.max(...rowBottoms) + 1);
    expect(at(PLACEHOLDER)).toBe(moved.bottom + 1);
    // The old rule, the last remaining row's own offset, leaves the Queue under the end target.
    const s2Delta = at("s2")! - pickup.rects[ids.indexOf("s2")]!.top;
    expect(s2Delta).not.toBe(shift);
    expect(disjoint(rect(queue.top + s2Delta, queue.height), rect(at(PLACEHOLDER)!, SLIM))).toBe(
      false,
    );
    // Over a snooze zone (the end target) the shift is the sticky over's: the Queue does not snap
    // back under the projected rows while the pointer is on the end box.
    const overZone = { ...layout, overIndex: ids.indexOf(PLACEHOLDER) };
    expect(
      afterRowsShift(createSidebarSortingStrategy(input), entries, overZone, QUEUE_DROP_ID),
    ).toBe(shift);
    // "Show N more" is trailing content too: the same shift.
    expect(afterRowsShift(createSidebarSortingStrategy(input), entries, layout, SHOW_MORE_ID)).toBe(
      shift,
    );
    expect(shift).not.toBe(0);
    // Over something that is not a list item (the Queue header, nothing) dnd-kit leaves every row at
    // rest, so the content after them rests too.
    expect(
      afterRowsShift(
        createSidebarSortingStrategy(input),
        entries,
        { ...layout, overIndex: -1 },
        QUEUE_DROP_ID,
      ),
    ).toBe(0);
    // No preview, no shift: the context drag, and a Queue drag (not in the list).
    expect(
      afterRowsShift(
        createSidebarSortingStrategy({ ...input, enabled: false }),
        entries,
        layout,
        QUEUE_DROP_ID,
      ),
    ).toBe(0);
    expect(
      afterRowsShift(
        createSidebarSortingStrategy(input),
        entries,
        { ...layout, activeIndex: -1 },
        QUEUE_DROP_ID,
      ),
    ).toBe(0);
  });

  it("with Settled collapsed the content after the rows rests at the zero-height last item's bottom", () => {
    // Settled collapsed: the last item is the zero-height settled-placeholder, whose -mb-px
    // cancels the gap, so the trailing content rests at its bottom, not one gap below it.
    const entries = list({ total: 1, visible: ["z1"] }, { custom: false, settled: [] });
    const last = entries.at(-1)!;
    expect(zero(last)).toBe(true);
    const rects = layoutOf(entries, 0).rects;
    const ids = entries.map(sidebarListItemId);
    const strategy = createSidebarSortingStrategy({
      items: entries,
      settledOrder: [],
      settledExpanded: false,
      boundaryLabelHeight: LABEL,
      snoozedThreadCount: 1,
    });
    // a1 over itself: it stays in Active. The labels open, and so does the placeholder's 36px
    // hint, one gap below the rest end.
    const shift = afterRowsShift(
      strategy,
      entries,
      { rects, activeIndex: ids.indexOf("a1"), overIndex: ids.indexOf("a1") },
      SHOW_MORE_ID,
    );
    expect(shift).toBe(LABELS_SHIFT + SLIM + 1);
  });

  it("at a root scale of 1.25 the trailing shift is the scaled Pins labels when nothing else moves", () => {
    const scale = 1.25;
    const entries = list({ total: 1, visible: ["z1"] }, { custom: false, settled: ["s1", "s2"] });
    // A scrolling list (no free space), every box scaled, the gap a device pixel.
    let top = 100;
    const rects = entries.map((item) => {
      const box = rect(top, height(item) * scale);
      top += zero(item) ? 0 : height(item) * scale + 1;
      return box;
    });
    const ids = entries.map(sidebarListItemId);
    const strategy = createSidebarSortingStrategy({
      items: entries,
      settledOrder: ["s1", "s2"],
      settledExpanded: true,
      boundaryLabelHeight: LABEL,
      snoozedThreadCount: 1,
    });
    // s1 over itself: it stays in Settled, only the labels open.
    const shift = afterRowsShift(
      strategy,
      entries,
      { rects, activeIndex: ids.indexOf("s1"), overIndex: ids.indexOf("s1") },
      SHOW_MORE_ID,
    );
    expect(shift).toBeCloseTo(sidebarDragLabelsShift(LABEL, scale), 6);
    expect(shift).not.toBeCloseTo(sidebarDragLabelsShift(LABEL), 6);
  });

  it("the resting placeholder is never a list candidate: a drop over the last row's lower part resolves there", () => {
    // No custom sections, so the last Active row sits right above the placeholder. A Settled row
    // that may not be snoozed has no zones: the placeholder's box rests over a2's lower 36px.
    const entries = list({ total: 0, visible: [] }, { custom: false });
    const rects = restLayout(entries, 300);
    const ids = entries.map(sidebarListItemId);
    const a2 = rects[ids.indexOf("a2")]!;
    const box = rects[ids.indexOf(PLACEHOLDER)]!;
    expect(box.top).toBeLessThan(a2.bottom);
    const source = rects[ids.indexOf("s1")]!;
    const detector = createSidebarCollisionDetection(
      (id) => resolveSidebarDropTarget(entries, "s1", id) !== null,
      { items: entries },
    );
    const y = a2.bottom - 6;
    const collisionRect = { ...source, top: y - SLIM / 2, bottom: y + SLIM / 2 };
    const over = detector({
      active: {
        id: "s1",
        data: { current: {} },
        rect: { current: { initial: source, translated: collisionRect } },
      },
      collisionRect,
      pointerCoordinates: { x: 130, y },
      droppableRects: new Map(ids.map((id, index) => [id, rects[index]!])),
      droppableContainers: ids.map((id, index) => ({
        id,
        key: id,
        disabled: false,
        data: { current: {} },
        node: { current: null },
        rect: { current: rects[index]! },
      })),
    })[0];
    expect(resolveSidebarDropTarget(entries, "s1", String(over?.id))?.section).toBe("active");
  });
});
