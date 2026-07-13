import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { ClientSettingsSchema, ComposerShortcut } from "./settings.ts";

const decodeClient = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeShortcut = Schema.decodeUnknownSync(ComposerShortcut);

describe("composerShortcuts client setting", () => {
  it("defaults to an empty list when absent", () => {
    expect(decodeClient({}).composerShortcuts).toEqual([]);
  });

  it("decodes a configured, ordered list unchanged", () => {
    const shortcuts = [
      { id: "a", label: "Explain", text: "Explain this code step by step." },
      { id: "b", label: "Tests", text: "Write thorough unit tests." },
    ];
    expect(decodeClient({ composerShortcuts: shortcuts }).composerShortcuts).toEqual(shortcuts);
  });

  it("decodes a single shortcut struct", () => {
    expect(decodeShortcut({ id: "x", label: "PR", text: "Draft a PR description." })).toEqual({
      id: "x",
      label: "PR",
      text: "Draft a PR description.",
    });
  });
});
