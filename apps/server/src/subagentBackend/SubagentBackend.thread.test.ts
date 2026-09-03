// @effect-diagnostics nodeBuiltinImport:off - builds a real tmpdir HOME so the fixed on-disk flag-file path is exercised for real.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { ProviderInstanceId, type ServerSettings, ThreadId } from "@t3tools/contracts";

import { ServerConfig, layerTest as serverConfigLayerTest } from "../config.ts";
import { ProviderAdapterRegistry } from "../provider/Services/ProviderAdapterRegistry.ts";
import { ServerSettingsService, layerTest as serverSettingsLayerTest } from "../serverSettings.ts";
import {
  OFF,
  type PersistedBackend,
  readBackendFile,
  readThreadBackendFile,
  reconcileAllBackends,
  resolveThreadBackend,
  setBackend,
  subagentBackendReconciler,
  writeBackendFile,
  writeThreadBackendFile,
  writeThreadBackendForSession,
} from "./SubagentBackend.ts";
import { threadBackendFileName } from "./ThreadBackendPath.ts";

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.HOME;
  home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sbt-thread-home-"));
  process.env.HOME = home;
});
afterEach(() => {
  if (previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }
});

const t1 = ThreadId.make("t1");

const CURSOR: PersistedBackend = {
  schemaVersion: 1,
  backend: "cursor",
  instanceId: "cursor",
  model: "sonnet",
  binaryPath: "/tmp/agent",
  apiEndpoint: "",
  updatedAt: null,
  degraded: null,
};

function settings(input: {
  enabled?: boolean;
  modes?: Record<string, "inherit" | "on" | "off">;
  cursor?: boolean;
}): ServerSettings {
  return {
    subagentBackendEnabled: input.enabled ?? true,
    subagentBackendThreadModes: input.modes ?? {},
    providerInstances:
      input.cursor === false
        ? {}
        : {
            cursor: {
              driver: "cursor",
              displayName: "UniSub",
              enabled: true,
              config: { binaryPath: "/tmp/agent", apiEndpoint: "" },
            },
          },
  } as unknown as ServerSettings;
}

describe("resolveThreadBackend", () => {
  it.layer(NodeServices.layer)("resolveThreadBackend", (it) => {
    it.effect("master off forces default whatever the thread asks", () =>
      Effect.gen(function* () {
        const r = yield* resolveThreadBackend({
          settings: settings({ enabled: false, modes: { t1: "on" } }),
          threadId: t1,
          global: CURSOR,
        });
        expect(r.backend).toBe("default");
        expect(r.degraded).toContain("switched off");
      }),
    );

    it.effect("absent and inherit both return the global record unchanged", () =>
      Effect.gen(function* () {
        const absent = yield* resolveThreadBackend({
          settings: settings({}),
          threadId: t1,
          global: CURSOR,
        });
        const inherit = yield* resolveThreadBackend({
          settings: settings({ modes: { t1: "inherit" } }),
          threadId: t1,
          global: CURSOR,
        });
        expect(absent).toBe(CURSOR);
        expect(inherit).toBe(CURSOR);
      }),
    );

    it.effect("off is default even when the global is cursor", () =>
      Effect.gen(function* () {
        const r = yield* resolveThreadBackend({
          settings: settings({ modes: { t1: "off" } }),
          threadId: t1,
          global: CURSOR,
        });
        expect(r).toEqual(OFF);
      }),
    );

    it.effect("on with a cursor global reuses the global (model included)", () =>
      Effect.gen(function* () {
        const r = yield* resolveThreadBackend({
          settings: settings({ modes: { t1: "on" } }),
          threadId: t1,
          global: CURSOR,
        });
        expect(r).toBe(CURSOR);
      }),
    );

    it.effect("on with a default global resolves the first enabled cursor instance", () =>
      Effect.gen(function* () {
        const r = yield* resolveThreadBackend({
          settings: settings({ modes: { t1: "on" } }),
          threadId: t1,
          global: OFF,
        });
        expect(r.backend).toBe("cursor");
        expect(r.instanceId).toBe("cursor");
        expect(r.model).toBe("auto");
      }),
    );

    it.effect("an inherited Object.prototype key is not an override", () =>
      Effect.gen(function* () {
        // Thread ids are client-generated and unconstrained, so the map lookup must not
        // walk the prototype chain: `{}["constructor"]` is a function. The `mode !== "on"`
        // shape already rejects it, so `Object.hasOwn` is belt-and-braces here; this pins
        // the outcome so a future `=== "inherit"`-style rewrite cannot regress it.
        for (const id of ["constructor", "__proto__", "toString", "valueOf"]) {
          const r = yield* resolveThreadBackend({
            settings: settings({}),
            threadId: ThreadId.make(id),
            global: OFF,
          });
          expect(r).toBe(OFF);
        }
      }),
    );

    it.effect("on with no cursor instance degrades to default with a reason", () =>
      Effect.gen(function* () {
        const r = yield* resolveThreadBackend({
          settings: settings({ modes: { t1: "on" }, cursor: false }),
          threadId: t1,
          global: OFF,
        });
        expect(r.backend).toBe("default");
        expect(r.degraded).toContain("Cursor instance");
      }),
    );
  });
});

