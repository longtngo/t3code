import { memo, type PointerEventHandler } from "react";
import { ChevronDownIcon, ChevronLeftIcon, OctagonXIcon, XIcon } from "lucide-react";
import { useEnvironmentIdentificationMode } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { StageBackdropButtonArt, useSidebarStageBackdropVariant } from "../SidebarStageBackdrop";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";

interface PendingActionState {
  questionIndex: number;
  isLastQuestion: boolean;
  canAdvance: boolean;
  isResponding: boolean;
  isComplete: boolean;
}

interface ComposerPrimaryActionsProps {
  compact: boolean;
  pendingAction: PendingActionState | null;
  isRunning: boolean;
  showPlanFollowUpPrompt: boolean;
  promptHasText: boolean;
  isSendBusy: boolean;
  sendDisabledReason: string | null;
  isConnecting: boolean;
  isEnvironmentUnavailable: boolean;
  /**
   * Blocks sending outright (no provider, no project). Distinct from
   * `isEnvironmentUnavailable`, which only means the send will be QUEUED.
   */
  isSendBlocked: boolean;
  isPreparingWorktree: boolean;
  hasSendableContent: boolean;
  preserveComposerFocusOnPointerDown?: boolean;
  onPreviousPendingQuestion: () => void;
  onInterrupt: () => void;
  /**
   * The ladder is armed: `onInterrupt`'s next call force-stops the session and
   * asks the watchdog to resume the thread. Renders the second rung as a
   * visibly different, destructive control so the escalation is neither
   * undiscoverable nor triggerable by an impatient double-click that the user
   * thinks is just "stop again".
   */
  isStopEscalated: boolean;
  /**
   * Dedicated cooperative decline for a pending question — never arms the Stop
   * escalation ladder. Distinct from `onInterrupt`, which is the ladder's entry
   * point and whose second press force-stops the session.
   */
  onCancelQuestion: () => void;
  onImplementPlanInNewThread: () => void;
}

export const formatPendingPrimaryActionLabel = (input: {
  compact: boolean;
  isLastQuestion: boolean;
  isResponding: boolean;
  questionIndex: number;
}) => {
  if (input.isResponding) {
    return "Submitting...";
  }
  if (input.compact) {
    return input.isLastQuestion ? "Submit" : "Next";
  }
  if (!input.isLastQuestion) {
    return "Next question";
  }
  return input.questionIndex > 0 ? "Submit answers" : "Submit answer";
};

const preventPointerFocus: PointerEventHandler<HTMLElement> = (event) => {
  event.preventDefault();
};

