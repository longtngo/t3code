import { useAtomValue } from "@effect/atom-react";
import { BotIcon } from "lucide-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { threadOffloadedToCursorAtom } from "~/state/subagentOffload";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** The sidebar row's bot icon while the thread's own server offloads its subagents to Cursor
 *  because the thread is set to Cursor (see `threadOffloadedToCursor`). */
export function SidebarThreadSubagentIndicator(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const offloaded = useAtomValue(threadOffloadedToCursorAtom(props.environmentId)(props.threadId));
  if (!offloaded) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label="Subagents set to Cursor"
            data-testid="sidebar-subagent-indicator"
            className="inline-flex shrink-0 items-center justify-center text-muted-foreground"
          >
            <BotIcon className="size-3.5" />
          </span>
        }
      />
      <TooltipPopup side="top">Subagents set to Cursor</TooltipPopup>
    </Tooltip>
  );
}
