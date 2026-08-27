/**
 * The queued-message strip: what the thread is holding until the running turn
 * finishes.
 *
 * Sits in the Tasks tier — a shoulder tab plus a drawer — rather than in the
 * banner stack or the composer's top drawer. Those two are a saturated
 * exclusivity lattice: the banner stack renders only its first item and hides
 * the rest behind a hover target a touch device cannot reach, and the top
 * drawer is one slot already claimed by approvals, user input and plan
 * follow-ups. Displacing any of those to show a queued message would trade a
 * blocking prompt for an informational one.
 *
 * @module ComposerQueuedMessages
 */
import { ClockIcon, Undo2Icon, XIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

export interface ComposerQueuedMessage {
  readonly id: string;
  readonly text: string;
  readonly attachmentCount: number;
}

/** Collapsed affordance. Mirrors `ComposerTasksBadge`'s two placements. */
export const ComposerQueuedBadge = memo(function ComposerQueuedBadge({
  count,
  hasTrailingShoulder = false,
  onToggle,
  placement,
}: {
  readonly count: number;
  readonly hasTrailingShoulder?: boolean;
  readonly onToggle: () => void;
  readonly placement: "shoulder" | "inline";
}) {
  return (
    <button
      type="button"
      aria-expanded="false"
      aria-label={`${String(count)} message${count === 1 ? "" : "s"} waiting to send`}
      className={cn(
        "flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground",
        placement === "shoulder"
          ? "h-7 rounded-t-md border border-border/60 border-b-0 bg-muted/40 px-2"
          : "h-6 rounded-md px-1.5",
        hasTrailingShoulder && "me-1",
      )}
      onClick={onToggle}
      // Keeps composer focus while opening, matching the tasks badge.
      onPointerDown={(event) => event.preventDefault()}
    >
      <ClockIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="font-medium text-foreground tabular-nums">{count}</span>
      <span className="hidden sm:inline">waiting</span>
    </button>
  );
});

export const ComposerQueuedDrawer = memo(function ComposerQueuedDrawer({
  messages,
  onCollapse,
  onRecall,
  recallPendingId,
  recallSupported,
}: {
  readonly messages: ReadonlyArray<ComposerQueuedMessage>;
  readonly onCollapse: () => void;
  readonly onRecall: (messageId: string) => void;
  readonly recallPendingId: string | null;
  /**
   * False for a provider whose adapter cannot take a queued message back. The
   * rows still render — seeing what is waiting is the larger half of this
   * feature — they just do not offer an action that would fail.
   */
  readonly recallSupported: boolean;
}) {
  return (
    <div className="chat-composer-top-drawer" data-chat-composer-queued-drawer="true">
      <div className="flex items-center gap-1 px-3 py-1.5 sm:px-4">
        <button
          type="button"
          aria-expanded="true"
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 self-stretch text-left text-xs text-muted-foreground hover:text-foreground"
          onClick={onCollapse}
          onPointerDown={(event) => event.preventDefault()}
        >
          <ClockIcon aria-hidden className="size-3.5 shrink-0" />
          <span className="font-medium text-foreground">Waiting to send</span>
          <span className="tabular-nums">{messages.length}</span>
        </button>
        <Button
          size="icon-micro"
          variant="ghost-muted"
          aria-label="Collapse queued messages"
          className="shrink-0"
          onClick={onCollapse}
          onPointerDown={(event) => event.preventDefault()}
        >
          <XIcon aria-hidden className="size-3" />
        </Button>
      </div>
      <div className="space-y-1 px-3 pb-3 sm:px-4" role="list">
        {messages.map((message) => (
          <div
            key={message.id}
            className="flex items-start gap-2 rounded-md bg-muted/40 px-2 py-1.5 text-xs"
            role="listitem"
          >
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-foreground">
              {message.text}
              {message.attachmentCount > 0 ? (
                <span className="ms-1.5 text-muted-foreground">
                  ({message.attachmentCount} attachment
                  {message.attachmentCount === 1 ? "" : "s"})
                </span>
              ) : null}
            </span>
            {recallSupported ? (
              <Button
                size="icon-micro"
                variant="ghost-muted"
                aria-label="Bring this message back to the composer"
                className="shrink-0"
                disabled={recallPendingId !== null}
                onClick={() => onRecall(message.id)}
                onPointerDown={(event) => event.preventDefault()}
              >
                <Undo2Icon aria-hidden className="size-3" />
              </Button>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
});
