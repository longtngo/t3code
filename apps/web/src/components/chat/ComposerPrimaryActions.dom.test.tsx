import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const stageArtworkState = vi.hoisted(() => ({
  mode: "none" as "artwork" | "none",
  variant: null as "nightly" | "dev" | null,
}));

vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentIdentificationMode: () => stageArtworkState.mode,
}));
vi.mock("../SidebarStageBackdrop", () => ({
  StageBackdropButtonArt: ({ variant }: { variant: string }) => `stage-${variant}`,
  useSidebarStageBackdropVariant: (enabled = true) => (enabled ? stageArtworkState.variant : null),
}));

import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { renderDom } from "../../testing/renderDom";

const STOP = '[aria-label="Stop generation"]';

function renderPendingActions(isRunning: boolean) {
  return renderDom(
    createElement(ComposerPrimaryActions, {
      compact: true,
      pendingAction: {
        questionIndex: 0,
        isLastQuestion: true,
        canAdvance: true,
        isResponding: false,
        isComplete: true,
      },
      isRunning,
      canInterrupt: isRunning,
      showPlanFollowUpPrompt: false,
      promptHasText: false,
      isSendBusy: false,
      sendDisabledReason: null,
      isConnecting: false,
      isEnvironmentUnavailable: false,
      isPreparingWorktree: false,
      hasSendableContent: false,
      onPreviousPendingQuestion: () => {},
      onInterrupt: () => {},
      onImplementPlanInNewThread: () => {},
    }),
  );
}

// `hasSendableContent` is parameterised deliberately. Send's `disabled` already
// includes `!hasSendableContent`, so a fixture hardcoding `false` makes every
// enabled/disabled assertion pass no matter what the running branch does.
function renderRunning(options?: { hasSendableContent?: boolean; onInterrupt?: () => void }) {
  return renderDom(
    createElement(ComposerPrimaryActions, {
      compact: true,
      pendingAction: null,
      isRunning: true,
      canInterrupt: true,
      showPlanFollowUpPrompt: false,
      promptHasText: false,
      isSendBusy: false,
      sendDisabledReason: null,
      isConnecting: false,
      isEnvironmentUnavailable: false,
      isPreparingWorktree: false,
      hasSendableContent: options?.hasSendableContent ?? false,
      onPreviousPendingQuestion: () => {},
      onInterrupt: options?.onInterrupt ?? (() => {}),
      onImplementPlanInNewThread: () => {},
    }),
  );
}

function renderStandaloneStop() {
  return renderRunning();
}

function renderSendButton(sendDisabledReason: string | null = null) {
  return renderDom(
    createElement(ComposerPrimaryActions, {
      compact: true,
      pendingAction: null,
      isRunning: false,
      canInterrupt: false,
      showPlanFollowUpPrompt: false,
      promptHasText: true,
      isSendBusy: false,
      sendDisabledReason,
      isConnecting: false,
      isEnvironmentUnavailable: false,
      isPreparingWorktree: false,
      hasSendableContent: true,
      onPreviousPendingQuestion: () => {},
      onInterrupt: () => {},
      onImplementPlanInNewThread: () => {},
    }),
  );
}

afterEach(() => {
  stageArtworkState.mode = "none";
  stageArtworkState.variant = null;
});

