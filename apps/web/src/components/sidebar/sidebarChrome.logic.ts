/**
 * The two fork-only footer panels — Local models and Resource Queue — share one positioning
 * context (the footer row's `relative` wrapper) and carry identical `absolute inset` classes, so
 * two open panels occupy the same box. Only one may be open, and `SidebarChromeFooter` owns which.
 */
export type SidebarFooterPanel = "models" | "queue";

/**
 * Resolve the next open panel.
 *
 * The close branch is identity-scoped on purpose, and it is the reason this is a function rather
 * than an inline `setState(null)`. Resource Queue closes on a 160ms mouse-leave timer, so a user
 * who leaves it and opens Local models inside that window would otherwise have the late timer null
 * out the panel they just opened. A close only counts when the panel asking to close is still the
 * one that is open.
 */
export function nextOpenFooterPanel(input: {
  readonly current: SidebarFooterPanel | null;
  readonly panel: SidebarFooterPanel;
  readonly open: boolean;
}): SidebarFooterPanel | null {
  if (input.open) {
    return input.panel;
  }
  return input.current === input.panel ? null : input.current;
}
