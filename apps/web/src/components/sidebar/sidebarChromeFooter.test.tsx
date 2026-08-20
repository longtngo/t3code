import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
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
 * `sidebarFooterRow.test.tsx`.
 */

const locationState = vi.hoisted(() => ({ pathname: "/" }));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => () => {},
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
vi.mock("./SidebarProviderUpdatePill", () => ({ SidebarProviderUpdatePill: () => null }));
vi.mock("./SidebarUpdatePill", () => ({
  SidebarUpdatePill: () => null,
  SidebarUpdateArchitectureWarning: () => null,
}));

import { SidebarChromeFooter } from "./SidebarChrome";
import { SidebarProvider } from "../ui/sidebar";

function renderFooterAt(pathname: string) {
  locationState.pathname = pathname;
  return renderToStaticMarkup(
    createElement(SidebarProvider, null, createElement(SidebarChromeFooter)),
  );
}

beforeEach(() => {
  locationState.pathname = "/";
});

describe("SidebarChromeFooter panel placement", () => {
  it("renders both status panels on a normal page", () => {
    const markup = renderFooterAt("/");
    expect(markup).toContain('data-panel="models"');
    expect(markup).toContain('data-panel="queue"');
  });

  it("KEEPS both status panels on the Usage page, where Back replaces navigation", () => {
    // The regression this exists for. "Back" swaps out Settings / Pull Requests
    // / Usage; it must not take the two readouts with it.
    const markup = renderFooterAt("/usage");
    expect(markup).toContain("Back");
    expect(markup).toContain('data-panel="models"');
    expect(markup).toContain('data-panel="queue"');
  });

  it("KEEPS both status panels on the Pull Requests page", () => {
    const markup = renderFooterAt("/pull-requests");
    expect(markup).toContain("Back");
    expect(markup).toContain('data-panel="models"');
    expect(markup).toContain('data-panel="queue"');
  });

  it("does swap the navigation controls for Back, which is the branch's actual job", () => {
    // Pins that the ternary still works, so the test above cannot pass merely
    // because the branch stopped doing anything.
    const normal = renderFooterAt("/");
    expect(normal).toContain('aria-label="Settings"');
    expect(normal).not.toContain("Back");

    const onUsage = renderFooterAt("/usage");
    expect(onUsage).not.toContain('aria-label="Settings"');
    expect(onUsage).toContain("Back");
  });

  it("anchors the panels' popovers to the row rather than to a menu item", () => {
    // The panels position themselves `absolute` against the nearest positioned
    // ancestor. That ancestor must be the row wrapper, or each popover collapses
    // to the width of its ~40px trigger.
    expect(renderFooterAt("/")).toContain('class="relative"');
  });
});
