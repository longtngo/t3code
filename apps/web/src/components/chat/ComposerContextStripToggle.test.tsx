import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  COMPOSER_CONTEXT_STRIP_ID,
  ComposerContextStripToggle,
} from "./ComposerContextStripToggle";

function render(props: { collapsed: boolean; worktreeActive: boolean }) {
  return renderToStaticMarkup(
    createElement(ComposerContextStripToggle, {
      ...props,
      onToggle: () => {},
    }),
  );
}

describe("ComposerContextStripToggle", () => {
  it("reports the strip's open state to assistive tech", () => {
    expect(render({ collapsed: false, worktreeActive: false })).toContain('aria-expanded="true"');
    expect(render({ collapsed: true, worktreeActive: false })).toContain('aria-expanded="false"');
  });

  it("points at the strip it controls", () => {
    expect(render({ collapsed: true, worktreeActive: false })).toContain(
      `aria-controls="${COMPOSER_CONTEXT_STRIP_ID}"`,
    );
  });

  // The button is the only way back once the strip is hidden, so its label has
  // to name the direction rather than the thing — "Workspace" alone would leave
  // a collapsed strip looking like a control that does nothing.
  it("names the direction it will move the strip", () => {
    expect(render({ collapsed: true, worktreeActive: false })).toContain(
      'aria-label="Show workspace"',
    );
    expect(render({ collapsed: false, worktreeActive: false })).toContain(
      'aria-label="Hide workspace"',
    );
  });

  // The row it sits in is the model picker, the runtime-mode picker, and this. All three are
  // built from the same primitives, and the data attributes those primitives stamp are the
  // only render-time evidence that this one did not re-specify its own size and tone.
  it("is built from the shared composer-control primitives", () => {
    const markup = render({ collapsed: true, worktreeActive: false });
    expect(markup).toContain("data-composer-control-icon");
    expect(markup).toContain("data-composer-control-chevron");
  });

  // With no label of its own, the glyph is the only workspace signal left while
  // the strip is closed. Assert the two icons actually differ rather than that
  // some icon rendered: a shared fallback would satisfy a weaker check.
  it("shows a different glyph for a worktree run than for a local checkout", () => {
    const local = render({ collapsed: true, worktreeActive: false });
    const worktree = render({ collapsed: true, worktreeActive: true });
    expect(local).toContain("lucide-folder");
    expect(worktree).toContain("lucide-folder-git");
    expect(worktree).not.toBe(local);
  });
});
