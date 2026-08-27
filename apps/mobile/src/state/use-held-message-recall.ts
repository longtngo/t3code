import { MessageId, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { useCallback, useState } from "react";

import { heldMessageEnvironment } from "./threads";
import { useAtomCommand } from "./use-atom-command";

export interface HeldMessageRecall {
  /** Resolves to the recalled text, or null when the turn could not be taken back. */
  readonly run: (message: { readonly id: string; readonly text: string }) => Promise<string | null>;
  readonly pendingId: string | null;
}

/**
 * Recall for one thread's held messages. The web twin of this lives in
 * `apps/web/src/hooks/useQueuedMessageRecall.ts`; both hit the same RPC and both
 * return the caller's own copy of the text rather than a second copy over the
 * wire.
 */
export function useHeldMessageRecall(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): HeldMessageRecall {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const withdraw = useAtomCommand(heldMessageEnvironment.withdraw, { reportFailure: false });
  const run = useCallback(
    async (message: { readonly id: string; readonly text: string }) => {
      if (pendingId !== null || environmentId === null || threadId === null) return null;
      setPendingId(message.id);
      try {
        const result = await withdraw({
          environmentId,
          input: { threadId, messageId: MessageId.make(message.id) },
        });
        return result._tag === "Success" && result.value.withdrawn ? message.text : null;
      } finally {
        setPendingId(null);
      }
    },
    [environmentId, pendingId, threadId, withdraw],
  );
  return { run, pendingId };
}
