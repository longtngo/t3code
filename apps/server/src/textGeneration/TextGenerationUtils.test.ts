import { describe, expect, it } from "vite-plus/test";

import { cliFailureDetail } from "./TextGenerationUtils.ts";

describe("cliFailureDetail", () => {
  it("reports stderr when the CLI explained itself", () => {
    expect(cliFailureDetail("Claude", 1, "", "Invalid API key")).toBe(
      "Claude CLI command failed: Invalid API key",
    );
  });

  it("falls back to stdout when stderr is empty", () => {
    expect(cliFailureDetail("Codex", 2, "usage: codex [options]", "   ")).toBe(
      "Codex CLI command failed: usage: codex [options]",
    );
  });

  // A CLI that writes to neither stream usually died before it ran its task —
  // its own runtime rejected the process, e.g. over an inherited NODE_OPTIONS
  // flag it does not implement. A bare exit code left nothing to search for,
  // which is what made that failure mode expensive to diagnose.
  it("says so when the CLI produced no output at all", () => {
    expect(cliFailureDetail("Claude", 1, "", "")).toBe(
      "Claude CLI command failed with code 1 and produced no output.",
    );
  });

  it("treats whitespace-only output as no output", () => {
    expect(cliFailureDetail("Claude", 1, "  \n", " \t ")).toBe(
      "Claude CLI command failed with code 1 and produced no output.",
    );
  });
});
