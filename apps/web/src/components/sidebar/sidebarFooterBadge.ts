import { SEVERITY_BG, type Severity } from "~/lib/vitals";

/**
 * The count badge shared by the sidebar footer's status controls.
 *
 * Resource Queue and Local models sit side by side in one ~16rem row, so a count that is a
 * pill on one and a bare number beside a dot on the other reads as two unrelated widgets. The
 * geometry and the tone vocabulary live here rather than in either component, which is what
 * keeps them the same shape as controls are added and restyled.
 */
export type SidebarFooterBadgeTone = "idle" | "active" | "pending";

const BADGE_BASE = "min-w-[15px] rounded-full px-1 py-px text-center text-[10px] tabular-nums";

const BADGE_TONE: Record<SidebarFooterBadgeTone, string> = {
  // Nothing happening: the badge recedes into the row rather than colouring it.
  idle: "bg-accent font-medium text-muted-foreground",
  active: "bg-emerald-500 font-semibold text-emerald-950",
  pending: "bg-amber-500 font-semibold text-amber-950",
};

export function sidebarFooterBadgeClass(tone: SidebarFooterBadgeTone): string {
  return `${BADGE_BASE} ${BADGE_TONE[tone]}`;
}

/** A percentage badge coloured by the same severity as the usage bar it summarises. */
export function sidebarFooterSeverityBadgeClass(level: Severity): string {
  return `${BADGE_BASE} ${SEVERITY_BG[level]} font-semibold text-black`;
}

/**
 * The footer's status controls themselves: a compact, auto-width pill holding an icon and a
 * badge. A plain button rather than a restyled `SidebarMenuButton`, because this look belongs
 * to these controls and `components/ui` exports own theirs.
 */
export const SIDEBAR_FOOTER_CONTROL_CLASS =
  "flex h-8 w-auto shrink-0 cursor-pointer items-center gap-1 overflow-hidden rounded-lg px-1.5 text-muted-foreground/70 text-xs outline-hidden ring-ring transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50 [&>svg]:shrink-0";
