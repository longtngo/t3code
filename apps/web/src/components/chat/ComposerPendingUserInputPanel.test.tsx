import { ApprovalRequestId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

function renderPanel(optionCount: number) {
  return renderToStaticMarkup(
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
        },
      ]}
      respondingRequestIds={[]}
      answers={{}}
      questionIndex={0}
      onToggleOption={() => {}}
      onAdvance={() => {}}
    />,
  );
}

describe("ComposerPendingUserInputPanel", () => {
  // The panel's height is subtracted from the timeline's visible area, so an
  // unbounded options list is what buries the conversation behind a question.
  it("bounds the options list and scrolls it internally", () => {
    const markup = renderPanel(12);

    // Written out rather than read from PENDING_OPTIONS_MAX_HEIGHT_CLASS: a
    // test that sources the value from the implementation cannot detect that
    // value being emptied or wrong.
    expect(markup).toContain("max-h-[40dvh]");
    expect(markup).toContain("sm:max-h-[22rem]");
    expect(markup).toContain("overflow-y-auto");
    // A flick past the end of the list must not scroll the timeline behind it.
    expect(markup).toContain("overscroll-contain");
  });

  it("keeps the question readable outside the scroll region", () => {
    const markup = renderPanel(12);
    const optionsListStart = markup.indexOf("overflow-y-auto");

    expect(optionsListStart).toBeGreaterThan(-1);
    // Header and question text precede the scrolling container, so they stay
    // pinned while the options scroll.
    expect(markup.indexOf("Which approach should we take?")).toBeLessThan(optionsListStart);
    expect(markup.indexOf("Approach")).toBeLessThan(optionsListStart);
  });

  it("exposes an expanded collapse toggle wired to the options list", () => {
    const markup = renderPanel(3);
    const controls = /aria-controls="([^"]+)"/.exec(markup);

    expect(markup).toContain('aria-label="Hide options"');
    expect(markup).toContain('aria-expanded="true"');
    expect(controls).not.toBeNull();
    // The toggle must point at an element that actually exists, or assistive
    // technology follows it nowhere.
    expect(markup).toContain(`id="${controls?.[1]}"`);
  });

  it("starts expanded, with the options visible and the hidden-count hint absent", () => {
    const markup = renderPanel(3);

    expect(markup).toContain("Option 3");
    expect(markup).not.toContain("3 options hidden");
  });

  it("tags each option with its index so a keyboard selection can be scrolled into view", () => {
    const markup = renderPanel(3);

    expect(markup).toContain('data-option-index="0"');
    expect(markup).toContain('data-option-index="2"');
  });
});
