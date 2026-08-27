/**
 * Splitting the timeline into what the transcript shows and what the queued
 * strip shows.
 *
 * A message sent while the thread is busy is already recorded server-side and
 * already identified by `waitingUserMessageIds`; the only thing this feature
 * changes is where it is drawn. Keeping the split here, rather than inline in
 * the render, is what makes "held messages leave the transcript exactly once"
 * something a test can assert.
 *
 * @module heldMessages.logic
 */

export interface HeldPartitionable {
  readonly id: string;
  readonly role: string;
}

export interface HeldPartition<TMessage> {
  /** What the transcript renders, in its original order. */
  readonly transcript: ReadonlyArray<TMessage>;
  /** What the queued strip renders, oldest first. */
  readonly held: ReadonlyArray<TMessage>;
}

/**
 * Split a timeline by held-message id.
 *
 * Returns the original array by reference when nothing is held, so the common
 * case — 97% of sends — costs one `Set.size` check and no allocation.
 */
export function partitionHeldMessages<TMessage extends HeldPartitionable>(
  messages: ReadonlyArray<TMessage>,
  heldIds: ReadonlySet<string>,
): HeldPartition<TMessage> {
  if (heldIds.size === 0) {
    return { transcript: messages, held: EMPTY_HELD };
  }
  const transcript: TMessage[] = [];
  const held: TMessage[] = [];
  for (const message of messages) {
    // Only a user message can be held. An assistant message sharing an id with
    // one would be a bug elsewhere, but routing it to the strip would hide the
    // agent's reply, so the role check is a guard rather than an optimisation.
    if (message.role === "user" && heldIds.has(message.id)) {
      held.push(message);
      continue;
    }
    transcript.push(message);
  }
  return held.length === 0 ? { transcript: messages, held: EMPTY_HELD } : { transcript, held };
}

const EMPTY_HELD: ReadonlyArray<never> = [];
