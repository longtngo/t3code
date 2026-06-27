import type { MessageId } from "@t3tools/contracts";
import { isTransportConnectionErrorMessage } from "@t3tools/client-runtime";
import { create } from "zustand";

// v1 queues only user turn-starts. Widen this predicate to add more later.
type QueueableCommand = { readonly type: "thread.turn.start"; readonly commandId: string } & Record<
  string,
  unknown
>;

export interface QueuedCommand {
  readonly command: QueueableCommand;
  readonly messageId: MessageId;
  readonly enqueuedAt: string;
}

interface OutboxState {
  readonly queue: readonly QueuedCommand[];
}

export const useCommandOutbox = create<OutboxState>(() => ({ queue: [] }));

export function getQueuedCommands(): readonly QueuedCommand[] {
  return useCommandOutbox.getState().queue;
}

export function enqueueCommand(command: QueueableCommand, messageId: MessageId): void {
  useCommandOutbox.setState((state) =>
    state.queue.some((q) => q.command.commandId === command.commandId)
      ? state
      : { queue: [...state.queue, { command, messageId, enqueuedAt: new Date().toISOString() }] },
  );
}

function dropHead(): void {
  useCommandOutbox.setState((state) => ({ queue: state.queue.slice(1) }));
}

export function clearOutbox(): void {
  useCommandOutbox.setState({ queue: [] });
}

export function clearOutboxForTests(): void {
  clearOutbox();
}

export async function flushOutbox(
  send: (command: QueueableCommand) => Promise<unknown>,
  options?: { readonly onTerminalError?: (queued: QueuedCommand, error: unknown) => void },
): Promise<void> {
  // Sequential FIFO. Re-read the live head each iteration so a concurrent
  // enqueue/dequeue cannot desync the cursor.
  for (;;) {
    const head = useCommandOutbox.getState().queue[0];
    if (head === undefined) return;
    try {
      await send(head.command);
      dropHead(); // idempotent server-side (dedupe by commandId), so a re-send is safe
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : typeof (error as { message?: unknown })?.message === "string"
            ? (error as { message: string }).message
            : String(error);
      if (isTransportConnectionErrorMessage(message)) {
        return; // transport dropped again — keep the remainder for the next reconnect
      }
      options?.onTerminalError?.(head, error); // rejected receipt / invalid command — drop so it can't wedge FIFO
      dropHead();
    }
  }
}
