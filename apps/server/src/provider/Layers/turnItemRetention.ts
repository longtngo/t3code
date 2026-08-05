/**
 * Bounds how much of a session's turn history stays resident.
 *
 * The Claude adapter appends every completed turn's full item list to
 * `context.turns` and never drops any of it, so a long-lived session's memory
 * grows with the conversation rather than with anything in flight.
 *
 * The array itself must stay whole: the resume cursor reports `turns.length`,
 * and reverting a turn splices by count. Both need the entries; neither reads
 * the items. The only reader of the items is `readThread`, which — checked
 * across the whole server — has no caller outside the adapters that declare it.
 * So older turns keep their identity and give up their payload.
 *
 * @module turnItemRetention
 */

/**
 * How many of the most recent turns keep their items.
 *
 * Generous on purpose: this exists to stop unbounded growth over a long
 * session, not to run close to a limit. Twenty turns is far more than any
 * caller reads today, and the entries themselves are never dropped.
 */
export const RETAINED_TURN_ITEMS = 20;

/** A turn as the adapter stores it: identity plus its accumulated items. */
export interface RetainableTurn {
  items: Array<unknown>;
}

/**
 * Release the items of every turn older than the retention window, in place.
 *
 * Returns how many turns were released, so a caller can log or assert on it.
 */
export function releaseOldTurnItems(
  turns: ReadonlyArray<RetainableTurn>,
  retained: number = RETAINED_TURN_ITEMS,
): number {
  const releaseBefore = turns.length - Math.max(0, retained);
  let released = 0;
  for (let index = 0; index < releaseBefore; index += 1) {
    const turn = turns[index];
    if (turn === undefined || turn.items.length === 0) continue;
    // Truncate rather than reassign: the array identity may already be held
    // elsewhere, and shortening it releases the element references either way.
    turn.items.length = 0;
    released += 1;
  }
  return released;
}
