import { CREW_PROMPT_BYTE_LIMIT, CREW_REPORT_NOTE_BYTE_LIMIT } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_CREW_MAX_CONCURRENT_TASKS,
  boundNoteBytes,
  byteLength,
  destinationOf,
  isNoteWithinBound,
  isPromptWithinBound,
  isWritableReportState,
  normalizeNote,
  requiresTurn,
  resolveCrewMaxConcurrentTasks,
} from "./CrewPolicy.ts";

describe("resolveCrewMaxConcurrentTasks", () => {
  it.each([
    ["absent", undefined, DEFAULT_CREW_MAX_CONCURRENT_TASKS],
    ["a plain number", "2", 2],
    ["zero disables", "0", 0],
    ["padded zero disables", "00", 0],
    ["whitespace-wrapped zero disables", " 0 ", 0],
    ["negative falls back", "-1", DEFAULT_CREW_MAX_CONCURRENT_TASKS],
    ["non-numeric falls back", "abc", DEFAULT_CREW_MAX_CONCURRENT_TASKS],
    ["empty falls back", "", DEFAULT_CREW_MAX_CONCURRENT_TASKS],
    ["a float falls back", "2.5", DEFAULT_CREW_MAX_CONCURRENT_TASKS],
  ])("%s -> %s", (_label, value, expected) => {
    expect(
      resolveCrewMaxConcurrentTasks(
        value === undefined ? {} : { T3CODE_CREW_MAX_CONCURRENT_TASKS: value },
      ),
    ).toBe(expected);
  });

  it("DEFECT ARM: Number() would read a negative as -1 and disable crew", () => {
    // `Number(" 0 ")` is 0 and `Number("-1")` is -1, so a `Number()`-based parser
    // reads a typo'd cap as "fewer than zero slots" and silently turns crew off.
    // The wrong value, asserted positively.
    expect(Number("-1")).toBe(-1);
    expect(resolveCrewMaxConcurrentTasks({ T3CODE_CREW_MAX_CONCURRENT_TASKS: "-1" })).toBe(4);
  });
});

describe("byte bounds", () => {
  it("counts bytes, not UTF-16 units", () => {
    // One emoji is 2 UTF-16 units and 4 bytes. A `length`-based bound would let
    // a note four times the limit through.
    expect("🙂".length).toBe(2);
    expect(byteLength("🙂")).toBe(4);
  });

  it("accepts a note exactly at the limit and refuses one byte more", () => {
    const exact = "a".repeat(CREW_REPORT_NOTE_BYTE_LIMIT);
    expect(isNoteWithinBound(exact)).toBe(true);
    expect(isNoteWithinBound(`${exact}a`)).toBe(false);
  });

  it("accepts a prompt exactly at the limit and refuses one byte more", () => {
    const exact = "a".repeat(CREW_PROMPT_BYTE_LIMIT);
    expect(isPromptWithinBound(exact)).toBe(true);
    expect(isPromptWithinBound(`${exact}a`)).toBe(false);
  });

  it("bounds on a character boundary, never mid-code-point", () => {
    const emoji = "🙂".repeat(10);
    const bounded = boundNoteBytes(emoji, 10);
    expect(byteLength(bounded)).toBeLessThanOrEqual(10);
    // The tell for a mid-code-point split is a replacement character surviving a
    // round trip through the encoder.
    expect(bounded).not.toContain("�");
    expect(bounded).toBe("🙂🙂");
  });

  it("leaves a note under the bound untouched", () => {
    expect(boundNoteBytes("short", 100)).toBe("short");
  });

  it("normalizes CRLF before the bound is applied", () => {
    expect(normalizeNote("a\r\nb\rc")).toBe("a\nb\nc");
  });
});

describe("destination", () => {
  const task = { parentThreadId: "bridge", crewThreadId: "crewmate" };

  it("a report goes to the bridge, an answer to the crewmate", () => {
    expect(destinationOf({ state: "progress" }, task)).toBe("bridge");
    expect(destinationOf({ state: "done" }, task)).toBe("bridge");
    expect(destinationOf({ state: "answer" }, task)).toBe("crewmate");
  });

  it("DEFECT ARM: keying on the bridge sends the answer to the wrong thread", () => {
    // The wrong value, positively: an answer delivered to the bridge is stamped
    // handled while the crewmate stays blocked holding a slot.
    const alwaysBridge = (_state: string) => task.parentThreadId;
    expect(alwaysBridge("answer")).toBe("bridge");
    expect(destinationOf({ state: "answer" }, task)).toBe("crewmate");
  });
});

describe("turn requirement", () => {
  it.each([
    ["progress", false],
    ["needs-decision", true],
    ["done", true],
    ["failed", true],
    ["answer", true],
  ] as const)("%s requires a turn: %s", (state, expected) => {
    expect(requiresTurn(state)).toBe(expected);
  });
});

describe("writable report states", () => {
  it("accepts the four crewmate states and refuses answer", () => {
    for (const state of ["progress", "needs-decision", "done", "failed"]) {
      expect(isWritableReportState(state)).toBe(true);
    }
    expect(isWritableReportState("answer")).toBe(false);
    expect(isWritableReportState("nonsense")).toBe(false);
  });
});
