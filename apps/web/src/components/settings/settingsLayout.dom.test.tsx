import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { renderDom } from "../../testing/renderDom";

import {
  scrollToSettingsTarget,
  SettingsRow,
  SettingsSearchTargetProvider,
  SettingsUnavailableGroup,
} from "./settingsLayout";

afterEach(() => {
  vi.unstubAllGlobals();
});

const PULSE_CLASS = "settings-search-target-pulse";

// Ported from upstream's settingsLayout.test.tsx, which this fork renamed to a
// real-DOM suite (docs/fork/README.md invariant 36). Upstream asserts on a static
// markup string; AGENTS.md rules that out, so this drives the same component and
// reads the mounted tree - which also drops upstream's HTML-escaped `[&amp;_h3]`.
describe("unavailable settings", () => {
  it("groups disabled controls under one reason", async () => {
    const view = await renderDom(
      <SettingsUnavailableGroup message="Only available in the desktop app.">
        <SettingsRow title="Window capture" description="Capture a window." />
      </SettingsUnavailableGroup>,
    );

    expect(view.text()).toContain("Only available in the desktop app.");
    // One reason for the whole group: the row's own heading is dimmed by the
    // wrapper rather than each row carrying its own disabled styling. Upstream's
    // markup string sees the group's two divs at once; here they are separate
    // nodes, so the dimming wrapper is read through its bordered parent.
    const dimmed = view.find('[class*="[&_h3]:opacity-64"]');
    expect(dimmed).not.toBeNull();
    expect(dimmed?.parentElement?.className).toContain("border-border/60");
    expect(view.text()).toContain("Window capture");
  });
});

describe("settings search targets", () => {
  it("does not persist destination styling in the rendered row", async () => {
    const rows = (className?: string) => (
      <SettingsSearchTargetProvider targetId="word-wrap">
        <SettingsRow
          id="word-wrap"
          title="Word wrap"
          description="Wrap long lines."
          className={className}
        />
        <SettingsRow id="time-format" title="Time format" description="Choose a clock." />
      </SettingsSearchTargetProvider>
    );
    const view = await renderDom(rows());

    expect(view.find("#word-wrap")?.getAttribute("tabindex")).toBe("-1");
    expect(view.find("[data-settings-search-target]")).toBeNull();
    // Only the destination is marked, and only imperatively at mount: a row that is not the
    // destination never carries the pulse...
    expect(view.find("#time-format")?.classList.contains(PULSE_CLASS)).toBe(false);
    // ...and because the pulse is not part of what the row renders, React's next write to that
    // row's class attribute drops it instead of putting it back.
    await view.rerender(rows("mt-2"));
    expect(view.find("#word-wrap")?.classList.contains(PULSE_CLASS)).toBe(false);
  });

  // Reaching the destination is the row's job on mount, and a static render never runs the ref
  // that does it, so none of this was covered before.
  it("takes the destination row on mount and tells the caller the jump landed", async () => {
    const onTargetHandled = vi.fn();
    const view = await renderDom(
      <SettingsSearchTargetProvider targetId="word-wrap" onTargetHandled={onTargetHandled}>
        <SettingsRow id="word-wrap" title="Word wrap" description="Wrap long lines." />
        <SettingsRow id="time-format" title="Time format" description="Choose a clock." />
      </SettingsSearchTargetProvider>,
    );

    expect(onTargetHandled).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(view.find("#word-wrap"));
    expect(view.find("#word-wrap")?.classList.contains(PULSE_CLASS)).toBe(true);
  });

  it("skips the pulse when the caller does not want the destination highlighted", async () => {
    const view = await renderDom(
      <SettingsSearchTargetProvider targetId="word-wrap" highlightTarget={false}>
        <SettingsRow id="word-wrap" title="Word wrap" description="Wrap long lines." />
      </SettingsSearchTargetProvider>,
    );

    expect(document.activeElement).toBe(view.find("#word-wrap"));
    expect(view.find("#word-wrap")?.classList.contains(PULSE_CLASS)).toBe(false);
  });

  it("scrolls directly to a section header and restarts the destination pulse", () => {
    const sectionScrollIntoView = vi.fn();
    const headerScrollIntoView = vi.fn();
    const focus = vi.fn();
    const remove = vi.fn();
    const add = vi.fn();
    const addEventListener = vi.fn();
    const target = {
      tagName: "SECTION",
      firstElementChild: { scrollIntoView: headerScrollIntoView },
      scrollIntoView: sectionScrollIntoView,
      focus,
      classList: { remove, add },
      addEventListener,
      offsetWidth: 100,
    } as unknown as HTMLElement;
    vi.stubGlobal("document", {
      getElementById: vi.fn(() => target),
    });
    vi.stubGlobal("window", {
      matchMedia: vi.fn(() => ({ matches: false })),
    });

    expect(scrollToSettingsTarget("providers")).toBe(true);
    expect(headerScrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    });
    expect(sectionScrollIntoView).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(remove).toHaveBeenCalledWith("settings-search-target-pulse");
    expect(add).toHaveBeenCalledWith("settings-search-target-pulse");
    expect(addEventListener).toHaveBeenCalledWith("blur", expect.any(Function), { once: true });
  });

  it("does not animate the destination when reduced motion is requested", () => {
    const scrollIntoView = vi.fn();
    const focus = vi.fn();
    const remove = vi.fn();
    const add = vi.fn();
    const target = {
      tagName: "DIV",
      firstElementChild: null,
      scrollIntoView,
      focus,
      classList: { remove, add },
      offsetWidth: 100,
    } as unknown as HTMLElement;
    vi.stubGlobal("document", {
      getElementById: vi.fn(() => target),
    });
    vi.stubGlobal("window", {
      matchMedia: vi.fn(() => ({ matches: true })),
    });

    expect(scrollToSettingsTarget("word-wrap")).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "auto",
      block: "center",
    });
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(remove).toHaveBeenCalledWith("settings-search-target-pulse");
    expect(add).not.toHaveBeenCalled();
  });

  it("leaves not-yet-mounted destinations to their mount lifecycle", () => {
    vi.stubGlobal("document", {
      getElementById: vi.fn(() => null),
    });

    expect(scrollToSettingsTarget("archive")).toBe(false);
  });
});
