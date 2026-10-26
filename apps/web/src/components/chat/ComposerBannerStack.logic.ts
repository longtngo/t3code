export type ComposerBannerPriority = "urgent" | "activity" | "status" | "notice";

interface ArrangeableBanner {
  readonly priority?: ComposerBannerPriority | undefined;
  readonly variant: string;
}

function noticeRank(item: ArrangeableBanner) {
  if (item.priority === "urgent" || item.variant === "error" || item.variant === "warning") {
    return 0;
  }
  if (item.priority === "activity") return 1;
  return 2;
}

/**
 * Splits the stack into what is always on screen and what folds behind the peek. Status rows
 * (connection, message sync) never fold. Urgent notices, then activity, take the front row;
 * otherwise the first status row does, so a passive notice never sits closer than the connection.
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
