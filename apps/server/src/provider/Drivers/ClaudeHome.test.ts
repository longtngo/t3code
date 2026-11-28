import * as NodeOS from "node:os";

const realPathOrSelf = (target: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.realPath(target).pipe(Effect.orElseSucceed(() => target));
  });

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";

import {
  claudeLocalSettingsDirectory,
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  mergeClaudeProcessEnvironment,
  resolveClaudeConfigDirPath,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  it.effect("finds the main checkout from a worktree whose name holds a line separator", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repo = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-local-" });
      const worktree = path.join(repo, ".claude", "worktrees", "feature\u2028tools");
      const worktreeGitDir = path.join(repo, ".git", "worktrees", "feature\u2028tools");
      yield* fileSystem.makeDirectory(worktree, { recursive: true });
      yield* fileSystem.makeDirectory(worktreeGitDir, { recursive: true });
      yield* fileSystem.writeFileString(path.join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`);
      yield* fileSystem.writeFileString(path.join(worktreeGitDir, "commondir"), "../..\n");

      expect(yield* claudeLocalSettingsDirectory(worktree)).toBe(repo);
    }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
  );

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
        // `~/.claude-work` does not exist, so the key is the resolved string; the
        // home itself is realpathed so a symlinked $HOME does not change it.
        expect(yield* makeClaudeContinuationGroupKey({ homePath })).toBe(
          `claude:store:${yield* realPathOrSelf(NodeOS.homedir())}/.claude-work/.claude/projects`,
        );
        expect(yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", homePath })).toBe(
          `claude\0${resolved}\0\0`,
        );
      }),
    );

    it.effect("gives a symlinked Claude home the continuation key of its target", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
        const target = path.join(root, ".claude");
        const link = path.join(root, ".claude-second-account");
        yield* fileSystem.makeDirectory(target);
        yield* fileSystem.symlink(target, link);

        // FORK (invariant 40): the login lives in CLAUDE_CONFIG_DIR (`configDirPath`), and the
        // key is the realpath of its store, so a symlinked config dir shares its target's key.
        const direct = yield* makeClaudeContinuationGroupKey({
          homePath: "",
          configDirPath: target,
        });
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "", configDirPath: link })).toBe(
          direct,
        );
        // The spawned process keeps the literal path, because Claude keys its login by that path.
        expect(
          (yield* makeClaudeEnvironment({ homePath: "", configDirPath: link })).CLAUDE_CONFIG_DIR,
        ).toBe(link);
      }).pipe(Effect.scoped),
    );

    it.effect("separates capability probes by cwd", () =>
      Effect.gen(function* () {
        const config = { binaryPath: "claude", homePath: "" };
        const first = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-a");
        const second = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-b");
        expect(first).not.toBe(second);
      }),
    );

    it.effect("keeps continuation compatible across instances with the same Claude HOME", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // Whatever the developer's real `~/.claude/projects` resolves to (it may be a
        // symlink), both blank-config forms land on it.
        const projects = path.join(NodeOS.homedir(), ".claude", "projects");
        const store = yield* fs.realPath(projects).pipe(Effect.orElseSucceed(() => projects));

        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" })).toBe(
          `claude:store:${store}`,
        );
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "", configDirPath: "" })).toBe(
          `claude:store:${store}`,
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
        const configDirPath = "~/.claude-instance-b";
        const configResolved = path.resolve(NodeOS.homedir(), ".claude-instance-b");

        expect(yield* resolveClaudeConfigDirPath({ homePath: "", configDirPath })).toBe(
          configResolved,
        );
        const env = yield* makeClaudeEnvironment({ homePath: "", configDirPath });
        expect(env.CLAUDE_CONFIG_DIR).toBe(configResolved);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "", configDirPath })).toBe(
          `claude:store:${configResolved}/projects`,
        );
        expect(
          yield* makeClaudeCapabilitiesCacheKey({
            binaryPath: "claude",
            homePath: "",
            configDirPath,
          }),
        ).toBe(`claude\0${homeResolved}\0${configResolved}\0`);
      }),
    );

    it.effect("keys the continuation group on the resolved projects directory", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "claude-store-" });
        const a = path.join(root, "a");
        const b = path.join(root, "b");
        const c = path.join(root, "c");
        yield* fs.makeDirectory(path.join(a, "projects"), { recursive: true });
        yield* fs.makeDirectory(b);
        yield* fs.symlink(path.join(a, "projects"), path.join(b, "projects"));
        yield* fs.makeDirectory(path.join(c, "projects"), { recursive: true });

        const keyA = yield* makeClaudeContinuationGroupKey({ homePath: "", configDirPath: a });
        const keyB = yield* makeClaudeContinuationGroupKey({ homePath: "", configDirPath: b });
        const keyC = yield* makeClaudeContinuationGroupKey({ homePath: "", configDirPath: c });

        expect(keyB).toBe(keyA);
        expect(keyC).not.toBe(keyA);
        expect(keyA).toBe(`claude:store:${yield* fs.realPath(path.join(a, "projects"))}`);
        // Different HOME, same config dir: HOME does not locate the transcript.
        expect(yield* makeClaudeContinuationGroupKey({ homePath: root, configDirPath: a })).toBe(
          keyA,
        );
      }),
    );

    it.effect(
      "does not change the key when the config dir under a symlinked ancestor is created later",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "claude-store-" });
          const real = path.join(root, "real");
          const link = path.join(root, "link");
          yield* fs.makeDirectory(real);
          yield* fs.symlink(real, link);
          const configDir = path.join(link, ".claude");
          const before = yield* makeClaudeContinuationGroupKey({
            homePath: "",
            configDirPath: configDir,
          });
          yield* fs.makeDirectory(path.join(real, ".claude", "projects"), { recursive: true });
          const after = yield* makeClaudeContinuationGroupKey({
            homePath: "",
            configDirPath: configDir,
          });
          expect(after).toBe(before);
          expect(before).toBe(`claude:store:${yield* fs.realPath(real)}/.claude/projects`);
        }),
    );

    it.effect("does not change the key when the projects directory is created later", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "claude-store-" });
        const real = path.join(root, "real");
        const link = path.join(root, "link");
        yield* fs.makeDirectory(real);
        yield* fs.symlink(real, link);

        const before = yield* makeClaudeContinuationGroupKey({ homePath: "", configDirPath: link });
        yield* fs.makeDirectory(path.join(real, "projects"));
        const after = yield* makeClaudeContinuationGroupKey({ homePath: "", configDirPath: link });

        expect(after).toBe(before);
        expect(before).toBe(`claude:store:${yield* fs.realPath(real)}/projects`);
      }),
    );
  });

  it.effect(
    "drops the launching Claude session and Electron's run-as-Node flag, and labels processes t3-code unless overridden, without reading settings while turned off",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // FORK (invariant 40): the settings file lives in the config dir, which is `configDirPath`
        // here, not `homePath` (that is HOME).
        const configDirPath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-claude-config-",
        });
        const claudeConfig = { homePath: "", configDirPath, enabled: true };
        const host = {
          CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
          CLAUDECODE: "1",
          CLAUDE_CODE_SESSION_ID: "host-session",
          CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/host-claude.sock",
          CLAUDE_EFFORT: "high",
          ELECTRON_RUN_AS_NODE: "1",
          KEEP: "1",
        };
        const instance = [
          { name: "CLAUDE_CODE_ENTRYPOINT", value: "instance", sensitive: false },
          { name: "CLAUDE_EFFORT", value: "low", sensitive: false },
        ];

        expect(yield* mergeClaudeProcessEnvironment(claudeConfig, undefined, host)).toEqual({
          CLAUDE_CODE_ENTRYPOINT: "t3-code",
          KEEP: "1",
        });
        expect(yield* mergeClaudeProcessEnvironment(claudeConfig, instance, host)).toEqual({
          CLAUDE_CODE_ENTRYPOINT: "instance",
          CLAUDE_EFFORT: "low",
          KEEP: "1",
        });

        yield* fileSystem.writeFileString(
          path.join(configDirPath, "settings.json"),
          JSON.stringify({ env: { CLAUDE_CODE_ENTRYPOINT: "custom" } }),
        );
        expect(
          (yield* mergeClaudeProcessEnvironment(claudeConfig, instance, host))
            .CLAUDE_CODE_ENTRYPOINT,
        ).toBe("custom");
        expect(
          (yield* mergeClaudeProcessEnvironment(
            { ...claudeConfig, enabled: false },
            instance,
            host,
          )).CLAUDE_CODE_ENTRYPOINT,
        ).toBe("instance");
      }),
  );
});
