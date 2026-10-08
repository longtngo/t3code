import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { THREAD_QUEUE_MAX_ENTRIES, type EnvironmentId, type ThreadId } from "@t3tools/contracts";

import { stackedThreadToast, toastManager } from "./components/ui/toast";
import { readThreadShell } from "./state/entities";
import {
  isClaimedThread,
  isSendingThread,
  queueAndWake,
  threadQueueEntryKey,
} from "./threadQueueRules";
import { useThreadQueueStore } from "./threadQueueStore";

export const QUEUE_FULL_MESSAGE = `The queue is full (${THREAD_QUEUE_MAX_ENTRIES}).`;
export const QUEUE_SENDING_MESSAGE = "Already sending. Add it again once it has gone out.";
export const QUEUE_READ_ONLY_MESSAGE = "The queue is read-only right now.";
export const SNOOZE_QUEUE_READ_ONLY_MESSAGE =
  "Can't snooze a queued thread while the queue is read-only.";

export type QueueAddResult = "added" | "full" | "sending" | "read-only";

/** A user's add: true when added; a refusal says why (`say`) rather than doing nothing. */
export function explainQueueAdd(result: QueueAddResult, say: (title: string) => void): boolean {
  if (result === "added") return true;
  say(
    result === "full"
      ? QUEUE_FULL_MESSAGE
      : result === "sending"
        ? QUEUE_SENDING_MESSAGE
        : QUEUE_READ_ONLY_MESSAGE,
  );
  return false;
}

/**
 * Adds a thread or draft for a user action. "full" when the queue takes nothing new, "sending"
 * when the queue is about to send this thread's draft; neither adds anything.
 */
export function addToQueue(
  entry: Parameters<ReturnType<typeof useThreadQueueStore.getState>["enqueue"]>[0],
): QueueAddResult {
  const queue = useThreadQueueStore.getState();
  // The store drops a user's change to a read-only queue without a word.
  if (queue.readOnly) return "read-only";
  const key = threadQueueEntryKey(entry);
  const queued = queue.entries.some((candidate) => threadQueueEntryKey(candidate) === key);
  if (isSendingThread(queue, key)) return "sending";
  if (!queued && queue.entries.length >= THREAD_QUEUE_MAX_ENTRIES) return "full";
  queue.enqueue(entry);
  return "added";
}

/** A user's "Add to queue" from any surface: a refused add says why rather than doing nothing. */
export function addToQueueOrSayWhy(entry: Parameters<typeof addToQueue>[0]): boolean {
  return explainQueueAdd(addToQueue(entry), (title) => toastManager.add({ type: "info", title }));
}

/** A queued thread cannot snooze while the Queue is read-only: it could not leave the Queue,
    and the Queue's send would wake it. */
export function queueRefusesSnooze(threadKey: string): boolean {
  const queue = useThreadQueueStore.getState();
  return (
    queue.readOnly &&
    queue.entries.some((candidate) => threadQueueEntryKey(candidate) === threadKey)
  );
}

/**
 * An archived or deleted thread leaves the Queue once the command landed, rather than when the
 * coordinator's prune sees the change (prune still covers a removal the queue drops).
 */
export function leaveQueueForRemoval(threadKey: string): void {
  const queue = useThreadQueueStore.getState();
  if (queue.entries.some((candidate) => threadQueueEntryKey(candidate) === threadKey)) {
    queue.remove(threadKey);
  }
}

/**
 * A snoozed thread leaves the Queue, or the Queue's send would wake it. Call once the snooze
 * landed. Returns the snooze Undo's follow-up, which appends it to the Queue again once it is
 * awake, or undefined when it was not queued here.
 */
export function leaveQueueForSnooze(threadKey: string): (() => void) | undefined {
  const queue = useThreadQueueStore.getState();
  const entry = queue.entries.find((candidate) => threadQueueEntryKey(candidate) === threadKey);
  // A read-only queue drops the removal, so there is nothing to put back.
  if (entry === undefined || queue.readOnly) return undefined;
  // A claim already holding the thread (an earlier send not yet seen landing) is not a reason
  // to drop it later; only a claim made after this removal is.
  const claimAtRemoval = isClaimedThread(queue, threadKey) ? queue.inFlight!.claimId : null;
  queue.remove(threadKey);
  return () => {
    // A peer's queue claimed and sent it while our removal was in flight: queueing it again would
    // send an empty draft. A send still in progress goes through addToQueue, which says so.
    const now = useThreadQueueStore.getState();
    if (
      isClaimedThread(now, threadKey) &&
      !isSendingThread(now, threadKey) &&
      now.inFlight!.claimId !== claimAtRemoval
    )
      return;
    // The wake already succeeded: a throw here must not read as "Failed to wake thread".
    try {
      addToQueueOrSayWhy({
        environmentId: entry.environmentId,
        threadId: entry.threadId,
        draftId: entry.draftId,
        label: entry.label,
      });
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to queue thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
  };
}

/** A thread menu's queue item (sidebar row, chat header), read when the menu opens. */
export function readThreadQueueMenuState(thread: {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly archivedAt: string | null;
}) {
  const queue = useThreadQueueStore.getState();
  const key = threadQueueEntryKey({ environmentId: thread.environmentId, threadId: thread.id });
  return {
    isQueued: queue.entries.some((entry) => threadQueueEntryKey(entry) === key),
    // The queue prunes an archived thread as soon as it is added.
    queueWritable: !queue.readOnly && thread.archivedAt === null,
  };
}

/** A thread menu's "Add to queue" / "Remove from queue" (sidebar row, chat header). Adding a
    thread that is snoozed now also wakes it (`wake`), as a drop from Snoozed on the Queue does. */
export async function runThreadQueueMenuAction(
  action: "queue" | "unqueue",
  thread: { readonly environmentId: EnvironmentId; readonly id: ThreadId; readonly title: string },
  wake: () => Promise<unknown>,
): Promise<void> {
  const entry = { environmentId: thread.environmentId, threadId: thread.id };
  if (action === "unqueue") {
    useThreadQueueStore.getState().remove(threadQueueEntryKey(entry));
    return;
  }
  const shell = readThreadShell(scopeThreadRef(thread.environmentId, thread.id));
  await queueAndWake({
    snoozed: shell !== null && effectiveSnoozed(shell, { now: new Date().toISOString() }),
    enqueue: () => addToQueueOrSayWhy({ ...entry, draftId: null, label: thread.title }),
    wake,
  });
}
