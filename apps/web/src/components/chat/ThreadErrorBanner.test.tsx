import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ThreadErrorBanner } from "./ThreadErrorBanner";

describe("ThreadErrorBanner", () => {
  it("renders nothing when error is absent", () => {
    expect(renderToString(createElement(ThreadErrorBanner, { error: null }))).toBe("");
  });

  it("renders long error text in the alert description content area", () => {
    const error =
      "You've hit your usage limit. Upgrade to Plus to continue using Codex, or try again at Jul 1.";
    const html = renderToString(createElement(ThreadErrorBanner, { error, onDismiss: () => {} }));

    expect(html).toContain("hit your usage limit");
    expect(html).toMatch(/min-w-0 flex-1[\s\S]*data-slot="alert-description"/);
    expect(html).toContain("Dismiss error");
  });
});
