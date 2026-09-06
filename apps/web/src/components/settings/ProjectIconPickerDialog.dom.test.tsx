import type { ComponentProps, ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { renderDom } from "../../testing/renderDom";

// The real dialog renders through a portal, outside the container this harness queries, and the
// scroll area and toggle group pull in browser APIs the picker's own logic does not need. These
// stand-ins keep the tree inside the container while forwarding the handlers the picker wires up,
// so a click still reaches the component under test.
vi.mock("../ui/button", () => ({
  Button: ({ children, onClick }: ComponentProps<"button">) => (
    <button onClick={onClick}>{children}</button>
  ),
}));

vi.mock("../ui/dialog", () => {
  const Container = ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>;
  return {
    Dialog: Container,
    DialogDescription: Container,
    DialogFooter: Container,
    DialogHeader: Container,
    DialogPanel: Container,
    DialogPopup: Container,
    DialogTitle: Container,
  };
});

vi.mock("../ui/input", () => ({ Input: () => <input /> }));
vi.mock("../ui/scroll-area", () => ({
  ScrollArea: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../ui/toggle-group", () => ({
  Toggle: ({ children, value }: { readonly children?: ReactNode; readonly value: string }) => (
    <button data-value={value}>{children}</button>
  ),
  ToggleGroup: ({
    children,
    value,
  }: {
    readonly children?: ReactNode;
    readonly value: readonly string[];
  }) => <div data-current={value.join(",")}>{children}</div>,
}));

import { ProjectIconPickerDialog } from "./ProjectIconPickerDialog";

describe("ProjectIconPickerDialog", () => {
  it("shows icons first and selects them for an automatic project", async () => {
    const view = await renderDom(
      <ProjectIconPickerDialog current={null} open onOpenChange={() => {}} onSelect={() => {}} />,
    );

    expect(view.find('[data-current="lucide"]')).not.toBeNull();
    expect(view.findAll("[data-value]").map((toggle) => toggle.textContent)).toEqual([
      "Icons",
      "Emoji",
    ]);
    expect(view.find('[aria-label="Icon color"]')).not.toBeNull();
  });

  it("saves the icon, color, and emoji the user picked", async () => {
    const onSelect = vi.fn();
    const onOpenChange = vi.fn();
    const view = await renderDom(
      <ProjectIconPickerDialog
        current={null}
        open
        onOpenChange={onOpenChange}
        onSelect={onSelect}
      />,
    );

    await view.click(view.find('[aria-label="Red"]'));
    await view.click(view.find('[aria-label="Terminal"]'));

    expect(view.find('[aria-label="Terminal"]')?.getAttribute("aria-pressed")).toBe("true");

    const save = view.findAll("button").find((button) => button.textContent === "Save icon");
    await view.click(save ?? null);

    expect(onSelect).toHaveBeenCalledWith({ kind: "lucide", name: "terminal", color: "red" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("saves the emoji an emoji project already carries", async () => {
    const onSelect = vi.fn();
    const view = await renderDom(
      <ProjectIconPickerDialog
        current={{ kind: "emoji", emoji: "🚀" }}
        open
        onOpenChange={() => {}}
        onSelect={onSelect}
      />,
    );

    expect(view.find('[data-current="emoji"]')).not.toBeNull();

    await view.click(view.find('[aria-label="Robot"]'));
    const save = view.findAll("button").find((button) => button.textContent === "Save icon");
    await view.click(save ?? null);

    expect(onSelect).toHaveBeenCalledWith({ kind: "emoji", emoji: "🤖" });
  });

  it("closes without selecting anything on cancel", async () => {
    const onSelect = vi.fn();
    const onOpenChange = vi.fn();
    const view = await renderDom(
      <ProjectIconPickerDialog
        current={null}
        open
        onOpenChange={onOpenChange}
        onSelect={onSelect}
      />,
    );

    const cancel = view.findAll("button").find((button) => button.textContent === "Cancel");
    await view.click(cancel ?? null);

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
