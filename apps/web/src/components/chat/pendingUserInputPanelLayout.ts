// The pending-question panel docks above the composer and its height is
// subtracted from the timeline's visible area (ChatView measures the composer
// overlay and feeds it to the list as `contentInsetEndAdjustment`). Collapsing
// the options is how the user gets that space back to read the conversation
// behind the question.

/** Options list bound while expanded. `dvh` so the mobile keyboard or a rotation re-clamps it. */
export const PENDING_OPTIONS_MAX_HEIGHT_CLASS = "max-h-[40dvh] sm:max-h-[22rem]";

export interface PendingOptionsVisibility {
  readonly toggleLabel: string;
  readonly toggleTitle: string;
  readonly hintLabel: string;
}

export function describePendingOptionsVisibility(input: {
  readonly optionCount: number;
  readonly isCollapsed: boolean;
}): PendingOptionsVisibility {
  const noun = input.optionCount === 1 ? "option" : "options";
  const hintLabel = `${input.optionCount} ${noun} hidden`;
  return input.isCollapsed
    ? { toggleLabel: "Show options", toggleTitle: "Show options", hintLabel }
    : {
        toggleLabel: "Hide options",
        toggleTitle: "Hide options to read the chat behind",
        hintLabel,
      };
}
