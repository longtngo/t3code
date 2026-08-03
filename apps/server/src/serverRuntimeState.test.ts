import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";

import * as ServerRuntimeState from "./serverRuntimeState.ts";

const isServerRuntimeStateError = Schema.is(ServerRuntimeState.ServerRuntimeStateError);

interface CapturedLog {
  readonly message: unknown;
  readonly annotations: Readonly<Record<string, unknown>>;
  readonly level?: string;
}

describe("serverRuntimeState", () => {
  it.effect("persists and reads the runtime state", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const statePath = path.join(root, "runtime", "server.json");
      const state: ServerRuntimeState.PersistedServerRuntimeState = {
        version: 1,
        pid: 123,
        host: "127.0.0.1",
        port: 4_971,
        origin: "http://127.0.0.1:4971",
        devUrl: "http://localhost:5733/",
        startedAt: "2026-06-20T00:00:00.000Z",
      };

      yield* ServerRuntimeState.persistServerRuntimeState({ path: statePath, state });
      const restored = yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath);

      assert.deepEqual(Option.getOrThrow(restored), state);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("records the dev web URL when the server fronts a dev server", () =>
    Effect.gen(function* () {
      const state = yield* ServerRuntimeState.makePersistedServerRuntimeState({
        config: { host: undefined, devUrl: new URL("http://localhost:5733") },
        port: 13_773,
      });

      assert.equal(state.devUrl, "http://localhost:5733/");
      assert.equal(state.origin, "http://127.0.0.1:13773");

      const withoutDev = yield* ServerRuntimeState.makePersistedServerRuntimeState({
        config: { host: undefined, devUrl: undefined },
        port: 13_773,
      });
      assert.isFalse("devUrl" in withoutDev);
    }),
  );

  it.effect("treats a missing runtime state file as absent", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });

      const restored = yield* ServerRuntimeState.readPersistedServerRuntimeState(
        path.join(root, "missing.json"),
      );

      assert.isTrue(Option.isNone(restored));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves malformed state decode failures", () => {
    const logs: CapturedLog[] = [];
    const logger = Logger.make(({ fiber, message }) => {
      logs.push({
        message,
        annotations: fiber.getRef(References.CurrentLogAnnotations),
      });
    });

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const statePath = path.join(root, "server.json");
      yield* fileSystem.writeFileString(statePath, "{not json");

      const restored = yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath);

      assert.isTrue(Option.isNone(restored));
      assert.equal(logs[0]?.message, `Failed to decode server runtime state at ${statePath}.`);
      const error = logs[0]?.annotations.cause;
      assert.isTrue(isServerRuntimeStateError(error));
      if (isServerRuntimeStateError(error)) {
        assert.equal(error.operation, "decode");
        assert.equal(error.statePath, statePath);
        assert.equal(error.message, `Failed to decode server runtime state at ${statePath}.`);
        assert.deepInclude(error.cause, { _tag: "SchemaError" });
      }
    }).pipe(
      Effect.provide(
        Layer.merge(NodeServices.layer, Logger.layer([logger], { mergeWithExisting: false })),
      ),
    );
  });

  it.effect("preserves runtime state read failures", () => {
    const logs: CapturedLog[] = [];
    const logger = Logger.make(({ fiber, message }) => {
      logs.push({
        message,
        annotations: fiber.getRef(References.CurrentLogAnnotations),
      });
    });

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const statePath = path.join(root, "server.json");
      yield* fileSystem.makeDirectory(statePath);

      const restored = yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath);

      assert.isTrue(Option.isNone(restored));
      assert.equal(logs[0]?.message, `Failed to read server runtime state at ${statePath}.`);
      const error = logs[0]?.annotations.cause;
      assert.isTrue(isServerRuntimeStateError(error));
      if (isServerRuntimeStateError(error)) {
        assert.equal(error.operation, "read");
        assert.equal(error.statePath, statePath);
        assert.equal(error.message, `Failed to read server runtime state at ${statePath}.`);
        assert.deepInclude(error.cause, { _tag: "PlatformError" });
      }
    }).pipe(
      Effect.provide(
        Layer.merge(NodeServices.layer, Logger.layer([logger], { mergeWithExisting: false })),
      ),
    );
  });

  it.effect("preserves runtime state persistence failures", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const blockedDirectory = path.join(root, "not-a-directory");
      const statePath = path.join(blockedDirectory, "server.json");
      yield* fileSystem.writeFileString(blockedDirectory, "blocked");

      const error = yield* ServerRuntimeState.persistServerRuntimeState({
        path: statePath,
        state: {
          version: 1,
          pid: 123,
          port: 4_971,
          origin: "http://127.0.0.1:4971",
          startedAt: "2026-06-20T00:00:00.000Z",
        },
      }).pipe(Effect.flip);

      assert.isTrue(isServerRuntimeStateError(error));
      if (isServerRuntimeStateError(error)) {
        assert.equal(error.operation, "persist");
        assert.equal(error.statePath, statePath);
        assert.equal(error.message, `Failed to persist server runtime state at ${statePath}.`);
        assert.deepInclude(error.cause, { _tag: "PlatformError" });
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("diagnosePreviousShutdown", () => {
  const state = (
    overrides: Partial<ServerRuntimeState.PersistedServerRuntimeState> = {},
  ): ServerRuntimeState.PersistedServerRuntimeState => ({
    version: 1,
    pid: 4_242,
    port: 13_773,
    origin: "http://127.0.0.1:13773",
    startedAt: "2026-08-03T00:00:00.000Z",
    ...overrides,
  });

  const nowEpochMillis = Date.parse("2026-08-03T01:00:00.000Z");
  const dead = () => false;
  const alive = () => true;

  it("reports a clean shutdown when the previous process cleared its state file", () => {
    const diagnosis = ServerRuntimeState.diagnosePreviousShutdown({
      previous: Option.none(),
      currentPid: 1,
      nowEpochMillis,
      isProcessAlive: dead,
    });

    assert.deepEqual(diagnosis, { _tag: "clean" });
  });

  it("reports a concurrent server when the recorded pid is still alive", () => {
    const diagnosis = ServerRuntimeState.diagnosePreviousShutdown({
      previous: Option.some(state()),
      currentPid: 1,
      nowEpochMillis,
      isProcessAlive: alive,
    });

    assert.deepEqual(diagnosis, { _tag: "concurrent", pid: 4_242 });
  });

  it("treats our own leftover state file as clean rather than a crash", () => {
    const diagnosis = ServerRuntimeState.diagnosePreviousShutdown({
      previous: Option.some(state({ pid: 7 })),
      currentPid: 7,
      nowEpochMillis,
      isProcessAlive: dead,
    });

    assert.deepEqual(diagnosis, { _tag: "clean" });
  });

  it("reports an unclean shutdown when a dead process left its state file behind", () => {
    const diagnosis = ServerRuntimeState.diagnosePreviousShutdown({
      previous: Option.some(state()),
      currentPid: 1,
      nowEpochMillis,
      isProcessAlive: dead,
    });

    assert.deepEqual(diagnosis, {
      _tag: "unclean",
      pid: 4_242,
      startedAt: "2026-08-03T00:00:00.000Z",
      previousBootAgeMillis: 3_600_000,
      crashLoopSuspected: false,
    });
  });

  it("suspects a crash loop when the previous boot died young", () => {
    const diagnosis = ServerRuntimeState.diagnosePreviousShutdown({
      previous: Option.some(state({ startedAt: "2026-08-03T00:58:00.000Z" })),
      currentPid: 1,
      nowEpochMillis,
      isProcessAlive: dead,
    });

    assert.deepInclude(diagnosis, { _tag: "unclean", crashLoopSuspected: true });
  });

  it("does not suspect a crash loop right at the uptime threshold", () => {
    const diagnosis = ServerRuntimeState.diagnosePreviousShutdown({
      previous: Option.some(state({ startedAt: "2026-08-03T00:55:00.000Z" })),
      currentPid: 1,
      nowEpochMillis,
      isProcessAlive: dead,
    });

    assert.deepInclude(diagnosis, {
      _tag: "unclean",
      previousBootAgeMillis: ServerRuntimeState.crashLoopUptimeThresholdMillis,
      crashLoopSuspected: false,
    });
  });

  it("claims no uptime, and no crash loop, when the recorded start time is unusable", () => {
    const diagnosis = ServerRuntimeState.diagnosePreviousShutdown({
      previous: Option.some(state({ startedAt: "not-a-timestamp" })),
      currentPid: 1,
      nowEpochMillis,
      isProcessAlive: dead,
    });

    assert.deepInclude(diagnosis, {
      _tag: "unclean",
      previousBootAgeMillis: undefined,
      crashLoopSuspected: false,
    });
  });

  it("clamps a start time in the future instead of reporting negative uptime", () => {
    const diagnosis = ServerRuntimeState.diagnosePreviousShutdown({
      previous: Option.some(state({ startedAt: "2026-08-03T02:00:00.000Z" })),
      currentPid: 1,
      nowEpochMillis,
      isProcessAlive: dead,
    });

    assert.deepInclude(diagnosis, { _tag: "unclean", previousBootAgeMillis: 0 });
  });
});

describe("reportPreviousShutdown", () => {
  const captureLogs = () => {
    const logs: Array<CapturedLog> = [];
    const logger = Logger.make(({ fiber, logLevel, message }) => {
      logs.push({
        message,
        annotations: fiber.getRef(References.CurrentLogAnnotations),
        level: logLevel,
      });
    });
    return { logs, layer: Logger.layer([logger], { mergeWithExisting: false }) };
  };

  /**
   * Ages the recorded start time against the effect's own clock, which
   * `it.effect` starts at the epoch — a wall-clock timestamp would read as
   * being in the future and clamp to zero.
   */
  const writeStaleState = Effect.fn(function* (bootAgeMillis: number) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const now = yield* DateTime.now;
    const startedAt = DateTime.formatIso(DateTime.subtract(now, { milliseconds: bootAgeMillis }));
    const root = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-previous-shutdown-test-",
    });
    const statePath = path.join(root, "server-runtime.json");
    yield* ServerRuntimeState.persistServerRuntimeState({
      path: statePath,
      state: {
        version: 1,
        pid: 4_242,
        port: 13_773,
        origin: "http://127.0.0.1:13773",
        startedAt,
      },
    });
    return { statePath, startedAt };
  });

  it.effect("stays quiet when the previous process shut down cleanly", () => {
    const { logs, layer } = captureLogs();

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-previous-shutdown-test-",
      });

      const diagnosis = yield* ServerRuntimeState.reportPreviousShutdown({
        path: path.join(root, "server-runtime.json"),
        isProcessAlive: () => false,
      });

      assert.deepEqual(diagnosis, { _tag: "clean" });
      assert.deepEqual(logs, []);
    }).pipe(Effect.provide(Layer.merge(NodeServices.layer, layer)));
  });

  it.effect("warns when a dead process left its state file behind", () => {
    const { logs, layer } = captureLogs();

    return Effect.gen(function* () {
      const { statePath, startedAt } = yield* writeStaleState(30 * 60 * 1_000);

      yield* ServerRuntimeState.reportPreviousShutdown({
        path: statePath,
        isProcessAlive: () => false,
      });

      assert.equal(logs.length, 1);
      assert.equal(logs[0]?.message, "server.boot.previous-shutdown-unclean");
      assert.equal(logs[0]?.level, "Warn");
      assert.deepInclude(logs[0]?.annotations, {
        previousPid: 4_242,
        previousStartedAt: startedAt,
        previousBootAgeSeconds: 1_800,
      });
    }).pipe(Effect.provide(Layer.merge(NodeServices.layer, layer)));
  });

  it.effect("escalates to an error when the previous boot died young", () => {
    const { logs, layer } = captureLogs();

    return Effect.gen(function* () {
      const { statePath } = yield* writeStaleState(45 * 1_000);

      yield* ServerRuntimeState.reportPreviousShutdown({
        path: statePath,
        isProcessAlive: () => false,
      });

      assert.equal(logs.length, 1);
      assert.equal(logs[0]?.message, "server.boot.crash-loop-suspected");
      assert.equal(logs[0]?.level, "Error");
      assert.deepInclude(logs[0]?.annotations, {
        previousPid: 4_242,
        previousBootAgeSeconds: 45,
      });
    }).pipe(Effect.provide(Layer.merge(NodeServices.layer, layer)));
  });

  it.effect("warns when another live server already owns the state file", () => {
    const { logs, layer } = captureLogs();

    return Effect.gen(function* () {
      const { statePath } = yield* writeStaleState(0);

      yield* ServerRuntimeState.reportPreviousShutdown({
        path: statePath,
        isProcessAlive: () => true,
      });

      assert.equal(logs.length, 1);
      assert.equal(logs[0]?.message, "server.boot.state-file-owned-by-live-process");
      assert.equal(logs[0]?.level, "Warn");
      assert.deepInclude(logs[0]?.annotations, { previousPid: 4_242 });
    }).pipe(Effect.provide(Layer.merge(NodeServices.layer, layer)));
  });
});
