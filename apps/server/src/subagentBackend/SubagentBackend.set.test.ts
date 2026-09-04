// @effect-diagnostics nodeBuiltinImport:off - builds a real tmpdir HOME and a real PATH-resolvable binary so resolution is exercised for real.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, type ServerSettings } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { vi } from "vite-plus/test";

import { layerTest as serverConfigLayerTest } from "../config.ts";
import { ProviderAdapterRegistry } from "../provider/Services/ProviderAdapterRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { listCursorModels } from "./cursorModels.ts";
import {
  backendWriteSemaphore,
  MASTER_OFF_REASON,
  readBackendFile,
  setBackend,
  writeBackendFile,
} from "./SubagentBackend.ts";

// vi.mock is hoisted above every import, so the `listCursorModels` binding above
// already resolves to this mock — letting individual tests override its behavior
// for one call via `vi.mocked(listCursorModels).mockImplementationOnce(...)`.
// `setBackend` never warms the model cache itself, and since the toggle-latency fix
// neither does the RPC around it: `ws.ts` calls
// `modelsForPersistedBackend(persisted, false)` after every `set`, which peeks the
// cache instead of spawning a probe. A probe inside `setBackend` would put back the
// multi-second wait that fix removed.
vi.mock("./cursorModels.ts", () => ({
  listCursorModels: vi.fn(() => Effect.die("listCursorModels should never run inside setBackend")),
}));

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

/** `setBackend` now fans its result out to every live thread, so it needs the session
 * registry and the threads dir. No instances here: the fan-out is covered in
 * `SubagentBackend.thread.test.ts`; these tests are about the global record. */
const emptyRegistryLayer = Layer.mock(ProviderAdapterRegistry)({
  listInstances: () => Effect.succeed([]),
});
const supportLayer = Layer.mergeAll(
  emptyRegistryLayer,
  serverConfigLayerTest("/tmp", { prefix: "sbt-set-" }),
);

describe("setBackend", () => {
  it.layer(NodeServices.layer)("setBackend", (it) => {
    it.effect("rejects an instance that is disabled", () =>
      Effect.gen(function* () {
        const result = yield* setBackend({ backend: "cursor", instanceId: cursorOffId });
        expect(result.backend).toBe("default");
        expect(result.degraded).toContain("not an enabled Cursor instance");
      }).pipe(Effect.provide(Layer.mergeAll(staticSettingsLayer(settings), supportLayer))),
    );

    it.effect("rejects an instance whose driver is not cursor", () =>
      Effect.gen(function* () {
        const result = yield* setBackend({ backend: "cursor", instanceId: claudeAgentId });
        expect(result.backend).toBe("default");
      }).pipe(Effect.provide(Layer.mergeAll(staticSettingsLayer(settings), supportLayer))),
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
      }).pipe(Effect.provide(Layer.mergeAll(staticSettingsLayer(settings), supportLayer))),
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
      }).pipe(Effect.provide(Layer.mergeAll(staticSettingsLayer(settings), supportLayer))),
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
          Effect.provide(Layer.mergeAll(staticSettingsLayer(missing), supportLayer)),
        );
        expect(result.backend).toBe("cursor");
        expect(result.binaryPath).toBe("definitely-not-on-path");
        expect(result.degraded).toContain("PATH");
      }),
    );

    it.effect("refuses under master-off without touching the file", () =>
      Effect.gen(function* () {
        // Seeded on purpose: the refusal must hand back the record the user set LAST,
        // not a fresh Off. Against an empty file every assertion below is trivially
        // true, and `before.updatedAt` is null so the unchanged-file check cannot bite.
        yield* writeBackendFile({
          schemaVersion: 1,
          backend: "cursor",
          instanceId: "cursor",
          model: "auto",
          binaryPath: "agent",
          apiEndpoint: "",
          updatedAt: null,
          degraded: null,
        });
        const before = yield* readBackendFile();
        const result = yield* setBackend({ backend: "cursor", instanceId: cursorId });
        expect(result.backend).toBe("cursor");
        expect(result.instanceId).toBe("cursor");
        expect(result.degraded).toBe(MASTER_OFF_REASON);
        const after = yield* readBackendFile();
        expect(after.updatedAt).toBe(before.updatedAt);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            staticSettingsLayer({ ...settings, subagentBackendEnabled: false }),
            supportLayer,
          ),
        ),
      ),
    );

    it.effect("admits a default under master-off, so the switch is not a one-way door", () =>
      Effect.gen(function* () {
        yield* writeBackendFile({
          schemaVersion: 1,
          backend: "cursor",
          instanceId: "cursor",
          model: "auto",
          binaryPath: "agent",
          apiEndpoint: "",
          updatedAt: null,
          degraded: null,
        });
        // Turning offload off machine-wide must not strand the global file on cursor:
        // refusing every write would leave no way back once the master switch is off.
        const result = yield* setBackend({ backend: "default" });
        expect(result.backend).toBe("default");
        expect(result.degraded).toBeNull();
        expect((yield* readBackendFile()).backend).toBe("default");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            staticSettingsLayer({ ...settings, subagentBackendEnabled: false }),
            supportLayer,
          ),
        ),
      ),
    );

    it.effect("writes default without naming an instance", () =>
      Effect.gen(function* () {
        const result = yield* setBackend({ backend: "default" });
        expect(result.backend).toBe("default");
        expect(result.instanceId).toBeNull();
        expect(result.degraded).toBeNull();
      }).pipe(Effect.provide(Layer.mergeAll(staticSettingsLayer(settings), supportLayer))),
    );

    it.effect(
      "reads settings inside the write permit, so a disable that lands before the permit is honoured",
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

          // Hold the permit ourselves; fork `set` (it must block on the permit); flip the
          // instance to disabled while still holding it; release. `set` may only read
          // settings after the release, so it must see `disabled`.
          const fiber = yield* backendWriteSemaphore.withPermits(1)(
            Effect.gen(function* () {
              const fiber = yield* setBackend({
                backend: "cursor",
                instanceId: cursorId,
                model: "composer-2.5",
              }).pipe(
                Effect.provide(Layer.mergeAll(refBackedSettingsLayer(settingsRef), supportLayer)),
                Effect.forkChild({ startImmediately: true }),
              );
              yield* Ref.set(settingsRef, disabled);
              return fiber;
            }),
          );
          const result = yield* Fiber.join(fiber);

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
          }).pipe(Effect.provide(Layer.mergeAll(staticSettingsLayer(settings), supportLayer)));
          expect(result.backend).toBe("cursor");
          expect(result.model).toBe("composer-2.5");
        }),
    );
  });
});
