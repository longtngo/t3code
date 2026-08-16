import { memo } from "react";
import { ChevronDownIcon, FolderGitIcon, FolderIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
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
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="shrink-0 gap-0.5 px-1.5 text-muted-foreground/70 hover:text-foreground/80"
            aria-label={label}
            aria-expanded={!collapsed}
            aria-controls={COMPOSER_CONTEXT_STRIP_ID}
            data-composer-context-strip-toggle="true"
            onClick={onToggle}
          />
        }
      >
        <WorkspaceIcon aria-hidden="true" className="size-3.5 shrink-0" />
        <ChevronDownIcon
          aria-hidden="true"
          className={cn(
            "size-3 shrink-0 opacity-50 transition-transform duration-150",
            !collapsed && "rotate-180",
          )}
        />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
});
