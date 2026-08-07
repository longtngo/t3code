import { describe, expect, it } from "vite-plus/test";

import { describePendingOptionsVisibility } from "./pendingUserInputPanelLayout";

describe("describePendingOptionsVisibility", () => {
  it("offers to hide the options, and says why, while they are showing", () => {
    const visibility = describePendingOptionsVisibility({ optionCount: 4, isCollapsed: false });

    expect(visibility.toggleLabel).toBe("Hide options");
    expect(visibility.toggleTitle).toBe("Hide options to read the chat behind");
  });

  it("offers to show the options once collapsed", () => {
    const visibility = describePendingOptionsVisibility({ optionCount: 4, isCollapsed: true });

    expect(visibility.toggleLabel).toBe("Show options");
    expect(visibility.hintLabel).toBe("4 options hidden");
  });

  it("keeps the hidden-count hint grammatical for a single option", () => {
    expect(describePendingOptionsVisibility({ optionCount: 1, isCollapsed: true }).hintLabel).toBe(
      "1 option hidden",
    );
    expect(describePendingOptionsVisibility({ optionCount: 0, isCollapsed: true }).hintLabel).toBe(
      "0 options hidden",
    );
  });
});
