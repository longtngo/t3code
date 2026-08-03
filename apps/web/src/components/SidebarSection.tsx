import type { ReactNode } from "react";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, LoaderIcon, XIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import type { SidebarItemStatus } from "../sidebarSections";

/** Visual tone of a status glyph, shared by plan steps and background/agent rows. */
export type StatusGlyphTone = "completed" | "running" | "failed" | "idle";

const STATUS_GLYPH_WRAPPER = "flex size-5 shrink-0 items-center justify-center rounded-full";

/** The shared status-glyph markup for background/agent rows. */
function statusGlyph(tone: StatusGlyphTone): ReactNode {
  if (tone === "completed") {
    return (
      <span className={cn(STATUS_GLYPH_WRAPPER, "bg-emerald-500/15 text-emerald-500")}>
        <CheckIcon className="size-3" />
      </span>
    );
  }
  if (tone === "failed") {
    return (
      <span className={cn(STATUS_GLYPH_WRAPPER, "bg-red-500/15 text-red-500")}>
        <XIcon className="size-3" />
      </span>
    );
  }
  if (tone === "running") {
    return (
      <span className={cn(STATUS_GLYPH_WRAPPER, "bg-blue-500/15 text-blue-400")}>
        <LoaderIcon className="size-3 animate-spin" />
      </span>
    );
  }
  return (
    <span className={cn(STATUS_GLYPH_WRAPPER, "border border-border/60 bg-muted/30")}>
      <span className="size-1.5 rounded-full bg-muted-foreground/30" />
    </span>
  );
}

/** Status glyph for a background/agent sidebar row. */
export function sidebarStatusIcon(status: SidebarItemStatus): ReactNode {
  return statusGlyph(status);
}

/**
 * A collapsible sidebar section with a header (label + count + chevron). Uses
 * the same manual disclosure pattern as the existing "Full Plan" toggle.
 */
export function SidebarSection({
  title,
  count,
  collapsed,
  onToggle,
  children,
}: {
  title: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <button
        type="button"
        className="group flex w-full items-center gap-1.5 text-left"
        onClick={onToggle}
        aria-expanded={!collapsed}
      >
        {collapsed ? (
          <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/40" />
        ) : (
          <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground/40" />
        )}
        <span className="text-[10px] font-semibold tracking-widest text-muted-foreground/40 uppercase group-hover:text-muted-foreground/60">
          {title}
        </span>
        <span className="text-[10px] font-semibold text-muted-foreground/30">{count}</span>
      </button>
      {collapsed ? null : <div className="space-y-1">{children}</div>}
    </div>
  );
}

/**
 * A clickable background/agent row: status glyph + label, with a hover remove
 * (×) for finished items. `selected` highlights the row whose detail is open.
 */
export function SidebarItemRow({
  status,
  label,
  detail,
  selected,
  onSelect,
  onRemove,
}: {
  status: SidebarItemStatus;
  label: string;
  detail?: string | undefined;
  selected: boolean;
  onSelect: () => void;
  onRemove?: (() => void) | undefined;
}) {
  return (
    <div
      className={cn(
        "group/row relative flex items-center rounded-lg",
        selected && "bg-accent/60",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2 text-left"
      >
        <span className="shrink-0">{sidebarStatusIcon(status)}</span>
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block truncate text-[13px] leading-snug",
              status === "completed" || status === "failed"
                ? "text-muted-foreground/60"
                : "text-foreground/90",
            )}
          >
            {label}
          </span>
          {detail ? (
            <span className="block truncate text-[11px] text-muted-foreground/50">{detail}</span>
          ) : null}
        </span>
      </button>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove"
          className="absolute right-1.5 hidden size-5 items-center justify-center rounded text-muted-foreground/50 hover:bg-muted/60 hover:text-foreground/80 group-hover/row:flex"
        >
          <XIcon className="size-3" />
        </button>
      ) : null}
    </div>
  );
}