export const ComposerPrimaryActions = memo(function ComposerPrimaryActions({
  compact,
  pendingAction,
  isRunning,
  showPlanFollowUpPrompt,
  promptHasText,
  isSendBusy,
  sendDisabledReason,
  isConnecting,
  isEnvironmentUnavailable,
  isSendBlocked,
  isPreparingWorktree,
  hasSendableContent,
  preserveComposerFocusOnPointerDown = false,
  onPreviousPendingQuestion,
  onInterrupt,
  isStopEscalated,
  onCancelQuestion,
  onImplementPlanInNewThread,
}: ComposerPrimaryActionsProps) {
  const pointerFocusProps = preserveComposerFocusOnPointerDown
    ? { onPointerDown: preventPointerFocus }
    : undefined;
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const isSendDisabled = sendDisabledReason !== null;
  const stageBackdropVariant = useSidebarStageBackdropVariant(
    environmentIdentificationMode === "artwork",
  );

  /**
   * Both rungs of the Stop ladder render from here, so the armed styling cannot
   * be applied to one entry point and forgotten on the other — the pending
   * question row has its own Stop.
   *
   * The armed rung is distinguished by SHAPE (a stop-sign octagon) rather than
   * colour alone: at 32px a fill-opacity shift does not read, and the button is
   * already destructive-red at rest, so there is no colour headroom. The ring
   * carries it at a glance. Deliberately static — a pulsing "armed" indicator
   * is exactly the continuously repainting animation this repo bans.
   */
  const renderStopGenerationButton = (insidePendingAction: boolean) => (
    <button
      type="button"
      className={cn(
        "flex cursor-pointer items-center justify-center rounded-full text-white shadow-xs shadow-destructive/24 inset-shadow-[0_1px_--theme(--color-white/16%)] transition-all duration-150 hover:bg-destructive hover:scale-105 active:inset-shadow-[0_1px_--theme(--color-black/8%)] active:shadow-none",
        // Standalone Stop sits beside Send while running, so it must match Send's
        // footprint exactly (`h-9 w-9 sm:h-8 sm:w-8`). Sizing it `size-8` made it
        // 32px against Send's 36px below `sm` — a visible mismatch on a phone, on
        // the very change whose point is that the row stops moving.
        insidePendingAction ? "size-8 sm:size-7" : "h-9 w-9 sm:h-8 sm:w-8",
        isStopEscalated
          ? "bg-destructive ring-2 ring-destructive/40 ring-offset-1 ring-offset-background"
          : "bg-destructive/90",
      )}
      {...pointerFocusProps}
      onClick={onInterrupt}
      data-stop-escalated={isStopEscalated ? "true" : "false"}
      aria-label={isStopEscalated ? "Force stop the session" : "Stop generation"}
      title={
        isStopEscalated
          ? "The cooperative stop was not honoured — this press force-stops the session and recovers the thread"
          : undefined
      }
    >
      {isStopEscalated ? (
        <OctagonXIcon className="size-4" aria-hidden="true" />
      ) : (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
          <rect x="2" y="2" width="8" height="8" rx="1.5" />
        </svg>
      )}
    </button>
  );

  const sendButton = (
    <button
      type="submit"
      className={cn(
        "relative isolate flex h-9 w-9 items-center justify-center overflow-hidden rounded-full shadow-xs transition-all duration-150 enabled:cursor-pointer enabled:inset-shadow-[0_1px_--theme(--color-white/16%)] hover:scale-105 active:inset-shadow-[0_1px_--theme(--color-black/8%)] active:shadow-none disabled:pointer-events-none disabled:opacity-30 disabled:shadow-none disabled:hover:scale-100 sm:h-8 sm:w-8",
        stageBackdropVariant
          ? "bg-transparent text-white enabled:shadow-black/24 enabled:hover:brightness-110"
          : "bg-message-action text-message-action-foreground enabled:shadow-message-action/24 hover:bg-message-action-hover",
      )}
      {...pointerFocusProps}
      // Note this checks `isSendBlocked`, NOT `isEnvironmentUnavailable`: a
      // disconnected environment leaves the button live so the message can be
      // queued for reconnect instead of being swallowed by a dead button.
      disabled={
        isSendBusy || isSendDisabled || isConnecting || isSendBlocked || !hasSendableContent
      }
      aria-label={
        isEnvironmentUnavailable
          ? "Queue message to send on reconnect"
          : sendDisabledReason
            ? sendDisabledReason
            : isConnecting
              ? "Connecting"
              : isPreparingWorktree
                ? "Preparing worktree"
                : isSendBusy
                  ? "Sending"
                  : "Send message"
      }
    >
      {stageBackdropVariant ? (
        <span className="absolute inset-0 -z-10" aria-hidden="true">
          <StageBackdropButtonArt variant={stageBackdropVariant} />
        </span>
      ) : null}
      {isConnecting || isSendBusy ? (
        <Spinner className="size-3.5" aria-hidden="true" />
      ) : (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path
            d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );

  if (pendingAction) {
    return (
      <div className={cn("flex items-center justify-end", compact ? "gap-1.5" : "gap-2")}>
        {isRunning ? renderStopGenerationButton(true) : null}
        {pendingAction.questionIndex > 0 ? (
          compact ? (
            <Button
              size="icon-sm"
              variant="outline"
              className="rounded-full"
              {...pointerFocusProps}
              onClick={onPreviousPendingQuestion}
              disabled={pendingAction.isResponding}
              aria-label="Previous question"
            >
              <ChevronLeftIcon className="size-3.5" />
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="rounded-full"
              {...pointerFocusProps}
              onClick={onPreviousPendingQuestion}
              disabled={pendingAction.isResponding}
            >
              Previous
            </Button>
          )
        ) : null}
        {/*
          Decline the question instead of being forced to answer it. Without
          this the pending row can offer no exit at all: Stop only renders while
          a turn is running, and Previous only past the first question.

          Wired to the same `onInterrupt` as Stop, which the adapter turns into a
          clean settle of the pending request (it registers an `abort` listener
          on the AskUserQuestion the moment it is created).

          The tripwire that used to sit here has FIRED. Stop regained its
          escalation ladder, so sharing `onInterrupt` would have meant a Cancel
          press arming the ladder and turning the NEXT Stop press into a session
          kill — the bug fixed in f4af9398e, reintroduced. `onCancelQuestion` is
          therefore back, exactly as it was, and dispatches the cooperative
          interrupt without touching the ledger.
        */}
        {compact ? (
          <Button
            size="icon-sm"
            variant="ghost"
            className="rounded-full"
            {...pointerFocusProps}
            onClick={onCancelQuestion}
            disabled={pendingAction.isResponding}
            aria-label="Cancel question"
          >
            <XIcon className="size-3.5" />
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="rounded-full"
            {...pointerFocusProps}
            onClick={onCancelQuestion}
            disabled={pendingAction.isResponding}
            aria-label="Cancel question"
          >
            Cancel
          </Button>
        )}
        <Button
          type="submit"
          size="sm"
          className={cn(
            "rounded-full bg-message-action text-message-action-foreground hover:bg-message-action-hover",
            compact ? "px-3" : "px-4",
          )}
          {...pointerFocusProps}
          disabled={
            isEnvironmentUnavailable ||
            isSendBlocked ||
            pendingAction.isResponding ||
            (pendingAction.isLastQuestion ? !pendingAction.isComplete : !pendingAction.canAdvance)
          }
        >
          {formatPendingPrimaryActionLabel({
            compact,
            isLastQuestion: pendingAction.isLastQuestion,
            isResponding: pendingAction.isResponding,
            questionIndex: pendingAction.questionIndex,
          })}
        </Button>
      </div>
    );
  }

  if (isRunning) {
    // Send stays mounted beside Stop rather than being replaced by it, so the
    // control never moves between idle and running. Every adapter has a defined
    // concurrent-send path — Claude queues the follow-up FIFO
    // (`ClaudeAdapter.ts:4637`), Cursor/Grok/OpenCode steer it into the running
    // turn — so this is not gated on the provider.
    //
    // Do NOT "simplify" this by deleting the branch and falling through to the
    // default Send: `showPlanFollowUpPrompt` is only unreachable while running
    // because this branch returns first, and falling through would start
    // rendering Refine/Implement mid-run.
    return (
      <div className={cn("flex items-center justify-end", compact ? "gap-1.5" : "gap-2")}>
        {renderStopGenerationButton(false)}
        {sendButton}
      </div>
    );
  }

  if (showPlanFollowUpPrompt) {
    if (promptHasText) {
      return (
        <Button
          type="submit"
          size="sm"
          className={cn(
            "rounded-full bg-message-action text-message-action-foreground hover:bg-message-action-hover",
            compact ? "h-9 px-3 sm:h-8" : "h-9 px-4 sm:h-8",
          )}
          {...pointerFocusProps}
          disabled={
            isSendBusy ||
            isSendDisabled ||
            isConnecting ||
            isEnvironmentUnavailable ||
            isSendBlocked
          }
        >
          {isConnecting || isSendBusy ? "Sending..." : "Refine"}
        </Button>
      );
    }

    return (
      <div data-chat-composer-implement-actions="true" className="flex items-center justify-end">
        <Button
          type="submit"
          size="sm"
          className="h-9 rounded-l-full rounded-r-none bg-message-action px-4 text-message-action-foreground hover:bg-message-action-hover sm:h-8"
          {...pointerFocusProps}
          disabled={
            isSendBusy ||
            isSendDisabled ||
            isConnecting ||
            isEnvironmentUnavailable ||
            isSendBlocked
          }
        >
          {isConnecting || isSendBusy ? "Sending..." : "Implement"}
        </Button>
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="sm"
                variant="default"
                className="h-9 rounded-l-none rounded-r-full border-l-message-action-foreground/20 bg-message-action px-2 text-message-action-foreground hover:bg-message-action-hover sm:h-8"
                aria-label="Implementation actions"
                {...pointerFocusProps}
                disabled={
                  isSendBusy ||
                  isSendDisabled ||
                  isConnecting ||
                  isEnvironmentUnavailable ||
                  isSendBlocked
                }
              />
            }
          >
            <ChevronDownIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end" side="top">
            <MenuItem
              disabled={
                isSendBusy ||
                isSendDisabled ||
                isConnecting ||
                isEnvironmentUnavailable ||
                isSendBlocked
              }
              onClick={() => void onImplementPlanInNewThread()}
            >
              Implement in a new thread
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    );
  }

  return sendButton;
});
