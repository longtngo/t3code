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
  it("treats a missing pull-request capability as unsupported under version skew", () => {
    expect(decodeDescriptor(descriptor).capabilities.pullRequests).toBeUndefined();
  });

  it("preserves an advertised pull-request capability", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, pullRequests: true },
      }).capabilities.pullRequests,
    ).toBe(true);
  });

  it("treats a missing attachment upload capability as unsupported", () => {
    expect(decodeDescriptor(descriptor).capabilities.attachmentUploads).toBeUndefined();
  });

  it("preserves an advertised attachment upload capability", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, attachmentUploads: true },
      }).capabilities.attachmentUploads,
    ).toBe(true);
  });

  it("preserves the server's generic attachment upload limit", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: {
          ...descriptor.capabilities,
          fileAttachments: { maxUploadBytes: 50 * 1024 * 1024 },
        },
      }).capabilities.fileAttachments,
    ).toEqual({ maxUploadBytes: 50 * 1024 * 1024 });
  });
});
