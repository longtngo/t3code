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

type View = Awaited<ReturnType<typeof renderDom>>;

const STOP = '[aria-label="Stop generation"]';
const ARMED_STOP = '[aria-label="Force stop the session"]';
const CANCEL = '[aria-label="Cancel question"]';

/** The Stop button on either rung, armed or not. */
function stopButton(view: View) {
  return view.find(`${STOP}, ${ARMED_STOP}`);
}

function renderPendingActions(isRunning: boolean, isStopEscalated = false) {
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
      showPlanFollowUpPrompt: false,
      promptHasText: false,
      isSendBusy: false,
      sendDisabledReason: null,
      isConnecting: false,
      isEnvironmentUnavailable: false,
      isSendBlocked: false,
      isPreparingWorktree: false,
      hasSendableContent: false,
      isStopEscalated,
      onPreviousPendingQuestion: () => {},
      onInterrupt: () => {},
      onCancelQuestion: () => {},
      onImplementPlanInNewThread: () => {},
    }),
  );
}

// Upstream's `renderRunningActions(showSendWhileRunning, hasSendableContent)` helper and
// its "renders send alongside stop while running when Enter-to-send is unavailable" test
// are deliberately absent: this fork removed the `showSendWhileRunning` prop, because
// Send is ALWAYS mounted beside Stop here (it queues a follow-up). The case upstream's
// test covers is asserted unconditionally by "keeps Send mounted beside Stop" below.
//
// `hasSendableContent` is parameterised deliberately. Send's `disabled` already
// includes `!hasSendableContent`, so a fixture hardcoding `false` makes every
// enabled/disabled assertion pass no matter what the running branch does.
function renderRunning(options?: {
  hasSendableContent?: boolean;
  isStopEscalated?: boolean;
  onInterrupt?: () => void;
}) {
  return renderDom(
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
      isStopEscalated: options?.isStopEscalated ?? false,
      onPreviousPendingQuestion: () => {},
      onInterrupt: options?.onInterrupt ?? (() => {}),
      onCancelQuestion: () => {},
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
      showPlanFollowUpPrompt: false,
      promptHasText: true,
      isSendBusy: false,
      sendDisabledReason,
      isConnecting: false,
      isEnvironmentUnavailable: false,
      isSendBlocked: false,
      isPreparingWorktree: false,
      hasSendableContent: true,
      isStopEscalated: false,
      onPreviousPendingQuestion: () => {},
      onInterrupt: () => {},
      onCancelQuestion: () => {},
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

    // Standalone Stop now matches Send's footprint so the pair is even; it was
    // `size-8` (32px) against Send's 36px below `sm`.
    const standalone = await renderStandaloneStop();
    const standaloneStop = standalone.find(STOP);
    for (const size of ["h-9", "w-9", "sm:h-8", "sm:w-8"]) {
      expect(standaloneStop?.classList.contains(size)).toBe(true);
    }
    expect(standaloneStop?.classList.contains("sm:size-7")).toBe(false);
  });

  it("keeps Send mounted beside Stop while a turn is running", async () => {
    const view = await renderRunning();
    expect(view.find(STOP)).not.toBeNull();
    expect(view.find('[aria-label="Send message"]')).not.toBeNull();
  });

  it("leaves Send usable while running so a follow-up can be queued", async () => {
    // Asserted on the `disabled` PROPERTY, not on a markup substring: the class list
    // carries `disabled:opacity-30` and friends, so `toContain("disabled")` was true of
    // every render and asserted nothing.
    //
    // Not vacuous in the other direction either — flipping `hasSendableContent`
    // flips the outcome, which is exactly what the second assertion pins.
    const sendable = await renderRunning({ hasSendableContent: true });
    expect(sendable.find<HTMLButtonElement>('[aria-label="Send message"]')?.disabled).toBe(false);

    const empty = await renderRunning({ hasSendableContent: false });
    expect(empty.find<HTMLButtonElement>('[aria-label="Send message"]')?.disabled).toBe(true);
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
  function renderPending(options: {
    isRunning: boolean;
    isResponding?: boolean;
    compact?: boolean;
    onCancelQuestion?: () => void;
  }) {
    return renderDom(
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
        isStopEscalated: false,
        onPreviousPendingQuestion: () => {},
        onInterrupt: () => {},
        onCancelQuestion: options.onCancelQuestion ?? (() => {}),
        onImplementPlanInNewThread: () => {},
      }),
    );
  }

  it("offers a way to decline a pending question", async () => {
    const view = await renderPending({ isRunning: true });
    expect(view.find(CANCEL)).not.toBeNull();
  });

  it("offers it even when no turn is running, where Stop is absent", async () => {
    // The regression this restores left a pending question with NO exit in this
    // state: Stop only renders while running, Previous only past question one.
    const view = await renderPending({ isRunning: false });
    expect(view.find(CANCEL)).not.toBeNull();
    expect(view.find(STOP)).toBeNull();
  });

  it("disables it while an answer is being submitted", async () => {
    // Matches Previous/Submit: a decline racing an in-flight submit is the one
    // way this button could do something the user did not intend.
    //
    // The `disabled` PROPERTY of the cancel button itself, not the substring
    // "disabled" anywhere in the markup: the Button's class list carries Tailwind
    // variants like `disabled:opacity-64`, so a substring check matched
    // unconditionally and passed whatever the component did. Both halves of this
    // test did exactly that before the negative case exposed it.
    const responding = await renderPending({ isRunning: true, isResponding: true });
    expect(responding.find<HTMLButtonElement>(CANCEL)?.disabled).toBe(true);

    const idle = await renderPending({ isRunning: true, isResponding: false });
    expect(idle.find<HTMLButtonElement>(CANCEL)?.disabled).toBe(false);
  });

  it("reads as a labelled action rather than a bare icon when not compact", async () => {
    const view = await renderPending({ isRunning: true, compact: false });
    expect(view.find(CANCEL)?.textContent).toContain("Cancel");
  });

  // Only reachable with a real DOM: static markup cannot dispatch the press, so the one
  // thing this control exists to do was never asserted.
  it("declines the question when it is pressed", async () => {
    const onCancelQuestion = vi.fn();
    const view = await renderPending({ isRunning: true, onCancelQuestion });

    await view.click(view.find(CANCEL));

    expect(onCancelQuestion).toHaveBeenCalledTimes(1);
  });

  it("does nothing when pressed while an answer is in flight", async () => {
    // The paired half of "disables it while an answer is being submitted": a disabled
    // attribute that still fires its handler would be the actual bug.
    const onCancelQuestion = vi.fn();
    const view = await renderPending({ isRunning: true, isResponding: true, onCancelQuestion });

    await view.click(view.find(CANCEL));

    expect(onCancelQuestion).not.toHaveBeenCalled();
  });
});

