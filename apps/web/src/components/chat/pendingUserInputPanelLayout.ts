// The pending-question panel's height is subtracted from the timeline's visible area (ChatView
// feeds the composer overlay in as `contentInsetEndAdjustment`), so collapsing the options is
// how the user gets room back to read the conversation behind the question.

/**
 * Options list bound while expanded, against viewport HEIGHT, not a width breakpoint: on a
 * 577px-tall window `sm:max-h-[22rem]` left the overlay at 112% of the viewport. `min()` keeps
 * 22rem on tall displays and 40% on short ones; `dvh` re-clamps on keyboard or rotation.
 */
export const PENDING_OPTIONS_MAX_HEIGHT_CLASS = "max-h-[min(22rem,40dvh)]";

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
