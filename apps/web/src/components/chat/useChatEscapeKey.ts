import { useEffect, type RefObject } from "react";

import {
  createChatEscapeHandler,
  isChatSurfaceFocused,
  type QueuedRecallOutcome,
} from "../ChatView.logic";

/**
 * FORK: Escape walks the button's Stop ladder: two deliberate presses force-stop, auto-repeat
 * never reaches the hard rung. Scoped by focus (overlays own Escape; `document.body` counts as
 * the chat), bubble phase so earlier handlers win; with messages queued it works the queue.
 * Takes the composer's props so Stop is its own `onInterrupt`, with no copy to substitute.
 */
export function useChatEscapeKey(
  composerProps: {
    readonly onInterrupt: () => void;
    readonly queuedMessageCount: number;
    readonly onRecallQueuedMessage: () => QueuedRecallOutcome;
  },
  input: {
    readonly composerFormRef: RefObject<HTMLFormElement | null>;
    readonly canInterrupt: boolean;
    readonly hasPendingQuestion: boolean;
  },
): void {
  const { onInterrupt, queuedMessageCount, onRecallQueuedMessage } = composerProps;
  const { composerFormRef, canInterrupt, hasPendingQuestion } = input;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window keydown listener that handles Escape for stop and queued-message recall
  useEffect(() => {
    const onKeyDown = createChatEscapeHandler({
      isChatSurfaceActive: () =>
        isChatSurfaceFocused({
          activeElement: document.activeElement,
          bodyElement: document.body,
          composerRoot: composerFormRef.current,
          hasOpenDialog: document.querySelector('[data-slot="dialog-popup"]') !== null,
        }),
      hasRunningTurn: canInterrupt,
      hasPendingQuestion,
      queuedMessageCount,
      recallQueuedMessage: onRecallQueuedMessage,
      stop: onInterrupt,
    });
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    canInterrupt,
    composerFormRef,
    hasPendingQuestion,
    onInterrupt,
    onRecallQueuedMessage,
    queuedMessageCount,
  ]);
}
