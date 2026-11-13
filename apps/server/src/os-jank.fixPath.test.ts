// @effect-diagnostics-next-line nodeBuiltinImport:off -- the PATH cache under HOME is written synchronously by os-jank.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { afterEach, beforeEach, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { fixPath } from "./os-jank.ts";

// A successful login-shell read caches PATH at $HOME/.t3/last-good-path. Without a private HOME this
// test overwrites the real server's cache with the test shell's transient PATH.
let originalHome: string | undefined;
let testHome: string;
beforeEach(() => {
  originalHome = process.env.HOME;
  testHome = NodeFS.mkdtempSync(`${NodeOS.tmpdir()}/os-jank-fixpath-home-`);
  process.env.HOME = testHome;
});
afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  NodeFS.rmSync(testHome, { recursive: true, force: true });
});

it.layer(NodeServices.layer)("fixPath PATH hydration resilience", (it) => {
  it.effect("leaves PATH untouched on an unsupported platform", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
      yield* fixPath().pipe(
        Effect.provideService(HostProcess.Platform, "freebsd" as NodeJS.Platform),
        Effect.provideService(HostProcess.Environment, env),
      );
      expect(env.PATH).toBe("/usr/bin:/bin");
    }),
  );

  it.effect("preserves the inherited PATH entries when hydrating on darwin", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", SHELL: "/bin/zsh" };
      yield* fixPath().pipe(
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provideService(HostProcess.Environment, env),
      );
      // Whatever the login-shell read yields, the merge must never drop the
      // entries the process already had, so CLIs on the inherited PATH stay
      // reachable.
      expect(env.PATH).toContain("/usr/bin");
    }),
  );
});
