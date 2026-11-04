import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { useCommitOnBlur } from "../hooks/useCommitOnBlur";
import { AppRouteModal } from "./AppRouteModal";

function CommitOnBlurField({ onCommit }: { onCommit: (next: string) => void }) {
  return <input aria-label="Instructions" {...useCommitOnBlur("", onCommit)} />;
}

describe("AppRouteModal", () => {
  // Fork: Escape inside a field keeps the modal open (the settings Escape guard,
  // `shouldLeaveSettingsOnEscape`), so upstream's "Esc closes and commits" becomes: Esc in the
  // field keeps the page and the text, and the field commits once focus leaves it.
  it("keeps a focused field and its text when Esc is pressed in it", async () => {
    const onCommit = vi.fn();
    await using _screen = await render(
      <AppRouteModal label="Settings">
        <CommitOnBlurField onCommit={onCommit} />
        <button type="button">Done</button>
      </AppRouteModal>,
      { router: "/settings/general" },
    );

    const field = page.getByRole("textbox", { name: "Instructions" });
    await field.fill("Keep titles short");
    await userEvent.keyboard("{Escape}");

    await expect.element(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    await expect.element(field).toHaveValue("Keep titles short");

    await userEvent.keyboard("{Tab}");
    await expect.element(page.getByRole("button", { name: "Done" })).toHaveFocus();
    expect(onCommit).toHaveBeenCalledWith("Keep titles short");
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();
  });
});
