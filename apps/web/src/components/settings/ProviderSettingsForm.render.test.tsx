import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";

import { DRIVER_OPTION_BY_VALUE } from "./providerDriverMeta";
import { ProviderSettingsForm } from "./ProviderSettingsForm";

// The unit project has no DOM environment, so these render to a static string rather than
// driving the control. That is enough for what a helper test cannot reach: whether the
// dropdown branch is wired at all, in every variant including `grid`, which used to fall
// through to a free-text input for a closed-set field.
const renderClaudeForm = (variant: "card" | "dialog" | "grid", value: unknown) => {
  const claude = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("claudeAgent")];
  expect(claude).toBeDefined();
  return renderToStaticMarkup(
    <ProviderSettingsForm
      definition={claude!}
      value={value}
      idPrefix="test"
      variant={variant}
      onChange={() => {}}
    />,
  );
};

describe("ProviderSettingsForm output style rendering", () => {
  it.each(["card", "dialog", "grid"] as const)(
    "renders a real dropdown in the %s variant",
    (variant) => {
      const markup = renderClaudeForm(variant, { outputStyle: "Learning" });

      expect(markup).toContain('role="combobox"');
      expect(markup).toContain('aria-label="Output style"');
      expect(markup).not.toContain("<select");
    },
  );

  it("shows the placeholder row, in placeholder colour, when no style is stored", () => {
    const markup = renderClaudeForm("card", {});

    expect(markup).toContain("Use ~/.claude/settings.json");
    // Unset reads as unset: Base UI marks an empty value with the `data-placeholder`
    // attribute (the class list mentions it in both states, so match the attribute).
    expect(markup).toContain('data-placeholder=""');
    expect(renderClaudeForm("card", { outputStyle: "Learning" })).not.toContain(
      'data-placeholder=""',
    );
  });

  it("still renders text fields as inputs, not dropdowns", () => {
    const markup = renderClaudeForm("card", { outputStyle: "Learning" });

    // The dropdown branch keys off `control: "select"`. A branch that fired for every
    // field would swallow `binaryPath` too.
    expect(markup).toContain('id="test-binaryPath"');
    expect(markup).not.toContain('<select id="test-binaryPath"');
  });
});
