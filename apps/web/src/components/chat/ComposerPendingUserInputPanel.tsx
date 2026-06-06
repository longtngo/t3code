import { type ApprovalRequestId } from "@t3tools/contracts";
import { memo, useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { type PendingUserInput } from "../../session-logic";
import {
  derivePendingUserInputProgress,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import { CheckIcon, ChevronDownIcon, ChevronUpIcon, RotateCcwIcon } from "lucide-react";
import { cn } from "~/lib/utils";

// Bounds for the user-draggable options height (px). The lower bound keeps a
// couple of options visible; the upper bound is resolved against the viewport
// at drag time so the panel can never fully swallow the chat behind it. A
// render-time `max-h-[80dvh]` cap (see the options list) re-clamps the stored
// height if the viewport later shrinks (mobile keyboard, rotation).
const MIN_OPTIONS_HEIGHT = 72;
const MAX_OPTIONS_HEIGHT_VH = 0.8;
// Height step (px) for keyboard ArrowUp/ArrowDown resize on the focused handle.
const RESIZE_KEY_STEP = 40;

interface PendingUserInputPanelProps {
  pendingUserInputs: PendingUserInput[];
  respondingRequestIds: ApprovalRequestId[];
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onToggleOption: (questionId: string, optionLabel: string) => void;
  onAdvance: () => void;
}

export const ComposerPendingUserInputPanel = memo(function ComposerPendingUserInputPanel({
  pendingUserInputs,
  respondingRequestIds,
  answers,
  questionIndex,
  onToggleOption,
  onAdvance,
}: PendingUserInputPanelProps) {
  if (pendingUserInputs.length === 0) return null;
  const activePrompt = pendingUserInputs[0];
  if (!activePrompt) return null;

  return (
    <ComposerPendingUserInputCard
      key={activePrompt.requestId}
      prompt={activePrompt}
      isResponding={respondingRequestIds.includes(activePrompt.requestId)}
      answers={answers}
      questionIndex={questionIndex}
      onToggleOption={onToggleOption}
      onAdvance={onAdvance}
    />
  );
});

const ComposerPendingUserInputCard = memo(function ComposerPendingUserInputCard({
  prompt,
  isResponding,
  answers,
  questionIndex,
  onToggleOption,
  onAdvance,
}: {
  prompt: PendingUserInput;
  isResponding: boolean;
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onToggleOption: (questionId: string, optionLabel: string) => void;
  onAdvance: () => void;
}) {
  const progress = derivePendingUserInputProgress(prompt.questions, answers, questionIndex);
  const activeQuestion = progress.activeQuestion;
  const autoAdvanceTimerRef = useRef<number | null>(null);
  const onAdvanceRef = useRef(onAdvance);

  // Collapse hides the options so the chat behind the panel can be read before
  // deciding; the drag grabber lets the user fine-tune the options height. A
  // null height falls back to the default responsive cap.
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [optionsHeight, setOptionsHeight] = useState<number | null>(null);
  const optionsListRef = useRef<HTMLDivElement>(null);
  const resizeStateRef = useRef<{ startY: number; startHeight: number; maxHeight: number } | null>(
    null,
  );

  // The card is keyed by requestId, so it does not remount when the active
  // question advances within a multi-question prompt. Reset the collapse/height
  // overrides on each question so a new question never inherits a hidden options
  // list or a height fine-tuned for a different option count.
  useEffect(() => {
    setIsCollapsed(false);
    setOptionsHeight(null);
  }, [questionIndex]);

  const handleResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const list = optionsListRef.current;
      if (!list) return;
      event.preventDefault();
      const startHeight = optionsHeight ?? list.getBoundingClientRect().height;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        return;
      }
      resizeStateRef.current = {
        startY: event.clientY,
        startHeight,
        maxHeight: window.innerHeight * MAX_OPTIONS_HEIGHT_VH,
      };
    },
    [optionsHeight],
  );

  const handleResizePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const resizeState = resizeStateRef.current;
    if (!resizeState) return;
    // Drag ended without us seeing pointerup (capture lost): stop resizing.
    if (event.buttons === 0) {
      resizeStateRef.current = null;
      return;
    }
    // Panel grows upward from the composer, so dragging up (smaller clientY)
    // makes the options list taller.
    const delta = resizeState.startY - event.clientY;
    const next = Math.max(
      MIN_OPTIONS_HEIGHT,
      Math.min(resizeState.maxHeight, resizeState.startHeight + delta),
    );
    setOptionsHeight(next);
  }, []);

  // pointerup / pointercancel / lostpointercapture all end the drag; the browser
  // auto-releases the capture on pointerup so no explicit release is needed.
  const handleResizePointerUp = useCallback(() => {
    resizeStateRef.current = null;
  }, []);

  const handleResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      const current =
        optionsHeight ?? optionsListRef.current?.getBoundingClientRect().height ?? MIN_OPTIONS_HEIGHT;
      const step = event.key === "ArrowUp" ? RESIZE_KEY_STEP : -RESIZE_KEY_STEP;
      const maxHeight = window.innerHeight * MAX_OPTIONS_HEIGHT_VH;
      setOptionsHeight(Math.max(MIN_OPTIONS_HEIGHT, Math.min(maxHeight, current + step)));
    },
    [optionsHeight],
  );

  useEffect(() => {
    onAdvanceRef.current = onAdvance;
  }, [onAdvance]);

  // Clear auto-advance timer on unmount
  useEffect(() => {
    return () => {
      if (autoAdvanceTimerRef.current !== null) {
        window.clearTimeout(autoAdvanceTimerRef.current);
      }
    };
  }, []);

  const handleOptionSelection = useEffectEvent((questionId: string, optionLabel: string) => {
    onToggleOption(questionId, optionLabel);
    if (activeQuestion?.multiSelect) {
      return;
    }
    if (autoAdvanceTimerRef.current !== null) {
      window.clearTimeout(autoAdvanceTimerRef.current);
    }
    autoAdvanceTimerRef.current = window.setTimeout(() => {
      autoAdvanceTimerRef.current = null;
      onAdvanceRef.current();
    }, 200);
  });

  // Keyboard shortcut: number keys 1-9 select corresponding options when focus is
  // outside editable fields. Multi-select prompts toggle options in place; single-
  // select prompts keep the existing auto-advance behavior.
  useEffect(() => {
    if (!activeQuestion || isResponding) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        return;
      }
      if (
        target instanceof HTMLElement &&
        target.closest('[contenteditable]:not([contenteditable="false"])')
      ) {
        return;
      }
      const digit = Number.parseInt(event.key, 10);
      if (Number.isNaN(digit) || digit < 1 || digit > 9) return;
      const optionIndex = digit - 1;
      if (optionIndex >= activeQuestion.options.length) return;
      const option = activeQuestion.options[optionIndex];
      if (!option) return;
      event.preventDefault();
      handleOptionSelection(activeQuestion.id, option.label);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [activeQuestion, isResponding]);

  if (!activeQuestion) {
    return null;
  }

  return (
    <div className="px-4 py-3 sm:px-5">
      {!isCollapsed ? (
        // Negative insets bleed the grabber to the card edges so the whole top
        // strip is draggable; they mirror the parent padding (px-4 py-3 sm:px-5)
        // and must be kept in sync with it.
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize options"
          tabIndex={0}
          onPointerDown={handleResizePointerDown}
          onPointerMove={handleResizePointerMove}
          onPointerUp={handleResizePointerUp}
          onPointerCancel={handleResizePointerUp}
          onLostPointerCapture={handleResizePointerUp}
          onKeyDown={handleResizeKeyDown}
          onDoubleClick={() => setOptionsHeight(null)}
          className="group -mx-4 -mt-2 mb-0.5 flex h-7 cursor-ns-resize touch-none items-center justify-center outline-none sm:-mx-5"
        >
          <span className="h-1 w-9 rounded-full bg-muted-foreground/25 transition-colors group-hover:bg-muted-foreground/45 group-focus-visible:bg-muted-foreground/60" />
        </div>
      ) : null}
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {prompt.questions.length > 1 ? (
            <span className="flex h-5 items-center rounded-md bg-muted/60 px-1.5 text-[10px] font-medium tabular-nums text-muted-foreground/60">
              {questionIndex + 1}/{prompt.questions.length}
            </span>
          ) : null}
          <span className="truncate text-[11px] font-semibold tracking-widest text-muted-foreground/50 uppercase">
            {activeQuestion.header}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {optionsHeight !== null && !isCollapsed ? (
            <button
              type="button"
              onClick={() => setOptionsHeight(null)}
              aria-label="Reset options height"
              title="Reset height"
              className="flex size-6 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-muted/40 hover:text-muted-foreground/80"
            >
              <RotateCcwIcon className="size-3.5" />
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setIsCollapsed((collapsed) => !collapsed)}
            aria-expanded={!isCollapsed}
            aria-label={isCollapsed ? "Show options" : "Hide options"}
            title={isCollapsed ? "Show options" : "Hide options to read the chat behind"}
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-muted/40 hover:text-muted-foreground/80"
          >
            {isCollapsed ? (
              <ChevronUpIcon className="size-4" />
            ) : (
              <ChevronDownIcon className="size-4" />
            )}
          </button>
        </div>
      </div>
      <p className="mt-1.5 text-sm text-foreground/90">{activeQuestion.question}</p>
      {isCollapsed ? (
        <button
          type="button"
          onClick={() => setIsCollapsed(false)}
          className="mt-1 text-left text-xs text-muted-foreground/55 transition-colors hover:text-muted-foreground/80"
        >
          {activeQuestion.options.length} option{activeQuestion.options.length === 1 ? "" : "s"}{" "}
          hidden — tap to show.
        </button>
      ) : (
        <>
          {activeQuestion.multiSelect ? (
            <p className="mt-1 text-xs text-muted-foreground/65">Select one or more options.</p>
          ) : null}
          <div
            ref={optionsListRef}
            data-pending-options-list="true"
            style={optionsHeight !== null ? { height: optionsHeight } : undefined}
            className={cn(
              "mt-3 space-y-1 overflow-y-auto pr-1",
              // Default: shorter on phones, roomier on desktop. When the user has
              // dragged an explicit height, still clamp to the dynamic viewport so
              // a keyboard/rotation shrink can't let it swallow the chat.
              optionsHeight === null ? "max-h-[40dvh] sm:max-h-[22rem]" : "max-h-[80dvh]",
            )}
          >
            {activeQuestion.options.map((option, index) => {
              const isSelected = progress.selectedOptionLabels.includes(option.label);
              const shortcutKey = index < 9 ? index + 1 : null;
              return (
                <button
                  key={`${activeQuestion.id}:${option.label}`}
                  type="button"
                  disabled={isResponding}
                  onClick={() => handleOptionSelection(activeQuestion.id, option.label)}
                  className={cn(
                    "group flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-all duration-150",
                    isSelected
                      ? "border-blue-500/40 bg-blue-500/8 text-foreground"
                      : "border-transparent bg-muted/20 text-foreground/80 hover:bg-muted/40 hover:border-border/40",
                    isResponding && "opacity-50 cursor-not-allowed",
                  )}
                >
                  {shortcutKey !== null ? (
                    <kbd
                      className={cn(
                        "flex size-5 shrink-0 items-center justify-center rounded text-[11px] font-medium tabular-nums transition-colors duration-150",
                        isSelected
                          ? "bg-blue-500/20 text-blue-400"
                          : "bg-muted/40 text-muted-foreground/50 group-hover:bg-muted/60 group-hover:text-muted-foreground/70",
                      )}
                    >
                      {shortcutKey}
                    </kbd>
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <span className="text-sm font-medium">{option.label}</span>
                    {option.description && option.description !== option.label ? (
                      <span className="ml-2 text-xs text-muted-foreground/50">
                        {option.description}
                      </span>
                    ) : null}
                  </div>
                  {isSelected ? <CheckIcon className="size-3.5 shrink-0 text-blue-400" /> : null}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
});
