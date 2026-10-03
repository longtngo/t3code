import { useEffect, type RefObject } from "react";

import {
  createChatEscapeHandler,
  isChatSurfaceFocused,
  type QueuedRecallOutcome,
} from "../ChatView.logic";

/**
 * FORK: Escape walks the same Stop ladder the button does, so two deliberate presses force-stop
 * and a held key (auto-repeat) never reaches the hard rung. Scoped by focus: every overlay that
 * owns Escape takes focus out of the composer form, and `document.body` counts as the chat
 * (clicking the transcript leaves focus there). Bubble phase, so a handler that already claimed
 * the press wins. With messages queued, Escape works the queue instead (see
 * `createChatEscapeHandler`) and never stops the turn the user is redirecting.
 *
 * Takes the composer's props object itself, so Stop is the composer's own `onInterrupt` (the
 * same action as its Stop button) and there is no place in `ChatComposer` to substitute a copy.
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