/** Registry double: every listed instance answers `listSessions` with the given thread ids,
 * except an instance whose id starts with "dead", which dies — the adapter crash the
 * per-adapter isolation exists for. */
function registryLayer(sessions: Record<string, ReadonlyArray<string>>) {
  const ids = Object.keys(sessions).map((id) => ProviderInstanceId.make(id));
  return Layer.mock(ProviderAdapterRegistry)({
    listInstances: () => Effect.succeed(ids),
    getByInstance: (id) =>
      Effect.succeed({
        listSessions: () =>
          id.startsWith("dead")
            ? Effect.die(new Error("adapter binding mismatch"))
            : Effect.succeed(
                (sessions[id] ?? []).map((threadId) => ({ threadId: ThreadId.make(threadId) })),
              ),
      } as never),
  });
}

/** Registry double whose very first step dies — the thread fan-out crashing after the
 * global file has already been written. */
const dyingRegistryLayer = Layer.mock(ProviderAdapterRegistry)({
  listInstances: () => Effect.die(new Error("registry is down")),
});

/** `ServerSettingsService` double whose settings read dies, to fail a write from inside. */
const dyingSettingsLayer = Layer.mock(ServerSettingsService)({
  getRawSettings: Effect.die(new Error("settings are unreadable")),
});

const cursorSettings = {
  providerInstances: {
    cursor: {
      driver: "cursor",
      displayName: "UniSub",
      enabled: true,
      config: { binaryPath: "/tmp/agent", apiEndpoint: "" },
    },
  },
};