describe("ComposerPrimaryActions", () => {
  it("disables and labels the send button while feedback is uploading", async () => {
    const view = await renderSendButton("Sending feedback");

    const send = view.find<HTMLButtonElement>('[aria-label="Sending feedback"]');
    expect(send).not.toBeNull();
    // The real `disabled` property, not the substring "disabled": the class list carries
    // `disabled:` Tailwind variants, so a markup substring matched unconditionally.
    expect(send?.disabled).toBe(true);
  });

  it("offers Stop generation while a running turn is waiting for user input", async () => {
    const view = await renderPendingActions(true);
    expect(view.find(STOP)).not.toBeNull();
  });

  it("does not offer Stop generation for a pending request without a running turn", async () => {
    const view = await renderPendingActions(false);
    expect(view.find(STOP)).toBeNull();
  });

  it("matches the small pending action size without changing the standalone size", async () => {
    const pending = await renderPendingActions(true);
    const pendingStop = pending.find(STOP);
    expect(pendingStop?.classList.contains("size-8")).toBe(true);
    expect(pendingStop?.classList.contains("sm:size-7")).toBe(true);

    const standalone = await renderStandaloneStop();
    const standaloneStop = standalone.find(STOP);
    for (const size of ["size-8", "sm:h-8", "sm:w-8"]) {
      expect(standaloneStop?.classList.contains(size)).toBe(true);
    }
    expect(standaloneStop?.classList.contains("sm:size-7")).toBe(false);
  });

  // Upstream's v2 composer shows Stop alone while a run has nothing to send, and
  // swaps it for the steer/queue action once there is a follow-up to send.
  it("offers Stop while running with nothing to send, and Steer once there is", async () => {
    const empty = await renderRunning({ hasSendableContent: false });
    expect(empty.find(STOP)).not.toBeNull();
    expect(empty.find('[aria-label="Steer message"]')).toBeNull();

    const sendable = await renderRunning({ hasSendableContent: true });
    expect(sendable.find<HTMLButtonElement>('[aria-label="Steer message"]')?.disabled).toBe(false);
  });

  it("renders stage artwork inside the send button when artwork identification is active", async () => {
    stageArtworkState.mode = "artwork";
    stageArtworkState.variant = "nightly";

    const view = await renderSendButton();

    expect(view.text()).toContain("stage-nightly");
  });

  it("hides stage artwork when artwork identification is inactive", async () => {
    stageArtworkState.variant = "nightly";

    const view = await renderSendButton();

    expect(view.text()).not.toContain("stage-nightly");
  });
});

// A collapsed composer (the desktop resting layout, the phone's one-line row)
// shows Send only when there is something to send. An empty prompt there
// renders no Send at all rather than a disabled one; Stop is unaffected.
function renderIdleHidden(options: {
  hasSendableContent: boolean;
  isRunning: boolean;
  isSendBusy?: boolean;
}) {
  return renderDom(
    createElement(ComposerPrimaryActions, {
      compact: true,
      hideIdleSend: true,
      pendingAction: null,
      isRunning: options.isRunning,
      canInterrupt: options.isRunning,
      showPlanFollowUpPrompt: false,
      promptHasText: options.hasSendableContent,
      isSendBusy: options.isSendBusy ?? false,
      sendDisabledReason: null,
      isConnecting: false,
      isEnvironmentUnavailable: false,
      isPreparingWorktree: false,
      hasSendableContent: options.hasSendableContent,
      onPreviousPendingQuestion: () => {},
      onInterrupt: () => {},
      onImplementPlanInNewThread: () => {},
    }),
  );
}

describe("ComposerPrimaryActions with hideIdleSend", () => {
  it("renders no Send when there is nothing to send", async () => {
    const view = await renderIdleHidden({ hasSendableContent: false, isRunning: false });
    expect(view.find('[aria-label="Submit message"]')).toBeNull();
  });

  it("renders Send once there is something to send", async () => {
    const view = await renderIdleHidden({ hasSendableContent: true, isRunning: false });
    expect(view.find<HTMLButtonElement>('[aria-label="Submit message"]')?.disabled).toBe(false);
  });

  // The draft is cleared at dispatch, so mid-send there is nothing sendable;
  // the "Sending" spinner has to stay until the dispatch settles.
  it("keeps the Sending spinner while a dispatch is in flight", async () => {
    const view = await renderIdleHidden({
      hasSendableContent: false,
      isRunning: false,
      isSendBusy: true,
    });
    expect(view.find('[aria-label="Submitting message"]')).not.toBeNull();
  });

  it("keeps Stop while running and still hides the idle Send", async () => {
    const view = await renderIdleHidden({ hasSendableContent: false, isRunning: true });
    expect(view.find(STOP)).not.toBeNull();
    expect(view.find('[aria-label="Submit message"]')).toBeNull();
  });
});
