import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { CommandDetail, QuestionsDetail } from "./WorkEntryDetailDialog";
import type { WorkEntryQuestion } from "./workEntryDetail.logic";

describe("QuestionsDetail", () => {
  const questions: ReadonlyArray<WorkEntryQuestion> = [
    {
      header: "Timing",
      question: "Deploy now?",
      options: [
        { label: "Yes", description: "Ship it" },
        { label: "No" },
      ],
      answer: "Yes",
    },
  ];

  it("renders each question, its options, and marks the chosen one", () => {
    const markup = renderToStaticMarkup(<QuestionsDetail questions={questions} />);
    expect(markup).toContain("Timing");
    expect(markup).toContain("Deploy now?");
    expect(markup).toContain("Ship it");
    expect(markup).toContain("✓ chosen");
    expect(markup).toContain("Yes");
  });

  it("shows a placeholder when the answer could not be recovered", () => {
    const markup = renderToStaticMarkup(
      <QuestionsDetail
        questions={[{ question: "Which env?", options: [{ label: "prod" }], answer: null }]}
      />,
    );
    expect(markup).toContain("No recorded answer.");
    expect(markup).not.toContain("✓ chosen");
  });
});

describe("CommandDetail", () => {
  it("renders the command and its output", () => {
    const markup = renderToStaticMarkup(
      <CommandDetail command="ls -la" output="total 8" isError={false} />,
    );
    expect(markup).toContain("Command");
    expect(markup).toContain("ls -la");
    expect(markup).toContain("total 8");
    expect(markup).not.toContain("Error");
  });

  it("marks an error result", () => {
    const markup = renderToStaticMarkup(
      <CommandDetail command="false" output="boom" isError={true} />,
    );
    expect(markup).toContain("Error");
    expect(markup).toContain("boom");
  });

  it("distinguishes no output from empty output", () => {
    expect(
      renderToStaticMarkup(<CommandDetail command="x" output={null} isError={false} />),
    ).toContain("No output.");
    expect(
      renderToStaticMarkup(<CommandDetail command="x" output="" isError={false} />),
    ).toContain("(empty output)");
  });
});