describe("the escalated Stop rung is visually distinct", () => {
  // Asserted on `data-stop-escalated`, never on a class substring. The class
  // list is full of Tailwind variant prefixes, and matching "destructive"
  // matches the UNARMED button too (it is destructive-red at rest) — the same
  // shape of false pass that `toContain("disabled")` produced above.

  it("marks the armed rung and leaves the first press unmarked", async () => {
    const armed = await renderRunning({ isStopEscalated: true });
    expect(stopButton(armed)?.getAttribute("data-stop-escalated")).toBe("true");

    const unarmed = await renderRunning({ isStopEscalated: false });
    expect(stopButton(unarmed)?.getAttribute("data-stop-escalated")).toBe("false");
  });

  it("renames the action so a screen reader hears a different button", async () => {
    // The label is the accessible half of the distinction: the ring and the
    // octagon are invisible to anyone not looking at the pixels.
    const armed = await renderRunning({ isStopEscalated: true });
    expect(armed.find(ARMED_STOP)).not.toBeNull();
    expect(armed.find(STOP)).toBeNull();
  });

  it("gives the armed rung a halo the unarmed one does not have", async () => {
    const armed = await renderRunning({ isStopEscalated: true });
    expect(stopButton(armed)?.classList.contains("ring-2")).toBe(true);
    expect(stopButton(armed)?.classList.contains("ring-destructive/40")).toBe(true);

    const unarmed = await renderRunning({ isStopEscalated: false });
    expect(stopButton(unarmed)?.classList.contains("ring-2")).toBe(false);
    expect(stopButton(unarmed)?.classList.contains("ring-destructive/40")).toBe(false);
  });

  it("explains what the press will do on hover", async () => {
    // The tooltip popup is portalled and only mounts while open, so the explanation
    // also rides on `aria-description` — which is what a static render reached, and
    // what a screen reader reaches without hovering at all.
    const armed = await renderRunning({ isStopEscalated: true });
    expect(stopButton(armed)?.getAttribute("aria-description")).toContain(
      "force-stops the session",
    );

    const unarmed = await renderRunning({ isStopEscalated: false });
    expect(unarmed.text()).not.toContain("force-stops the session");
    expect(stopButton(unarmed)?.getAttribute("aria-description")).toBeNull();
  });

  it("marks the pending-question row's Stop too, which is a second entry to the same ladder", async () => {
    // Both rungs render from `renderStopGenerationButton`, so this is the test
    // that fails if someone re-inlines one of the two call sites.
    const armed = await renderPendingActions(true, true);
    expect(stopButton(armed)?.getAttribute("data-stop-escalated")).toBe("true");

    const unarmed = await renderPendingActions(true, false);
    expect(stopButton(unarmed)?.getAttribute("data-stop-escalated")).toBe("false");
  });

  it("does not mark Cancel, which never arms the ladder", async () => {
    // Cancel is a Button, not the Stop button — it must carry no escalation
    // marking however the ladder is armed.
    const view = await renderPendingActions(true, true);
    expect(view.find(CANCEL)?.hasAttribute("data-stop-escalated")).toBe(false);
  });
});

