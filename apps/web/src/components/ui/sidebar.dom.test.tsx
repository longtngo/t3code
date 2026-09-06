import { describe, expect, it, vi } from "vite-plus/test";

import { renderDom } from "../../testing/renderDom";

import {
  SidebarMenuButton,
  SidebarMenuSubButton,
  SidebarProvider,
  SidebarTrigger,
} from "./sidebar";
import { resolveSidebarState } from "./sidebarState";

function renderSidebarButton(className?: string) {
  return renderDom(
    <SidebarProvider>
      <SidebarMenuButton className={className}>Projects</SidebarMenuButton>
    </SidebarProvider>,
  );
}

const classesOf = (element: Element | null) => [...(element?.classList ?? [])];

describe("sidebar interactive cursors", () => {
  it("uses mobile sheet visibility for the shared responsive state", () => {
    expect(resolveSidebarState({ isMobile: true, open: true, openMobile: false })).toBe(
      "collapsed",
    );
    expect(resolveSidebarState({ isMobile: true, open: false, openMobile: true })).toBe("expanded");
    expect(resolveSidebarState({ isMobile: false, open: true, openMobile: false })).toBe(
      "expanded",
    );
  });

  it("exposes collapsed state for shared titlebar inset styling", async () => {
    const view = await renderDom(
      <SidebarProvider defaultOpen={false}>
        <div />
      </SidebarProvider>,
    );

    expect(view.find('[data-sidebar-state="collapsed"]')).not.toBeNull();
  });

  it("keeps the sidebar trigger interactive inside Electron drag regions", async () => {
    const view = await renderDom(
      <SidebarProvider>
        <SidebarTrigger />
      </SidebarProvider>,
    );

    expect(classesOf(view.find('[data-slot="sidebar-trigger"]'))).toEqual(
      expect.arrayContaining([
        "[-webkit-app-region:no-drag]",
        "size-[var(--workspace-titlebar-control-size)]!",
      ]),
    );
  });

  it("uses shared geometry and icon constraints for menu buttons by default", async () => {
    const view = await renderSidebarButton();
    const classes = classesOf(view.find('[data-slot="sidebar-menu-button"]'));

    expect(view.find('[data-slot="sidebar-menu-button"]')).not.toBeNull();
    expect(classes).toEqual(
      expect.arrayContaining([
        "h-8",
        "rounded-[var(--control-radius)]",
        "px-[var(--sidebar-row-content-inset)]",
        "py-1.5",
        "[&>svg:not([class*='size-'])]:size-4",
        "[&>svg]:shrink-0",
        "cursor-pointer",
        "gap-[var(--sidebar-control-gap)]",
        "[&>svg]:text-[var(--sidebar-icon-color)]",
      ]),
    );
    expect(classes).not.toContain("[&>svg]:opacity-60");
  });

  it("applies the shared default treatment to icon-only menu buttons", async () => {
    const view = await renderDom(
      <SidebarProvider>
        <SidebarMenuButton size="icon">
          <span>+</span>
        </SidebarMenuButton>
      </SidebarProvider>,
    );

    expect(classesOf(view.find('[data-slot="sidebar-menu-button"]'))).toEqual(
      expect.arrayContaining([
        "size-8",
        "justify-center",
        "p-0",
        "font-medium",
        "text-sidebar-muted-foreground/80",
      ]),
    );
  });

  it("lets project drag handles override the default pointer cursor", async () => {
    const view = await renderSidebarButton("cursor-grab");
    const classes = classesOf(view.find('[data-slot="sidebar-menu-button"]'));

    expect(classes).toContain("cursor-grab");
    expect(classes).not.toContain("cursor-pointer");
  });

  it("uses a pointer cursor for submenu buttons", async () => {
    const view = await renderDom(
      <SidebarMenuSubButton render={<button type="button" />}>Show more</SidebarMenuSubButton>,
    );

    const button = view.find('[data-slot="sidebar-menu-sub-button"]');

    expect(button).not.toBeNull();
    expect(classesOf(button)).toContain("cursor-pointer");
  });
});

describe("sidebar interaction", () => {
  it("toggles the shared collapsed state when the trigger is pressed", async () => {
    const onClick = vi.fn();
    const view = await renderDom(
      <SidebarProvider defaultOpen>
        <SidebarTrigger onClick={onClick} />
      </SidebarProvider>,
    );

    expect(view.find('[data-sidebar-state="expanded"]')).not.toBeNull();

    await view.click(view.find('[data-slot="sidebar-trigger"]'));

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(view.find('[data-sidebar-state="collapsed"]')).not.toBeNull();
    expect(view.find('[data-sidebar-state="expanded"]')).toBeNull();

    await view.click(view.find('[data-slot="sidebar-trigger"]'));

    expect(view.find('[data-sidebar-state="expanded"]')).not.toBeNull();
  });

  it("forwards clicks on a menu button to its handler", async () => {
    const onClick = vi.fn();
    const view = await renderDom(
      <SidebarProvider>
        <SidebarMenuButton onClick={onClick}>Projects</SidebarMenuButton>
      </SidebarProvider>,
    );

    await view.click(view.find('[data-slot="sidebar-menu-button"]'));

    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
