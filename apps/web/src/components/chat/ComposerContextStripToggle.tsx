import { memo } from "react";
import { FolderGitIcon, FolderIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { ComposerControl, ComposerControlChevron, ComposerControlIcon } from "./ComposerControl";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const COMPOSER_CONTEXT_STRIP_ID = "composer-context-strip";

/**
 * Collapses and restores the composer's context strip. Icon-only because the strip's labels
 * collapse to `max-w-0` on overflow, so a label would degrade to an ellipsis; otherwise built
 * from the same `ComposerControl` primitives as its neighbours. The glyph tracks the workspace
 * (worktree vs local checkout), the only state visible while the strip is closed.
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
