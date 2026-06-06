import { ApprovalRequestId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import type { PendingUserInput } from "../../session-logic";

const makePrompt = (
  questions: PendingUserInput["questions"],
  requestId = "req-1",
): PendingUserInput => ({
  requestId: ApprovalRequestId.make(requestId),
  createdAt: "2026-06-06T00:00:00.000Z",
  questions,
});

const renderPanel = (prompt: PendingUserInput, questionIndex = 0) =>
  renderToStaticMarkup(
    <ComposerPendingUserInputPanel
      pendingUserInputs={[prompt]}
      respondingRequestIds={[]}
      answers={{}}
      questionIndex={questionIndex}
      onToggleOption={() => {}}
      onAdvance={() => {}}
    />,
  );

const SINGLE_QUESTION = makePrompt([
  {
    id: "q1",
    header: "Approach",
    question: "Which approach should we take?",
    options: [
      { label: "Option A", description: "First choice" },
      { label: "Option B", description: "Second choice" },
    ],
    multiSelect: false,
  },
]);

describe("ComposerPendingUserInputPanel", () => {
  it("renders nothing when there are no pending inputs", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingUserInputPanel
        pendingUserInputs={[]}
        respondingRequestIds={[]}
        answers={{}}
        questionIndex={0}
        onToggleOption={() => {}}
        onAdvance={() => {}}
      />,
    );
    expect(markup).toBe("");
  });

  it("renders a draggable resize handle in the default (expanded) state", () => {
    const markup = renderPanel(SINGLE_QUESTION);
    // The resize grabber is an accessible, focusable separator.
    expect(markup).toContain('role="separator"');
    expect(markup).toContain('aria-label="Resize options"');
    expect(markup).toContain("cursor-ns-resize");
  });

  it("renders a collapse toggle that advertises hiding the options", () => {
    const markup = renderPanel(SINGLE_QUESTION);
    // Default state is expanded, so the chevron offers to hide.
    expect(markup).toContain('aria-label="Hide options"');
    expect(markup).toContain('aria-expanded="true"');
  });

  it("caps the options list shorter on mobile by default and shows the options", () => {
    const markup = renderPanel(SINGLE_QUESTION);
    // Mobile-first default cap (roomier on >=sm); guards the 80%-screen fix.
    expect(markup).toContain("max-h-[40dvh]");
    expect(markup).toContain("sm:max-h-[22rem]");
    expect(markup).toContain("Option A");
    expect(markup).toContain("Option B");
  });

  it("does not render the reset-height control until the user has resized", () => {
    // optionsHeight starts null, so the reset affordance is absent on first paint.
    const markup = renderPanel(SINGLE_QUESTION);
    expect(markup).not.toContain('aria-label="Reset options height"');
  });

  it("shows a question counter for multi-question prompts", () => {
    const prompt = makePrompt([
      {
        id: "q1",
        header: "One",
        question: "First?",
        options: [{ label: "A", description: "a" }],
        multiSelect: false,
      },
      {
        id: "q2",
        header: "Two",
        question: "Second?",
        options: [{ label: "B", description: "b" }],
        multiSelect: false,
      },
    ]);
    const markup = renderPanel(prompt, 0);
    expect(markup).toContain("1/2");
  });
});
