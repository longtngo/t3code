import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

/**
 * The fork-only Resource Queue panel renders inside the bottom row and depends on two properties
 * no typecheck sees: it is an `<li>` (the row is a `<ul>`), and it uses `static` to opt out of
 * `SidebarMenuItem`'s `relative`, or its popover shrinks to its ~40px trigger.
 */

const queueState = vi.hoisted(() => ({
  snapshot: null as null | Record<string, unknown>,
}));

vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => "env-1",
  useEnvironmentConnectionSummaries: () => [
    {
      environmentId: "env-1",
      environmentLabel: "local",
      isEnabled: true,
      connectionState: "connected",
    },
  ],
}));
vi.mock("../../hooks/useResourceQueues", () => ({
  useResourceQueues: () => [
    { data: queueState.snapshot, status: "ok", message: null, receivedAt: 0 },
  ],
}));
vi.mock("../../hooks/useHostMetrics", () => ({
  useHostMetrics: () => ({ sample: null, status: "ok", message: null, receivedAt: 0 }),
}));

import { SidebarResourceQueue } from "./SidebarResourceQueue";
import { SidebarMenu, SidebarProvider } from "../ui/sidebar";
import { renderDom } from "../../testing/renderDom";

/** Renders a control the way the footer row actually mounts it: inside the `<ul>`. */
function renderInRow(child: ReactNode) {
  return renderDom(createElement(SidebarProvider, null, createElement(SidebarMenu, null, child)));
}

type RowView = Awaited<ReturnType<typeof renderInRow>>;

/** The panel is controlled by the footer; closed is the default fixture. */
const closedPanel = { isOpen: false, onOpenChange: () => {} };

/** The control's own list item, as a direct child of the row's `<ul>`. */
function rowItem(view: RowView) {
  return view.find("ul > li");
}

beforeEach(() => {
  queueState.snapshot = null;
});

describe("the footer owns the panel's open state", () => {
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

  it("keeps its trigger visible while the panel is open", async () => {
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

describe("the Resource Queue panel is a disclosure, not a dialog", () => {
  // It opens on hover or click and closes on a mouse-leave timer, so `dialog` would promise a
  // focus move, trap and restore that a panel vanishing on pointer drift cannot honour.
  const open = { isOpen: true, onOpenChange: () => {} };

  it("does not claim a dialog role it cannot honour", async () => {
    const view = await renderInRow(createElement(SidebarResourceQueue, open));

    // Paired with the positive so the absence cannot pass by the panel simply
    // not rendering — which is exactly how this assertion would go vacuous.
    expect(view.find("#sidebar-resource-queue-panel")).not.toBeNull();
    expect(view.find('[role="dialog"]')).toBeNull();
    expect(view.find("[aria-haspopup]")).toBeNull();
  });

  it("points the trigger at the panel it expands", async () => {
    const view = await renderInRow(createElement(SidebarResourceQueue, open));

    expect(view.find('[aria-controls="sidebar-resource-queue-panel"]')).not.toBeNull();
    expect(view.find("#sidebar-resource-queue-panel")).not.toBeNull();
    expect(view.find('[aria-expanded="true"]')).not.toBeNull();
  });

  it("drops aria-controls while the panel is gone", async () => {
    // A reference to an id that is not in the document is invalid ARIA, and the
    // panel only exists while open.
    const view = await renderInRow(createElement(SidebarResourceQueue, closedPanel));

    expect(view.find("[aria-controls]")).toBeNull();
    expect(view.find('[aria-expanded="false"]')).not.toBeNull();
  });
});

// Only reachable with a real DOM: `onOpenChange` is the whole contract between this control
// and `SidebarChromeFooter`'s open state, and static markup could never dispatch the click
// that drives it.
describe("footer controls report their open state to the footer", () => {
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
