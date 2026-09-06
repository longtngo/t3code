import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

/**
 * Both fork-only footer panels now render as controls INSIDE the sidebar's
 * bottom row, beside Settings / Pull Requests / Usage. Two structural
 * properties make that work, and neither is visible to a typecheck:
 *
 *  1. each is an `<li>`, because the row is a `<ul>` — a `<div>` there is
 *     invalid markup that React only warns about at runtime;
 *  2. each opts out of `SidebarMenuItem`'s baked-in `relative` with `static`,
 *     so its popover anchors to the footer row and is footer-width. Lose that
 *     and the panel silently shrinks to the width of its ~40px trigger.
 *
 * Both would render "fine" if broken, which is why they are pinned here.
 */

const queueState = vi.hoisted(() => ({
  snapshot: null as null | Record<string, unknown>,
}));
const modelState = vi.hoisted(() => ({
  online: false,
}));

vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => "env-1",
}));
vi.mock("../../hooks/useResourceQueue", () => ({
  useResourceQueue: () => ({ snapshot: queueState.snapshot }),
}));
vi.mock("../../hooks/useSettings", () => ({
  usePrimarySettings: (select: (state: { localLlm: { models: unknown[] } }) => unknown) =>
    select({ localLlm: { models: [] } }),
}));
vi.mock("../../hooks/useLlmModels", () => ({
  useLlmModels: () => ({
    sample: modelState.online
      ? { models: [{ configId: "m1", status: "online", pid: 42 }] }
      : { models: [] },
  }),
  useLlmModelActions: () => ({ pending: new Set<string>(), load: () => {}, unload: () => {} }),
}));

import { sidebarFooterBadgeClass } from "./sidebarFooterBadge";
import { SidebarLocalModels } from "./SidebarLocalModels";
import { SidebarResourceQueue } from "./SidebarResourceQueue";
import { SidebarMenu, SidebarProvider } from "../ui/sidebar";
import { renderDom } from "../../testing/renderDom";

/** Renders a control the way the footer row actually mounts it: inside the `<ul>`. */
function renderInRow(child: ReactNode) {
  return renderDom(createElement(SidebarProvider, null, createElement(SidebarMenu, null, child)));
}

type RowView = Awaited<ReturnType<typeof renderInRow>>;

/** Both panels are controlled by the footer now; closed is the default fixture. */
const closedPanel = { isOpen: false, onOpenChange: () => {} };

/** The control's own list item, as a direct child of the row's `<ul>`. */
function rowItem(view: RowView) {
  return view.find("ul > li");
}

beforeEach(() => {
  queueState.snapshot = null;
  modelState.online = false;
});

describe("Local models in the footer row", () => {
  it("is a list item, so it is valid inside the row's <ul>", async () => {
    const view = await renderInRow(createElement(SidebarLocalModels, closedPanel));
    expect(rowItem(view)).not.toBeNull();
  });

  it("opts out of item-relative positioning so its panel spans the footer", async () => {
    // `static` is what redirects the panel's anchor to the row wrapper. Asserted
    // on the class the component actually sets, and paired with the negative so
    // a stray `relative` cannot creep back in.
    const view = await renderInRow(createElement(SidebarLocalModels, closedPanel));
    const item = rowItem(view);
    expect(item?.classList.contains("static")).toBe(true);
    expect(item?.classList.contains("relative")).toBe(false);
  });

  it("keeps its icon and status tag in the row", async () => {
    const view = await renderInRow(createElement(SidebarLocalModels, closedPanel));
    expect(view.find('[aria-label="Local models"]')).not.toBeNull();
    // The count badge — the tag that makes the control worth glancing at. Asserted on the
    // shared footer-badge geometry, so a local restyle that drifts away from Resource Queue
    // fails here rather than only showing up side by side in the row.
    const badge = view.find('[aria-label="0 local models loaded"]');
    expect(badge).not.toBeNull();
    expect(badge?.className).toBe(sidebarFooterBadgeClass("idle"));
  });

  it("does not carry its old full-width text label into the row", async () => {
    // The label moved to the tooltip and the panel heading. A visible inline
    // "Local models" span in the row would mean the trigger never shrank.
    const view = await renderInRow(createElement(SidebarLocalModels, closedPanel));
    const inlineLabels = view
      .findAll("span.text-xs")
      .filter((span) => span.textContent === "Local models");
    expect(inlineLabels).toHaveLength(0);
  });
});

