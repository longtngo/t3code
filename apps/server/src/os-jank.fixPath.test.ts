import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { fixPath } from "./os-jank.ts";

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
