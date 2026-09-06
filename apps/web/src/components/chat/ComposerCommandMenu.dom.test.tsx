import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { renderDom } from "../../testing/renderDom";
import { ComposerCommandMenu, type ComposerCommandItem } from "./ComposerCommandMenu";

const slashCommandItem: ComposerCommandItem = {
  id: "slash:model",
  type: "slash-command",
  command: "model",
  label: "/model",
  description: "Switch response model for this thread",
};

const appSkillItem: ComposerCommandItem = {
  id: "skill:codex:browser",
  type: "skill",
  provider: ProviderDriverKind.make("codex"),
  skill: {
    name: "browser",
    path: "/Users/maria/.codex/plugins/browser/skills/browser/SKILL.md",
    scope: "user",
    enabled: true,
  },
  label: "Browser",
  description: "Open and control the in-app browser",
};

const repoSkillItem: ComposerCommandItem = {
  id: "skill:codex:ask-matt",
  type: "skill",
  provider: ProviderDriverKind.make("codex"),
  skill: {
    name: "ask-matt",
    displayName: "Ask Matt",
    path: "/skills/ask-matt/SKILL.md",
    scope: "repo",
    enabled: true,
  },
  label: "/skill:ask-matt",
  description: "Find the right skill or workflow",
};

function renderMenu(
  item: ComposerCommandItem,
  overrides: {
    triggerKind?: "slash-command" | "skill";
    onSelect?: (item: ComposerCommandItem) => void;
  } = {},
) {
  return renderDom(
    <ComposerCommandMenu
      items={[item]}
      resolvedTheme="dark"
      isLoading={false}
      triggerKind={overrides.triggerKind ?? "slash-command"}
      activeItemId={item.id}
      onHighlightedItemChange={() => {}}
      onSelect={overrides.onSelect ?? (() => {})}
    />,
  );
}

describe("ComposerCommandMenu", () => {
  it("renders slash commands with their descriptions", async () => {
    const view = await renderMenu(slashCommandItem);

    expect(view.text()).toContain("/model");
    expect(view.text()).toContain("Switch response model for this thread");
  });

  it("shows the app source for an app skill", async () => {
    const view = await renderMenu(appSkillItem, { triggerKind: "skill" });

    expect(view.text()).toContain("Browser");
    const badge = view.find('[data-slot="badge"]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toContain("App Skill");
    expect(badge?.querySelector("svg")).not.toBeNull();
    expect(view.text()).toContain("Open and control the in-app browser");
  });

  it("shows the repo source for a slash skill", async () => {
    const view = await renderMenu(repoSkillItem);

    // The `/skill:` prefix is a dimmed lead-in on the same label as the skill's
    // display name, not a separate row.
    const prefix = view.find("span.text-secondary-label");
    expect(prefix?.textContent).toBe("/skill:");
    expect(prefix?.parentElement?.textContent).toBe("/skill:Ask Matt");
    const badge = view.find('[data-slot="badge"]');
    expect(badge?.textContent).toBe("Repo");
    expect(badge?.querySelector("svg")?.getAttribute("class")).toContain("lucide-folder");
    expect(view.text()).toContain("Find the right skill or workflow");
  });

  // Picking an entry is what the menu exists for, and it has to hand back the
  // whole item: the composer needs the skill/command payload, not just a label.
  it("hands the selected item back to the composer", async () => {
    const onSelect = vi.fn();
    const view = await renderMenu(repoSkillItem, { onSelect });

    await view.click(view.find('[data-composer-item-id="skill:codex:ask-matt"]'));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(repoSkillItem);
  });
});
