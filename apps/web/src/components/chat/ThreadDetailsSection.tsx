import { ChevronDownIcon } from "lucide-react";
import * as Schema from "effect/Schema";
import type { ComponentProps, ReactNode } from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { cn } from "../../lib/utils";

/**
 * Sections share header and content insets in both the sidebar and popover. A `collapseKey`
 * makes the title fold the rows; the choice is per section and per device, so folding Lineage
 * once keeps it folded on every thread. Header actions stay visible while folded.
 */
export function ThreadDetailsSection({
  headingId,
  title,
  actions,
  collapseKey,
  separated = true,
  showHeading = true,
  children,
  ...props
}: Omit<ComponentProps<"section">, "className" | "style" | "title" | "aria-labelledby"> & {
  headingId: string;
  title: string;
  actions?: ReactNode;
  collapseKey?: "tasks" | "background" | "lineage" | undefined;
  separated?: boolean;
  showHeading?: boolean;
}) {
  const [collapsed, setCollapsed] = useLocalStorage(
    `t3code:thread-details:collapsed:${collapseKey ?? "none"}`,
    false,
    Schema.Boolean,
  );
  const folded = collapseKey !== undefined && collapsed;
  return (
    <section
      {...props}
      aria-labelledby={showHeading ? headingId : undefined}
      aria-label={showHeading ? undefined : title}
      className={cn("px-2 pt-2 pb-2.5", separated && "border-t border-border/65", folded && "pb-2")}
    >
      <div
        className={cn(
          "flex min-h-8 min-w-0 items-center justify-between gap-2 px-1.5",
          !folded && "mb-1",
          !showHeading && "hidden",
        )}
      >
        <h3
          id={headingId}
          className="min-w-0 truncate text-2xs font-medium text-muted-foreground select-none"
        >
          {collapseKey === undefined ? (
            title
          ) : (
            <button
              type="button"
              aria-expanded={!folded}
              onClick={() => setCollapsed(!folded)}
              className="flex max-w-full cursor-pointer items-center gap-1 rounded-sm hover:text-foreground/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
            >
              <span className="truncate">{title}</span>
              <ChevronDownIcon
                aria-hidden
                className={cn("size-3 shrink-0 transition-transform", !folded && "rotate-180")}
              />
            </button>
          )}
        </h3>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
      {folded ? null : children}
    </section>
  );
}
