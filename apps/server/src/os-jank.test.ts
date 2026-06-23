import { describe, expect, it } from "vite-plus/test";

import { fixPath } from "./os-jank.ts";

const TIMEOUT = () => {
  throw new Error("spawnSync /bin/zsh ETIMEDOUT");
};
const silent = () => {};

describe("fixPath PATH hydration resilience (darwin/linux)", () => {
  it("merges the login-shell PATH over the inherited PATH", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
    fixPath({
      platform: "darwin",
      env,
      userShell: "/bin/zsh",
      readPath: () => "/Users/me/.local/bin:/opt/homebrew/bin",
      writeCachedPath: silent,
      logWarning: silent,
    });
    expect(env.PATH).toContain("/Users/me/.local/bin");
    expect(env.PATH).toContain("/usr/bin");
  });

  it("reuses the cached PATH when the login-shell read times out", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
    fixPath({
      platform: "darwin",
      env,
      userShell: "/bin/zsh",
      readPath: TIMEOUT,
      readLaunchctlPath: () => undefined,
      cachePath: "/cache/resolved-path",
      readCachedPath: () => "/Users/me/.local/bin:/opt/homebrew/bin:/usr/bin:/bin",
      writeCachedPath: silent,
      logWarning: silent,
    });
    // Without the fallback this would collapse to "/usr/bin:/bin" and lose claude.
    expect(env.PATH).toContain("/Users/me/.local/bin");
  });

  it("appends existing well-known user bin dirs when read fails and no cache exists", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
    fixPath({
      platform: "darwin",
      env,
      userShell: "/bin/zsh",
      readPath: TIMEOUT,
      readLaunchctlPath: () => undefined,
      cachePath: "/cache/resolved-path",
      readCachedPath: () => undefined,
      homeDir: "/Users/me",
      dirExists: (path) => path === "/Users/me/.local/bin",
      writeCachedPath: silent,
      logWarning: silent,
    });
    expect(env.PATH).toContain("/Users/me/.local/bin");
    // Non-existent candidates are not added.
    expect(env.PATH).not.toContain("/Users/me/.bun/bin");
  });

  it("persists the hydrated PATH after an authoritative shell read", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
    let cachedTo: string | undefined;
    let cachedValue: string | undefined;
    fixPath({
      platform: "darwin",
      env,
      userShell: "/bin/zsh",
      readPath: () => "/Users/me/.local/bin:/usr/bin",
      cachePath: "/cache/resolved-path",
      writeCachedPath: (path, value) => {
        cachedTo = path;
        cachedValue = value;
      },
      logWarning: silent,
    });
    expect(cachedTo).toBe("/cache/resolved-path");
    expect(cachedValue).toContain("/Users/me/.local/bin");
  });

  it("does not overwrite the cache on a degraded boot (read failed)", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
    let writeCount = 0;
    fixPath({
      platform: "darwin",
      env,
      userShell: "/bin/zsh",
      readPath: TIMEOUT,
      readLaunchctlPath: () => undefined,
      cachePath: "/cache/resolved-path",
      readCachedPath: () => "/Users/me/.local/bin:/usr/bin",
      dirExists: () => false,
      writeCachedPath: () => {
        writeCount += 1;
      },
      logWarning: silent,
    });
    expect(writeCount).toBe(0);
  });
});
