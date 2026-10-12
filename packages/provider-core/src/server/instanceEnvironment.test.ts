import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { mergeProviderInstanceEnvironment } from "./instanceEnvironment.ts";

describe("mergeProviderInstanceEnvironment", () => {
  it.effect.each([
    { value: "~/.account", tail: ".account" },
    { value: "~\\.account\\work", tail: ".account\\work" },
  ])("expands configured provider homes set to $value", ({ value, tail }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const baseEnv = {
        CODEX_HOME: "~/.inherited-codex",
        CLAUDE_CONFIG_DIR: "~/.inherited-claude",
      };
      const environment = yield* mergeProviderInstanceEnvironment(
        [
          { name: "CODEX_HOME", value, sensitive: false },
          { name: "CLAUDE_CONFIG_DIR", value, sensitive: false },
          { name: "CUSTOM_VALUE", value, sensitive: false },
        ],
        baseEnv,
      );

      expect(environment).toEqual({
        CODEX_HOME: path.join("/home/ada", tail),
        CLAUDE_CONFIG_DIR: path.join("/home/ada", tail),
        CUSTOM_VALUE: value,
      });
      expect(baseEnv).toEqual({
        CODEX_HOME: "~/.inherited-codex",
        CLAUDE_CONFIG_DIR: "~/.inherited-claude",
      });
    }).pipe(
      Effect.provideService(HostProcess.HomeDirectory, "/home/ada"),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("leaves inherited provider homes unchanged", () =>
    Effect.gen(function* () {
      const baseEnv = { CODEX_HOME: "~/.codex", CLAUDE_CONFIG_DIR: "~\\.claude" };

      expect(
        yield* mergeProviderInstanceEnvironment(
          [{ name: "CUSTOM_VALUE", value: "~/.custom", sensitive: false }],
          baseEnv,
        ),
      ).toEqual({ ...baseEnv, CUSTOM_VALUE: "~/.custom" });
    }),
  );

  it.effect("overrides inherited environment values and preserves empty strings", () =>
    Effect.gen(function* () {
      expect(
        yield* mergeProviderInstanceEnvironment(
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
    }),
  );

  // NODE_OPTIONS is this server's own runtime tuning. Forwarding it to a
  // provider CLI breaks any CLI whose runtime rejects a flag we happen to use:
  // Bun-built `claude` exits 1 with no output at all when it inherits
  // `--inspect-port`, which silently killed every Claude text generation.
  it.effect("drops inherited NODE_OPTIONS when the instance has no overrides", () =>
    Effect.gen(function* () {
      expect(
        yield* mergeProviderInstanceEnvironment(undefined, {
          NODE_OPTIONS: "--inspect-port=9230",
          PATH: "/bin",
        }),
      ).toEqual({ PATH: "/bin" });
    }),
  );

  it.effect("drops inherited NODE_OPTIONS when the instance has unrelated overrides", () =>
    Effect.gen(function* () {
      expect(
        yield* mergeProviderInstanceEnvironment(
          [{ name: "ANTHROPIC_API_KEY", value: "sk-test", sensitive: true }],
          { NODE_OPTIONS: "--inspect-port=9230", PATH: "/bin" },
        ),
      ).toEqual({ ANTHROPIC_API_KEY: "sk-test", PATH: "/bin" });
    }),
  );

  // Stripping the inherited value must not block deliberate configuration:
  // instance overrides are applied after the strip, so an explicitly
  // configured NODE_OPTIONS still reaches the provider.
  it.effect("keeps a NODE_OPTIONS the instance sets explicitly", () =>
    Effect.gen(function* () {
      expect(
        yield* mergeProviderInstanceEnvironment(
          [{ name: "NODE_OPTIONS", value: "--max-old-space-size=512", sensitive: false }],
          { NODE_OPTIONS: "--inspect-port=9230" },
        ),
      ).toEqual({ NODE_OPTIONS: "--max-old-space-size=512" });
    }),
  );

  // Windows env lookup is case-insensitive, but spreading process.env yields an
  // ordinary case-sensitive object, so a literal delete would miss this.
  it.effect("drops inherited NODE_OPTIONS regardless of case", () =>
    Effect.gen(function* () {
      expect(
        yield* mergeProviderInstanceEnvironment(undefined, {
          Node_Options: "--inspect-port=9230",
          PATH: "/bin",
        }),
      ).toEqual({ PATH: "/bin" });
    }),
  );
});
