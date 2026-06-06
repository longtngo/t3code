import { ApprovalRequestId } from "@t3tools/contracts";
import "../../index.css";

import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import type { PendingUserInput } from "../../session-logic";

const PROMPT: PendingUserInput = {
  requestId: ApprovalRequestId.make("req-pending-1"),
  createdAt: "2026-06-06T00:00:00.000Z",
  questions: [
    {
      id: "q1",
      header: "Approach",
      question: "Which approach should we take?",
      options: [
        { label: "Option A", description: "First choice" },
        { label: "Option B", description: "Second choice" },
        { label: "Option C", description: "Third choice" },
      ],
      multiSelect: false,
    },
  ],
};

async function mountPanel() {
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(
    <ComposerPendingUserInputPanel
      pendingUserInputs={[PROMPT]}
      respondingRequestIds={[]}
      answers={{}}
      questionIndex={0}
      onToggleOption={vi.fn()}
      onAdvance={vi.fn()}
    />,
    { container: host },
  );
  const cleanup = async () => {
    await screen.unmount();
    host.remove();
  };
  return { [Symbol.asyncDispose]: cleanup };
}

const optionsList = () =>
  document.querySelector<HTMLElement>('[data-pending-options-list="true"]');
const resizeHandle = () =>
  document.querySelector<HTMLElement>('[role="separator"][aria-label="Resize options"]');

describe("ComposerPendingUserInputPanel interactions", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("collapses to hide options for reading the chat behind, then re-expands", async () => {
    await using _ = await mountPanel();

    expect(document.body.textContent ?? "").toContain("Option A");

    await page.getByLabelText("Hide options").click();
    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).not.toContain("Option A");
      expect(text).toContain("hidden");
    });
    // The options list is unmounted while collapsed.
    expect(optionsList()).toBeNull();

    await page.getByLabelText("Show options").click();
    await vi.waitFor(() => {
      expect(document.body.textContent ?? "").toContain("Option A");
    });
    expect(optionsList()).not.toBeNull();
  });

  it("re-expands when the collapsed hint itself is tapped", async () => {
    await using _ = await mountPanel();

    await page.getByLabelText("Hide options").click();
    await vi.waitFor(() => expect(optionsList()).toBeNull());

    await page.getByText(/hidden — tap to show/).click();
    await vi.waitFor(() => {
      expect(document.body.textContent ?? "").toContain("Option A");
    });
  });

  it("resizes via keyboard on the focused handle and exposes a reset control", async () => {
    await using _ = await mountPanel();

    // No explicit height initially: no inline height, no reset affordance.
    expect(optionsList()?.style.height).toBe("");
    expect(document.querySelector('[aria-label="Reset options height"]')).toBeNull();

    const handle = resizeHandle();
    expect(handle).not.toBeNull();
    handle!.focus();
    handle!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));

    await vi.waitFor(() => {
      const list = optionsList();
      expect(list?.style.height).not.toBe("");
      // Once an explicit height is set, the list switches to the viewport clamp.
      expect(list?.className).toContain("max-h-[80dvh]");
    });
    const reset = document.querySelector<HTMLButtonElement>(
      '[aria-label="Reset options height"]',
    );
    expect(reset).not.toBeNull();

    reset!.click();
    await vi.waitFor(() => {
      expect(optionsList()?.style.height).toBe("");
      expect(document.querySelector('[aria-label="Reset options height"]')).toBeNull();
    });
  });
});
