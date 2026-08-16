import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
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

import { SidebarLocalModels } from "./SidebarLocalModels";
import { SidebarResourceQueue } from "./SidebarResourceQueue";
import { SidebarMenu, SidebarProvider } from "../ui/sidebar";

/** Renders a control the way the footer row actually mounts it: inside the `<ul>`. */
function renderInRow(child: ReactNode) {
  return renderToStaticMarkup(
    createElement(SidebarProvider, null, createElement(SidebarMenu, null, child)),
  );
}

/** Both panels are controlled by the footer now; closed is the default fixture. */
const closedPanel = { isOpen: false, onOpenChange: () => {} };

/** The opening tag of the control's own list item. */
function itemTag(markup: string) {
  const start = markup.indexOf("<li");
  return markup.slice(start, markup.indexOf(">", start) + 1);
}

beforeEach(() => {
  queueState.snapshot = null;
  modelState.online = false;
});

describe("Local models in the footer row", () => {
  it("is a list item, so it is valid inside the row's <ul>", () => {
    expect(itemTag(renderInRow(createElement(SidebarLocalModels, closedPanel)))).toContain("<li");
  });

  it("opts out of item-relative positioning so its panel spans the footer", () => {
    // `static` is what redirects the panel's anchor to the row wrapper. Asserted
    // on the class the component actually sets, and paired with the negative so
    // a stray `relative` cannot creep back in.
    const tag = itemTag(renderInRow(createElement(SidebarLocalModels, closedPanel)));
    expect(tag).toContain("static");
    expect(tag).not.toMatch(/\brelative\b/);
  });

  it("keeps its icon and status tag in the row", () => {
    const markup = renderInRow(createElement(SidebarLocalModels, closedPanel));
    expect(markup).toContain('aria-label="Local models"');
    // The status dot — the tag that makes the control worth glancing at.
    expect(markup).toContain("size-1.5 rounded-full");
  });

  it("does not carry its old full-width text label into the row", () => {
    // The label moved to the tooltip and the panel heading. A visible inline
    // "Local models" span in the row would mean the trigger never shrank.
    const markup = renderInRow(createElement(SidebarLocalModels, closedPanel));
    expect(markup).not.toContain('<span class="text-xs">Local models</span>');
  });
});

describe("only one footer panel may be open", () => {
  // The two panels anchor to the SAME row wrapper with identical absolute insets
  // (`absolute right-0 bottom-full left-0 z-50`), so two open panels sit in one
  // box and one paints over the other. `SidebarChromeFooter` arbitrates via
  // `nextOpenFooterPanel`; these pin that each panel actually honours the prop.

  it("draws the Local models panel only when the footer says it is open", () => {
    const open = { isOpen: true, onOpenChange: () => {} };
    expect(renderInRow(createElement(SidebarLocalModels, open))).toContain("No model configs yet");
    expect(renderInRow(createElement(SidebarLocalModels, closedPanel))).not.toContain(
      "No model configs yet",
    );
  });

  it("draws the Resource Queue panel only when the footer says it is open", () => {
    // Keyed on the panel's id, not its label: the trigger's own label is
    // "Resource Queue" and the panel's was "Resource queue", which differ by
    // one character and would have let this pass on the wrong element.
    const open = { isOpen: true, onOpenChange: () => {} };
    expect(renderInRow(createElement(SidebarResourceQueue, open))).toContain(
      'id="sidebar-resource-queue-panel"',
    );
    expect(renderInRow(createElement(SidebarResourceQueue, closedPanel))).not.toContain(
      'id="sidebar-resource-queue-panel"',
    );
  });

  it("keeps both triggers visible while one panel is open", () => {
    // Exclusivity is about the PANELS, not the controls. Closing the other
    // panel must never take its trigger out of the row.
    const markup = renderInRow(
      createElement(SidebarResourceQueue, { isOpen: true, onOpenChange: () => {} }),
    );
    expect(markup).toContain('aria-label="Resource Queue"');
  });
});

describe("Resource Queue in the footer row", () => {
  it("is a list item, so it is valid inside the row's <ul>", () => {
    expect(itemTag(renderInRow(createElement(SidebarResourceQueue, closedPanel)))).toContain("<li");
  });

  it("opts out of item-relative positioning so its popover spans the footer", () => {
    const tag = itemTag(renderInRow(createElement(SidebarResourceQueue, closedPanel)));
    expect(tag).toContain("static");
    expect(tag).not.toMatch(/\brelative\b/);
  });

  it("shows both count tags in the row even when the broker is silent", () => {
    // Zeroes are the common case and must still render — an icon with no counts
    // says nothing, which is the whole reason these are tags and not a bare icon.
    const markup = renderInRow(createElement(SidebarResourceQueue, closedPanel));
    expect(markup).toContain('title="running (holding a lease)"');
    expect(markup).toContain('title="waiting (queued)"');
  });

  it("surfaces the maintenance tag when the broker is draining", () => {
    queueState.snapshot = { maintenance: true, running: [], waiting: [], resources: [] };
    const withMaintenance = renderInRow(createElement(SidebarResourceQueue, closedPanel));
    queueState.snapshot = { maintenance: false, running: [], waiting: [], resources: [] };
    const without = renderInRow(createElement(SidebarResourceQueue, closedPanel));

    expect(withMaintenance).toContain('title="broker in maintenance (draining)"');
    expect(without).not.toContain('title="broker in maintenance (draining)"');
  });

  it("does not carry its old full-width text label into the row", () => {
    const markup = renderInRow(createElement(SidebarResourceQueue, closedPanel));
    expect(markup).not.toContain('<span class="text-xs">Resource Queue</span>');
    expect(markup).toContain('aria-label="Resource Queue"');
  });
});

describe("both footer panels are disclosures, not dialogs", () => {
  // Each opens on hover or click and closes on a mouse-leave timer. `dialog`
  // promises a screen reader a focus move, a focus trap and a restore on close,
  // none of which a panel that vanishes when the pointer drifts can honour —
  // and the honest reading of "it has no focus management" is that the role is
  // wrong, not that a trap is missing.
  const open = { isOpen: true, onOpenChange: () => {} };

  it("does not claim a dialog role it cannot honour", () => {
    const markup = renderInRow(createElement(SidebarResourceQueue, open));

    // Paired with the positive so the absence cannot pass by the panel simply
    // not rendering — which is exactly how this assertion would go vacuous.
    expect(markup).toContain('id="sidebar-resource-queue-panel"');
    expect(markup).not.toContain('role="dialog"');
    expect(markup).not.toContain("aria-haspopup");
  });

  it.each([
    ["Resource Queue", SidebarResourceQueue, "sidebar-resource-queue-panel"],
    ["Local models", SidebarLocalModels, "sidebar-local-models-panel"],
  ] as const)("points %s's trigger at the panel it expands", (_label, Component, panelId) => {
    const markup = renderInRow(createElement(Component, open));

    expect(markup).toContain(`aria-controls="${panelId}"`);
    expect(markup).toContain(`id="${panelId}"`);
    expect(markup).toContain('aria-expanded="true"');
  });

  it.each([
    ["Resource Queue", SidebarResourceQueue],
    ["Local models", SidebarLocalModels],
  ] as const)("drops %s's aria-controls while the panel is gone", (_label, Component) => {
    // A reference to an id that is not in the document is invalid ARIA, and the
    // panel only exists while open.
    const markup = renderInRow(createElement(Component, closedPanel));

    expect(markup).not.toContain("aria-controls");
    expect(markup).toContain('aria-expanded="false"');
  });
});
