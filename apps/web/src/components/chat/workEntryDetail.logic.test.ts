import { describe, expect, it } from "vite-plus/test";
import type { WorkLogEntry } from "../../session-logic";
import { formatWorkEntryDetail } from "./workEntryDetail.logic";

function entry(overrides: Partial<WorkLogEntry> = {}): WorkLogEntry {
  return { id: "1", createdAt: "2026-07-12T00:00:00Z", label: "Work", tone: "tool", ...overrides };
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
