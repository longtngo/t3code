import { type RuntimeRequestId, type ScopedThreadRef } from "@t3tools/contracts";
import { memo, use, useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { BackgroundThreadContext } from "./backgroundThread";
import { useStableCallback } from "~/hooks/useStableCallback";
import { type PendingUserInput } from "../../session-logic";
import {
  derivePendingUserInputProgress,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import { CheckIcon, ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import {
  describePendingOptionsVisibility,
  PENDING_OPTIONS_MAX_HEIGHT_CLASS,
} from "./pendingUserInputPanelLayout";
import ChatMarkdown from "../ChatMarkdown";

interface PendingUserInputPanelProps {
  pendingUserInputs: PendingUserInput[];
  cwd: string | undefined;
  threadRef: ScopedThreadRef;
  disabled?: boolean;
  respondingRequestIds: RuntimeRequestId[];
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onToggleOption: (questionId: string, optionValue: string) => void;
  onAdvance: () => void;
  onDismiss: (requestId: RuntimeRequestId) => void;
}

export const ComposerPendingUserInputPanel = memo(function ComposerPendingUserInputPanel({
  pendingUserInputs,
  cwd,
  threadRef,
  disabled = false,
  respondingRequestIds,
  answers,
  questionIndex,
  onToggleOption,
  onAdvance,
  onDismiss,
}: PendingUserInputPanelProps) {
  if (pendingUserInputs.length === 0) return null;
  const activePrompt = pendingUserInputs[0];
  if (!activePrompt) return null;

  return (
    <ComposerPendingUserInputCard
      key={activePrompt.requestId}
      prompt={activePrompt}
      cwd={cwd}
      threadRef={threadRef}
      disabled={disabled}
      isResponding={respondingRequestIds.includes(activePrompt.requestId)}
      answers={answers}
      questionIndex={questionIndex}
      onToggleOption={onToggleOption}
      onAdvance={onAdvance}
      onDismiss={onDismiss}
    />
  );
});

const ComposerPendingUserInputCard = memo(function ComposerPendingUserInputCard({
  prompt,
  cwd,
  threadRef,
  disabled,
  isResponding,
  answers,
  questionIndex,
  onToggleOption,
  onAdvance,
  onDismiss,
}: {
  prompt: PendingUserInput;
  cwd: string | undefined;
  threadRef: ScopedThreadRef;
  disabled: boolean;
  isResponding: boolean;
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onToggleOption: (questionId: string, optionValue: string) => void;
  onAdvance: () => void;
  onDismiss: (requestId: RuntimeRequestId) => void;
}) {
  // Message-mode requests remain answerable after their provider turn ends.
  const canRespond = prompt.responseCapability !== "not_resumable";
  const responseDisabled = disabled || isResponding || !canRespond;
  const autoAdvanceTimerRef = useRef<number | null>(null);
  // The auto-advance timer fires after the render that armed it.
  const advance = useStableCallback(onAdvance);
  const optionsListRef = useRef<HTMLDivElement | null>(null);
  const optionsListId = useId();
  // Collapsing hides the options so the thread behind can be read. The card is keyed by
  // `requestId` and does not remount as `questionIndex` advances, so storing the collapsed
  // question's id (not a flag) is the reset: a collapse never hides the next question's options.
  const [collapsedQuestionId, setCollapsedQuestionId] = useState<string | null>(null);
  const [optimisticSingleSelect, setOptimisticSingleSelect] = useState<{
    questionId: string;
    optionValue: string;
  } | null>(null);

  const progress = derivePendingUserInputProgress(prompt.questions, answers, questionIndex);
  const activeQuestion = progress.activeQuestion;
  const customAnswerActive = progress.customAnswer.trim().length > 0;
  // Read here, before the hooks below, so the compiler can keep `activeQuestion` cached.
  const draftSelectedOptions = activeQuestion?.options.map(
    (option) =>
      !customAnswerActive && progress.selectedOptionValues.includes(option.value ?? option.label),
  );
  const isCollapsed = collapsedQuestionId !== null && collapsedQuestionId === activeQuestion?.id;
  const setIsCollapsed = (collapsed: boolean) =>
    setCollapsedQuestionId(collapsed ? (activeQuestion?.id ?? null) : null);

  // The optimistic pick is dropped once the draft confirms it or the question moves on.
  if (
    optimisticSingleSelect &&
    activeQuestion &&
    !activeQuestion.multiSelect &&
    (optimisticSingleSelect.questionId !== activeQuestion.id ||
      (!customAnswerActive &&
        progress.selectedOptionValues.includes(optimisticSingleSelect.optionValue)))
  ) {
    setOptimisticSingleSelect(null);
  }

  // A delayed answer only advances its own question, while permission remains granted.
  useEffect(() => {
    const clearAutoAdvance = () => {
      if (autoAdvanceTimerRef.current !== null) {
        window.clearTimeout(autoAdvanceTimerRef.current);
        autoAdvanceTimerRef.current = null;
      }
    };
    if (disabled || activeQuestion?.id === undefined) clearAutoAdvance();
    return clearAutoAdvance;
  }, [activeQuestion?.id, disabled]);

  const handleOptionSelection = (questionId: string, optionValue: string, optionIndex: number) => {
    if (disabled || isResponding) return;
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
      onToggleOption(questionId, optionValue);
      return;
    }
    setOptimisticSingleSelect({ questionId, optionValue });
    onToggleOption(questionId, optionValue);
    if (autoAdvanceTimerRef.current !== null) {
      window.clearTimeout(autoAdvanceTimerRef.current);
    }
    autoAdvanceTimerRef.current = window.setTimeout(() => {
      autoAdvanceTimerRef.current = null;
      advance();
    }, 200);
  };

  const selectOptionFromShortcut = useEffectEvent(handleOptionSelection);
  const backgroundThread = use(BackgroundThreadContext);

  useEffect(() => {
    // FORK: no `isCollapsed` bail - the options list stays mounted through a collapse.
    if (!activeQuestion || responseDisabled || backgroundThread) return;
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
      selectOptionFromShortcut(activeQuestion.id, option.value ?? option.label, optionIndex);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [activeQuestion, backgroundThread, responseDisabled]);

  if (!activeQuestion) {
    return null;
  }

  const visibility = describePendingOptionsVisibility({
    optionCount: activeQuestion.options.length,
    isCollapsed,
  });

  return (
    <div className="px-4 py-3 sm:px-5">
      <div className="mb-2 flex items-center gap-3">
        <span className="text-secondary-label text-2xs font-semibold tracking-widest uppercase">
          {activeQuestion.header}
        </span>
        {prompt.questions.length > 1 ? (
          <span className="flex h-5 items-center rounded-md bg-muted/60 px-1.5 text-secondary-label text-3xs font-medium tabular-nums">
            {questionIndex + 1}/{prompt.questions.length}
          </span>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={() => setIsCollapsed(!isCollapsed)}
                aria-expanded={!isCollapsed}
                aria-controls={optionsListId}
                aria-label={visibility.toggleLabel}
                className="-my-1 ml-auto flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-secondary-label outline-none transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/25"
              />
            }
          >
            {isCollapsed ? (
              <ChevronUpIcon className="size-4" />
            ) : (
              <ChevronDownIcon className="size-4" />
            )}
          </TooltipTrigger>
          <TooltipPopup>{visibility.toggleTitle}</TooltipPopup>
        </Tooltip>
        {prompt.dismissible ? (
          // Async questions only. The fork's header is a plain row rather than
          // upstream's CollapsibleTrigger (see docs/fork/README.md invariant 4),
          // so this is an ordinary sibling button and needs no click containment.
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  disabled={isResponding}
                  data-pending-user-input-dismiss
                  aria-label="Dismiss question without answering"
                  onClick={() => onDismiss(prompt.requestId)}
                  className="-my-1 flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-secondary-label outline-none transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/25 disabled:cursor-not-allowed disabled:opacity-50"
                />
              }
            >
              <XIcon className="size-4" />
            </TooltipTrigger>
            <TooltipPopup>Dismiss question without answering</TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      <ChatMarkdown
        text={activeQuestion.question}
        cwd={cwd}
        threadRef={threadRef}
        className="text-foreground/90"
      />
      {activeQuestion.multiSelect ? (
        <p className="mt-1 text-secondary-label text-xs">Select one or more options.</p>
      ) : null}
      {isCollapsed ? (
        <button
          type="button"
          onClick={() => setIsCollapsed(false)}
          className="mt-2 cursor-pointer rounded-md text-secondary-label text-xs underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/25"
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
          const optionValue = option.value ?? option.label;
          const isOptimisticallySelected =
            optimisticSingleSelect?.questionId === activeQuestion.id &&
            optimisticSingleSelect.optionValue === optionValue;
          const isSelected = isOptimisticallySelected || draftSelectedOptions?.[index] === true;
          const shortcutKey = index < 9 ? index + 1 : null;
          const className = cn(
            "group flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left outline-none transition-all duration-150 focus-visible:border-primary/40 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/25",
            isSelected
              ? "border-primary/30 bg-primary/8 text-foreground"
              : "border-transparent bg-muted/22 text-foreground/85 hover:border-border/45 hover:bg-muted/34",
            (disabled || isResponding) && "opacity-50 cursor-not-allowed",
            !disabled && !isResponding && "cursor-pointer",
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
                    "flex size-5 shrink-0 items-center justify-center rounded border border-border/50 text-2xs font-medium tabular-nums transition-colors duration-150",
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
              key={`${activeQuestion.id}:${optionValue}`}
              type="button"
              aria-pressed={isSelected}
              data-option-index={index}
              disabled={disabled || isResponding}
              onClick={() => {
                handleOptionSelection(activeQuestion.id, optionValue, index);
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
