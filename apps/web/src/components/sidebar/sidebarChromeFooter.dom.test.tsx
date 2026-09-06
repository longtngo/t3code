import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

/**
 * Where the two fork-only panels sit RELATIVE TO the footer's Back-button
 * ternary is a behaviour decision, and one that was got wrong once during the
 * move that created this row.
 *
 * Settings, Pull Requests and Usage are navigation, so "Back" rightly replaces
 * them once you are on one of those pages. Local models and Resource Queue are
 * live status readouts with no destination — putting them inside that branch
 * would silently remove the resource queue and model status from two pages as a
 * side effect of a layout change. Nothing enforced that until this file.
 *
 * The two panels are mocked deliberately: the question here is the footer's own
 * JSX structure, not what the panels render. Their internals are covered in
 * `sidebarFooterRow.dom.test.tsx`.
 */

const locationState = vi.hoisted(() => ({ pathname: "/" }));
const navigate = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  // Upstream #7153 moved this footer into `SidebarUtilityMenu`, which asks the router
  // whether Back has anywhere to go before falling back to "/".
  useCanGoBack: () => false,
  useLocation: ({ select }: { select: (location: { pathname: string }) => unknown }) =>
    select({ pathname: locationState.pathname }),
  Link: () => null,
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [{ serverConfig: { environment: { capabilities: { pullRequests: true } } } }],
  }),
}));
vi.mock("./SidebarLocalModels", () => ({
  SidebarLocalModels: () => createElement("li", { "data-panel": "models" }),
}));
vi.mock("./SidebarResourceQueue", () => ({
  SidebarResourceQueue: () => createElement("li", { "data-panel": "queue" }),
}));
vi.mock("./SidebarCrew", () => ({
  SidebarCrew: () => createElement("li", { "data-panel": "crew" }),
}));
vi.mock("./SidebarProviderUpdatePill", () => ({ SidebarProviderUpdatePill: () => null }));
vi.mock("./SidebarSubagentBackend", () => ({
  SidebarSubagentBackend: () => createElement("div", { "data-panel": "subagents" }),
}));
vi.mock("./SidebarUpdatePill", () => ({
  SidebarUpdatePill: () => null,
  SidebarUpdateArchitectureWarning: () => null,
}));

import { SidebarChromeFooter, SidebarUtilityMenu } from "./SidebarChrome";
import { SidebarProvider } from "../ui/sidebar";
import { renderDom } from "../../testing/renderDom";

function renderFooterAt(pathname: string) {
  locationState.pathname = pathname;
  return renderDom(createElement(SidebarProvider, null, createElement(SidebarChromeFooter)));
}

beforeEach(() => {
  locationState.pathname = "/";
  navigate.mockClear();
});

describe("SidebarChromeFooter panel placement", () => {
  it("renders both status panels on a normal page", async () => {
    const view = await renderFooterAt("/");
    expect(view.find('[data-panel="models"]')).not.toBeNull();
    expect(view.find('[data-panel="queue"]')).not.toBeNull();
  });

  it("KEEPS both status panels on the Usage page, where Back replaces navigation", async () => {
    // The regression this exists for. "Back" swaps out Settings / Pull Requests
    // / Usage; it must not take the two readouts with it.
    const view = await renderFooterAt("/usage");
    expect(view.text()).toContain("Back");
    expect(view.find('[data-panel="models"]')).not.toBeNull();
    expect(view.find('[data-panel="queue"]')).not.toBeNull();
  });

  it("KEEPS both status panels on the Pull Requests page", async () => {
    const view = await renderFooterAt("/pull-requests");
    expect(view.text()).toContain("Back");
    expect(view.find('[data-panel="models"]')).not.toBeNull();
    expect(view.find('[data-panel="queue"]')).not.toBeNull();
  });

  it("does swap the navigation controls for Back, which is the branch's actual job", async () => {
    // Pins that the ternary still works, so the test above cannot pass merely
    // because the branch stopped doing anything.
    const normal = await renderFooterAt("/");
    expect(normal.find('[aria-label="Settings"]')).not.toBeNull();
    expect(normal.text()).not.toContain("Back");

    const onUsage = await renderFooterAt("/usage");
    expect(onUsage.find('[aria-label="Settings"]')).toBeNull();
    expect(onUsage.text()).toContain("Back");
  });

  it("anchors the panels' popovers to the row rather than to a menu item", async () => {
    // The panels position themselves `absolute` against the nearest positioned
    // ancestor. That ancestor must be the row wrapper, or each popover collapses
    // to the width of its ~40px trigger.
    const view = await renderFooterAt("/");
    const row = view.find("div.relative");
    expect(row).not.toBeNull();
    expect(row?.querySelector('[data-panel="models"]')).not.toBeNull();
    expect(row?.querySelector('[data-panel="queue"]')).not.toBeNull();
  });

  it("mounts the subagent disclosure inside the utility menu, which is what the settings page renders", async () => {
    locationState.pathname = "/settings";
    const view = await renderDom(
      createElement(SidebarProvider, null, createElement(SidebarUtilityMenu)),
    );
    expect(view.find('[data-panel="subagents"]')).not.toBeNull();
  });

  it("mounts the subagent disclosure exactly once in the footer", async () => {
    const view = await renderFooterAt("/");
    expect(view.findAll('[data-panel="subagents"]')).toHaveLength(1);
  });
});

// Only reachable with a real DOM: the previous version rendered to static markup, so every
// footer control's click handler — the whole point of the row — went uncovered.
describe("SidebarChromeFooter navigation", () => {
  it("navigates to Settings when the Settings control is clicked", async () => {
    const view = await renderFooterAt("/");

    await view.click(view.find('[aria-label="Settings"]'));

    expect(navigate).toHaveBeenCalledWith({ to: "/settings" });
  });

  it("navigates to Usage when the Usage control is clicked", async () => {
    const view = await renderFooterAt("/");

    await view.click(view.find('[aria-label="Usage"]'));

    expect(navigate).toHaveBeenCalledWith({ to: "/usage" });
  });

  it("sends Back to the root when the router has no history to pop", async () => {
    // `useCanGoBack` is mocked false above, which is the fallback branch of `handleBackClick`.
    const view = await renderFooterAt("/usage");

    const back = view.findAll("button").find((button) => button.textContent?.includes("Back"));
    await view.click(back ?? null);

    expect(navigate).toHaveBeenCalledWith({ to: "/" });
  });
});
