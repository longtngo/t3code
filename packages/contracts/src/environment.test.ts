import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ExecutionEnvironmentCapabilities } from "./environment.ts";

const decodeCapabilities = Schema.decodeUnknownEffect(ExecutionEnvironmentCapabilities);

describe("ExecutionEnvironmentCapabilities", () => {
  it.effect("reads a capability an older server never sent as unsupported", () =>
    Effect.gen(function* () {
      // Every optional capability carries the same contract: absent means the
      // server does not have it, so a client must compare against `true` rather
      // than treat undefined as permission. A decode failure here would take
      // out the whole descriptor and disconnect the environment instead.
      const decoded = yield* decodeCapabilities({ repositoryIdentity: true });

      assert.strictEqual(decoded.vcsLocalOnlyStatus, undefined);
      assert.strictEqual(decoded.vcsLocalOnlyStatus === true, false);
      assert.strictEqual(decoded.threadSettlement, undefined);
    }),
  );

  it.effect("carries the local-only status capability when the server advertises it", () =>
    Effect.gen(function* () {
      const decoded = yield* decodeCapabilities({
        repositoryIdentity: true,
        vcsLocalOnlyStatus: true,
      });

      assert.strictEqual(decoded.vcsLocalOnlyStatus, true);
    }),
  );
});
