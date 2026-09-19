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

    expect(view.text()).toContain(detail);
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

    expect(view.text()).toContain("Safari");
    expect(view.text()).toContain("Allow ChatGPT to use Safari?");
  });

  it("preserves the full app name and approval message", async () => {
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

    expect(view.text()).toContain(appName);
    expect(view.text()).toContain(detail);
  });
});
