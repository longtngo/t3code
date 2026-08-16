import { describe, expect, it } from "vite-plus/test";

import { nextOpenFooterPanel } from "./sidebarChrome.logic";

describe("nextOpenFooterPanel", () => {
  it("opens the panel that asked to open", () => {
    expect(nextOpenFooterPanel({ current: null, panel: "models", open: true })).toBe("models");
  });

  it("replaces the other panel rather than stacking on it", () => {
    // The whole point: both panels anchor to the same row wrapper with identical
    // absolute insets, so two open panels sit in the same box.
    expect(nextOpenFooterPanel({ current: "models", panel: "queue", open: true })).toBe("queue");
  });

  it("closes the panel that asked to close", () => {
    expect(nextOpenFooterPanel({ current: "queue", panel: "queue", open: false })).toBe(null);
  });

  it("ignores a stale close from a panel that is no longer open", () => {
    // Resource Queue closes on a 160ms mouse-leave timer. Leaving it and opening
    // Local models inside that window fires a late close for "queue" — which must
    // NOT null out the panel the user just opened.
    expect(nextOpenFooterPanel({ current: "models", panel: "queue", open: false })).toBe("models");
  });

  it("is a no-op when nothing is open and a panel closes", () => {
    expect(nextOpenFooterPanel({ current: null, panel: "models", open: false })).toBe(null);
  });
});
