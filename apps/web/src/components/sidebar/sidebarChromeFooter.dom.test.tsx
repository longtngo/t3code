import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

/**
 * Where the fork-only panel sits relative to the footer's Back-button ternary was got wrong
 * once. Resource Queue is a status readout, not navigation, so placing it in the Back branch
 * would hide it on those pages. The panel is mocked: the question is the footer's JSX
 * structure (its internals: `sidebarFooterRow.dom.test.tsx`).
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
vi.mock("./SidebarResourceQueue", () => ({
  SidebarResourceQueue: () => createElement("li", { "data-panel": "queue" }),
}));
vi.mock("./SidebarProviderUpdatePill", () => ({ SidebarProviderUpdatePill: () => null }));
vi.mock("./SidebarUpdatePill", () => ({
  SidebarUpdatePill: () => null,
  SidebarUpdateArchitectureWarning: () => null,
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
  it("renders the status panel on a normal page", async () => {
    const view = await renderFooterAt("/");
    expect(view.find('[data-panel="queue"]')).not.toBeNull();
  });

  it("KEEPS the status panel on the Pull Requests page, where Back replaces navigation", async () => {
    // "Back" swaps out the navigation controls; it must not take the readout with it.
    const view = await renderFooterAt("/pull-requests");
    expect(view.text()).toContain("Back");
    expect(view.find('[data-panel="queue"]')).not.toBeNull();
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

  it("anchors the panel's popover to the row rather than to a menu item", async () => {
    // The panel positions itself `absolute` against the nearest positioned
    // ancestor. That ancestor must be the row wrapper, or the popover collapses
    // to the width of its ~40px trigger.
    const view = await renderFooterAt("/");
    const row = view.find("div.relative");
    expect(row).not.toBeNull();
    expect(row?.querySelector('[data-panel="queue"]')).not.toBeNull();
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
