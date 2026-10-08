import { THREAD_QUEUE_MAX_ENTRIES, type EnvironmentId, type ThreadId } from "@t3tools/contracts";

import { toastManager } from "./components/ui/toast";
import { isSendingThread, threadQueueEntryKey } from "./threadQueueRules";
import { useThreadQueueStore } from "./threadQueueStore";

export const QUEUE_FULL_MESSAGE = `The queue is full (${THREAD_QUEUE_MAX_ENTRIES}).`;
export const QUEUE_SENDING_MESSAGE = "Already sending. Add it again once it has gone out.";
export const QUEUE_READ_ONLY_MESSAGE = "The queue is read-only right now.";

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

/** A thread menu's "Add to queue" / "Remove from queue" (sidebar row, chat header). */
export function runThreadQueueMenuAction(
  action: "queue" | "unqueue",
  thread: { readonly environmentId: EnvironmentId; readonly id: ThreadId; readonly title: string },
): void {
  const entry = { environmentId: thread.environmentId, threadId: thread.id };
  if (action === "unqueue") {
    useThreadQueueStore.getState().remove(threadQueueEntryKey(entry));
    return;
  }
  addToQueueOrSayWhy({ ...entry, draftId: null, label: thread.title });
}
