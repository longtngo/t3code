import { FoldVerticalIcon } from "lucide-react";

import { cn } from "~/lib/utils";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * The armed-state mark for auto-compact, next to the prompt-shortcut gear above the composer.
 *
 * It renders only while the thread is armed, which makes it a state cue as much as a control:
 * the way in is the thread menu, and this is the way back out, in the place the reader is
 * already looking when they wonder why the thread compacted itself. The status line rides on
 * the tooltip rather than sitting above the input, so an armed thread costs one glyph of
 * chrome instead of a permanent row of text.
 */
export function ComposerAutoCompactControl({
  armed,
  paused,
  status,
  onDisarm,
}: {
  armed: boolean;
  /**
   * The sequence has stopped and will not resume without a message from the user. It is the
   * one state that has to be legible without hovering, since nothing else will say it: the
   * banner that used to carry it is gone.
   */
  paused: boolean;
  /** What the sequence is about to do, or null when there is nothing more to say than "on". */
  status: string | null;
  onDisarm: () => void;
}) {
  if (!armed) return null;
  // The status rides on the accessible name, not only on the tooltip: the tooltip is
  // pointer-only, and this control has to say the same thing in the mobile web view where
  // nothing hovers.
  const description = `${status ?? "Auto-compact is on"}. Click to turn it off.`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={description}
            data-composer-auto-compact-control="true"
            data-auto-compact-paused={paused ? "true" : "false"}
            onClick={onDisarm}
            className={cn(
              "inline-flex shrink-0 items-center rounded-md border p-1.5",
              paused
                ? "border-amber-500/50 bg-amber-500/10 text-amber-600 hover:bg-amber-500/15 dark:text-amber-400"
                : "border-primary/40 bg-primary/10 text-primary hover:bg-primary/15",
            )}
          />
        }
      >
        <FoldVerticalIcon aria-hidden="true" className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-64">
        {description}
      </TooltipPopup>
    </Tooltip>
  );
}