describe("only one footer panel may be open", () => {
  // The two panels anchor to the SAME row wrapper with identical absolute insets
  // (`absolute right-0 bottom-full left-0 z-50`), so two open panels sit in one
  // box and one paints over the other. `SidebarChromeFooter` arbitrates via
  // `nextOpenFooterPanel`; these pin that each panel actually honours the prop.

  it("draws the Local models panel only when the footer says it is open", async () => {
    const open = { isOpen: true, onOpenChange: () => {} };
    const opened = await renderInRow(createElement(SidebarLocalModels, open));
    expect(opened.text()).toContain("No model configs yet");
    const closed = await renderInRow(createElement(SidebarLocalModels, closedPanel));
    expect(closed.text()).not.toContain("No model configs yet");
  });

  it("draws the Resource Queue panel only when the footer says it is open", async () => {
    // Keyed on the panel's id, not its label: the trigger's own label is
    // "Resource Queue" and the panel's was "Resource queue", which differ by
    // one character and would have let this pass on the wrong element.
    const open = { isOpen: true, onOpenChange: () => {} };
    const opened = await renderInRow(createElement(SidebarResourceQueue, open));
    expect(opened.find("#sidebar-resource-queue-panel")).not.toBeNull();
    const closed = await renderInRow(createElement(SidebarResourceQueue, closedPanel));
    expect(closed.find("#sidebar-resource-queue-panel")).toBeNull();
  });

  it("keeps both triggers visible while one panel is open", async () => {
    // Exclusivity is about the PANELS, not the controls. Closing the other
    // panel must never take its trigger out of the row.
    const view = await renderInRow(
      createElement(SidebarResourceQueue, { isOpen: true, onOpenChange: () => {} }),
    );
    expect(view.find('[aria-label="Resource Queue"]')).not.toBeNull();
  });
});

describe("Resource Queue in the footer row", () => {
  it("is a list item, so it is valid inside the row's <ul>", async () => {
    const view = await renderInRow(createElement(SidebarResourceQueue, closedPanel));
    expect(rowItem(view)).not.toBeNull();
  });

  it("opts out of item-relative positioning so its popover spans the footer", async () => {
    const view = await renderInRow(createElement(SidebarResourceQueue, closedPanel));
    const item = rowItem(view);
    expect(item?.classList.contains("static")).toBe(true);
    expect(item?.classList.contains("relative")).toBe(false);
  });

  it("shows both count tags in the row even when the broker is silent", async () => {
    // Zeroes are the common case and must still render — an icon with no counts
    // says nothing, which is the whole reason these are tags and not a bare icon.
    const view = await renderInRow(createElement(SidebarResourceQueue, closedPanel));
    expect(view.find('[aria-label="0 running (holding a lease)"]')).not.toBeNull();
    expect(view.find('[aria-label="0 waiting (queued)"]')).not.toBeNull();
  });

  it("surfaces the maintenance tag when the broker is draining", async () => {
    queueState.snapshot = { maintenance: true, running: [], waiting: [], resources: [] };
    const withMaintenance = await renderInRow(createElement(SidebarResourceQueue, closedPanel));
    queueState.snapshot = { maintenance: false, running: [], waiting: [], resources: [] };
    const without = await renderInRow(createElement(SidebarResourceQueue, closedPanel));

    expect(withMaintenance.find('[aria-label="broker in maintenance (draining)"]')).not.toBeNull();
    expect(without.find('[aria-label="broker in maintenance (draining)"]')).toBeNull();
  });

  it("does not carry its old full-width text label into the row", async () => {
    const view = await renderInRow(createElement(SidebarResourceQueue, closedPanel));
    const inlineLabels = view
      .findAll("span.text-xs")
      .filter((span) => span.textContent === "Resource Queue");
    expect(inlineLabels).toHaveLength(0);
    expect(view.find('[aria-label="Resource Queue"]')).not.toBeNull();
  });
});

