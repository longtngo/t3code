import { createPatch } from "diff";
import type { WorkLogEntry } from "../../session-logic";

/**
 * One question in an AskUserQuestion detail body: its header, prompt, offered options, and the
 * answer the user picked (`null` when it couldn't be recovered from the tool result).
 */
export interface WorkEntryQuestion {
  readonly header?: string;
  readonly question: string;
  readonly options: ReadonlyArray<{ readonly label: string; readonly description?: string }>;
  readonly answer: string | null;
}

/**
 * The body of a work-log entry's detail modal. Three tool-specific shapes render purpose-built
 * views (AskUserQuestion questions+answers, Bash command+output, Edit diff); the remaining shapes
 * are the generic fallback — pretty-printed JSON, plain text, or nothing.
 */
export type WorkEntryDetailBody =
  | { readonly kind: "questions"; readonly questions: ReadonlyArray<WorkEntryQuestion> }
  | {
      readonly kind: "command";
      readonly command: string;
      readonly output: string | null;
      readonly isError: boolean;
    }
  | { readonly kind: "edit"; readonly filePath: string; readonly patch: string }
  | { readonly kind: "json"; readonly json: string }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "empty" };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

interface ToolPayload {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly result: Record<string, unknown> | undefined;
}

/**
 * Read the raw tool payload the client retained on the entry: `detailPayload.data =
 * { toolName, input, result }` (see ClaudeAdapter). Returns `null` unless both a tool name and an
 * object input are present, so callers fall through to the generic detail rendering.
 */
function readToolPayload(entry: WorkLogEntry): ToolPayload | null {
  const data = asRecord(asRecord(entry.detailPayload)?.data);
  const toolName = asString(data?.toolName);
  const input = asRecord(data?.input);
  if (!toolName || !input) {
    return null;
  }
  return { toolName, input, result: asRecord(data?.result) };
}

/**
 * Normalize a tool-result `content` field to a string. The result block's content is a string for
 * some tools but frequently an array of `{ type: "text", text }` blocks; only genuine text parts
 * are kept (a non-text block, e.g. an image, must not leak `[object Object]`). Returns `null` for
 * anything that carries no content (e.g. `undefined`), and `""` for an empty/text-less array.
 */
export function normalizeToolResultContent(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const element of content) {
      const record = asRecord(element);
      if (record?.type === "text" && typeof record.text === "string") {
        parts.push(record.text);
      }
    }
    return parts.join("\n");
  }
  return null;
}

const ANSWER_SUFFIX = '". You can now continue';

/**
 * Recover each question's answer from the AskUserQuestion result string, which has the SDK-produced
 * shape `... "Q1"="A1", "Q2"="A2". You can now continue ...`. The exact question texts are used as
 * left-to-right anchors (`"<question>"="`) so answers containing commas, periods, or quotes don't
 * break the split. An answer runs from just after its anchor to just before the next question's
 * anchor (dropping the `", ` separator); the last answer runs to the trailing `". You can now
 * continue` marker (or the final quote). A question whose anchor isn't found yields `null`; never
 * throws.
 */
export function extractAskUserQuestionAnswers(
  content: string,
  questionTexts: ReadonlyArray<string>,
): Array<string | null> {
  const anchors = questionTexts.map((question) => `"${question}"="`);
  const positions: number[] = [];
  let searchFrom = 0;
  for (const anchor of anchors) {
    const index = content.indexOf(anchor, searchFrom);
    positions.push(index);
    if (index >= 0) {
      searchFrom = index + anchor.length;
    }
  }

  return positions.map((anchorPos, i) => {
    const anchor = anchors[i];
    if (anchorPos < 0 || anchor === undefined) {
      return null;
    }
    const start = anchorPos + anchor.length;

    let nextPos = -1;
    for (let j = i + 1; j < positions.length; j += 1) {
      const candidate = positions[j];
      if (candidate !== undefined && candidate >= 0) {
        nextPos = candidate;
        break;
      }
    }

    let end: number;
    if (nextPos >= 0) {
      // Structure between answers: `<answer>", "<nextQuestion>"="` — the next anchor starts at the
      // opening quote of the next question, preceded by `", ` (closing quote + comma + space).
      end = nextPos - 3;
    } else {
      const suffixIndex = content.indexOf(ANSWER_SUFFIX, start);
      if (suffixIndex >= 0) {
        end = suffixIndex; // ANSWER_SUFFIX begins with the answer's closing quote.
      } else {
        const lastQuote = content.lastIndexOf('"');
        end = lastQuote > start ? lastQuote : content.length;
      }
    }
    return content.slice(start, Math.max(start, end));
  });
}

