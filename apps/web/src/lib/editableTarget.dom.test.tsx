import { describe, expect, it } from "vite-plus/test";

import { shouldLeaveSettingsOnEscape } from "./editableTarget";

function element(tag: string, contentEditable = false): HTMLElement {
  const node = document.createElement(tag);
  if (contentEditable) node.contentEditable = "true";
  return node;
}

describe("shouldLeaveSettingsOnEscape", () => {
  const event = (over: Partial<Parameters<typeof shouldLeaveSettingsOnEscape>[0]> = {}) => ({
    key: "Escape",
    defaultPrevented: false,
    target: element("div"),
    ...over,
  });

  it("leaves on a plain Escape", () => {
    expect(shouldLeaveSettingsOnEscape(event())).toBe(true);
  });

  it("stays put while the user is typing", () => {
    // The regression: a half-typed repository form was discarded along with the page.
    expect(shouldLeaveSettingsOnEscape(event({ target: element("input") }))).toBe(false);
    expect(shouldLeaveSettingsOnEscape(event({ target: element("textarea") }))).toBe(false);
    expect(shouldLeaveSettingsOnEscape(event({ target: element("div", true) }))).toBe(false);
  });

  it("stays put inside a rich-text editor, where the target is a descendant", () => {
    // The appearance tab renders a live Lexical composer. A keydown there lands
    // on the caret's text node's parent, not on the contenteditable host, so the
    // test has to be `isContentEditable` (inherited) and not `contentEditable`
    // (own attribute) - the two disagree only here.
    const host = element("div", true);
    const caret = document.createElement("span");
    host.append(caret);
    document.body.append(host);
    try {
      expect(shouldLeaveSettingsOnEscape(event({ target: caret }))).toBe(false);
    } finally {
      host.remove();
    }
  });

  it("leaves from a control that is not a text field", () => {
    expect(shouldLeaveSettingsOnEscape(event({ target: element("button") }))).toBe(true);
    // A shortcut firing while a list row has focus must still work.
    expect(shouldLeaveSettingsOnEscape(event({ target: element("li") }))).toBe(true);
  });

  it("handles a missing or non-element target", () => {
    // `event.target` is null when the event was dispatched at the window, which
    // is exactly where the caller listens.
    expect(shouldLeaveSettingsOnEscape(event({ target: null }))).toBe(true);
    expect(shouldLeaveSettingsOnEscape(event({ target: new EventTarget() }))).toBe(true);
  });

  it("defers to a handler that already claimed the key", () => {
    // The sidebar search, the theme radial and the repository editor all
    // preventDefault their own Escape.
    expect(shouldLeaveSettingsOnEscape(event({ defaultPrevented: true }))).toBe(false);
  });

  it("ignores every other key", () => {
    expect(shouldLeaveSettingsOnEscape(event({ key: "Enter" }))).toBe(false);
  });
});
