import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

/**
 * Where the two fork-only panels sit relative to the footer's Back-button ternary was got wrong
 * once. Local models and Resource Queue are status readouts, not navigation, so placing them in
 * the Back branch would hide them on those pages. The panels are mocked: the question is the
 * footer's JSX structure (their internals: `sidebarFooterRow.dom.test.tsx`).
 */

const locationState = vi.hoisted(() => ({ pathname: "/" }));
const navigate = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  // `SidebarUtilityMenu` owns this footer and asks the router whether Back has anywhere to go
  // before falling back to "/".
  useCanGoBack: () => false,
  useLocation: ({ select }: { select: (location: { pathname: string }) => unknown }) =>
    select({ pathname: locationState.pathname }),
  Link: () => null,
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [{ serverConfig: { environment: { capabilities: { pullRequests: true } } } }],
  }),
  usePullRequestsSupported: () => true,
}));
vi.mock("./SidebarLocalModels", () => ({
  SidebarLocalModels: () => createElement("li", { "data-panel": "models" }),
}));
vi.mock("./SidebarResourceQueue", () => ({
  SidebarResourceQueue: () => createElement("li", { "data-panel": "queue" }),
}));
vi.mock("./SidebarProviderUpdatePill", () => ({ SidebarProviderUpdatePill: () => null }));
vi.mock("./SidebarUpdatePill", () => ({
  SidebarUpdatePill: () => null,
  SidebarUpdateArchitectureWarning: () => null,
}));

vi.mock("./SidebarSubagentBackend", () => ({
  SidebarSubagentBackend: () => createElement("li", { "data-panel": "subagents" }),
}));

import { SidebarChromeFooter } from "./SidebarChrome";
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

  it("KEEPS the status panels on the Pull Requests page, where Back replaces navigation", async () => {
    // "Back" swaps out the navigation controls; it must not take the readouts with it.
    const view = await renderFooterAt("/pull-requests");
    expect(view.text()).toContain("Back");
    expect(view.find('[data-panel="models"]')).not.toBeNull();
    expect(view.find('[data-panel="queue"]')).not.toBeNull();
    expect(view.find('[data-panel="subagents"]')).not.toBeNull();
  });

  it("does swap the navigation controls for Back, which is the branch's actual job", async () => {
    // Pins that the ternary still works, so the test above cannot pass merely
    // because the branch stopped doing anything.
    const normal = await renderFooterAt("/");
    expect(normal.find('[aria-label="Settings"]')).not.toBeNull();
    expect(normal.text()).not.toContain("Back");

    const onPullRequests = await renderFooterAt("/pull-requests");
    expect(onPullRequests.find('[aria-label="Settings"]')).toBeNull();
    expect(onPullRequests.text()).toContain("Back");
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
    // Subagents is an icon in the same row, and its panel expands as that row's first item.
    expect(row?.querySelector('ul > [data-panel="subagents"]')).not.toBeNull();
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

  it("sends Back to the root when no main app page was visited first", async () => {
    // Back returns to the last main app URL; none was recorded here.
    const view = await renderFooterAt("/pull-requests");

    const back = view.findAll("button").find((button) => button.textContent?.includes("Back"));
    await view.click(back ?? null);

    expect(navigate).toHaveBeenCalledWith({ href: "/" });
  });
});
