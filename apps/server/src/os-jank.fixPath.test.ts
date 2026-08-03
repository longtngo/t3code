import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { fixPath } from "./os-jank.ts";

it.layer(NodeServices.layer)("fixPath PATH hydration resilience", (it) => {
  it.effect("leaves PATH untouched on an unsupported platform", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
      yield* fixPath().pipe(
        Effect.provideService(HostProcessPlatform, "freebsd" as NodeJS.Platform),
        Effect.provideService(HostProcessEnvironment, env),
      );
      expect(env.PATH).toBe("/usr/bin:/bin");
    }),
  );

  it.effect("preserves the inherited PATH entries when hydrating on darwin", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", SHELL: "/bin/zsh" };
      yield* fixPath().pipe(
        Effect.provideService(HostProcessPlatform, "darwin"),
        Effect.provideService(HostProcessEnvironment, env),
      );
      // Whatever the login-shell read yields, the merge must never drop the
      // entries the process already had, so CLIs on the inherited PATH stay
      // reachable.
      expect(env.PATH).toContain("/usr/bin");
    }),
  );
});
