import { describe, expect, it } from "@effect/vitest";

import { RETAINED_TURN_ITEMS, releaseOldTurnItems } from "./turnItemRetention.ts";

const makeTurns = (count: number) =>
  Array.from({ length: count }, (_unused, index) => ({ items: [`item-${index}`] as Array<unknown> }));

describe("releaseOldTurnItems", () => {
  it("retains 20 turns", () => {
    // Every other case here is written as RETAINED_TURN_ITEMS ± n, which makes them all pass
    // for *any* window — 5, 1000, 1 — and so leaves the one number this module exists to
    // choose unasserted. The window trades replay fidelity against retained heap, so changing
    // it should require changing a test on purpose rather than sliding through green.
    expect(RETAINED_TURN_ITEMS).toBe(20);
  });

  it("keeps every entry, so the resume cursor's count and a revert's splice still work", () => {
    // This is the constraint that rules out simply capping the array: the
    // adapter reports `turns.length` as its resume cursor and reverts by
    // splicing a count off the end. Dropping entries would silently move both.
    const turns = makeTurns(RETAINED_TURN_ITEMS + 5);

    releaseOldTurnItems(turns);

    expect(turns).toHaveLength(RETAINED_TURN_ITEMS + 5);
  });

  it("releases the items of turns beyond the retention window", () => {
    const turns = makeTurns(RETAINED_TURN_ITEMS + 3);

    const released = releaseOldTurnItems(turns);

    expect(released).toBe(3);
    expect(turns.slice(0, 3).every((turn) => turn.items.length === 0)).toBe(true);
  });

  it("leaves the most recent turns' items intact", () => {
    const turns = makeTurns(RETAINED_TURN_ITEMS + 3);

    releaseOldTurnItems(turns);

    expect(turns.slice(3).every((turn) => turn.items.length === 1)).toBe(true);
    expect(turns.at(-1)?.items).toEqual([`item-${String(RETAINED_TURN_ITEMS + 2)}`]);
  });

  it("does nothing while the session is still inside the window", () => {
    const turns = makeTurns(RETAINED_TURN_ITEMS);

    expect(releaseOldTurnItems(turns)).toBe(0);
    expect(turns.every((turn) => turn.items.length === 1)).toBe(true);
  });

  it("counts only the turns it actually emptied, so a second pass is a no-op", () => {
    const turns = makeTurns(RETAINED_TURN_ITEMS + 2);

    expect(releaseOldTurnItems(turns)).toBe(2);
    expect(releaseOldTurnItems(turns)).toBe(0);
  });

  it("honours a caller-supplied window", () => {
    const turns = makeTurns(5);

    expect(releaseOldTurnItems(turns, 2)).toBe(3);
    expect(turns.map((turn) => turn.items.length)).toEqual([0, 0, 0, 1, 1]);
  });
});
