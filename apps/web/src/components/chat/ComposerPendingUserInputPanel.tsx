import { type ApprovalRequestId } from "@t3tools/contracts";
import { memo, useCallback, useEffect, useId, useRef, useState } from "react";
import { type PendingUserInput } from "../../session-logic";
import {
  derivePendingUserInputProgress,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import {
  describePendingOptionsVisibility,
  PENDING_OPTIONS_MAX_HEIGHT_CLASS,
} from "./pendingUserInputPanelLayout";

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
  const optionsListRef = useRef<HTMLDivElement | null>(null);
  const optionsListId = useId();
  // Collapsing hides the options so the conversation behind the panel can be
  // read before answering. The panel is keyed by `requestId`, so it does NOT
  // remount when `questionIndex` advances within a multi-question prompt —
  // without the reset below a collapse would carry over and hide the next
  // question's options.
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [optimisticSingleSelect, setOptimisticSingleSelect] = useState<{
    questionId: string;
    optionLabel: string;
  } | null>(null);

  useEffect(() => {
    setIsCollapsed(false);
  }, [questionIndex]);

  useEffect(() => {
    onAdvanceRef.current = onAdvance;
  }, [onAdvance]);

  useEffect(() => {
    if (!activeQuestion || activeQuestion.multiSelect || !optimisticSingleSelect) {
      return;
    }
    if (optimisticSingleSelect.questionId !== activeQuestion.id) {
      setOptimisticSingleSelect(null);
      return;
    }
    if (
      progress.customAnswer.trim().length === 0 &&
      progress.selectedOptionLabels.includes(optimisticSingleSelect.optionLabel)
    ) {
      setOptimisticSingleSelect(null);
    }
  }, [
    activeQuestion,
    optimisticSingleSelect,
    progress.customAnswer,
    progress.selectedOptionLabels,
  ]);

  // Clear auto-advance timer on unmount
  useEffect(() => {
    return () => {
      if (autoAdvanceTimerRef.current !== null) {
        window.clearTimeout(autoAdvanceTimerRef.current);
      }
    };
  }, []);

  // useCallback rather than useEffectEvent, taking upstream's #6646 fix ("keep
  // multi-select questions open after the first click"). Both forms already had
  // the multi-select early return, so the bug was in the effect-event semantics
  // themselves, not the branch — and this fork used the same pattern, so it
  // carried the same defect. The fork's extra `optionIndex` and its reveal
  // behaviour ride on top of the fix rather than replacing it.
  const handleOptionSelection = useCallback(
    (questionId: string, optionLabel: string, optionIndex: number) => {
      // A number-key shortcut can target an option scrolled below the fold of
      // the bounded list, or hidden outright by a collapse. Reveal it either
      // way so a selection is never invisible. `scrollIntoView` runs after the
      // expand has painted, and no-ops when the option is already in view.
      setIsCollapsed(false);
      window.requestAnimationFrame(() => {
        optionsListRef.current
          ?.querySelector(`[data-option-index="${optionIndex}"]`)
          ?.scrollIntoView({ block: "nearest" });
      });

      if (activeQuestion?.multiSelect) {
        onToggleOption(questionId, optionLabel);
        return;
      }
      setOptimisticSingleSelect({ questionId, optionLabel });
      onToggleOption(questionId, optionLabel);
      if (autoAdvanceTimerRef.current !== null) {
        window.clearTimeout(autoAdvanceTimerRef.current);
      }
      autoAdvanceTimerRef.current = window.setTimeout(() => {
        autoAdvanceTimerRef.current = null;
        onAdvanceRef.current();
      }, 200);
    },
    [activeQuestion, onToggleOption],
  );

  // Keyboard shortcut: number keys 1-9 select corresponding options when focus is
  // outside editable fields. Multi-select prompts toggle options in place; single-
  // select prompts keep the existing auto-advance behavior.
  useEffect(() => {
    if (!activeQuestion || isResponding) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
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
      handleOptionSelection(activeQuestion.id, option.label, optionIndex);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
    // handleOptionSelection is a dependency now that it is a useCallback: its
    // identity changes with the active question, and the listener must close
    // over the current one (upstream #6646).
  }, [activeQuestion, handleOptionSelection, isResponding]);

  if (!activeQuestion) {
    return null;
  }

  const customAnswerActive = progress.customAnswer.trim().length > 0;
  const visibility = describePendingOptionsVisibility({
    optionCount: activeQuestion.options.length,
    isCollapsed,
  });

  return (
    <div className="px-4 py-3 sm:px-5">
      <div className="mb-2 flex items-center gap-3">
        <span className="text-secondary-label text-[11px] font-semibold tracking-widest uppercase">
          {activeQuestion.header}
        </span>
        {prompt.questions.length > 1 ? (
          <span className="flex h-5 items-center rounded-md bg-muted/60 px-1.5 text-secondary-label text-[10px] font-medium tabular-nums">
            {questionIndex + 1}/{prompt.questions.length}
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => setIsCollapsed((collapsed) => !collapsed)}
          aria-expanded={!isCollapsed}
          aria-controls={optionsListId}
          aria-label={visibility.toggleLabel}
          title={visibility.toggleTitle}
          className="-my-1 ml-auto flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-secondary-label outline-none transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:ring-1 focus-visible:ring-primary/25"
        >
          {isCollapsed ? (
            <ChevronUpIcon className="size-4" />
          ) : (
            <ChevronDownIcon className="size-4" />
          )}
        </button>
      </div>
      <p className="text-sm text-foreground/90">{activeQuestion.question}</p>
      {activeQuestion.multiSelect ? (
        <p className="mt-1 text-secondary-label text-xs">Select one or more options.</p>
      ) : null}
      {isCollapsed ? (
        <button
          type="button"
          onClick={() => setIsCollapsed(false)}
          className="mt-2 cursor-pointer rounded-md text-secondary-label text-xs underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-1 focus-visible:ring-primary/25"
        >
          {visibility.hintLabel}
        </button>
      ) : null}
      <div
        ref={optionsListRef}
        id={optionsListId}
        // Kept mounted while collapsed (display:none, so it is out of the
        // a11y tree and costs no height) so `aria-controls` always resolves
        // and the list keeps its scroll position across a collapse.
        className={cn(
          "mt-3 space-y-1.5 overflow-y-auto overscroll-contain pr-1",
          PENDING_OPTIONS_MAX_HEIGHT_CLASS,
          isCollapsed && "hidden",
        )}
      >
        {activeQuestion.options.map((option, index) => {
          const isOptimisticallySelected =
            optimisticSingleSelect?.questionId === activeQuestion.id &&
            optimisticSingleSelect.optionLabel === option.label;
          const isSelected =
            isOptimisticallySelected ||
            (!customAnswerActive && progress.selectedOptionLabels.includes(option.label));
          const shortcutKey = index < 9 ? index + 1 : null;
          const className = cn(
            "group flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left outline-none transition-all duration-150 focus-visible:border-primary/40 focus-visible:ring-1 focus-visible:ring-primary/25",
            isSelected
              ? "border-primary/30 bg-primary/8 text-foreground"
              : "border-transparent bg-muted/22 text-foreground/85 hover:border-border/45 hover:bg-muted/34",
            isResponding && "opacity-50 cursor-not-allowed",
            !isResponding && "cursor-pointer",
          );
          const content = (
            <>
              <div className="min-w-0 flex-1 flex flex-col gap-0.5">
                <span className="text-sm font-medium">{option.label}</span>
                {option.description && option.description !== option.label ? (
                  <span className="text-secondary-label text-xs">{option.description}</span>
                ) : null}
              </div>
              {isSelected ? (
                <CheckIcon className="size-3.5 shrink-0 text-primary" />
              ) : shortcutKey !== null ? (
                <kbd
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded border border-border/50 text-[11px] font-medium tabular-nums transition-colors duration-150",
                    "bg-background/35 text-secondary-label group-hover:border-border/70 group-hover:text-foreground",
                  )}
                >
                  {shortcutKey}
                </kbd>
              ) : null}
            </>
          );
          return (
            <button
              key={`${activeQuestion.id}:${option.label}`}
              type="button"
              data-option-index={index}
              disabled={isResponding}
              onClick={() => {
                handleOptionSelection(activeQuestion.id, option.label, index);
              }}
              className={className}
            >
              {content}
            </button>
          );
        })}
      </div>
    </div>
  );
});
