import { describe, expect, it } from "vite-plus/test";

import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";

describe("mergeProviderInstanceEnvironment", () => {
  it("overrides inherited environment values and preserves empty strings", () => {
    expect(
      mergeProviderInstanceEnvironment(
        [
          { name: "OPENROUTER_API_KEY", value: "sk-or-test", sensitive: true },
          { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
        ],
        { ANTHROPIC_API_KEY: "inherited", PATH: "/bin" },
      ),
    ).toMatchObject({
      OPENROUTER_API_KEY: "sk-or-test",
      ANTHROPIC_API_KEY: "",
      PATH: "/bin",
    });
  });

  // NODE_OPTIONS is this server's own runtime tuning. Forwarding it to a
  // provider CLI breaks any CLI whose runtime rejects a flag we happen to use:
  // Bun-built `claude` exits 1 with no output at all when it inherits
  // `--inspect-port`, which silently killed every Claude text generation.
  it("drops inherited NODE_OPTIONS when the instance has no overrides", () => {
    expect(
      mergeProviderInstanceEnvironment(undefined, {
        NODE_OPTIONS: "--inspect-port=9230",
        PATH: "/bin",
      }),
    ).toEqual({ PATH: "/bin" });
  });

  it("drops inherited NODE_OPTIONS when the instance has unrelated overrides", () => {
    expect(
      mergeProviderInstanceEnvironment(
        [{ name: "ANTHROPIC_API_KEY", value: "sk-test", sensitive: true }],
        { NODE_OPTIONS: "--inspect-port=9230", PATH: "/bin" },
      ),
    ).toEqual({ ANTHROPIC_API_KEY: "sk-test", PATH: "/bin" });
  });

  // Stripping the inherited value must not block deliberate configuration:
  // instance overrides are applied after the strip, so an explicitly
  // configured NODE_OPTIONS still reaches the provider.
  it("keeps a NODE_OPTIONS the instance sets explicitly", () => {
    expect(
      mergeProviderInstanceEnvironment(
        [{ name: "NODE_OPTIONS", value: "--max-old-space-size=512", sensitive: false }],
        { NODE_OPTIONS: "--inspect-port=9230" },
      ),
    ).toEqual({ NODE_OPTIONS: "--max-old-space-size=512" });
  });

  // Windows env lookup is case-insensitive, but spreading process.env yields an
  // ordinary case-sensitive object, so a literal delete would miss this.
  it("drops inherited NODE_OPTIONS regardless of case", () => {
    expect(
      mergeProviderInstanceEnvironment(undefined, {
        Node_Options: "--inspect-port=9230",
        PATH: "/bin",
      }),
    ).toEqual({ PATH: "/bin" });
  });
});
