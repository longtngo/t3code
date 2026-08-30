/**
 * Whether a thread has a user message no turn has adopted yet.
 *
 * This is work in flight even though `session` may still be null: `turn.start`
 * emits message-sent and turn-start-requested first, and the session arrives
 * later. The server's decider uses it to refuse settling or snoozing such a
 * thread; the clients use it to keep the thread out of the settled shelf. The
 * two MUST agree, or the UI offers an action the server then rejects.
 *
 * They used to be separate implementations - `threadHasQueuedTurnStart` in the
 * decider and `hasQueuedTurnStart` in client-runtime - each with a comment
 * saying it mirrored the other, and each with its own copy of the grace
 * constant. The rule lives here now; the two callers only adapt their own shapes
 * to it (the decider walks `messages`, clients read a denormalized
 * `latestUserMessageAt`).
 */
export const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;

export function isQueuedTurnStart(input: {
  /** Newest user message, in ms. Non-finite when the thread has none. */
  readonly latestUserMessageAtMs: number;
  /** Newest of the latest turn's timestamps, in ms. `-Infinity` when no turn. */
  readonly latestTurnAtMs: number;
  readonly sessionStatus: string | null | undefined;
  readonly nowMs: number;
}): boolean {
  // A failed session start clears the queued state: the failure is already
  // visible as a status edge and an error, so blocking on top of it strands the
  // thread.
  if (input.sessionStatus === "error") return false;
  if (!Number.isFinite(input.latestUserMessageAtMs)) return false;
  if (!Number.isFinite(input.nowMs)) return false;
  // Adoption stamps the new turn's requestedAt with the message time, so a
  // message that is not strictly newer than every turn timestamp has been taken.
  if (input.latestUserMessageAtMs <= input.latestTurnAtMs) return false;
  // Bounded on BOTH sides. Message timestamps come from whichever device sent
  // the message, so a clock ahead of this one produces a negative age; without
  // the lower bound that negative age satisfies `<= grace` for as long as the
  // skew lasts, holding the thread unsettleable far past the intended window.
  return Math.abs(input.nowMs - input.latestUserMessageAtMs) <= QUEUED_TURN_START_GRACE_MS;
}

/** The newest of a latest turn's timestamps, or `-Infinity` when there is none. */
export function latestTurnTimestampMs(
  latestTurn: {
    readonly requestedAt: string;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
  } | null,
): number {
  if (latestTurn === null) return Number.NEGATIVE_INFINITY;
  return Math.max(
    ...[latestTurn.requestedAt, latestTurn.startedAt, latestTurn.completedAt].map((candidate) =>
      candidate == null ? Number.NEGATIVE_INFINITY : Date.parse(candidate),
    ),
  );
}
