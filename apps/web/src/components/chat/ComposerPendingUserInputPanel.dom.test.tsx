import { ApprovalRequestId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { renderDom } from "../../testing/renderDom";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

function renderPanel(
  optionCount: number,
  handlers: {
    onToggleOption?: () => void;
    onAdvance?: () => void;
    onDismiss?: () => void;
    dismissible?: boolean;
  } = {},
) {
  return renderDom(
    <ComposerPendingUserInputPanel
      pendingUserInputs={[
        {
          requestId: ApprovalRequestId.make("request-1"),
          createdAt: "2026-08-07T00:00:00.000Z",
          questions: [
            {
              id: "question-1",
              header: "Approach",
              question: "Which approach should we take?",
              multiSelect: false,
              options: Array.from({ length: optionCount }, (_unused, index) => ({
                label: `Option ${index + 1}`,
                description: `Description for option ${index + 1}`,
              })),
            },
          ],
          dismissible: handlers.dismissible ?? true,
        },
      ]}
      respondingRequestIds={[]}
      answers={{}}
      questionIndex={0}
      onToggleOption={handlers.onToggleOption ?? (() => {})}
      onAdvance={handlers.onAdvance ?? (() => {})}
      onDismiss={handlers.onDismiss ?? (() => {})}
    />,
  );
}

/** The scrolling container the options live in, reached through a real option. */
function optionsList(view: { find: (selector: string) => HTMLElement | null }) {
  const list = view.find('[data-option-index="0"]')?.parentElement;
  expect(list).not.toBeNull();
  return list as HTMLElement;
}

describe("ComposerPendingUserInputPanel", () => {
  // The panel's height is subtracted from the timeline's visible area, so an
  // unbounded options list is what buries the conversation behind a question.
  it("bounds the options list and scrolls it internally", async () => {
    const view = await renderPanel(12);
    const list = optionsList(view);

    // Written out rather than read from PENDING_OPTIONS_MAX_HEIGHT_CLASS: a
    // test that sources the value from the implementation cannot detect that
    // value being emptied or wrong.
    //
    // The bound must be against viewport HEIGHT. A width breakpoint
    // (`sm:max-h-[22rem]`) leaves a short, wide window uncapped in the only
    // dimension that matters — measured at 112% of the viewport before this.
    expect([...list.classList]).toContain("max-h-[min(22rem,40dvh)]");
    expect([...list.classList].filter((name) => name.startsWith("sm:max-h-"))).toEqual([]);
    expect([...list.classList]).toContain("overflow-y-auto");
    // A flick past the end of the list must not scroll the timeline behind it.
    expect([...list.classList]).toContain("overscroll-contain");
  });

  it("keeps the question readable outside the scroll region", async () => {
    const view = await renderPanel(12);
    const list = optionsList(view);
    const question = view
      .findAll("p, span")
      .find((element) => element.textContent === "Which approach should we take?");
    const header = view.findAll("p, span").find((element) => element.textContent === "Approach");

    // Header and question text sit outside the scrolling container and ahead of
    // it in the document, so they stay pinned while the options scroll.
    expect(question).toBeDefined();
    expect(header).toBeDefined();
    expect(list.contains(question ?? null)).toBe(false);
    expect(list.contains(header ?? null)).toBe(false);
    expect(question?.compareDocumentPosition(list)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(header?.compareDocumentPosition(list)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("exposes an expanded collapse toggle wired to the options list", async () => {
    const view = await renderPanel(3);
    const toggle = view.find('[aria-label="Hide options"]');

    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    const controls = toggle?.getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    // The toggle must point at an element that actually exists, or assistive
    // technology follows it nowhere.
    expect(document.getElementById(controls ?? "")).toBe(optionsList(view));
  });

  it("starts expanded, with the options visible and the hidden-count hint absent", async () => {
    const view = await renderPanel(3);

    expect(view.text()).toContain("Option 3");
    expect(view.text()).not.toContain("3 options hidden");
  });

  // Collapsing is how the conversation behind the panel becomes readable again,
  // and the way back out of it. The options list stays mounted while hidden so
  // `aria-controls` keeps resolving, which means "hidden" has to be asserted on
  // the class, not on the element's absence.
  it("hides the options and offers the way back when the toggle is pressed", async () => {
    const view = await renderPanel(3);

    await view.click(view.find('[aria-label="Hide options"]'));

    expect([...optionsList(view).classList]).toContain("hidden");
    expect(view.text()).toContain("3 options hidden");
    const toggle = view.find('[aria-label="Show options"]');
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");

    await view.click(toggle);

    expect([...optionsList(view).classList]).not.toContain("hidden");
    expect(view.text()).not.toContain("3 options hidden");
  });

  it("tags each option with its index so a keyboard selection can be scrolled into view", async () => {
    const view = await renderPanel(3);

    expect(view.find('[data-option-index="0"]')).not.toBeNull();
    expect(view.find('[data-option-index="2"]')).not.toBeNull();
  });

  // Selecting an option is the whole point of the panel: it is what answers the
  // agent's question, and the value it reports is what the agent receives.
  it("reports the chosen option to its owner", async () => {
    const onToggleOption = vi.fn();
    const view = await renderPanel(3, { onToggleOption });

    await view.click(view.find('[data-option-index="1"]'));

    expect(onToggleOption).toHaveBeenCalledTimes(1);
    expect(onToggleOption).toHaveBeenCalledWith("question-1", "Option 2");
  });

  // Ported from upstream's ComposerPendingUserInputPanel.test.tsx, which this fork
  // replaced with a real-DOM suite (docs/fork/README.md invariant 36). Driven rather
  // than asserted on markup, because the prop arrived in the merge with nothing
  // rendering it - a dismiss button that exists but never calls back is the failure.
  it("offers dismiss only for async questions, and dismissing reports the request", async () => {
    const onDismiss = vi.fn();
    const view = await renderPanel(2, { onDismiss });

    const dismiss = view.find("[data-pending-user-input-dismiss]");
    expect(dismiss).not.toBeNull();
    await view.click(dismiss);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith("request-1");

    const native = await renderPanel(2, { onDismiss, dismissible: false });
    expect(native.find("[data-pending-user-input-dismiss]")).toBeNull();
  });
});
