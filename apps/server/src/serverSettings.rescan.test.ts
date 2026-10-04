// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import * as ServerSettingsModule from "./serverSettings.ts";

const logs: Array<string> = [];
const capture = Logger.make(({ message }) => {
  logs.push(Array.isArray(message) ? String(message[0]) : String(message));
});

const layer = () =>
  ServerSettingsModule.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
    Layer.provideMerge(
      Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3-rescan-" })),
    ),
    Layer.provideMerge(Logger.layer([capture], { mergeWithExisting: false })),
  );

const count = (needle: string) => logs.filter((line) => line.includes(needle)).length;

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

it.layer(NodeServices.layer)("settings rescan", (it) => {
  it.effect("I1: delivers a file change with no watch event", () =>
    Effect.gen(function* () {
      logs.length = 0;
      const { settingsPath } = yield* ServerConfig.ServerConfig;
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      yield* settings.getRawSettings;
      NodeFS.writeFileSync(settingsPath, '{"enableAgentDeviceAccess": true}\n');
      const { emitted } = yield* withEmits(settings.rescan);
      assert.equal(emitted.length, 1);
      assert.isTrue((yield* settings.getRawSettings).enableAgentDeviceAccess);
      assert.equal(count("watch rescan applied a change the file watcher had not delivered"), 1);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("I2 + I7: unchanged file emits nothing; a broken file warns once over 5 ticks", () =>
    Effect.gen(function* () {
      logs.length = 0;
      const { settingsPath } = yield* ServerConfig.ServerConfig;
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      NodeFS.writeFileSync(settingsPath, '{"enableAgentDeviceAccess": true}\n');
      yield* settings.rescan;
      const unchanged = yield* withEmits(Effect.all([settings.rescan, settings.rescan]));
      assert.equal(unchanged.emitted.length, 0);
      NodeFS.writeFileSync(settingsPath, "{");
      const broken = yield* withEmits(
        Effect.all([
          settings.rescan,
          settings.rescan,
          settings.rescan,
          settings.rescan,
          settings.rescan,
        ]),
      );
      assert.equal(broken.emitted.length, 0);
      assert.equal(count("failed to parse settings.json"), 1);
      // I6: last good value kept
      assert.isTrue((yield* settings.getRawSettings).enableAgentDeviceAccess);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("I5 + I9: a directory at the path warns once, keeps the cache, recovers once", () =>
    Effect.gen(function* () {
      logs.length = 0;
      const { settingsPath } = yield* ServerConfig.ServerConfig;
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      NodeFS.writeFileSync(settingsPath, '{"enableAgentDeviceAccess": true}\n');
      yield* settings.rescan;
      NodeFS.rmSync(settingsPath);
      NodeFS.mkdirSync(settingsPath);
      yield* Effect.all([settings.rescan, settings.rescan, settings.rescan]);
      assert.equal(count("settings file unreadable"), 1);
      assert.isTrue((yield* settings.getRawSettings).enableAgentDeviceAccess);
      NodeFS.rmdirSync(settingsPath);
      NodeFS.writeFileSync(settingsPath, '{"enableAgentDeviceAccess": false}\n');
      const { emitted } = yield* withEmits(settings.rescan);
      assert.equal(count("settings file readable again"), 1);
      assert.equal(emitted.length, 1);
      // The latch is re-armed: a second healthy tick stays quiet, and a new outage warns again.
      yield* settings.rescan;
      assert.equal(count("settings file readable again"), 1);
      NodeFS.rmSync(settingsPath);
      NodeFS.mkdirSync(settingsPath);
      yield* Effect.all([settings.rescan, settings.rescan]);
      assert.equal(count("settings file unreadable"), 2);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("rewriting the same value with different formatting emits and logs nothing", () =>
    Effect.gen(function* () {
      logs.length = 0;
      const { settingsPath } = yield* ServerConfig.ServerConfig;
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      NodeFS.writeFileSync(settingsPath, '{"enableAgentDeviceAccess": true}\n');
      yield* settings.rescan;
      logs.length = 0;
      NodeFS.writeFileSync(settingsPath, '{\n  "enableAgentDeviceAccess":   true\n}\n');
      const { emitted } = yield* withEmits(settings.rescan);
      assert.equal(emitted.length, 0);
      assert.equal(count("watch rescan applied a change the file watcher had not delivered"), 0);
    }).pipe(Effect.provide(layer())),
  );

  it.effect(
    "the boot lookup's Bitbucket migration forgets the old bytes, so a restore re-migrates",
    () =>
      Effect.gen(function* () {
        const { settingsPath } = yield* ServerConfig.ServerConfig;
        const settings = yield* ServerSettingsModule.ServerSettingsService;
        const inline = '{"bitbucket":{"accessToken":"plain-token-xyz"}}\n';
        NodeFS.mkdirSync(NodePath.dirname(settingsPath), { recursive: true });
        NodeFS.writeFileSync(settingsPath, inline);
        yield* settings.getRawSettings;
        assert.notInclude(NodeFS.readFileSync(settingsPath, "utf8"), "plain-token-xyz");
        NodeFS.writeFileSync(settingsPath, inline);
        yield* settings.rescan;
        assert.notInclude(NodeFS.readFileSync(settingsPath, "utf8"), "plain-token-xyz");
      }).pipe(Effect.provide(layer())),
  );

  it.effect("after a failed start, a broken file warns once and a valid file emits once", () =>
    Effect.gen(function* () {
      logs.length = 0;
      const { settingsPath } = yield* ServerConfig.ServerConfig;
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      NodeFS.rmSync(settingsPath, { force: true });
      NodeFS.mkdirSync(settingsPath);
      const started = yield* Effect.exit(settings.start);
      assert.isTrue(started._tag === "Failure");
      NodeFS.rmdirSync(settingsPath);
      NodeFS.writeFileSync(settingsPath, "{");
      const broken = yield* withEmits(
        Effect.all([settings.rescan, settings.rescan, settings.rescan, settings.rescan]),
      );
      assert.equal(broken.emitted.length, 0);
      assert.equal(count("failed to parse settings.json"), 1);
      NodeFS.writeFileSync(settingsPath, '{"enableAgentDeviceAccess": true}\n');
      const { emitted } = yield* withEmits(settings.rescan);
      assert.equal(emitted.length, 1);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("I3 + I8: updateSettings emits once; a following rescan emits and logs nothing", () =>
    Effect.gen(function* () {
      logs.length = 0;
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      yield* settings.getRawSettings;
      const { emitted } = yield* withEmits(
        Effect.gen(function* () {
          yield* Effect.all(
            [settings.updateSettings({ enableAgentDeviceAccess: true }), settings.rescan],
            {
              concurrency: "unbounded",
            },
          );
          yield* settings.rescan;
        }),
      );
      assert.equal(emitted.length, 1);
      assert.equal(count("watch rescan applied a change the file watcher had not delivered"), 0);
      assert.isTrue((yield* settings.getRawSettings).enableAgentDeviceAccess);
    }).pipe(Effect.provide(layer())),
  );
  it.effect("a self-write forgets the old bytes, so restoring them is applied", () =>
    Effect.gen(function* () {
      const { settingsPath } = yield* ServerConfig.ServerConfig;
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      const first = '{"enableAgentDeviceAccess": true}\n';
      NodeFS.writeFileSync(settingsPath, first);
      yield* settings.rescan;
      yield* settings.updateSettings({ enableAgentDeviceAccess: false });
      NodeFS.writeFileSync(settingsPath, first);
      const { emitted } = yield* withEmits(settings.rescan);
      assert.equal(emitted.length, 1);
      assert.isTrue((yield* settings.getRawSettings).enableAgentDeviceAccess);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("the Bitbucket migration write forgets the old bytes, so a restore re-migrates", () =>
    Effect.gen(function* () {
      const { settingsPath } = yield* ServerConfig.ServerConfig;
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      yield* settings.getRawSettings;
      const inline = '{"bitbucket":{"accessToken":"plain-token-xyz"}}\n';
      NodeFS.writeFileSync(settingsPath, inline);
      yield* settings.rescan;
      assert.notInclude(NodeFS.readFileSync(settingsPath, "utf8"), "plain-token-xyz");
      NodeFS.writeFileSync(settingsPath, inline);
      yield* settings.rescan;
      assert.notInclude(NodeFS.readFileSync(settingsPath, "utf8"), "plain-token-xyz");
    }).pipe(Effect.provide(layer())),
  );

  it.effect("a failed migration write is retried on every tick until it lands", () =>
    Effect.gen(function* () {
      logs.length = 0;
      const { settingsPath } = yield* ServerConfig.ServerConfig;
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      yield* settings.getRawSettings;
      const settingsDir = NodePath.dirname(settingsPath);
      NodeFS.writeFileSync(settingsPath, '{"bitbucket":{"accessToken":"plain-token-xyz"}}\n');
      yield* Effect.acquireRelease(
        Effect.sync(() => NodeFS.chmodSync(settingsDir, 0o555)),
        () => Effect.sync(() => NodeFS.chmodSync(settingsDir, 0o755)),
      );
      yield* settings.rescan;
      yield* settings.rescan;
      assert.equal(count("settings refresh failed"), 2);
      NodeFS.chmodSync(settingsDir, 0o755);
      yield* settings.rescan;
      assert.notInclude(NodeFS.readFileSync(settingsPath, "utf8"), "plain-token-xyz");
    }).pipe(Effect.scoped, Effect.provide(layer())),
  );

  // Fails before any write, so only the reset on a failed decode can make the next tick retry.
  it.effect("a refresh that fails before writing is retried on every tick", () =>
    Effect.gen(function* () {
      logs.length = 0;
      const { settingsPath } = yield* ServerConfig.ServerConfig;
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      const sql = yield* SqlClient.SqlClient;
      yield* settings.getRawSettings;
      NodeFS.writeFileSync(settingsPath, '{"enableAgentDeviceAccess": true}\n');
      yield* sql`ALTER TABLE projection_thread_sessions RENAME TO hidden_sessions`;
      yield* settings.rescan;
      yield* settings.rescan;
      assert.equal(count("settings refresh failed"), 2);
      yield* sql`ALTER TABLE hidden_sessions RENAME TO projection_thread_sessions`;
      const { emitted } = yield* withEmits(settings.rescan);
      assert.equal(emitted.length, 1);
      assert.isTrue((yield* settings.getRawSettings).enableAgentDeviceAccess);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("the timer skips a missing file; a recreated file is applied once", () =>
    Effect.gen(function* () {
      const { settingsPath } = yield* ServerConfig.ServerConfig;
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      NodeFS.writeFileSync(settingsPath, '{"enableAgentDeviceAccess": true}\n');
      yield* settings.rescan;
      NodeFS.rmSync(settingsPath);
      const missing = yield* withEmits(Effect.all([settings.rescan, settings.rescan]));
      assert.equal(missing.emitted.length, 0);
      assert.isTrue((yield* settings.getRawSettings).enableAgentDeviceAccess);
      NodeFS.writeFileSync(settingsPath, '{"enableAgentDeviceAccess": false}\n');
      const recreated = yield* withEmits(settings.rescan);
      assert.equal(recreated.emitted.length, 1);
      assert.isFalse((yield* settings.getRawSettings).enableAgentDeviceAccess);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("a cache reload outside refresh does not strand the timer", () =>
    Effect.gen(function* () {
      const { settingsPath } = yield* ServerConfig.ServerConfig;
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      NodeFS.writeFileSync(settingsPath, '{"enableAgentDeviceAccess": true}\n');
      yield* settings.rescan;
      NodeFS.writeFileSync(settingsPath, '{"enableAgentDeviceAccess": false}\n');
      yield* settings.start; // invalidate + lookup outside refresh
      assert.isFalse((yield* settings.getRawSettings).enableAgentDeviceAccess);
      NodeFS.writeFileSync(settingsPath, '{"enableAgentDeviceAccess": true}\n');
      yield* settings.rescan;
      assert.isTrue((yield* settings.getRawSettings).enableAgentDeviceAccess);
    }).pipe(Effect.provide(layer())),
  );
});

// The watch path (refresh(false)) publishes an untrusted file's defaults; only the timer skips it.
// macOS drops watch events under load, so keep rewriting the file until one event gets through.
it.live("a watch event applies an untrusted file the timer would skip", () =>
  Effect.gen(function* () {
    const { settingsPath } = yield* ServerConfig.ServerConfig;
    const settings = yield* ServerSettingsModule.ServerSettingsService;
    NodeFS.mkdirSync(NodePath.dirname(settingsPath), { recursive: true });
    NodeFS.writeFileSync(settingsPath, '{"enableAgentDeviceAccess": true}\n');
    yield* settings.start;
    assert.isTrue((yield* settings.getRawSettings).enableAgentDeviceAccess);
    const changes = yield* settings.subscribeChanges;
    const seen = yield* Queue.unbounded<unknown>();
    yield* changes.pipe(
      Stream.runForEach((s) => Queue.offer(seen, s)),
      Effect.forkScoped,
    );
    yield* Effect.raceFirst(
      Queue.take(seen),
      Effect.forever(
        Effect.andThen(
          Effect.sleep("300 millis"),
          Effect.sync(() => NodeFS.writeFileSync(settingsPath, "{")),
        ),
      ),
    ).pipe(
      // Surviving events arrive many seconds late under load; stays under the 120 s test timeout.
      Effect.timeout("90 seconds"),
    );
    assert.isFalse((yield* settings.getRawSettings).enableAgentDeviceAccess);
  }).pipe(Effect.scoped, Effect.provide(Layer.provideMerge(layer(), NodeServices.layer))),
);
