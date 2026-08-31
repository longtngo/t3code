// @effect-diagnostics nodeBuiltinImport:off - builds a real tmpdir HOME and a real PATH-resolvable binary so resolution is exercised for real.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, type ServerSettings } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { vi } from "vite-plus/test";

import { ServerSettingsService } from "../serverSettings.ts";
import { listCursorModels } from "./cursorModels.ts";
import { setBackend } from "./SubagentBackend.ts";

// vi.mock is hoisted above every import, so the `listCursorModels` binding above
// already resolves to this mock — letting individual tests override its behavior
// for one call via `vi.mocked(listCursorModels).mockImplementationOnce(...)`.
// `setBackend` never warms the model cache itself: `ws.ts` always calls
// `modelsForPersistedBackend(persisted, true)` right after every `set`, so a probe
// inside `setBackend` would just be a second, redundant one.
vi.mock("./cursorModels.ts", () => ({
  listCursorModels: vi.fn(() => Effect.die("listCursorModels should never run inside setBackend")),
}));

// `resolveCommandPath` forwards to the real implementation by default, so PATH
// resolution is still exercised for real; only one test below overrides it once to
// simulate a settings change landing while resolution is in flight.
vi.mock("@t3tools/shared/shell", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@t3tools/shared/shell")>();
  return { ...actual, resolveCommandPath: vi.fn(actual.resolveCommandPath) };
});

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.HOME;
  home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sbt-set-"));
  process.env.HOME = home;
});
afterEach(() => {
  if (previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }
  vi.mocked(listCursorModels).mockReset();
  vi.mocked(listCursorModels).mockImplementation(() =>
    Effect.die("listCursorModels should never run inside setBackend"),
  );
});

const cursorId = ProviderInstanceId.make("cursor");
const cursorOffId = ProviderInstanceId.make("cursor_off");
const claudeAgentId = ProviderInstanceId.make("claudeAgent");

const settings = {
  providerInstances: {
    cursor: {
      driver: "cursor",
      displayName: "UniSub",
      enabled: true,
      config: { binaryPath: "agent", apiEndpoint: "" },
    },
    cursor_off: {
      driver: "cursor",
      displayName: "Old",
      enabled: false,
      config: { binaryPath: "agent" },
    },
    claudeAgent: { driver: "claudeAgent", enabled: true, config: {} },
  },
} as unknown as ServerSettings;

/** Fixed-value `ServerSettingsService` test double: `getRawSettings` always
 * returns the same snapshot, for tests that don't care about settings drift. */
const staticSettingsLayer = (fixed: ServerSettings) =>
  Layer.succeed(
    ServerSettingsService,
    ServerSettingsService.of({
      start: Effect.void,
      ready: Effect.void,
      getSettings: Effect.succeed(fixed),
      getRawSettings: Effect.succeed(fixed),
      updateSettings: () => Effect.die("updateSettings unused in this test"),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.succeed(Stream.empty),
    }),
  );

/** `Ref`-backed `ServerSettingsService` test double: `getRawSettings` returns
 * whatever the `Ref` currently holds, so a test can change it mid-call. */
const refBackedSettingsLayer = (ref: Ref.Ref<ServerSettings>) =>
  Layer.succeed(
    ServerSettingsService,
    ServerSettingsService.of({
      start: Effect.void,
      ready: Effect.void,
      getSettings: Ref.get(ref),
      getRawSettings: Ref.get(ref),
      updateSettings: () => Effect.die("updateSettings unused in this test"),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.succeed(Stream.empty),
    }),
  );

