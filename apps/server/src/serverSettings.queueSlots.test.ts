// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeFS from "node:fs";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import * as ServerSettingsModule from "./serverSettings.ts";

const layer = () =>
  ServerSettingsModule.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
    Layer.provideMerge(
      Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3-queue-slots-" })),
    ),
  );

const Q = { slots: 5, perProvider: true, providerSlots: { codex: 2 } };
const BROKEN = '{"enableAssistantStreaming": tru';

// Collects emissions without sleeping: subscribe, act, then let the collector drain what is buffered.
const withEmits = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const settings = yield* ServerSettingsModule.ServerSettingsService;
    const changes = yield* settings.subscribeChanges;
    const emitted: Array<unknown> = [];
    const fiber = yield* changes.pipe(
      Stream.runForEach((s) => Effect.sync(() => emitted.push(s))),
      Effect.forkScoped,
    );
    const result = yield* body;
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(fiber);
    return { result, emitted };
  }).pipe(Effect.scoped);

const fileJson = (path: string) => JSON.parse(NodeFS.readFileSync(path, "utf8"));

it.layer(NodeServices.layer)("queue slot settings writes", (it) => {
  it.effect("1: a missing file takes the import", () =>
    Effect.gen(function* () {
      const { settingsPath } = yield* ServerConfig.ServerConfig;
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      NodeFS.rmSync(settingsPath, { force: true });
      yield* settings.getRawSettings;
      const result = yield* settings.updateSettings({ queueSlotsImport: Q, queueSlots: {} });
      assert.deepEqual(result.queueSlots, Q);
      assert.deepEqual(fileJson(settingsPath).queueSlots, Q);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("2: an import never overwrites a stored value", () =>
    Effect.gen(function* () {
      const { settingsPath } = yield* ServerConfig.ServerConfig;
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      NodeFS.writeFileSync(
        settingsPath,
        '{"queueSlots":{"slots":3,"perProvider":false,"providerSlots":{}}}\n',
      );
      yield* settings.getRawSettings;
      const result = yield* settings.updateSettings({ queueSlotsImport: Q });
      assert.equal(result.queueSlots?.slots, 3);
      assert.equal(fileJson(settingsPath).queueSlots.slots, 3);
    }).pipe(Effect.provide(layer())),
  );

  it.effect(
    "3: a broken file is not rewritten for a queue change, which fails, and nothing emits",
    () =>
      Effect.gen(function* () {
        const { settingsPath } = yield* ServerConfig.ServerConfig;
        const settings = yield* ServerSettingsModule.ServerSettingsService;
        NodeFS.writeFileSync(settingsPath, BROKEN);
        yield* settings.getRawSettings;
        const { result, emitted } = yield* withEmits(
          Effect.flip(settings.updateSettings({ queueSlots: { slots: 2 } })),
        );
        assert.include(result.message, "queue change was not saved");
        assert.equal(NodeFS.readFileSync(settingsPath, "utf8"), BROKEN);
        assert.equal(emitted.length, 0);
      }).pipe(Effect.provide(layer())),
  );

  it.effect("4: a broken file is not rewritten for an import", () =>
    Effect.gen(function* () {
      const { settingsPath } = yield* ServerConfig.ServerConfig;
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      NodeFS.writeFileSync(settingsPath, BROKEN);
      yield* settings.getRawSettings;
      const { emitted } = yield* withEmits(settings.updateSettings({ queueSlotsImport: Q }));
      assert.equal(NodeFS.readFileSync(settingsPath, "utf8"), BROKEN);
      assert.equal(emitted.length, 0);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("5: a file changed on disk since the cache loaded is not rewritten", () =>
    Effect.gen(function* () {
      const { settingsPath } = yield* ServerConfig.ServerConfig;
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      NodeFS.writeFileSync(settingsPath, '{"enableAgentDeviceAccess": true}\n');
      yield* settings.getRawSettings;
      const external = '{"enableAgentDeviceAccess": true, "allowSpendingCredits": false}\n';
      NodeFS.writeFileSync(settingsPath, external);
      const { result, emitted } = yield* withEmits(
        Effect.flip(settings.updateSettings({ queueSlots: { slots: 4 } })),
      );
      assert.include(result.message, "queue change was not saved");
      assert.equal(NodeFS.readFileSync(settingsPath, "utf8"), external);
      assert.equal(emitted.length, 0);
    }).pipe(Effect.provide(layer())),
  );

  it.effect(
    "6: a mixed patch on a broken file writes the other key as before, without the queue",
    () =>
      Effect.gen(function* () {
        const { settingsPath } = yield* ServerConfig.ServerConfig;
        const settings = yield* ServerSettingsModule.ServerSettingsService;
        NodeFS.writeFileSync(settingsPath, BROKEN);
        yield* settings.getRawSettings;
        const result = yield* settings.updateSettings({
          queueSlots: { slots: 2 },
          cursorKeychainUsageEnabled: true,
        });
        // Pins today's behaviour for a non-queue key: the broken file is replaced.
        const written = fileJson(settingsPath);
        assert.isTrue(written.cursorKeychainUsageEnabled);
        assert.notProperty(written, "queueSlots");
        assert.isUndefined(result.queueSlots);
      }).pipe(Effect.provide(layer())),
  );

  it.effect("7 (I11): an import keeps a history-enabled provider enabled", () =>
    Effect.gen(function* () {
      const { settingsPath } = yield* ServerConfig.ServerConfig;
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id, status, provider_name, provider_instance_id, updated_at
        )
        VALUES ('thread-cursor', 'ready', 'cursor', 'cursor', '2026-08-25T00:00:00.000Z')
      `;
      NodeFS.writeFileSync(settingsPath, '{"enableAgentDeviceAccess": true}\n');
      yield* settings.getRawSettings;
      yield* settings.updateSettings({ queueSlotsImport: Q });
      assert.isTrue((yield* settings.getSettings).providers.cursor.enabled);
      assert.notEqual(fileJson(settingsPath).providers?.cursor?.enabled, false);
      assert.deepEqual(fileJson(settingsPath).queueSlots, Q);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("8: after a rescan picks up an external change, a queue write is accepted", () =>
    Effect.gen(function* () {
      const { settingsPath } = yield* ServerConfig.ServerConfig;
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      NodeFS.writeFileSync(settingsPath, '{"enableAgentDeviceAccess": true}\n');
      yield* settings.getRawSettings;
      NodeFS.writeFileSync(
        settingsPath,
        '{"enableAgentDeviceAccess": true, "allowSpendingCredits": false}\n',
      );
      yield* settings.rescan;
      // The client pairs a partial patch with its whole local value; a partial onto none fails normalize.
      yield* settings.updateSettings({ queueSlotsImport: Q, queueSlots: { slots: 4 } });
      const written = fileJson(settingsPath);
      assert.equal(written.queueSlots.slots, 4);
      assert.isFalse(written.allowSpendingCredits);
    }).pipe(Effect.provide(layer())),
  );

  it.effect(
    "9: a hold at 0 on a file the rescan saw broken fails instead of keeping the old value",
    () =>
      Effect.gen(function* () {
        const { settingsPath } = yield* ServerConfig.ServerConfig;
        const settings = yield* ServerSettingsModule.ServerSettingsService;
        NodeFS.writeFileSync(
          settingsPath,
          '{"queueSlots":{"slots":3,"perProvider":false,"providerSlots":{}}}\n',
        );
        yield* settings.getRawSettings;
        NodeFS.writeFileSync(settingsPath, BROKEN);
        yield* settings.rescan;
        const held = { slots: 0, perProvider: false, providerSlots: {} };
        const error = yield* Effect.flip(
          settings.updateSettings({ queueSlotsImport: held, queueSlots: { slots: 0 } }),
        );
        assert.equal(error._tag, "ServerSettingsError");
        assert.include(error.message, "queue change was not saved");
        assert.equal(NodeFS.readFileSync(settingsPath, "utf8"), BROKEN);
      }).pipe(Effect.provide(layer())),
  );

  it.effect("10: a refused import-only patch still succeeds", () =>
    Effect.gen(function* () {
      const { settingsPath } = yield* ServerConfig.ServerConfig;
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      NodeFS.writeFileSync(
        settingsPath,
        '{"queueSlots":{"slots":3,"perProvider":false,"providerSlots":{}}}\n',
      );
      yield* settings.getRawSettings;
      NodeFS.writeFileSync(settingsPath, BROKEN);
      yield* settings.rescan;
      const result = yield* settings.updateSettings({ queueSlotsImport: Q });
      assert.equal(result.queueSlots?.slots, 3);
      assert.equal(NodeFS.readFileSync(settingsPath, "utf8"), BROKEN);
    }).pipe(Effect.provide(layer())),
  );
});