function parseAskUserQuestionBody(
  input: Record<string, unknown>,
  result: Record<string, unknown> | undefined,
): WorkEntryDetailBody | null {
  const questionsRaw = input.questions;
  if (!Array.isArray(questionsRaw) || questionsRaw.length === 0) {
    return null;
  }

  const parsed: Array<Omit<WorkEntryQuestion, "answer">> = [];
  for (const rawQuestion of questionsRaw) {
    const record = asRecord(rawQuestion);
    const question = asString(record?.question);
    if (!question) {
      return null; // Malformed — fall through to the raw JSON view.
    }
    const optionsRaw = record?.options;
    const options = Array.isArray(optionsRaw)
      ? optionsRaw.flatMap((rawOption) => {
          const optionRecord = asRecord(rawOption);
          const label = asString(optionRecord?.label);
          if (!label) {
            return [];
          }
          const description = asString(optionRecord?.description);
          return [description ? { label, description } : { label }];
        })
      : [];
    const header = asString(record?.header);
    parsed.push(header ? { header, question, options } : { question, options });
  }

  const content = normalizeToolResultContent(result?.content) ?? "";
  const answers = extractAskUserQuestionAnswers(
    content,
    parsed.map((question) => question.question),
  );
  const questions = parsed.map((question, i) => ({ ...question, answer: answers[i] ?? null }));
  return { kind: "questions", questions };
}

function parseBashBody(
  input: Record<string, unknown>,
  result: Record<string, unknown> | undefined,
): WorkEntryDetailBody | null {
  const command = asString(input.command);
  if (!command) {
    return null;
  }
  return {
    kind: "command",
    command,
    output: normalizeToolResultContent(result?.content),
    isError: result?.is_error === true,
  };
}

function buildEditBody(input: Record<string, unknown>): WorkEntryDetailBody | null {
  const filePath = asString(input.file_path);
  const oldString = asString(input.old_string);
  const newString = asString(input.new_string);
  if (filePath === undefined || oldString === undefined || newString === undefined) {
    return null;
  }
  return { kind: "edit", filePath, patch: createPatch(filePath, oldString, newString) };
}

function formatToolBody(tool: ToolPayload): WorkEntryDetailBody | null {
  switch (tool.toolName) {
    case "AskUserQuestion":
      return parseAskUserQuestionBody(tool.input, tool.result);
    case "Bash":
      return parseBashBody(tool.input, tool.result);
    case "Edit":
      return buildEditBody(tool.input);
    default:
      return null;
  }
}

/**
 * Decide how to render a work-log entry's detail. AskUserQuestion / Bash / Edit tool calls get a
 * purpose-built body; everything else prefers the raw structured payload (formatted JSON), then a
 * JSON-looking detail string, then plain text, and finally `empty`.
 */
export function formatWorkEntryDetail(entry: WorkLogEntry): WorkEntryDetailBody {
  const tool = readToolPayload(entry);
  if (tool) {
    const specialized = formatToolBody(tool);
    if (specialized) {
      return specialized;
    }
  }

  const payload = entry.detailPayload;
  if (payload != null && typeof payload === "object") {
    return { kind: "json", json: prettyJson(payload) };
  }

  const detail = entry.detail;
  if (typeof detail === "string") {
    const trimmed = detail.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (parsed != null && typeof parsed === "object") {
          return { kind: "json", json: prettyJson(parsed) };
        }
      } catch {
        // Not valid JSON — fall through to plain text.
      }
    }
    if (trimmed.length > 0) return { kind: "text", text: detail };
  }

  return { kind: "empty" };
}
