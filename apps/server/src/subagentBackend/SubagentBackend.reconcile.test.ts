// @effect-diagnostics nodeBuiltinImport:off - builds a real tmpdir HOME so the fixed on-disk flag-file path is exercised for real.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import type { ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { readBackendFile, reconcileBackend, writeBackendFile } from "./SubagentBackend.ts";

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.HOME;
  home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sbt-reconcile-"));
  process.env.HOME = home;
});
afterEach(() => {
  if (previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }
});

const CURSOR = {
  schemaVersion: 1,
  backend: "cursor",
  instanceId: "cursor",
  model: "auto",
  binaryPath: "/tmp/agent",
  apiEndpoint: "",
  updatedAt: null,
  degraded: null,
};

const withInstances = (providerInstances: Record<string, unknown>): ServerSettings =>
  ({ providerInstances }) as unknown as ServerSettings;

describe("reconcileBackend", () => {
  it.layer(NodeServices.layer)("reconcileBackend", (it) => {
    it.effect("resets to default when the flagged instance is disabled", () =>
      Effect.gen(function* () {
        yield* writeBackendFile({ ...CURSOR, instanceId: "cursor" });
        const disabled = withInstances({
          cursor: { driver: "cursor", enabled: false, config: {} },
        });

        yield* reconcileBackend(disabled);

        expect((yield* readBackendFile()).backend).toBe("default");
      }),
    );

    it.effect("resets to default when the flagged instance no longer exists", () =>
      Effect.gen(function* () {
        yield* writeBackendFile({ ...CURSOR, instanceId: "gone" });

        yield* reconcileBackend(withInstances({}));

        expect((yield* readBackendFile()).backend).toBe("default");
      }),
    );

    it.effect("refreshes binaryPath when the instance config changes", () =>
      Effect.gen(function* () {
        yield* writeBackendFile({ ...CURSOR, binaryPath: "/old/agent" });
        const moved = withInstances({
          cursor: { driver: "cursor", enabled: true, config: { binaryPath: "/new/agent" } },
        });

        yield* reconcileBackend(moved);

        const after = yield* readBackendFile();
        expect(after.backend).toBe("cursor");
        expect(after.binaryPath).toBe("/new/agent");
      }),
    );

    it.effect("leaves an already-default file alone", () =>
      Effect.gen(function* () {
        yield* writeBackendFile({ ...CURSOR, backend: "default", instanceId: null });
        const before = yield* readBackendFile();

        yield* reconcileBackend(withInstances({}));

        expect(yield* readBackendFile()).toEqual(before);
      }),
    );

    it.effect(
      "does not rewrite on a second reconcile once an unresolvable binary is already recorded as degraded",
      () =>
        Effect.gen(function* () {
          // A still-enabled, still-cursor instance whose binary can't be resolved on
          // this process's PATH: reconcile keeps `backend: cursor` but marks `degraded`.
          // Before persisting `degraded`, the file read back always decoded it as
          // `null`, so `haveReconcilableFieldsChanged` saw a diff on every settings
          // change forever, even when nothing dispatch-relevant had actually changed.
          yield* writeBackendFile({ ...CURSOR, binaryPath: "definitely-not-on-path" });
          const unresolvable = withInstances({
            cursor: {
              driver: "cursor",
              enabled: true,
              config: { binaryPath: "definitely-not-on-path" },
            },
          });

          yield* reconcileBackend(unresolvable);
          const afterFirst = yield* readBackendFile();
          expect(afterFirst.degraded).toContain("Could not resolve");

          yield* reconcileBackend(unresolvable);
          const afterSecond = yield* readBackendFile();

          // A rewrite would have stamped a fresh `updatedAt`; identical `updatedAt`
          // proves the second reconcile skipped the write entirely.
          expect(afterSecond.updatedAt).toBe(afterFirst.updatedAt);
        }),
    );
  });
});
