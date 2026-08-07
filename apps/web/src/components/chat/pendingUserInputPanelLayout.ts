// The pending-question panel docks above the composer and its height is
// subtracted from the timeline's visible area (ChatView measures the composer
// overlay and feeds it to the list as `contentInsetEndAdjustment`). Collapsing
// the options is how the user gets that space back to read the conversation
// behind the question.

/**
 * Options list bound while expanded.
 *
 * Bounded against the viewport's HEIGHT, not a width breakpoint. A
 * `sm:max-h-[22rem]` pair reads sensibly but keys the cap off viewport width
 * while the thing being protected is vertical space: measured live on a
 * 577px-tall window, `22rem` still left the composer overlay at 112% of the
 * viewport, i.e. no conversation visible at all. `min()` takes whichever bound
 * is tighter, so a tall display keeps the 22rem cap and a short one falls back
 * to 40% of the viewport. `dvh` so the mobile keyboard or a rotation re-clamps.
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
