import { MessageId, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { useCallback, useState } from "react";

import { heldMessageEnvironment } from "~/state/heldMessages";
import { useAtomCommand } from "~/state/use-atom-command";

export interface QueuedMessageRecall {
  /** Resolves to the recalled text, or null when the turn could not be taken back. */
  readonly run: (message: { readonly id: string; readonly text: string }) => Promise<string | null>;
  readonly pendingId: string | null;
}

/**
 * Recall for one thread's queued messages.
 *
 * The text comes back from the caller's own copy rather than from the server:
 * the strip is already rendering it, and the withdraw answers only whether the
 * turn was released. One in-flight recall at a time, keyed by message id, so
 * the row that is being taken back is the row that shows as busy.
 */
export function useQueuedMessageRecall(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): QueuedMessageRecall {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const withdraw = useAtomCommand(heldMessageEnvironment.withdraw, {
    label: "held-messages:withdraw",
  });
  const run = useCallback(
    async (message: { readonly id: string; readonly text: string }) => {
      if (pendingId !== null || environmentId === null || threadId === null) return null;
      setPendingId(message.id);
      try {
        const result = await withdraw({
          environmentId,
          input: { threadId, messageId: MessageId.make(message.id) },
        });
        // A failed round trip is reported by the command runner already; here it
        // means the same thing as losing the race, so the message stays put.
        return result._tag === "Success" && result.value.withdrawn ? message.text : null;
      } finally {
        setPendingId(null);
      }
    },
    [environmentId, pendingId, threadId, withdraw],
  );
  return { run, pendingId };
}
