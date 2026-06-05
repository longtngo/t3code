import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  resolveClaudeConfigDirPath,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
    it.effect("uses the process home when no Claude home override is configured", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir());

        expect(yield* resolveClaudeHomePath({ homePath: "" })).toBe(resolved);
        const baseEnv = { PATH: "/usr/bin" };
        expect(yield* makeClaudeEnvironment({ homePath: "" }, baseEnv)).toBe(baseEnv);
      }),
    );

    it.effect("resolves configured Claude HOME and stamps continuation/cache keys with it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.claude-work";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");

        expect(yield* resolveClaudeHomePath({ homePath })).toBe(resolved);
        expect((yield* makeClaudeEnvironment({ homePath })).HOME).toBe(resolved);
        expect(yield* makeClaudeContinuationGroupKey({ homePath })).toBe(
          `claude:home:${resolved}:config:`,
        );
        expect(yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", homePath })).toBe(
          `claude\0${resolved}\0`,
        );
      }),
    );

    it.effect("keeps continuation compatible across instances with the same Claude HOME", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir());

        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" })).toBe(
          `claude:home:${resolved}:config:`,
        );
      }),
    );
  });

  describe("Claude config dir resolution", () => {
    it.effect("scrubs an inherited CLAUDE_CONFIG_DIR so instances match their own keys", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const baseEnv = { CLAUDE_CONFIG_DIR: "/inherited/elsewhere", PATH: "/usr/bin" };

        const blank = yield* makeClaudeEnvironment({ homePath: "" }, baseEnv);
        expect(blank.CLAUDE_CONFIG_DIR).toBeUndefined();
        expect(blank.PATH).toBe("/usr/bin");

        const homeOnly = yield* makeClaudeEnvironment({ homePath: "~/.claude-work" }, baseEnv);
        expect(homeOnly.CLAUDE_CONFIG_DIR).toBeUndefined();

        const configured = yield* makeClaudeEnvironment(
          { homePath: "", configDirPath: "~/.claude-personal" },
          baseEnv,
        );
        expect(configured.CLAUDE_CONFIG_DIR).toBe(
          path.resolve(NodeOS.homedir(), ".claude-personal"),
        );
        expect(baseEnv.CLAUDE_CONFIG_DIR).toBe("/inherited/elsewhere");
      }),
    );

    it.effect("sets CLAUDE_CONFIG_DIR and isolates keys when a config dir is configured", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homeResolved = path.resolve(NodeOS.homedir());
        const configDirPath = "~/.claude-personal";
        const configResolved = path.resolve(NodeOS.homedir(), ".claude-personal");

        expect(yield* resolveClaudeConfigDirPath({ homePath: "", configDirPath })).toBe(
          configResolved,
        );
        const env = yield* makeClaudeEnvironment({ homePath: "", configDirPath });
        expect(env.CLAUDE_CONFIG_DIR).toBe(configResolved);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "", configDirPath })).toBe(
          `claude:home:${homeResolved}:config:${configResolved}`,
        );
        expect(
          yield* makeClaudeCapabilitiesCacheKey({
            binaryPath: "claude",
            homePath: "",
            configDirPath,
          }),
        ).toBe(`claude\0${homeResolved}\0${configResolved}`);
      }),
    );
  });
});
