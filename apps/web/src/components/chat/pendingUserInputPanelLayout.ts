import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

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

export function describePendingOptionsVisibility(
  input: {
    readonly optionCount: number;
    readonly isCollapsed: boolean;
  },
  resolve: MessageResolver = m,
): PendingOptionsVisibility {
  const hintLabel = resolve(
    msg("{count, plural, one {{count} option hidden} other {{count} options hidden}}", {
      count: input.optionCount,
    }),
  );
  if (input.isCollapsed) {
    const show = resolve(msg("Show options"));
    return { toggleLabel: show, toggleTitle: show, hintLabel };
  }
  return {
    toggleLabel: resolve(msg("Hide options")),
    toggleTitle: resolve(msg("Hide options to read the chat behind")),
    hintLabel,
  };
}
