import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
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

import { ComposerPrimaryActions, formatPendingPrimaryActionLabel } from "./ComposerPrimaryActions";

function renderPendingActions(isRunning: boolean) {
  return renderToStaticMarkup(
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
      showPlanFollowUpPrompt: false,
      promptHasText: false,
      isSendBusy: false,
      sendDisabledReason: null,
      isConnecting: false,
      isEnvironmentUnavailable: false,
      isSendBlocked: false,
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
function renderRunning(options?: { hasSendableContent?: boolean }) {
  return renderToStaticMarkup(
    createElement(ComposerPrimaryActions, {
      compact: true,
      pendingAction: null,
      isRunning: true,
      showPlanFollowUpPrompt: false,
      promptHasText: false,
      isSendBusy: false,
      sendDisabledReason: null,
      isConnecting: false,
      isEnvironmentUnavailable: false,
      isSendBlocked: false,
      isPreparingWorktree: false,
      hasSendableContent: options?.hasSendableContent ?? false,
      onPreviousPendingQuestion: () => {},
      onInterrupt: () => {},
      onImplementPlanInNewThread: () => {},
    }),
  );
}

function renderStandaloneStop() {
  return renderRunning();
}

function renderSendButton() {
  return renderToStaticMarkup(
    createElement(ComposerPrimaryActions, {
      compact: true,
      pendingAction: null,
      isRunning: false,
      showPlanFollowUpPrompt: false,
      promptHasText: true,
      isSendBusy: false,
      sendDisabledReason: null,
      isConnecting: false,
      isEnvironmentUnavailable: false,
      isSendBlocked: false,
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

describe("formatPendingPrimaryActionLabel", () => {
  it("returns 'Submitting...' while responding", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: false,
        isResponding: true,
        questionIndex: 0,
      }),
    ).toBe("Submitting...");
  });

  it("returns 'Submitting...' while responding regardless of other flags", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: true,
        isLastQuestion: true,
        isResponding: true,
        questionIndex: 3,
      }),
    ).toBe("Submitting...");
  });

  it("returns 'Submit' in compact mode on the last question", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: true,
        isLastQuestion: true,
        isResponding: false,
        questionIndex: 0,
      }),
    ).toBe("Submit");
  });

  it("returns 'Next' in compact mode when not the last question", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: true,
        isLastQuestion: false,
        isResponding: false,
        questionIndex: 1,
      }),
    ).toBe("Next");
  });

  it("returns 'Next question' when not the last question", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: false,
        isResponding: false,
        questionIndex: 0,
      }),
    ).toBe("Next question");
  });

  it("returns singular 'Submit answer' on the last question when it is the only question", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: true,
        isResponding: false,
        questionIndex: 0,
      }),
    ).toBe("Submit answer");
  });

  it("returns plural 'Submit answers' on the last question when there are multiple questions", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: true,
        isResponding: false,
        questionIndex: 1,
      }),
    ).toBe("Submit answers");
  });

  it("returns plural 'Submit answers' for higher question indices", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: true,
        isResponding: false,
        questionIndex: 5,
      }),
    ).toBe("Submit answers");
  });
});