describe("setBackend", () => {
  it.layer(NodeServices.layer)("setBackend", (it) => {
    it.effect("rejects an instance that is disabled", () =>
      Effect.gen(function* () {
        const result = yield* setBackend({ backend: "cursor", instanceId: cursorOffId });
        expect(result.backend).toBe("default");
        expect(result.degraded).toContain("not an enabled Cursor instance");
      }).pipe(Effect.provide(staticSettingsLayer(settings))),
    );

    it.effect("rejects an instance whose driver is not cursor", () =>
      Effect.gen(function* () {
        const result = yield* setBackend({ backend: "cursor", instanceId: claudeAgentId });
        expect(result.backend).toBe("default");
      }).pipe(Effect.provide(staticSettingsLayer(settings))),
    );

    it.effect("accepts auto without consulting the model cache", () =>
      Effect.gen(function* () {
        // listCursorModels is mocked to die; auto must still succeed.
        const result = yield* setBackend({
          backend: "cursor",
          instanceId: cursorId,
          model: "auto",
        });
        expect(result.backend).toBe("cursor");
        expect(result.model).toBe("auto");
      }).pipe(Effect.provide(staticSettingsLayer(settings))),
    );

    it.effect("writes the resolved absolute binary path", () =>
      Effect.gen(function* () {
        // Hermetic PATH: point resolution at a binary this test creates itself,
        // rather than relying on some binary named "agent" happening to already
        // be on whichever machine runs the suite.
        const binDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sbt-bin-"));
        const executablePath = NodePath.join(binDir, "agent");
        NodeFS.writeFileSync(executablePath, "#!/bin/sh\nexit 0\n");
        NodeFS.chmodSync(executablePath, 0o755);

        const result = yield* setBackend({ backend: "cursor", instanceId: cursorId }).pipe(
          Effect.provideService(HostProcessEnvironment, { PATH: binDir }),
        );
        expect(result.binaryPath).toBe(executablePath);
      }).pipe(Effect.provide(staticSettingsLayer(settings))),
    );

    it.effect("writes the raw path and marks degraded when resolution fails", () =>
      Effect.gen(function* () {
        const missing = {
          ...settings,
          providerInstances: {
            cursor: {
              driver: "cursor",
              enabled: true,
              config: { binaryPath: "definitely-not-on-path" },
            },
          },
        } as unknown as ServerSettings;
        const result = yield* setBackend({ backend: "cursor", instanceId: cursorId }).pipe(
          Effect.provide(staticSettingsLayer(missing)),
        );
        expect(result.backend).toBe("cursor");
        expect(result.binaryPath).toBe("definitely-not-on-path");
        expect(result.degraded).toContain("PATH");
      }),
    );

    it.effect("writes default without naming an instance", () =>
      Effect.gen(function* () {
        const result = yield* setBackend({ backend: "default" });
        expect(result.backend).toBe("default");
        expect(result.instanceId).toBeNull();
        expect(result.degraded).toBeNull();
      }).pipe(Effect.provide(staticSettingsLayer(settings))),
    );

    it.effect(
      "refuses a selection whose instance was disabled while binary resolution was in flight",
      () =>
        Effect.gen(function* () {
          const disabled = {
            providerInstances: {
              cursor: {
                driver: "cursor",
                displayName: "UniSub",
                enabled: false,
                config: { binaryPath: "agent", apiEndpoint: "" },
              },
            },
          } as unknown as ServerSettings;

          const settingsRef = yield* Ref.make(settings);
          // Simulate the race: while (the mocked) `resolveCommandPath` is "in
          // flight", something else — here, standing in for the reconciler or
          // another `set` call — disables the flagged instance. The pre-write
          // revalidation must see `disabled`, not the `enabled` snapshot read
          // before resolution ran.
          vi.mocked(resolveCommandPath).mockImplementationOnce((path: string) =>
            Ref.set(settingsRef, disabled).pipe(Effect.as(path)),
          );

          const result = yield* setBackend({
            backend: "cursor",
            instanceId: cursorId,
            model: "composer-2.5",
          }).pipe(Effect.provide(refBackedSettingsLayer(settingsRef)));

          expect(result.backend).toBe("default");
          expect(result.degraded).toContain("not an enabled Cursor instance");
        }),
    );

    it.effect(
      "never consults the model cache, even for a named model — ws.ts probes after every set",
      () =>
        Effect.gen(function* () {
          // listCursorModels is mocked to die unconditionally; a non-"auto" model
          // used to warm the cache from inside setBackend, which was dead work
          // because ws.ts always re-probes right after `set` regardless of model.
          const result = yield* setBackend({
            backend: "cursor",
            instanceId: cursorId,
            model: "composer-2.5",
          }).pipe(Effect.provide(staticSettingsLayer(settings)));
          expect(result.backend).toBe("cursor");
          expect(result.model).toBe("composer-2.5");
        }),
    );
  });
});
