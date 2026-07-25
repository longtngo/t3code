// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFs from "node:fs";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  listLoginShellCandidates,
  mergePathEntries,
  readPathFromLoginShell,
  readPathFromLaunchctl,
  resolveWindowsEnvironment,
} from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeOS from "node:os";

function logPathHydrationWarning(message: string, error?: unknown): void {
  process.stderr.write(
    `[server] ${message} ${error instanceof Error ? error.message : (error ?? "")}\n`,
  );
}

/**
 * Well-known user/tool bin directories a login shell normally adds to PATH but
 * a minimal launchd/systemd PATH omits. Used only as a last resort when the
 * login-shell read fails and no cached PATH is available, so binaries installed
 * here (e.g. `claude` in `~/.local/bin`) stay reachable. Only directories that
 * actually exist are returned.
 */
function existingUserBinDirs(
  platform: NodeJS.Platform,
  homeDir: string,
  dirExists: (path: string) => boolean,
): ReadonlyArray<string> {
  if (platform !== "darwin" && platform !== "linux") return [];
  const candidates = [
    `${homeDir}/.local/bin`,
    `${homeDir}/.bun/bin`,
    `${homeDir}/.cargo/bin`,
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
  ];
  return candidates.filter((dir) => dirExists(dir));
}

function defaultReadCachedPath(cachePath: string): string | undefined {
  try {
    const value = NodeFs.readFileSync(cachePath, "utf8").trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function defaultWriteCachedPath(cachePath: string, value: string): void {
  try {
    NodeFs.writeFileSync(cachePath, value, "utf8");
  } catch (error) {
    logPathHydrationWarning(`Failed to cache hydrated PATH at ${cachePath}.`, error);
  }
}

/** Default file used to persist (and on failure reuse) the last good hydrated PATH. */
function defaultPathCacheFile(homeDir: string): string {
  return `${homeDir}/.t3/last-good-path`;
}

function hydratePosixPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): void {
  const homeDir = NodeOS.homedir();
  const cachePath = defaultPathCacheFile(homeDir);

  let shellPath: string | undefined;
  for (const shell of listLoginShellCandidates(platform, env.SHELL)) {
    try {
      shellPath = readPathFromLoginShell(shell);
    } catch (error) {
      logPathHydrationWarning(`Failed to read PATH from login shell ${shell}.`, error);
    }

    if (shellPath) break;
  }

  const launchctlPath = platform === "darwin" && !shellPath ? readPathFromLaunchctl() : undefined;

  // A fresh login-shell read is authoritative. When it (and launchctl) fail —
  // e.g. the `zsh -ilc` probe times out under load while a service restarts —
  // fall back to the last PATH we successfully hydrated, then to well-known
  // user bin dirs, instead of collapsing to the minimal launchd PATH (which
  // would drop ~/.local/bin and make CLIs like `claude` look "not on PATH").
  const discoveredPath = shellPath ?? launchctlPath;
  const cachedPath = !discoveredPath ? defaultReadCachedPath(cachePath) : undefined;
  const fallbackDirs =
    !discoveredPath && !cachedPath
      ? existingUserBinDirs(platform, homeDir, (path) => NodeFs.existsSync(path))
      : [];

  const preferredPath =
    [discoveredPath ?? cachedPath, ...fallbackDirs].filter(Boolean).join(":") || undefined;
  const mergedPath = mergePathEntries(preferredPath, env.PATH, platform);
  if (mergedPath) {
    env.PATH = mergedPath;
  }

  // Persist only after an authoritative shell read, so a degraded boot (which
  // used the cache or a fallback) never overwrites a known-good cached PATH.
  if (shellPath && mergedPath) {
    defaultWriteCachedPath(cachePath, mergedPath);
  }
}

export const fixPath = Effect.fn("fixPath")(function* (): Effect.fn.Return<
  void,
  never,
  FileSystem.FileSystem | Path.Path
> {
  const platform = yield* HostProcessPlatform;
  const env = yield* HostProcessEnvironment;

  if (platform === "win32") {
    const repairedEnvironment = yield* resolveWindowsEnvironment(env).pipe(
      Effect.catchDefect((defect) =>
        Effect.sync(() => {
          logPathHydrationWarning("Failed to hydrate PATH from the user environment.", defect);
          return {} as Partial<NodeJS.ProcessEnv>;
        }),
      ),
    );
    for (const [key, value] of Object.entries(repairedEnvironment)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
    return;
  }

  if (platform !== "darwin" && platform !== "linux") return;

  yield* Effect.sync(() => hydratePosixPath(env, platform)).pipe(
    Effect.catchDefect((defect) =>
      Effect.sync(() => {
        logPathHydrationWarning("Failed to hydrate PATH from the user environment.", defect);
      }),
    ),
  );
});

export const expandHomePath = Effect.fn(function* (input: string) {
  const { join } = yield* Path.Path;
  if (input === "~") {
    return NodeOS.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return join(NodeOS.homedir(), input.slice(2));
  }
  return input;
});

export const resolveBaseDir = Effect.fn(function* (raw: string | undefined) {
  const { join, resolve } = yield* Path.Path;
  if (!raw || raw.trim().length === 0) {
    return join(NodeOS.homedir(), ".t3");
  }
  return resolve(yield* expandHomePath(raw.trim()));
});
