import { describe, expect, it } from "vite-plus/test";

import { renderDom } from "../../testing/renderDom";

import { PanelLayoutControls } from "./PanelLayoutControls";

describe("PanelLayoutControls", () => {
  it("has no task badge and the plain aria-label when no counts are given", async () => {
    const view = await renderDom(
      <PanelLayoutControls
        showTerminalControl={false}
        terminalAvailable={false}
        terminalOpen={false}
        terminalShortcutLabel={null}
        rightPanelAvailable
        rightPanelOpen={false}
        rightPanelShortcutLabel={null}
        liveAgentCount={0}
        onToggleTerminal={() => undefined}
        onToggleRightPanel={() => undefined}
      />,
    );

    const button = view.find("button");
    expect(button?.getAttribute("aria-label")).toBe("Toggle right panel");
    expect(view.findAll("[data-panel-badge]")).toHaveLength(0);
  });

  it("shows the fraction badge and composes both counts into the aria-label", async () => {
    const view = await renderDom(
      <PanelLayoutControls
        showTerminalControl={false}
        terminalAvailable={false}
        terminalOpen={false}
        terminalShortcutLabel={null}
        rightPanelAvailable
        rightPanelOpen={false}
        rightPanelShortcutLabel={null}
        liveAgentCount={2}
        taskCompletedCount={3}
        taskTotalCount={7}
        onToggleTerminal={() => undefined}
        onToggleRightPanel={() => undefined}
      />,
    );

    const button = view.find("button");
    expect(button?.getAttribute("aria-label")).toBe(
      "Toggle right panel, 2 agents working, 3 of 7 tasks complete",
    );
    const badges = view.findAll("[data-panel-badge]");
    expect(badges.map((badge) => badge.textContent)).toEqual(["2", "3/7"]);
  });

  it("swaps the fraction for a checkmark once every step is complete", async () => {
    const view = await renderDom(
      <PanelLayoutControls
        showTerminalControl={false}
        terminalAvailable={false}
        terminalOpen={false}
        terminalShortcutLabel={null}
        rightPanelAvailable
        rightPanelOpen={false}
        rightPanelShortcutLabel={null}
        liveAgentCount={0}
        taskCompletedCount={7}
        taskTotalCount={7}
        onToggleTerminal={() => undefined}
        onToggleRightPanel={() => undefined}
      />,
    );

    const button = view.find("button");
    expect(button?.getAttribute("aria-label")).toBe("Toggle right panel, all 7 tasks complete");
    const badges = view.findAll("[data-panel-badge]");
    expect(badges.map((badge) => badge.textContent)).toEqual(["✓"]);
  });
});
