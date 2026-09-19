import { ApprovalRequestId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { renderDom } from "../../testing/renderDom";

import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";

/** The visible label of every approval button, in render order. */
const labelsOf = (buttons: ReadonlyArray<Element>) =>
  buttons.map((button) => button.textContent?.trim() ?? "");

describe("ComposerPendingApprovalActions", () => {
  it("keeps the main decisions visible and secondary decisions in the menu", async () => {
    const view = await renderDom(
      <ComposerPendingApprovalActions
        requestId={ApprovalRequestId.make("approval-1")}
        isResponding={false}
        onRespondToApproval={async () => undefined}
      />,
    );

    const labels = labelsOf(view.findAll("button"));

    expect(labels).toContain("Decline");
    expect(labels).toContain("Approve");
    expect(labels).not.toContain("Cancel");
    expect(labels).not.toContain("Always allow this session");
    expect(view.find('[aria-label="More approval options"]')).not.toBeNull();
  });

  it("keeps secondary provider labels out of the compact action row", async () => {
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

    expect(labels).not.toContain("Always allow Safari");
    expect(labels).toContain("Approve");
    expect(labels).not.toContain("Always allow this session");
  });

  it("preserves provider labels for the main decisions", async () => {
    const view = await renderDom(
      <ComposerPendingApprovalActions
        requestId={ApprovalRequestId.make("approval-1")}
        isResponding={false}
        options={[
          { decision: "accept", label: "Allow once" },
          { decision: "decline", label: "Deny" },
        ]}
        onRespondToApproval={async () => undefined}
      />,
    );

    const labels = labelsOf(view.findAll("button"));

    expect(labels).toContain("Allow once");
    expect(labels).toContain("Deny");
    expect(labels).not.toContain("Approve");
    expect(labels).not.toContain("Decline");
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
