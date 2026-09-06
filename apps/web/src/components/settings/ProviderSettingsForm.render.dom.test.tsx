import { describe, expect, it, vi } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";

import { renderDom } from "../../testing/renderDom";
import { DRIVER_OPTION_BY_VALUE } from "./providerDriverMeta";
import { ProviderSettingsForm } from "./ProviderSettingsForm";

// These mount the real form so the dropdown can be opened and chosen from. What a helper test
// cannot reach is whether the dropdown branch is wired at all, in every variant including
// `settings` (upstream's rename of `grid`), which used to fall through to a free-text input for
// a closed-set field.
const renderClaudeForm = (
  variant: "card" | "dialog" | "settings",
  value: unknown,
  onChange: (next: Record<string, unknown> | undefined) => void = () => {},
) => {
  const claude = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("claudeAgent")];
  expect(claude).toBeDefined();
  return renderDom(
    <ProviderSettingsForm
      definition={claude!}
      value={value}
      idPrefix="test"
      variant={variant}
      onChange={onChange}
    />,
  );
};

describe("ProviderSettingsForm output style rendering", () => {
  it.each(["card", "dialog", "settings"] as const)(
    "renders a real dropdown in the %s variant",
    async (variant) => {
      const view = await renderClaudeForm(variant, { outputStyle: "Learning" });

      expect(view.find('[role="combobox"][aria-label="Output style"]')).not.toBeNull();
      expect(view.find("select")).toBeNull();
    },
  );

  it("shows the placeholder row, in placeholder colour, when no style is stored", async () => {
    const unset = await renderClaudeForm("card", {});

    expect(unset.text()).toContain("Use ~/.claude/settings.json");
    // Unset reads as unset: Base UI marks an empty value with the `data-placeholder`
    // attribute (the class list mentions it in both states, so match the attribute).
    expect(unset.find("[data-placeholder]")).not.toBeNull();

    const set = await renderClaudeForm("card", { outputStyle: "Learning" });
    expect(set.find("[data-placeholder]")).toBeNull();
  });

  it("still renders text fields as inputs, not dropdowns", async () => {
    const view = await renderClaudeForm("card", { outputStyle: "Learning" });

    // The dropdown branch keys off `control: "select"`. A branch that fired for every
    // field would swallow `binaryPath` too.
    const binaryPath = view.find("#test-binaryPath");
    expect(binaryPath).not.toBeNull();
    expect(binaryPath?.tagName).toBe("INPUT");
  });

  it("stores the style the user picks, and omits the key for the default row", async () => {
    const onChange = vi.fn();
    const view = await renderClaudeForm("card", { binaryPath: "/custom/claude" }, onChange);

    await view.click(view.find('[role="combobox"][aria-label="Output style"]'));
    // The Base UI popup portals outside the mount host, so it is queried from the document.
    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(options.map((option) => option.textContent)).toEqual([
      "Use ~/.claude/settings.json",
      "Concise",
      "Explanatory",
      "Learning",
      "Proactive",
    ]);

    await view.click(options.find((option) => option.textContent === "Learning") ?? null);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({
      binaryPath: "/custom/claude",
      outputStyle: "Learning",
    });
  });
});