describe("thread flag files", () => {
  it.layer(NodeServices.layer)("thread flag files", (it) => {
    const withLayers = (
      sessions: Record<string, ReadonlyArray<string>>,
      overrides: Parameters<typeof serverSettingsLayerTest>[0],
    ) =>
      Layer.mergeAll(
        registryLayer(sessions),
        serverConfigLayerTest("/tmp", { prefix: "sbt-thread-" }),
        serverSettingsLayerTest(overrides),
      );

    it.effect("writes a 0600 file inside the threads dir, and reads it back", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { subagentThreadsDir } = yield* ServerConfig;
        yield* writeThreadBackendFile(subagentThreadsDir, t1, CURSOR);
        const info = yield* fs.stat(`${subagentThreadsDir}/${threadBackendFileName(t1)}`);
        expect(Number(info.mode) & 0o777).toBe(0o600);
        const back = yield* readThreadBackendFile(subagentThreadsDir, t1);
        expect(back.backend).toBe("cursor");
        expect(back.instanceId).toBe("cursor");
      }).pipe(Effect.provide(withLayers({}, {}))),
    );

    it.effect("an unreadable file degrades with a reason, not a clean Off", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { subagentThreadsDir } = yield* ServerConfig;
        yield* writeThreadBackendFile(subagentThreadsDir, t1, CURSOR);
        const filePath = `${subagentThreadsDir}/${threadBackendFileName(t1)}`;
        yield* fs.chmod(filePath, 0o000);
        const back = yield* readThreadBackendFile(subagentThreadsDir, t1);
        // Restored before the assertions so a failing expect cannot leave the scoped
        // temp dir undeletable.
        yield* fs.chmod(filePath, 0o600);
        expect(back.backend).toBe("default");
        expect(back.degraded).toContain("could not be read");
      }).pipe(Effect.provide(withLayers({}, {}))),
    );

    it.effect("refuses an over-long name instead of failing inside mkdtemp", () =>
      Effect.gen(function* () {
        const { subagentThreadsDir } = yield* ServerConfig;
        const exit = yield* Effect.exit(
          writeThreadBackendFile(subagentThreadsDir, ThreadId.make("x".repeat(183)), CURSOR),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(String(exit)).toContain("ThreadBackendNameTooLongError");
      }).pipe(Effect.provide(withLayers({}, {}))),
    );

    it.effect("reconcileAllBackends writes every live thread and survives a dying adapter", () =>
      Effect.gen(function* () {
        yield* writeBackendFile(CURSOR);
        const { subagentThreadsDir } = yield* ServerConfig;
        yield* reconcileAllBackends();
        const a = yield* readThreadBackendFile(subagentThreadsDir, ThreadId.make("a"));
        const b = yield* readThreadBackendFile(subagentThreadsDir, ThreadId.make("b"));
        expect(a.backend).toBe("cursor");
        expect(b.backend).toBe("default");
        // The dying adapter's thread is the fail-open the isolation buys: never enumerated,
        // so never written. Asserted so "survives" cannot quietly mean "wrote everything".
        // Must assert the ABSENCE reason specifically, not merely a non-null `degraded`:
        // this pass leaves a non-null `degraded` on the files it does write (the global's
        // unresolvable binary propagates into them), so `not.toBeNull()` would hold either
        // way. `updatedAt` pins it further — every written file carries a timestamp.
        const dead = yield* readThreadBackendFile(
          subagentThreadsDir,
          ThreadId.make("never-written"),
        );
        expect(dead.degraded).toBe("No thread flag file.");
        expect(dead.updatedAt).toBeNull();
      }).pipe(
        Effect.provide(
          withLayers(
            { cursor: ["a"], deadClaude: ["never-written"], claude: ["b"] },
            // Computed key, not `{ b: ... }`: `subagentBackendThreadModes` is keyed by the
            // branded `ThreadId`, which a plain string literal key does not satisfy.
            { ...cursorSettings, subagentBackendThreadModes: { [ThreadId.make("b")]: "off" } },
          ),
        ),
      ),
    );

    it.effect("master off flips a live thread's file to default in one reconcile", () =>
      Effect.gen(function* () {
        yield* writeBackendFile(CURSOR);
        const { subagentThreadsDir } = yield* ServerConfig;
        yield* reconcileAllBackends();
        const a = yield* readThreadBackendFile(subagentThreadsDir, ThreadId.make("a"));
        expect(a.backend).toBe("default");
        expect(a.degraded).toContain("switched off");
        // The global file is NOT rewritten by the master switch: the wrapper is only ever
        // pointed at thread files from a T3 session, and the user's global choice survives.
        expect((yield* readBackendFile()).backend).toBe("cursor");
      }).pipe(
        Effect.provide(
          withLayers({ cursor: ["a"] }, { ...cursorSettings, subagentBackendEnabled: false }),
        ),
      ),
    );

    it.effect("writeThreadBackendForSession resolves inherit from the global file", () =>
      Effect.gen(function* () {
        yield* writeBackendFile(CURSOR);
        const { subagentThreadsDir } = yield* ServerConfig;
        yield* writeThreadBackendForSession(t1);
        const back = yield* readThreadBackendFile(subagentThreadsDir, t1);
        expect(back.backend).toBe("cursor");
        expect(back.model).toBe("sonnet");
      }).pipe(Effect.provide(withLayers({}, cursorSettings))),
    );

    it.effect("removes the thread's file when the session write fails", () =>
      Effect.gen(function* () {
        const { subagentThreadsDir } = yield* ServerConfig;
        // The previous session left a cursor record here. Nothing else ever removes a
        // thread file, so a failed rewrite would leave the new subprocess dispatching
        // on it.
        yield* writeThreadBackendFile(subagentThreadsDir, t1, CURSOR);
        yield* writeThreadBackendForSession(t1).pipe(Effect.provide(dyingSettingsLayer));
        const back = yield* readThreadBackendFile(subagentThreadsDir, t1);
        expect(back.degraded).toBe("No thread flag file.");
        expect(back.backend).toBe("default");
      }).pipe(Effect.provide(withLayers({}, cursorSettings))),
    );

    it.effect("removeOnFailure:false keeps the file a previous good write left behind", () =>
      Effect.gen(function* () {
        const { subagentThreadsDir } = yield* ServerConfig;
        // The post-start call rewrites a file this same session already wrote correctly.
        // Removing it on failure would delete a good file and leave the running
        // subprocess pointing at nothing.
        yield* writeThreadBackendFile(subagentThreadsDir, t1, CURSOR);
        yield* writeThreadBackendForSession(t1, { removeOnFailure: false }).pipe(
          Effect.provide(dyingSettingsLayer),
        );
        const back = yield* readThreadBackendFile(subagentThreadsDir, t1);
        expect(back.backend).toBe("cursor");
        expect(back.instanceId).toBe("cursor");
      }).pipe(Effect.provide(withLayers({}, cursorSettings))),
    );

    it.effect("setBackend fans the new global out to every live thread file", () =>
      Effect.gen(function* () {
        const { subagentThreadsDir } = yield* ServerConfig;
        yield* setBackend({ backend: "cursor", instanceId: ProviderInstanceId.make("cursor") });
        expect((yield* readThreadBackendFile(subagentThreadsDir, ThreadId.make("a"))).backend).toBe(
          "cursor",
        );
        yield* setBackend({ backend: "default" });
        expect((yield* readThreadBackendFile(subagentThreadsDir, ThreadId.make("a"))).backend).toBe(
          "default",
        );
      }).pipe(Effect.provide(withLayers({ cursor: ["a"] }, cursorSettings))),
    );

    it.effect("master off writes no thread files from setBackend", () =>
      Effect.gen(function* () {
        const { subagentThreadsDir } = yield* ServerConfig;
        yield* setBackend({ backend: "cursor", instanceId: ProviderInstanceId.make("cursor") });
        const a = yield* readThreadBackendFile(subagentThreadsDir, ThreadId.make("a"));
        // Must assert the ABSENCE reason specifically, not merely a "default" backend: a
        // written master-off file also reads back as `default`, so `backend` alone holds
        // either way. `updatedAt` pins it further — every written file carries a timestamp.
        expect(a.degraded).toBe("No thread flag file.");
        expect(a.updatedAt).toBeNull();
      }).pipe(
        Effect.provide(
          withLayers({ cursor: ["a"] }, { ...cursorSettings, subagentBackendEnabled: false }),
        ),
      ),
    );

    it.effect("keeps the saved global record when the thread fan-out dies", () =>
      Effect.gen(function* () {
        const result = yield* setBackend({
          backend: "cursor",
          instanceId: ProviderInstanceId.make("cursor"),
        });
        // The global file is already written by the time the fan-out runs, so a crash
        // there must not report the selection as unsaved.
        expect(result.backend).toBe("cursor");
        expect((yield* readBackendFile()).backend).toBe("cursor");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            dyingRegistryLayer,
            serverConfigLayerTest("/tmp", { prefix: "sbt-thread-" }),
            serverSettingsLayerTest(cursorSettings),
          ),
        ),
      ),
    );

    it.effect("the reconciler subscriber writes thread files at startup", () =>
      Effect.gen(function* () {
        yield* writeBackendFile(CURSOR);
        const { subagentThreadsDir } = yield* ServerConfig;
        yield* subagentBackendReconciler;
        const a = yield* readThreadBackendFile(subagentThreadsDir, ThreadId.make("a"));
        expect(a.backend).toBe("cursor");
      }).pipe(Effect.provide(withLayers({ cursor: ["a"] }, cursorSettings))),
    );

    it.effect("300 concurrent thread writes across 4 threads leave every file parseable", () =>
      Effect.gen(function* () {
        yield* writeBackendFile(CURSOR);
        const { subagentThreadsDir } = yield* ServerConfig;
        const ids = ["w1", "w2", "w3", "w4"].map((id) => ThreadId.make(id));
        yield* Effect.forEach(
          Array.from({ length: 300 }, (_, i) => ids[i % 4]!),
          (id) => writeThreadBackendForSession(id),
          { concurrency: "unbounded", discard: true },
        );
        for (const id of ids) {
          const back = yield* readThreadBackendFile(subagentThreadsDir, id);
          expect(back.degraded).toBeNull();
          expect(back.backend).toBe("cursor");
        }
      }).pipe(Effect.provide(withLayers({}, cursorSettings))),
    );
  });
});
