import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { CLAUDE_OUTPUT_STYLES, ProviderDriverKind } from "@t3tools/contracts";

import { DRIVER_OPTION_BY_VALUE } from "./providerDriverMeta";
import { ProviderSettingsForm } from "./ProviderSettingsForm";

// The unit project has no DOM environment, so these render to a static string rather than
// driving the control. That is enough for what a helper test cannot reach: whether the
// dropdown branch is wired at all, and whether it keeps the affordances that tell a user
// it opens. `folder` is the cautionary case - a control annotated on two Claude fields
// that no renderer branches on, which passes every key-based assertion in this repo.
const renderClaudeForm = (variant: "card" | "dialog") => {
  const claude = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("claudeAgent")];
  expect(claude).toBeDefined();
  return renderToStaticMarkup(
    <ProviderSettingsForm
      definition={claude!}
      value={{ outputStyle: "Learning" }}
      idPrefix="test"
      variant={variant}
      onChange={() => {}}
    />,
  );
};

describe("ProviderSettingsForm output style rendering", () => {
  it.each(["card", "dialog"] as const)("renders a real dropdown in the %s variant", (variant) => {
    const markup = renderClaudeForm(variant);

    expect(markup).toContain('<select id="test-outputStyle"');
    for (const style of CLAUDE_OUTPUT_STYLES) {
      // The chosen option also carries `selected=""`, so match the two halves
      // rather than one exact tag.
      expect(markup).toMatch(new RegExp(`<option value="${style}"[^>]*>${style}</option>`));
    }
    expect(markup).toContain('<option value="">Use ~/.claude/settings.json</option>');
    // The stored value is what the dropdown shows, not merely one of its rows.
    expect(markup).toMatch(/<option value="Learning" selected="">/);
  });

  it("keeps the chevron that is the only remaining cue the control opens", () => {
    const markup = renderClaudeForm("card");

    // Asserted against the two elements' own class lists, not as substrings of the whole
    // document. A loose `toContain` passes on any of these classes appearing anywhere -
    // including on a different field - so it cannot tell a working overlay from a broken
    // one. Dropping `pe-7` alone paints the chevron over the end of the longest label.
    const select = markup.match(/<select id="test-outputStyle" class="([^"]*)"/)?.[1]?.split(" ");
    expect(select).toEqual(
      // `appearance-none` is what makes the select share the text fields' chrome, and it
      // takes the browser's own arrow with it; `pe-7` is the room the chevron needs.
      expect.arrayContaining(["appearance-none", "cursor-pointer", "pe-7", "bg-transparent"]),
    );

    const chevron = markup.match(/<svg[^>]*class="([^"]*lucide-chevrons-up-down[^"]*)"/)?.[1];
    expect(chevron?.split(" ")).toEqual(
      expect.arrayContaining(["absolute", "end-2", "size-4", "pointer-events-none"]),
    );
    expect(markup).toContain('aria-hidden="true"');
  });

  it("still renders text fields as inputs, not dropdowns", () => {
    const markup = renderClaudeForm("card");

    // The dropdown branch keys off `options` being present. A branch that fired for every
    // field would swallow `binaryPath` too.
    expect(markup).toContain('id="test-binaryPath"');
    expect(markup).not.toContain('<select id="test-binaryPath"');
  });
});
