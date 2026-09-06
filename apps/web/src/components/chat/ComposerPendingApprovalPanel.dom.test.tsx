import { ApprovalRequestId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { renderDom } from "../../testing/renderDom";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";

describe("ComposerPendingApprovalPanel", () => {
  it("keeps the complete command readable in the compact row", async () => {
    const detail = `bun run release -- ${"x".repeat(500)}\nsecond line`;
    const view = await renderDom(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: ApprovalRequestId.make("approval-1"),
          requestKind: "command",
          createdAt: "2026-07-18T00:00:00.000Z",
          detail,
        }}
        pendingCount={1}
      />,
    );

    const complete = view.find('[data-approval-detail="complete"]');
    expect(complete).not.toBeNull();
    expect(complete?.getAttribute("aria-label")).toBe("Command");
    expect(view.find('[role="group"]')).not.toBeNull();

    // Keyboard-reachable, so the overflowing row can be scrolled without a mouse. Asserted on
    // the resolved property rather than by focusing it: happy-dom's `focus()` moves
    // `document.activeElement` even to an unfocusable element, so that check cannot fail.
    expect((complete as HTMLElement | null)?.tabIndex).toBe(0);

    expect(view.text()).toContain(detail);

    // The row is scrollable rather than clipped: bounded height, its own scrollbar, and
    // no wrapping, so a 500-character command stays complete instead of being cut off.
    for (const className of [
      "max-h-20",
      "overflow-auto",
      "whitespace-pre",
      "min-w-0",
      "[scrollbar-width:thin]",
      "[&::-webkit-scrollbar]:h-1.5",
    ]) {
      expect(complete?.classList.contains(className)).toBe(true);
    }
    expect(view.find(".truncate")).toBeNull();
    expect(view.find('[class*="line-clamp"]')).toBeNull();

    expect(view.text()).not.toContain("Command approval requested");
  });

  it("falls back to the approval kind when the provider sends an empty detail", async () => {
    const view = await renderDom(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: ApprovalRequestId.make("approval-2"),
          requestKind: "file-read",
          createdAt: "2026-07-18T00:00:00.000Z",
          detail: "",
        }}
        pendingCount={1}
      />,
    );

    expect(view.text()).toContain("File read approval");
  });

  it("shows the app name and message for an MCP access request", async () => {
    const view = await renderDom(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: ApprovalRequestId.make("approval-safari"),
          requestKind: "mcp-elicitation",
          createdAt: "2026-08-24T00:00:00.000Z",
          appName: "Safari",
          detail: "Allow ChatGPT to use Safari?",
        }}
        pendingCount={1}
      />,
    );

    expect(view.find('[aria-label="App access approval"]')).not.toBeNull();
    const complete = view.find('[aria-label="App access request"]');
    expect(complete).not.toBeNull();
    // The app name is its own element rather than part of the message text.
    expect(view.find(".max-w-32")?.textContent).toBe("Safari");
    expect(complete?.textContent).toBe("Allow ChatGPT to use Safari?");
  });

  it("limits long app names so the complete approval message stays readable", async () => {
    const appName = "A".repeat(200);
    const detail = "Allow ChatGPT to access the selected application?";
    const view = await renderDom(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: ApprovalRequestId.make("approval-long-app-name"),
          requestKind: "mcp-elicitation",
          createdAt: "2026-08-24T00:00:00.000Z",
          appName,
          detail,
        }}
        pendingCount={1}
      />,
    );

    const name = view.find(".max-w-32");
    expect(name?.textContent).toBe(appName);
    for (const className of ["max-w-32", "shrink", "truncate"]) {
      expect(name?.classList.contains(className)).toBe(true);
    }

    const complete = view.find('[data-approval-detail="complete"]');
    expect(complete).not.toBeNull();
    expect(complete?.textContent).toBe(detail);
  });
});
