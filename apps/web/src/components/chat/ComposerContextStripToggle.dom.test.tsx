import { createElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { renderDom } from "../../testing/renderDom";
import {
  COMPOSER_CONTEXT_STRIP_ID,
  ComposerContextStripToggle,
} from "./ComposerContextStripToggle";

function render(props: { collapsed: boolean; worktreeActive: boolean; onToggle?: () => void }) {
  const { onToggle = () => {}, ...rest } = props;
  return renderDom(createElement(ComposerContextStripToggle, { ...rest, onToggle }));
}

describe("ComposerContextStripToggle", () => {
  it("reports the strip's open state to assistive tech", async () => {
    const open = await render({ collapsed: false, worktreeActive: false });
    expect(open.find("button")?.getAttribute("aria-expanded")).toBe("true");

    const closed = await render({ collapsed: true, worktreeActive: false });
    expect(closed.find("button")?.getAttribute("aria-expanded")).toBe("false");
  });

  it("points at the strip it controls", async () => {
    const view = await render({ collapsed: true, worktreeActive: false });
    expect(view.find("button")?.getAttribute("aria-controls")).toBe(COMPOSER_CONTEXT_STRIP_ID);
  });

  // The button is the only way back once the strip is hidden, so its label has
  // to name the direction rather than the thing — "Workspace" alone would leave
  // a collapsed strip looking like a control that does nothing.
  it("names the direction it will move the strip", async () => {
    const closed = await render({ collapsed: true, worktreeActive: false });
    expect(closed.find('button[aria-label="Show workspace"]')).not.toBeNull();

    const open = await render({ collapsed: false, worktreeActive: false });
    expect(open.find('button[aria-label="Hide workspace"]')).not.toBeNull();
  });

  // The row it sits in is the model picker, the runtime-mode picker, and this. All three are
  // built from the same primitives, and the data attributes those primitives stamp are the
  // only render-time evidence that this one did not re-specify its own size and tone.
  it("is built from the shared composer-control primitives", async () => {
    const view = await render({ collapsed: true, worktreeActive: false });

    expect(view.find("[data-composer-control-icon]")).not.toBeNull();
    expect(view.find("[data-composer-control-chevron]")).not.toBeNull();
  });

  // With no label of its own, the glyph is the only workspace signal left while
  // the strip is closed. Assert the two icons actually differ rather than that
  // some icon rendered: a shared fallback would satisfy a weaker check.
  it("shows a different glyph for a worktree run than for a local checkout", async () => {
    const local = await render({ collapsed: true, worktreeActive: false });
    expect(local.find(".lucide-folder")).not.toBeNull();
    expect(local.find(".lucide-folder-git")).toBeNull();

    const worktree = await render({ collapsed: true, worktreeActive: true });
    expect(worktree.find(".lucide-folder-git")).not.toBeNull();
    expect(worktree.find(".lucide-folder")).toBeNull();
  });

  // The static-markup version could not press the button, so nothing proved the
  // trigger was wired to `onToggle` at all rather than merely rendering.
  it("calls onToggle when the button is pressed", async () => {
    const onToggle = vi.fn();
    const view = await render({ collapsed: true, worktreeActive: false, onToggle });

    await view.click(view.find("button"));

    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
