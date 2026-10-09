import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { renderDom } from "../../testing/renderDom";
import { PanelLayoutControls } from "./PanelLayoutControls";

const controls = (threadPanelSummary: string | null) => (
  <PanelLayoutControls
    showTerminalControl={false}
    showRightPanelControl={false}
    terminalAvailable={false}
    terminalOpen={false}
    terminalShortcutLabel={null}
    threadPanelOpen={false}
    threadPanelPresentation="inline"
    threadPanelShortcutLabel={null}
    threadPanelSummary={threadPanelSummary}
    rightPanelAvailable={false}
    rightPanelOpen={false}
    rightPanelShortcutLabel={null}
    onToggleTerminal={() => {}}
    onToggleThreadPanel={() => {}}
    onToggleRightPanel={() => {}}
  />
);
const toggleLabel = (view: Awaited<ReturnType<typeof renderDom>>) =>
  view.find("[aria-label^='Toggle thread details panel']")?.getAttribute("aria-label");

describe("PanelLayoutControls thread details toggle", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the task fraction beside the icon and in its name", async () => {
    const view = await renderDom(controls("2/5"));
    expect(view.text()).toContain("2/5");
    expect(toggleLabel(view)).toBe("Toggle thread details panel (2/5 tasks complete)");
  });

  it("shows no fraction when there is none", async () => {
    const view = await renderDom(controls(null));
    expect(view.text()).not.toMatch(/\d+\/\d+/);
    expect(toggleLabel(view)).toBe("Toggle thread details panel");
  });
});
