import { PlusIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS } from "./threadDetailsPanelStyles";

const THREAD_DETAILS_SHOW_MORE_PAGE = 12;

/**
 * One windowed list in the thread details card: the first N rows (Settings → thread details rows),
 * then Show more. Only the rows Show more added are state, so a setting change re-windows an open
 * list. Callers key it by thread and list so a new thread or run starts folded back to N.
 */
export function ThreadDetailsRowGroup<Row>(props: {
  readonly label?: string;
  readonly rows: ReadonlyArray<Row>;
  /** Show at least this many rows even past the limit, e.g. to keep the running step in view. */
  readonly minVisible?: number;
  readonly children: (visibleRows: ReadonlyArray<Row>) => ReactNode;
}) {
  const limit = useClientSettings((settings) => settings.threadDetailsSectionRowLimit);
  const [expanded, setExpanded] = useState(props.label === undefined);
  const [extra, setExtra] = useState(0);
  if (props.rows.length === 0) return null;
  const visibleRows = props.rows.slice(0, Math.max(limit + extra, props.minVisible ?? 0));
  const hiddenCount = props.rows.length - visibleRows.length;
  return (
    <div>
      {props.label ? (
        <CollapsibleSectionHeader
          expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          count={expanded ? undefined : props.rows.length}
        >
          {props.label}
        </CollapsibleSectionHeader>
      ) : null}
      {expanded ? (
        <>
          {props.children(visibleRows)}
          {hiddenCount > 0 ? (
            <button
              type="button"
              onClick={() => setExtra(visibleRows.length - limit + THREAD_DETAILS_SHOW_MORE_PAGE)}
              className={`flex h-8 w-full cursor-pointer items-center rounded-lg ${THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS} text-sm font-medium text-muted-foreground/70 hover:bg-black/[0.055] hover:text-foreground/80 dark:hover:bg-white/[0.075]`}
            >
              <PlusIcon aria-hidden className="size-4 shrink-0" />
              Show {Math.min(hiddenCount, THREAD_DETAILS_SHOW_MORE_PAGE)} more
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
