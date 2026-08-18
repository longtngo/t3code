import { memo } from "react";
import { FolderGitIcon, FolderIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { ComposerControl, ComposerControlChevron, ComposerControlIcon } from "./ComposerControl";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const COMPOSER_CONTEXT_STRIP_ID = "composer-context-strip";

/**
 * Collapses and restores the composer's workspace/branch context strip.
 *
 * Deliberately icon-only. The strip's own labels already collapse to nothing
 * once it overflows (`useLabelsOverflow` sets `data-compact`, which animates
 * every label to `max-w-0`), so a labelled trigger would read well for `main`
 * and degrade to an ellipsis for a real branch name while competing with the
 * model picker for room. The icon costs the same width at every name length.
 *
 * Icon-only is the only way it differs from its neighbours: it is built from
 * the same `ComposerControl` primitives as the model and runtime-mode pickers,
 * so height, padding, icon size, and muted tone all come from one place rather
 * than being re-specified here and drifting out of step with the row.
 *
 * The glyph is the one piece of state that survives to zero label width, so it
 * tracks the workspace rather than being decorative: a worktree run and a local
 * checkout are visibly different while the strip is closed.
 */
export const ComposerContextStripToggle = memo(function ComposerContextStripToggle({
  collapsed,
  worktreeActive,
  onToggle,
}: {
  collapsed: boolean;
  worktreeActive: boolean;
  onToggle: () => void;
}) {
  const WorkspaceIcon = worktreeActive ? FolderGitIcon : FolderIcon;
  const label = collapsed ? "Show workspace" : "Hide workspace";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ComposerControl
            type="button"
            className="shrink-0"
            aria-label={label}
            aria-expanded={!collapsed}
            aria-controls={COMPOSER_CONTEXT_STRIP_ID}
            data-composer-context-strip-toggle="true"
            onClick={onToggle}
          />
        }
      >
        <ComposerControlIcon icon={WorkspaceIcon} />
        <ComposerControlChevron
          className={cn("transition-transform duration-150", !collapsed && "rotate-180")}
        />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
});