describe("both footer panels are disclosures, not dialogs", () => {
  // Each opens on hover or click and closes on a mouse-leave timer. `dialog`
  // promises a screen reader a focus move, a focus trap and a restore on close,
  // none of which a panel that vanishes when the pointer drifts can honour —
  // and the honest reading of "it has no focus management" is that the role is
  // wrong, not that a trap is missing.
  const open = { isOpen: true, onOpenChange: () => {} };

  it("does not claim a dialog role it cannot honour", async () => {
    const view = await renderInRow(createElement(SidebarResourceQueue, open));

    // Paired with the positive so the absence cannot pass by the panel simply
    // not rendering — which is exactly how this assertion would go vacuous.
    expect(view.find("#sidebar-resource-queue-panel")).not.toBeNull();
    expect(view.find('[role="dialog"]')).toBeNull();
    expect(view.find("[aria-haspopup]")).toBeNull();
  });

  it.each([
    ["Resource Queue", SidebarResourceQueue, "sidebar-resource-queue-panel"],
    ["Local models", SidebarLocalModels, "sidebar-local-models-panel"],
  ] as const)("points %s's trigger at the panel it expands", async (_label, Component, panelId) => {
    const view = await renderInRow(createElement(Component, open));

    expect(view.find(`[aria-controls="${panelId}"]`)).not.toBeNull();
    expect(view.find(`#${panelId}`)).not.toBeNull();
    expect(view.find('[aria-expanded="true"]')).not.toBeNull();
  });

  it.each([
    ["Resource Queue", SidebarResourceQueue],
    ["Local models", SidebarLocalModels],
  ] as const)("drops %s's aria-controls while the panel is gone", async (_label, Component) => {
    // A reference to an id that is not in the document is invalid ARIA, and the
    // panel only exists while open.
    const view = await renderInRow(createElement(Component, closedPanel));

    expect(view.find("[aria-controls]")).toBeNull();
    expect(view.find('[aria-expanded="false"]')).not.toBeNull();
  });
});

// Only reachable with a real DOM: `onOpenChange` is the whole contract between these controls
// and `SidebarChromeFooter`'s arbitration, and static markup could never dispatch the click
// that drives it.
describe("footer controls report their open state to the footer", () => {
  it("asks the footer to open Local models when the trigger is clicked", async () => {
    const onOpenChange = vi.fn();
    const view = await renderInRow(
      createElement(SidebarLocalModels, { isOpen: false, onOpenChange }),
    );

    await view.click(view.find('[aria-label="Local models"]'));

    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it("asks the footer to close Local models when the open trigger is clicked", async () => {
    const onOpenChange = vi.fn();
    const view = await renderInRow(
      createElement(SidebarLocalModels, { isOpen: true, onOpenChange }),
    );

    await view.click(view.find('[aria-label="Local models"]'));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("pins Resource Queue open when its trigger is clicked", async () => {
    const onOpenChange = vi.fn();
    const view = await renderInRow(
      createElement(SidebarResourceQueue, { isOpen: false, onOpenChange }),
    );

    await view.click(view.find('[aria-label="Resource Queue"]'));

    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it("unpins Resource Queue when its pinned trigger is clicked again", async () => {
    const onOpenChange = vi.fn();
    const view = await renderInRow(
      createElement(SidebarResourceQueue, { isOpen: true, onOpenChange }),
    );

    await view.click(view.find('[aria-label="Resource Queue"]'));
    await view.click(view.find('[aria-label="Resource Queue"]'));

    expect(onOpenChange).toHaveBeenNthCalledWith(1, true);
    expect(onOpenChange).toHaveBeenNthCalledWith(2, false);
  });
});
