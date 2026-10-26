/**
 * Window-level shortcuts must ask this before acting, or they steal keys from the focused field.
 * `SettingsSidebarNav` and `KeybindingsSettings` carry near-copies with extra clauses of their
 * own, so this stays local to the settings-page rule.
 */
function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
  );
}

/**
 * Whether a window-level Escape should dismiss the settings page.
 *
 * The whole decision lives here so it is testable: the route's listener does no
 * more than call this. `defaultPrevented` keeps element-scoped handlers (the
 * sidebar search, the theme editor) in charge of their own Escape.
 */
export function shouldLeaveSettingsOnEscape(event: {
  readonly key: string;
  readonly defaultPrevented: boolean;
  readonly target: EventTarget | null;
}): boolean {
  if (event.key !== "Escape" || event.defaultPrevented) return false;
  return !isEditableTarget(event.target);
}
