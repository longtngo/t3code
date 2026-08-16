import { describe, expect, it } from "vite-plus/test";
import type { WorkLogEntry } from "../../session-logic";
import {
  extractAskUserQuestionAnswers,
  formatWorkEntryDetail,
  normalizeToolResultContent,
} from "./workEntryDetail.logic";

function entry(overrides: Partial<WorkLogEntry> = {}): WorkLogEntry {
  return { id: "1", createdAt: "2026-07-12T00:00:00Z", label: "Work", tone: "tool", ...overrides };
}

function toolEntry(
  toolName: string,
  input: Record<string, unknown>,
  result?: Record<string, unknown>,
): WorkLogEntry {
  return entry({ detailPayload: { data: { toolName, input, ...(result ? { result } : {}) } } });
}

describe("formatWorkEntryDetail", () => {
  it("pretty-prints a structured payload as JSON", () => {
    const result = formatWorkEntryDetail(
      entry({ detailPayload: { tool: "Bash", exitCode: 0, matches: [{ line: 12 }] } }),
    );
    expect(result.kind).toBe("json");
    if (result.kind === "json") {
      expect(result.json).toBe(
        '{\n  "tool": "Bash",\n  "exitCode": 0,\n  "matches": [\n    {\n      "line": 12\n    }\n  ]\n}',
      );
    }
  });

  it("prefers the payload over the detail string", () => {
    const result = formatWorkEntryDetail(
      entry({ detailPayload: { a: 1 }, detail: "some flattened text" }),
    );
    expect(result).toEqual({ kind: "json", json: '{\n  "a": 1\n}' });
  });

  it("parses a JSON detail string when there is no payload", () => {
    const result = formatWorkEntryDetail(entry({ detail: '{"error":"boom","retriable":false}' }));
    expect(result).toEqual({
      kind: "json",
      json: '{\n  "error": "boom",\n  "retriable": false\n}',
    });
  });

  it("keeps non-JSON detail as plain text", () => {
    expect(formatWorkEntryDetail(entry({ detail: "Server suite: 1467 passed." }))).toEqual({
      kind: "text",
      text: "Server suite: 1467 passed.",
    });
  });

  it("treats a detail string that looks like JSON but doesn't parse as text", () => {
    expect(formatWorkEntryDetail(entry({ detail: "{not valid json" }))).toEqual({
      kind: "text",
      text: "{not valid json",
    });
  });

  it("does not treat a bare JSON scalar as a JSON document", () => {
    // "42" parses but isn't an object/array — show it as text, not a code block.
    expect(formatWorkEntryDetail(entry({ detail: "42" }))).toEqual({ kind: "text", text: "42" });
  });

  it("is empty when there is neither payload nor detail", () => {
    expect(formatWorkEntryDetail(entry())).toEqual({ kind: "empty" });
    expect(formatWorkEntryDetail(entry({ detail: "   " }))).toEqual({ kind: "empty" });
  });
});

describe("normalizeToolResultContent", () => {
  it("passes a string through unchanged", () => {
    expect(normalizeToolResultContent("hello\nworld")).toBe("hello\nworld");
  });

  it("joins text blocks and ignores non-text blocks", () => {
    expect(
      normalizeToolResultContent([
        { type: "text", text: "line 1" },
        { type: "image", source: {} },
        { type: "text", text: "line 2" },
        { type: "text", text: 42 }, // non-string text ignored
      ]),
    ).toBe("line 1\nline 2");
  });

  it("returns an empty string for an empty or text-less array", () => {
    expect(normalizeToolResultContent([])).toBe("");
    expect(normalizeToolResultContent([{ type: "image" }])).toBe("");
  });

  it("returns null for content that is neither string nor array", () => {
    expect(normalizeToolResultContent(undefined)).toBeNull();
    expect(normalizeToolResultContent({ text: "x" })).toBeNull();
  });
});

describe("extractAskUserQuestionAnswers", () => {
  const build = (pairs: ReadonlyArray<[string, string]>) =>
    `Your questions have been answered: ${pairs
      .map(([q, a]) => `"${q}"="${a}"`)
      .join(", ")}. You can now continue with these answers in mind.`;

  it("extracts answers containing commas, periods, and question marks", () => {
    const q1 = "The feature-flag work isn't merged. How should the runbook treat it?";
    const a1 = "1, but before that, are the local PRs in sync? if not push. it might help";
    const q2 = "Where should the runbook live?";
    const a2 = "Reports dir only";
    expect(
      extractAskUserQuestionAnswers(
        build([
          [q1, a1],
          [q2, a2],
        ]),
        [q1, q2],
      ),
    ).toEqual([a1, a2]);
  });

  it("handles a single question", () => {
    const q = "Proceed?";
    expect(extractAskUserQuestionAnswers(build([[q, "Yes, do it"]]), [q])).toEqual(["Yes, do it"]);
  });

  it("is not fooled by a question that is a substring of another", () => {
    const q1 = "prod?";
    const q2 = "Deploy to prod?";
    expect(
      extractAskUserQuestionAnswers(
        build([
          [q1, "no"],
          [q2, "yes"],
        ]),
        [q1, q2],
      ),
    ).toEqual(["no", "yes"]);
  });

  it("handles an answer that itself contains the quote-comma-quote separator", () => {
    const q1 = "First?";
    const a1 = 'she said "hi", then left';
    const q2 = "Second?";
    expect(
      extractAskUserQuestionAnswers(
        build([
          [q1, a1],
          [q2, "b"],
        ]),
        [q1, q2],
      ),
    ).toEqual([a1, "b"]);
  });

  it("returns null for a question whose anchor is absent, keeping others aligned", () => {
    const q1 = "Present?";
    const q2 = "Missing?";
    const content = `Your questions have been answered: "${q1}"="here". You can now continue.`;
    expect(extractAskUserQuestionAnswers(content, [q1, q2])).toEqual(["here", null]);
  });

  it("falls back to the final quote when the trailing marker is absent", () => {
    const q = "Q?";
    expect(extractAskUserQuestionAnswers(`"${q}"="the answer"`, [q])).toEqual(["the answer"]);
  });
});

