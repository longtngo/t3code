import type { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";

/** Config slice that determines where this Claude instance reads/writes state. */
type ClaudeHomeConfig = Pick<ClaudeSettings, "homePath"> & {
  readonly configDirPath?: string | undefined;
};
const quotePath = Schema.encodeSync(Schema.fromJsonString(Schema.String));

export const resolveClaudeHomePath = Effect.fn("resolveClaudeHomePath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const homePath = config.homePath.trim();
  return path.resolve(homePath.length > 0 ? expandHomePath(homePath, home) : home);
});

/**
 * The configured CLAUDE_CONFIG_DIR, or "" for Claude's default ~/.claude. Config
 * dirs, not HOME, isolate logins: macOS salts the Keychain credential service
 * name by CLAUDE_CONFIG_DIR.
 */
export const resolveClaudeConfigDirPath = Effect.fn("resolveClaudeConfigDirPath")(function* (
  config: ClaudeHomeConfig,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const configDirPath = (config.configDirPath ?? "").trim();
  return configDirPath.length > 0 ? path.resolve(expandHomePath(configDirPath, home)) : "";
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
    // CLAUDE_CONFIG_DIR, not HOME, separates logins: macOS salts the Keychain
    // credential service name by it and leaves the keychain lookup intact.
    env.CLAUDE_CONFIG_DIR = yield* resolveClaudeConfigDirPath(config);
  } else {
    // An inherited CLAUDE_CONFIG_DIR would bind this instance to a different login
    // than its continuation/cache keys encode (blank resolves to ""), so scrub it.
    delete env.CLAUDE_CONFIG_DIR;
  }
  return env;
});

/** managed-mcp.json excludes other MCP config and forbids --strict-mcp-config; omit the flag when present. */
export const hasClaudeManagedMcpConfig = Effect.fn("hasClaudeManagedMcpConfig")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const managedMcpConfigPath =
    platform === "darwin"
      ? "/Library/Application Support/ClaudeCode/managed-mcp.json"
      : platform === "win32"
        ? "C:\\Program Files\\ClaudeCode\\managed-mcp.json"
        : "/etc/claude-code/managed-mcp.json";
  return yield* fileSystem.exists(managedMcpConfigPath).pipe(Effect.orElseSucceed(() => false));
});

/**
 * Keyed on the transcript store `<configDir>/projects`, where `claude --resume`
 * reads sessions, so config dirs sharing one store share a group. HOME is not in
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

/** Separate spawn env from login commands to preserve literal paths, including relative inherited values. */
export const claudeSignedOutMessage = (input: {
  readonly configDir: string | undefined;
  readonly cwd: string;
}): string => {
  const configuration =
    input.configDir !== undefined
      ? ` from ${quotePath(input.cwd)}, with CLAUDE_CONFIG_DIR set to ${quotePath(input.configDir)}`
      : "";
  return `Claude could not authenticate. For subscription login, run \`claude auth login\` on this environment's machine${configuration}, then start a new thread. For API-key authentication, check this instance's configured credentials.`;
};
