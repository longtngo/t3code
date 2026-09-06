import { ApprovalRequestId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { renderDom } from "../../testing/renderDom";

import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";

/** The visible label of every approval button, in render order. */
const labelsOf = (buttons: ReadonlyArray<Element>) =>
  buttons.map((button) => button.textContent?.trim() ?? "");

describe("ComposerPendingApprovalActions", () => {
  it("states that the persistent approval lasts for this session", async () => {
    const view = await renderDom(
      <ComposerPendingApprovalActions
        requestId={ApprovalRequestId.make("approval-1")}
        isResponding={false}
        onRespondToApproval={async () => undefined}
      />,
    );

    const buttons = view.findAll("button");
    const labels = labelsOf(buttons);

    expect(labels).toContain("Cancel");
    expect(labels).toContain("Always allow this session");
    expect(labels).not.toContain("Always allow");

    // `size="micro"`: a 20px row that keeps its type size on wide viewports.
    expect([...(buttons[0]?.classList ?? [])]).toEqual(
      expect.arrayContaining(["h-5", "sm:text-[11px]"]),
    );
    expect(buttons[0]?.classList.contains("sm:h-6")).toBe(false);
  });

  it("shows only the approval choices advertised by an MCP server", async () => {
    const view = await renderDom(
      <ComposerPendingApprovalActions
        requestId={ApprovalRequestId.make("approval-safari")}
        isResponding={false}
        options={[
          { decision: "decline", label: "Decline" },
          { decision: "acceptAlways", label: "Always allow Safari" },
          { decision: "accept", label: "Approve" },
        ]}
        onRespondToApproval={async () => undefined}
      />,
    );

    const labels = labelsOf(view.findAll("button"));

    expect(labels).toContain("Always allow Safari");
    expect(labels).toContain("Approve");
    expect(labels).not.toContain("Always allow this session");
  });

  it("marks an option that carries a provider warning", async () => {
    const view = await renderDom(
      <ComposerPendingApprovalActions
        requestId={ApprovalRequestId.make("approval-1")}
        isResponding={false}
        options={[
          { decision: "accept", label: "Allow once" },
          {
            decision: "acceptForSession",
            label: "Allow for this thread",
            warning: "Untrusted files could re-run this action without asking.",
          },
          { decision: "decline", label: "Deny" },
        ]}
        onRespondToApproval={async () => undefined}
      />,
    );

    const warned = view.find(
      '[aria-description="Untrusted files could re-run this action without asking."]',
    );

    expect(warned).not.toBeNull();
    expect(warned?.classList.contains("text-warning")).toBe(true);
    expect(warned?.textContent).toContain("Allow for this thread");
  });

  it("limits provider-supplied approval labels so narrow rows can wrap", async () => {
    const label = "Allow ".repeat(40).trim();
    const view = await renderDom(
      <ComposerPendingApprovalActions
        requestId={ApprovalRequestId.make("approval-long-label")}
        isResponding={false}
        options={[{ decision: "acceptAlways", label }]}
        onRespondToApproval={async () => undefined}
      />,
    );

    const labelSlot = view.find("span.max-w-40.truncate");

    expect(labelSlot).not.toBeNull();
    expect(labelSlot?.textContent).toBe(label);
  });

  it("responds with the decision of the button that was pressed", async () => {
    const onRespondToApproval = vi.fn(async () => undefined);
    const requestId = ApprovalRequestId.make("approval-clicked");
    const view = await renderDom(
      <ComposerPendingApprovalActions
        requestId={requestId}
        isResponding={false}
        onRespondToApproval={onRespondToApproval}
      />,
    );

    const approve = view
      .findAll("button")
      .find((button) => button.textContent?.trim() === "Approve");

    await view.click(approve ?? null);

    expect(onRespondToApproval).toHaveBeenCalledTimes(1);
    expect(onRespondToApproval).toHaveBeenCalledWith(requestId, "accept");
  });

  it("cannot be answered while a response is in flight", async () => {
    const onRespondToApproval = vi.fn(async () => undefined);
    const view = await renderDom(
      <ComposerPendingApprovalActions
        requestId={ApprovalRequestId.make("approval-responding")}
        isResponding
        onRespondToApproval={onRespondToApproval}
      />,
    );

    const approve = view
      .findAll<HTMLButtonElement>("button")
      .find((button) => button.textContent?.trim() === "Approve");

    expect(approve?.disabled).toBe(true);

    await view.click(approve ?? null);

    expect(onRespondToApproval).not.toHaveBeenCalled();
  });
});
