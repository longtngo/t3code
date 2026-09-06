/**
 * Whether a keyboard event landed inside something the user is typing into.
 *
 * Window-level shortcuts have to ask this before acting, or they steal keys from
 * whatever has focus. `SettingsSidebarNav` and `KeybindingsSettings` carry
 * near-copies of this test, each with an extra clause of its own, so this stays
 * local to the settings-page rule rather than pretending to be the one version.
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