describe("Cancel is not the Stop ladder", () => {
  // The tripwire this locks down: Cancel used to share `onInterrupt`, which is
  // now the escalation ladder's entry point. Sharing it again would mean a
  // Cancel press arms escalation and the NEXT Stop press kills the session —
  // the f4af9398e bug, reintroduced.
  async function renderWithSpies() {
    const onInterrupt = vi.fn();
    const onCancelQuestion = vi.fn();
    const view = await renderDom(
      createElement(ComposerPrimaryActions, {
        compact: false,
        pendingAction: {
          questionIndex: 0,
          isLastQuestion: true,
          canAdvance: true,
          isResponding: false,
          isComplete: true,
        },
        isRunning: true,
        showPlanFollowUpPrompt: false,
        promptHasText: false,
        isSendBusy: false,
        sendDisabledReason: null,
        isConnecting: false,
        isEnvironmentUnavailable: false,
        isSendBlocked: false,
        isPreparingWorktree: false,
        hasSendableContent: false,
        isStopEscalated: false,
        onPreviousPendingQuestion: () => {},
        onInterrupt,
        onCancelQuestion,
        onImplementPlanInNewThread: () => {},
      }),
    );
    return { view, onInterrupt, onCancelQuestion };
  }

  it("renders Cancel and Stop as separate controls", async () => {
    const { view } = await renderWithSpies();
    expect(view.find(CANCEL)).not.toBeNull();
    expect(view.find(STOP)).not.toBeNull();
  });

  it("requires a distinct cancel handler rather than reusing onInterrupt", async () => {
    // A structural guard: if someone deletes `onCancelQuestion` and points
    // Cancel back at `onInterrupt`, this file stops typechecking — the prop is
    // required. This test documents WHY that requirement exists so it is not
    // "simplified" away later.
    const { view } = await renderWithSpies();
    expect(view.text()).toContain("Cancel");
  });

  // The two tests the static render could only gesture at: the spies above were
  // constructed and never called, because markup cannot be pressed.
  it("routes a Cancel press to the cancel handler and never to the stop ladder", async () => {
    const { view, onInterrupt, onCancelQuestion } = await renderWithSpies();

    await view.click(view.find(CANCEL));

    expect(onCancelQuestion).toHaveBeenCalledTimes(1);
    expect(onInterrupt).not.toHaveBeenCalled();
  });

  it("routes a Stop press to the stop ladder and never to the cancel handler", async () => {
    const { view, onInterrupt, onCancelQuestion } = await renderWithSpies();

    await view.click(view.find(STOP));

    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(onCancelQuestion).not.toHaveBeenCalled();
  });
});
