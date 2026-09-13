export type ComposerBannerPriority = "urgent" | "activity" | "status" | "notice";

interface ArrangeableBanner {
  readonly priority?: ComposerBannerPriority | undefined;
  readonly variant: string;
}

function noticeRank(item: ArrangeableBanner) {
  if (item.priority === "activity") return 0;
  if (item.priority === "urgent" || item.variant === "error" || item.variant === "warning") {
    return 1;
  }
  return 2;
}

/**
 * Splits the stack into what is always on screen and what folds behind the peek.
 *
 * The front row is attached to the composer. Status rows (connection, message sync)
 * describe whether the thread is usable right now, so they never fold: they stack
 * above the front in their given order. Everything else folds behind the peek.
 * Activity and urgent notices keep the front; otherwise the first status row takes
 * it, so a passive notice never sits closer to the composer than the connection.
 */
export function arrangeComposerBannerStack<T extends ArrangeableBanner>(
  items: ReadonlyArray<T>,
): { front: T | null; status: T[]; folded: T[] } {
  const status = items.filter((item) => item.priority === "status");
  const others = items
    .filter((item) => item.priority !== "status")
    .toSorted((a, b) => noticeRank(a) - noticeRank(b));
  const leader = others[0];
  if (leader !== undefined && (status.length === 0 || noticeRank(leader) < 2)) {
    return { front: leader, status, folded: others.slice(1) };
  }
  return { front: status[0] ?? null, status: status.slice(1), folded: others };
}
