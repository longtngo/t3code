import * as NodeOS from "node:os";

import type { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
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
  baseEnv: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const homePath = config.homePath.trim();
  const configDirPath = (config.configDirPath ?? "").trim();
  if (
    homePath.length === 0 &&
    configDirPath.length === 0 &&
    baseEnv.CLAUDE_CONFIG_DIR === undefined
  ) {
    return baseEnv;
  }
  const env = { ...baseEnv };
  if (homePath.length > 0) {
    env.HOME = yield* resolveClaudeHomePath(config);
  }
  if (configDirPath.length > 0) {
    env.CLAUDE_CONFIG_DIR = yield* resolveClaudeConfigDirPath(config);
  } else {
    // An inherited CLAUDE_CONFIG_DIR would bind this instance to a different
    // login than its continuation/cache keys encode (they resolve blank to "").
    // Scrub it so a blank-config instance genuinely uses Claude's default dir.
    delete env.CLAUDE_CONFIG_DIR;
  }
  return env;
});

export const makeClaudeContinuationGroupKey = Effect.fn("makeClaudeContinuationGroupKey")(
  function* (config: ClaudeHomeConfig): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config);
    const resolvedConfigDir = yield* resolveClaudeConfigDirPath(config);
    return `claude:home:${resolvedHomePath}:config:${resolvedConfigDir}`;
  },
);

export const makeClaudeCapabilitiesCacheKey = Effect.fn("makeClaudeCapabilitiesCacheKey")(
  function* (
    config: ClaudeHomeConfig & Pick<ClaudeSettings, "binaryPath">,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config);
    const resolvedConfigDir = yield* resolveClaudeConfigDirPath(config);
    return `${config.binaryPath}\0${resolvedHomePath}\0${resolvedConfigDir}`;
  },
);