describe("ComposerPrimaryActions", () => {
  it("offers Stop generation while a running turn is waiting for user input", () => {
    expect(renderPendingActions(true)).toContain('aria-label="Stop generation"');
  });

  it("does not offer Stop generation for a pending request without a running turn", () => {
    expect(renderPendingActions(false)).not.toContain('aria-label="Stop generation"');
  });

  it("matches the small pending action size without changing the standalone size", () => {
    expect(renderPendingActions(true)).toContain("size-8 sm:size-7");
    // Standalone Stop now matches Send's footprint so the pair is even; it was
    // `size-8` (32px) against Send's 36px below `sm`.
    expect(renderStandaloneStop()).toContain("h-9 w-9 sm:h-8 sm:w-8");
    expect(renderStandaloneStop()).not.toContain("sm:size-7");
  });

  it("keeps Send mounted beside Stop while a turn is running", () => {
    const markup = renderRunning();
    expect(markup).toContain('aria-label="Stop generation"');
    expect(markup).toContain('aria-label="Send message"');
  });

  it("leaves Send usable while running so a follow-up can be queued", () => {
    // Must match the ATTRIBUTE, not the substring: the class list carries
    // `disabled:opacity-30` and friends, so `toContain("disabled")` is true of
    // every render and asserts nothing.
    //
    // Not vacuous in the other direction either — flipping `hasSendableContent`
    // flips the outcome, which is exactly what the second assertion pins.
    expect(renderRunning({ hasSendableContent: true })).not.toContain('disabled=""');
    expect(renderRunning({ hasSendableContent: false })).toContain('disabled=""');
  });

  it("renders stage artwork inside the send button when artwork identification is active", () => {
    stageArtworkState.mode = "artwork";
    stageArtworkState.variant = "nightly";

    const markup = renderSendButton();

    expect(markup).toContain("stage-nightly");
    expect(markup).toContain("bg-transparent text-white");
    expect(markup).not.toContain("bg-message-action text-message-action-foreground");
  });

  it("keeps the normal send-button fill when artwork identification is inactive", () => {
    stageArtworkState.variant = "nightly";

    const markup = renderSendButton();

    expect(markup).not.toContain("stage-nightly");
    expect(markup).toContain("bg-message-action text-message-action-foreground");
  });

  // FORK: upstream's three "showSendWhileRunning" tests sat here (#4781). They
  // assert that Stop is the ONLY action while a turn runs unless a mobile-only
  // opt-in prop is set. This fork keeps Send mounted beside Stop on every
  // viewport — the control must not move between idle and running, and every
  // adapter has a defined concurrent-send path — so that prop does not exist
  // here and those tests assert behaviour this composer no longer has.
  // The two tests above ("keeps Send mounted beside Stop while a turn is
  // running", "leaves Send usable while running so a follow-up can be queued")
  // are the fork's coverage of the same ground.
});

describe("ComposerPrimaryActions cancel question", () => {
  // Parameterised so a fixture cannot accidentally hide the control behind the
  // same flag that hides Stop.
  function renderPending(options: { isRunning: boolean; isResponding?: boolean; compact?: boolean }) {
    return renderToStaticMarkup(
      createElement(ComposerPrimaryActions, {
        compact: options.compact ?? true,
        pendingAction: {
          questionIndex: 0,
          isLastQuestion: true,
          canAdvance: true,
          isResponding: options.isResponding ?? false,
          isComplete: true,
        },
        isRunning: options.isRunning,
        showPlanFollowUpPrompt: false,
        promptHasText: false,
        isSendBusy: false,
        sendDisabledReason: null,
        isConnecting: false,
        isEnvironmentUnavailable: false,
        isSendBlocked: false,
        isPreparingWorktree: false,
        hasSendableContent: false,
        onPreviousPendingQuestion: () => {},
        onInterrupt: () => {},
        onImplementPlanInNewThread: () => {},
      }),
    );
  }

  it("offers a way to decline a pending question", () => {
    expect(renderPending({ isRunning: true })).toContain('aria-label="Cancel question"');
  });

  it("offers it even when no turn is running, where Stop is absent", () => {
    // The regression this restores left a pending question with NO exit in this
    // state: Stop only renders while running, Previous only past question one.
    const markup = renderPending({ isRunning: false });
    expect(markup).toContain('aria-label="Cancel question"');
    expect(markup).not.toContain('aria-label="Stop generation"');
  });

  it("disables it while an answer is being submitted", () => {
    // Matches Previous/Submit: a decline racing an in-flight submit is the one
    // way this button could do something the user did not intend.
    const openingTag = (markup: string) => {
      const upToLabel = markup.slice(0, markup.indexOf('aria-label="Cancel question"'));
      return upToLabel.slice(upToLabel.lastIndexOf("<button"));
    };
    // `disabled=""` (the rendered ATTRIBUTE), not the substring "disabled":
    // the Button's class list carries Tailwind variants like
    // `disabled:opacity-64`, so a substring check matches unconditionally and
    // passes whatever the component does. Both halves of this test did exactly
    // that before the negative case exposed it.
    expect(openingTag(renderPending({ isRunning: true, isResponding: true }))).toContain(
      'disabled=""',
    );
    expect(openingTag(renderPending({ isRunning: true, isResponding: false }))).not.toContain(
      'disabled=""',
    );
  });

  it("reads as a labelled action rather than a bare icon when not compact", () => {
    expect(renderPending({ isRunning: true, compact: false })).toContain("Cancel");
  });
});
