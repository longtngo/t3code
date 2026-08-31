// @effect-diagnostics nodeBuiltinImport:off - builds a real tmpdir HOME so the fixed on-disk flag-file path is exercised for real.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { layerTest as serverSettingsLayerTest } from "../serverSettings.ts";
import { readBackendFile, subagentBackendReconciler, writeBackendFile } from "./SubagentBackend.ts";

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.HOME;
  home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sbt-reconciler-"));
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
  instanceId: "gone",
  model: "auto",
  binaryPath: "/tmp/agent",
  apiEndpoint: "",
  updatedAt: null,
  degraded: null,
};

describe("subagentBackendReconciler", () => {
  it.layer(NodeServices.layer)("subagentBackendReconciler", (it) => {
    it.effect(
      "reconciles once at startup against current settings, with no settings change ever published",
      () =>
        Effect.gen(function* () {
          // Simulates an instance deleted (or `settings.json` hand-edited) while
          // the server was down: the flag file still names it, but nothing
          // publishes a settings change after boot, so only the explicit
          // startup reconcile — not the change stream, which the test layer's
          // `subscribeChanges` never emits on — can catch this before the
          // wrapper dispatches to a Cursor instance that no longer exists.
          yield* writeBackendFile(CURSOR);

          yield* subagentBackendReconciler;

          const after = yield* readBackendFile();
          expect(after.backend).toBe("default");
        }).pipe(Effect.provide(serverSettingsLayerTest({ providerInstances: {} }))),
    );
  });
});