describe("formatWorkEntryDetail — AskUserQuestion", () => {
  const questions = [
    {
      question: "Deploy now?",
      header: "Timing",
      options: [{ label: "Yes", description: "Ship it" }, { label: "No" }],
    },
    { question: "Which env?", options: [{ label: "staging" }, { label: "prod" }] },
  ];
  const result = {
    type: "tool_result",
    content:
      'Your questions have been answered: "Deploy now?"="Yes", "Which env?"="prod". You can now continue with these answers in mind.',
  };

  it("renders questions with options and the chosen answers", () => {
    const body = formatWorkEntryDetail(toolEntry("AskUserQuestion", { questions }, result));
    expect(body).toEqual({
      kind: "questions",
      questions: [
        {
          header: "Timing",
          question: "Deploy now?",
          options: [{ label: "Yes", description: "Ship it" }, { label: "No" }],
          answer: "Yes",
        },
        {
          question: "Which env?",
          options: [{ label: "staging" }, { label: "prod" }],
          answer: "prod",
        },
      ],
    });
  });

  it("normalizes array-shaped result content before parsing (Finding 1)", () => {
    const arrayResult = {
      content: [
        {
          type: "text",
          text: 'Your questions have been answered: "Deploy now?"="No", "Which env?"="staging". You can now continue.',
        },
      ],
    };
    const body = formatWorkEntryDetail(toolEntry("AskUserQuestion", { questions }, arrayResult));
    if (body.kind !== "questions") throw new Error(`expected questions, got ${body.kind}`);
    expect(body.questions.map((question) => question.answer)).toEqual(["No", "staging"]);
  });

  it("still renders questions with null answers when the result is missing", () => {
    const body = formatWorkEntryDetail(toolEntry("AskUserQuestion", { questions }));
    if (body.kind !== "questions") throw new Error(`expected questions, got ${body.kind}`);
    expect(body.questions.map((question) => question.answer)).toEqual([null, null]);
  });

  it("falls through to JSON when questions are malformed", () => {
    const body = formatWorkEntryDetail(
      toolEntry("AskUserQuestion", { questions: [{ header: "no question text" }] }),
    );
    expect(body.kind).toBe("json");
  });
});

describe("formatWorkEntryDetail — Bash", () => {
  it("renders the command and its output", () => {
    const body = formatWorkEntryDetail(
      toolEntry("Bash", { command: "ls -la" }, { content: "total 8\ndrwxr-xr-x", is_error: false }),
    );
    expect(body).toEqual({
      kind: "command",
      command: "ls -la",
      output: "total 8\ndrwxr-xr-x",
      isError: false,
    });
  });

  it("marks an error result and normalizes array output", () => {
    const body = formatWorkEntryDetail(
      toolEntry(
        "Bash",
        { command: "false" },
        { content: [{ type: "text", text: "boom" }], is_error: true },
      ),
    );
    expect(body).toEqual({ kind: "command", command: "false", output: "boom", isError: true });
  });

  it("falls through to JSON when there is no command", () => {
    expect(formatWorkEntryDetail(toolEntry("Bash", { notCommand: 1 })).kind).toBe("json");
  });
});

describe("formatWorkEntryDetail — Edit", () => {
  it("builds a unified-diff patch from old/new strings", () => {
    const body = formatWorkEntryDetail(
      toolEntry("Edit", {
        file_path: "apps/web/src/foo.ts",
        old_string: "const a = 1;\n",
        new_string: "const a = 2;\n",
      }),
    );
    if (body.kind !== "edit") throw new Error(`expected edit, got ${body.kind}`);
    expect(body.filePath).toBe("apps/web/src/foo.ts");
    expect(body.patch).toContain("--- apps/web/src/foo.ts");
    expect(body.patch).toContain("-const a = 1;");
    expect(body.patch).toContain("+const a = 2;");
  });

  it("falls through to JSON when required Edit fields are missing", () => {
    expect(
      formatWorkEntryDetail(toolEntry("Edit", { file_path: "x.ts", old_string: "a" })).kind,
    ).toBe("json");
  });
});

describe("formatWorkEntryDetail — unknown tools", () => {
  it("falls through to the JSON payload view for a tool with no specialized body", () => {
    const body = formatWorkEntryDetail(toolEntry("Read", { file_path: "x.ts" }));
    expect(body.kind).toBe("json");
  });
});
