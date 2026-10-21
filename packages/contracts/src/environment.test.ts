import { assert, it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ExecutionEnvironmentCapabilities, ExecutionEnvironmentDescriptor } from "./environment.ts";

const decodeCapabilities = Schema.decodeUnknownEffect(ExecutionEnvironmentCapabilities);

describe("ExecutionEnvironmentCapabilities", () => {
  effectIt.effect("reads a capability an older server never sent as unsupported", () =>
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

  effectIt.effect("carries the local-only status capability when the server advertises it", () =>
    Effect.gen(function* () {
      const decoded = yield* decodeCapabilities({
        repositoryIdentity: true,
        vcsLocalOnlyStatus: true,
      });

      assert.strictEqual(decoded.vcsLocalOnlyStatus, true);
    }),
  );
});

const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);

const descriptor = {
  environmentId: "environment-1",
  label: "Local",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "0.0.32",
  capabilities: { repositoryIdentity: true },
} as const;

describe("ExecutionEnvironmentDescriptor", () => {
  it("decodes old, recognized and future manual installation descriptors", () => {
    expect(decodeDescriptor(descriptor).capabilities.serverInstallation).toBeUndefined();
    for (const installation of [{ kind: "npx" }, { kind: "npm-global", prefix: "/opt/node" }]) {
      expect(
        decodeDescriptor({
          ...descriptor,
          capabilities: { ...descriptor.capabilities, serverInstallation: installation },
        }).capabilities.serverInstallation,
      ).toEqual(installation);
    }
    for (const installation of [{ kind: "future-manager" }, { kind: "npm-global" }]) {
      expect(
        decodeDescriptor({
          ...descriptor,
          capabilities: { ...descriptor.capabilities, serverInstallation: installation },
        }).capabilities.serverInstallation,
      ).toBeUndefined();
    }
  });
});
