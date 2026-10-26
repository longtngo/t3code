// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  listLoginShellCandidates,
  mergePathEntries,
  readEnvironmentFromLoginShell,
  readPathFromLaunchctl,
  resolveWindowsEnvironment,
  setWindowsPath,
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
 * Existing user/tool bin dirs a login shell adds but a launchd/systemd PATH omits. A last
 * resort when the login-shell read fails and nothing is cached, so e.g. `~/.local/bin/claude`
 * stays reachable.
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
    const value = NodeFS.readFileSync(cachePath, "utf8").trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function defaultWriteCachedPath(cachePath: string, value: string): void {
  try {
    NodeFS.writeFileSync(cachePath, value, "utf8");
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

  let shellEnvironment: Partial<Record<string, string>> = {};
  for (const shell of listLoginShellCandidates(platform, env.SHELL)) {
    try {
      // mise's record of the PATH entries it added. It must travel with the
      // shell's PATH, or `mise x` can rebuild PATH behind a same-named wrapper
      // (`exec mise x claude -- claude`) that then re-runs itself forever.
      shellEnvironment = readEnvironmentFromLoginShell(shell, ["PATH", "__MISE_DIFF", "JAVA_HOME"]);
    } catch (error) {
      logPathHydrationWarning(`Failed to read PATH from login shell ${shell}.`, error);
    }

    if (shellEnvironment.PATH) break;
  }

  const shellPath = shellEnvironment.PATH;
  const launchctlPath = platform === "darwin" && !shellPath ? readPathFromLaunchctl() : undefined;

  // A fresh login-shell read is authoritative. When it and launchctl fail (e.g. `zsh -ilc`
  // times out under load), fall back to the last hydrated PATH, then well-known bin dirs,
  // never the minimal launchd PATH that hides CLIs like `claude`.
  const discoveredPath = shellPath ?? launchctlPath;
  const cachedPath = !discoveredPath ? defaultReadCachedPath(cachePath) : undefined;
  const fallbackDirs =
    !discoveredPath && !cachedPath
      ? existingUserBinDirs(platform, homeDir, (path) => NodeFS.existsSync(path))
      : [];

  const preferredPath =
    [discoveredPath ?? cachedPath, ...fallbackDirs].filter(Boolean).join(":") || undefined;
  const mergedPath = mergePathEntries(preferredPath, env.PATH, platform);
  if (mergedPath) {
    env.PATH = mergedPath;
  }
  if (shellPath && shellEnvironment.__MISE_DIFF) {
    env.__MISE_DIFF = shellEnvironment.__MISE_DIFF;
  }
  // Android SDK tools are Java programs. A keg-only JDK (Homebrew's openjdk)
  // is only reachable through the JAVA_HOME the shell profile sets.
  if (!env.JAVA_HOME && shellEnvironment.JAVA_HOME) {
    env.JAVA_HOME = shellEnvironment.JAVA_HOME;
  }

  // Persist only after an authoritative shell read, so a degraded boot (which
  // used the cache or a fallback) never overwrites a known-good cached PATH.
  if (shellPath && mergedPath) {
    defaultWriteCachedPath(cachePath, mergedPath);
  }
}

export function hydratePosixHome(
  env: NodeJS.ProcessEnv,
  resolveHomeDir = () => NodeOS.userInfo().homedir,
): void {
  if ((env.HOME?.trim() ?? "").length > 0) return;

  const homeDir = resolveHomeDir();
  if (homeDir.length > 0) {
    env.HOME = homeDir;
  }
}

export const fixPath = Effect.fn("fixPath")(function* (options?: {
  readonly shellEnvironmentPrepared?: boolean | undefined;
}): Effect.fn.Return<void, never, FileSystem.FileSystem | Path.Path> {
  const platform = yield* HostProcess.Platform;
  const env = yield* HostProcess.Environment;

  if (platform === "win32") {
    // Desktop already populated the child env; repeating PowerShell probes costs seconds.
    if (options?.shellEnvironmentPrepared === true) return;
    const repairedEnvironment = yield* resolveWindowsEnvironment(env).pipe(
      Effect.catchDefect((defect) =>
        Effect.sync(() => {
          logPathHydrationWarning("Failed to hydrate PATH from the user environment.", defect);
          return {} as Partial<NodeJS.ProcessEnv>;
        }),
      ),
    );
    for (const [key, value] of Object.entries(repairedEnvironment)) {
      if (value === undefined) continue;
      if (key === "PATH") {
        setWindowsPath(env, value);
      } else {
        env[key] = value;
      }
    }
    return;
  }

  if (platform !== "darwin" && platform !== "linux") return;

  yield* Effect.sync(() => hydratePosixHome(env)).pipe(
    Effect.catchDefect((defect) =>
      Effect.sync(() => {
        logPathHydrationWarning("Failed to hydrate HOME from the user account.", defect);
      }),
    ),
  );
  if (options?.shellEnvironmentPrepared === true) return;
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
  const home = yield* HostProcess.HomeDirectory;
  if (input === "~") {
    return home;
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return join(home, input.slice(2));
  }
  return input;
});

export const resolveBaseDir = Effect.fn(function* (raw: string | undefined) {
  const { join, resolve } = yield* Path.Path;
  if (!raw || raw.trim().length === 0) {
    return join(yield* HostProcess.HomeDirectory, ".t3");
  }
  return resolve(yield* expandHomePath(raw.trim()));
});
