import * as NodeOS from "node:os";

import type { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { expandHomePath } from "../../pathExpansion.ts";

/** Config slice that determines where this Claude instance reads/writes state. */
type ClaudeHomeConfig = Pick<ClaudeSettings, "homePath"> & {
  readonly configDirPath?: string | undefined;
};

export const resolveClaudeHomePath = Effect.fn("resolveClaudeHomePath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = config.homePath.trim();
  return path.resolve(homePath.length > 0 ? expandHomePath(homePath) : NodeOS.homedir());
});

/**
 * Resolve the configured CLAUDE_CONFIG_DIR for this instance, or "" when none
 * is set (the instance uses Claude's default ~/.claude). Distinct config dirs
 * are what actually isolate credentials between accounts — on macOS the
 * Keychain credential service name is salted by CLAUDE_CONFIG_DIR, so two
 * instances differing only by HOME would still share one login.
 */
export const resolveClaudeConfigDirPath = Effect.fn("resolveClaudeConfigDirPath")(function* (
  config: ClaudeHomeConfig,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const configDirPath = (config.configDirPath ?? "").trim();
  return configDirPath.length > 0 ? path.resolve(expandHomePath(configDirPath)) : "";
});

export const makeClaudeEnvironment = Effect.fn("makeClaudeEnvironment")(function* (
  config: ClaudeHomeConfig,
  baseEnv?: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const resolvedBaseEnv = baseEnv ?? process.env;
  const homePath = config.homePath.trim();
  const configDirPath = (config.configDirPath ?? "").trim();
  if (
    homePath.length === 0 &&
    configDirPath.length === 0 &&
    resolvedBaseEnv.CLAUDE_CONFIG_DIR === undefined
  ) {
    return resolvedBaseEnv;
  }
  const env = { ...resolvedBaseEnv };
  if (homePath.length > 0) {
    env.HOME = yield* resolveClaudeHomePath(config);
  }
  if (configDirPath.length > 0) {
    // Isolate this instance's credentials via CLAUDE_CONFIG_DIR. On macOS the
    // Keychain credential service name is salted by CLAUDE_CONFIG_DIR, so this
    // (rather than HOME alone) is what actually separates logins between
    // accounts while leaving the keychain lookup intact.
    env.CLAUDE_CONFIG_DIR = yield* resolveClaudeConfigDirPath(config);
  } else {
    // An inherited CLAUDE_CONFIG_DIR would bind this instance to a different
    // login than its continuation/cache keys encode (they resolve blank to "").
    // Scrub it so a blank-config instance genuinely uses Claude's default dir.
    delete env.CLAUDE_CONFIG_DIR;
  }
  return env;
});

/**
 * Key the continuation group on the transcript store — `<configDir>/projects`,
 * the directory `claude --resume` reads `<cwd>/<sessionId>.jsonl` from. Two
 * config dirs whose `projects` resolve to one directory can resume each
 * other's sessions, so they share a group (fork precedent:
 * `codexContinuationIdentity` keys on Codex's shared home). HOME is not part of
 * the key: with `CLAUDE_CONFIG_DIR` set it does not locate the transcript.
 */
export const makeClaudeContinuationGroupKey = Effect.fn("makeClaudeContinuationGroupKey")(
  function* (
    config: ClaudeHomeConfig,
  ): Effect.fn.Return<string, never, Path.Path | FileSystem.FileSystem> {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const configDir =
      (yield* resolveClaudeConfigDirPath(config)) ||
      path.join(yield* resolveClaudeHomePath(config), ".claude");
    return `claude:store:${yield* realPathThroughExistingAncestor(fs, path, path.join(configDir, "projects"))}`;
  },
);

/**
 * `realpath` of `target` when it exists, otherwise of its deepest existing ancestor with the
 * missing tail re-joined. The key must not change between the boot before Claude first
 * creates `projects` (or the config dir itself) and the boot after, and a symlink anywhere
 * on the way must resolve the same in both.
 */
const realPathThroughExistingAncestor = Effect.fn("realPathThroughExistingAncestor")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  target: string,
): Effect.fn.Return<string, never> {
  const tail: Array<string> = [];
  let current = target;
  while (true) {
    const real = yield* fs.realPath(current).pipe(Effect.option);
    if (Option.isSome(real)) return path.join(real.value, ...tail);
    const parent = path.dirname(current);
    if (parent === current) return target;
    tail.unshift(path.basename(current));
    current = parent;
  }
});

export const makeClaudeCapabilitiesCacheKey = Effect.fn("makeClaudeCapabilitiesCacheKey")(
  function* (
    config: ClaudeHomeConfig & Pick<ClaudeSettings, "binaryPath">,
    cwd?: string,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config);
    const resolvedConfigDir = yield* resolveClaudeConfigDirPath(config);
    return `${config.binaryPath}\0${resolvedHomePath}\0${resolvedConfigDir}\0${cwd ?? ""}`;
  },
);
