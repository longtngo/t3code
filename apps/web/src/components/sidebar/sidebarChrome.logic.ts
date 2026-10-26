/**
 * The two fork-only footer panels — Local models and Resource Queue — share one positioning
 * context (the footer row's `relative` wrapper) and carry identical `absolute inset` classes, so
 * two open panels occupy the same box. Only one may be open, and `SidebarChromeFooter` owns which.
 */
export type SidebarFooterPanel = "models" | "queue";

/**
 * Resolve the next open panel. The close branch is identity-scoped: Resource Queue closes on a
 * 160ms mouse-leave timer, which would otherwise null out Local models opened inside that
 * window. A close counts only when the panel asking is still the open one.
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
