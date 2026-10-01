// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as ServerConfig from "./config.ts";
import * as Keybindings from "./keybindings.ts";

const logs: Array<string> = [];
const capture = Logger.make(({ message }) => {
  logs.push(Array.isArray(message) ? String(message[0]) : String(message));
});

const layer = () =>
  Keybindings.layer.pipe(
    Layer.provideMerge(
      Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3-kb-rescan-" })),
    ),
    Layer.provideMerge(Logger.layer([capture], { mergeWithExisting: false })),
  );

const count = (needle: string) => logs.filter((line) => line.includes(needle)).length;

const CUSTOM = '[{"key":"mod+shift+y","command":"terminal.toggle"}]\n';
const hasCustom = (state: Keybindings.KeybindingsConfigState) =>
  state.keybindings.some(
    (rule) =>
      rule.command === "terminal.toggle" &&
      rule.shortcut.key === "y" &&
      rule.shortcut.shiftKey &&
      rule.shortcut.modKey,
  );

// Collects emissions without sleeping: subscribe, act, then let the collector drain what is buffered.
const withEmits = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const keybindings = yield* Keybindings.Keybindings;
    const emitted: Array<Keybindings.KeybindingsChangeEvent> = [];
    const fiber = yield* keybindings.streamChanges.pipe(
      Stream.runForEach((event) => Effect.sync(() => emitted.push(event))),
      Effect.forkScoped,
    );
    yield* Effect.yieldNow;
    const result = yield* body;
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(fiber);
    return { result, emitted };
  }).pipe(Effect.scoped);

it.layer(NodeServices.layer)("keybindings rescan", (it) => {
  it.effect("I1: delivers a file change with no watch event", () =>
    Effect.gen(function* () {
      logs.length = 0;
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      const keybindings = yield* Keybindings.Keybindings;
      yield* keybindings.getSnapshot;
      NodeFS.writeFileSync(keybindingsConfigPath, CUSTOM);
      const { emitted } = yield* withEmits(keybindings.rescan);
      assert.equal(emitted.length, 1);
      assert.isTrue(hasCustom(emitted[0]!));
      assert.isTrue(hasCustom(yield* keybindings.getSnapshot));
      assert.equal(count("watch rescan applied a change the file watcher had not delivered"), 1);
    }).pipe(Effect.provide(layer())),
  );

  it.effect(
    "I2 + I7: a broken file over 5 rescans emits nothing and keeps the last good state",
    () =>
      Effect.gen(function* () {
        logs.length = 0;
        const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
        const keybindings = yield* Keybindings.Keybindings;
        NodeFS.writeFileSync(keybindingsConfigPath, CUSTOM);
        yield* keybindings.rescan;
        const before = yield* keybindings.getSnapshot;
        const unchanged = yield* withEmits(Effect.all([keybindings.rescan, keybindings.rescan]));
        assert.equal(unchanged.emitted.length, 0);
        NodeFS.writeFileSync(keybindingsConfigPath, "[");
        const broken = yield* withEmits(
          Effect.all([
            keybindings.rescan,
            keybindings.rescan,
            keybindings.rescan,
            keybindings.rescan,
            keybindings.rescan,
          ]),
        );
        assert.equal(broken.emitted.length, 0);
        const after = yield* keybindings.getSnapshot;
        assert.isTrue(hasCustom(after));
        assert.deepStrictEqual(after.issues, before.issues);
      }).pipe(Effect.provide(layer())),
  );

  it.effect("an invalid entry is trusted: publishes its issue once and is decoded once", () =>
    Effect.gen(function* () {
      logs.length = 0;
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      const keybindings = yield* Keybindings.Keybindings;
      yield* keybindings.getSnapshot;
      NodeFS.writeFileSync(keybindingsConfigPath, '[{"key":"","command":"x"}]\n');
      const first = yield* withEmits(keybindings.rescan);
      assert.equal(first.emitted.length, 1);
      assert.isTrue(
        first.emitted[0]!.issues.some((issue) => issue.kind === "keybindings.invalid-entry"),
      );
      const second = yield* withEmits(keybindings.rescan);
      assert.equal(second.emitted.length, 0);
      // Unchanged bytes are not re-decoded, so the entry warning does not repeat every tick.
      assert.equal(count("ignoring invalid keybinding entry"), 1);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("I5 + I9: a directory at the path warns once, keeps the cache, recovers once", () =>
    Effect.gen(function* () {
      logs.length = 0;
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      const keybindings = yield* Keybindings.Keybindings;
      NodeFS.writeFileSync(keybindingsConfigPath, CUSTOM);
      yield* keybindings.rescan;
      NodeFS.rmSync(keybindingsConfigPath);
      NodeFS.mkdirSync(keybindingsConfigPath);
      yield* Effect.all([keybindings.rescan, keybindings.rescan, keybindings.rescan]);
      assert.equal(count("keybindings file unreadable"), 1);
      assert.isTrue(hasCustom(yield* keybindings.getSnapshot));
      NodeFS.rmdirSync(keybindingsConfigPath);
      NodeFS.writeFileSync(keybindingsConfigPath, "[]\n");
      const { emitted } = yield* withEmits(keybindings.rescan);
      assert.equal(count("keybindings file readable again"), 1);
      assert.equal(emitted.length, 1);
      // The latch is re-armed: a second healthy tick stays quiet, and a new outage warns again.
      yield* keybindings.rescan;
      assert.equal(count("keybindings file readable again"), 1);
      NodeFS.rmSync(keybindingsConfigPath);
      NodeFS.mkdirSync(keybindingsConfigPath);
      yield* Effect.all([keybindings.rescan, keybindings.rescan]);
      assert.equal(count("keybindings file unreadable"), 2);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("rewriting the same rules with different formatting emits and logs nothing", () =>
    Effect.gen(function* () {
      logs.length = 0;
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      const keybindings = yield* Keybindings.Keybindings;
      NodeFS.writeFileSync(keybindingsConfigPath, CUSTOM);
      yield* keybindings.rescan;
      logs.length = 0;
      NodeFS.writeFileSync(
        keybindingsConfigPath,
        '[\n  { "command": "terminal.toggle",   "key": "mod+shift+y" }\n]\n',
      );
      const { emitted } = yield* withEmits(keybindings.rescan);
      assert.equal(emitted.length, 0);
      assert.equal(count("watch rescan applied a change the file watcher had not delivered"), 0);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("I3 + I8: upsert racing a rescan emits once; a following rescan logs nothing", () =>
    Effect.gen(function* () {
      logs.length = 0;
      const keybindings = yield* Keybindings.Keybindings;
      yield* keybindings.getSnapshot;
      const { emitted } = yield* withEmits(
        Effect.gen(function* () {
          yield* Effect.all(
            [
              keybindings.upsertKeybindingRule({ key: "mod+shift+y", command: "terminal.toggle" }),
              keybindings.rescan,
            ],
            { concurrency: "unbounded" },
          );
          yield* keybindings.rescan;
        }),
      );
      assert.equal(emitted.length, 1);
      assert.equal(count("watch rescan applied a change the file watcher had not delivered"), 0);
      assert.isTrue(hasCustom(yield* keybindings.getSnapshot));
    }).pipe(Effect.provide(layer())),
  );

  it.effect("the timer skips a missing file; a recreated file is applied once", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      const keybindings = yield* Keybindings.Keybindings;
      NodeFS.writeFileSync(keybindingsConfigPath, CUSTOM);
      yield* keybindings.rescan;
      NodeFS.rmSync(keybindingsConfigPath);
      const missing = yield* withEmits(Effect.all([keybindings.rescan, keybindings.rescan]));
      assert.equal(missing.emitted.length, 0);
      assert.isTrue(hasCustom(yield* keybindings.getSnapshot));
      NodeFS.writeFileSync(keybindingsConfigPath, "[]\n");
      const recreated = yield* withEmits(keybindings.rescan);
      assert.equal(recreated.emitted.length, 1);
      assert.isFalse(hasCustom(recreated.emitted[0]!));
    }).pipe(Effect.provide(layer())),
  );

  it.effect("a self-write forgets the old bytes, so restoring them is applied", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      const keybindings = yield* Keybindings.Keybindings;
      NodeFS.writeFileSync(keybindingsConfigPath, CUSTOM);
      yield* keybindings.rescan;
      yield* keybindings.removeKeybindingRule({ key: "mod+shift+y", command: "terminal.toggle" });
      assert.isFalse(hasCustom(yield* keybindings.getSnapshot));
      NodeFS.writeFileSync(keybindingsConfigPath, CUSTOM);
      const { emitted } = yield* withEmits(keybindings.rescan);
      assert.equal(emitted.length, 1);
      assert.isTrue(hasCustom(emitted[0]!));
    }).pipe(Effect.provide(layer())),
  );

  it.effect("an upsert forgets the old bytes, so restoring them is applied", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      const keybindings = yield* Keybindings.Keybindings;
      NodeFS.writeFileSync(keybindingsConfigPath, CUSTOM);
      yield* keybindings.rescan;
      yield* keybindings.upsertKeybindingRule({ key: "mod+shift+u", command: "terminal.toggle" });
      NodeFS.writeFileSync(keybindingsConfigPath, CUSTOM);
      const { emitted } = yield* withEmits(keybindings.rescan);
      assert.equal(emitted.length, 1);
      assert.isTrue(hasCustom(emitted[0]!));
    }).pipe(Effect.provide(layer())),
  );
});

// The watch path (refresh(false)) publishes a malformed file's issue; only the timer skips it.
// macOS drops watch events under load, so keep rewriting the file until one event gets through.
it.live("a watch event publishes a malformed file's issue the timer would skip", () =>
  Effect.gen(function* () {
    const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
    const keybindings = yield* Keybindings.Keybindings;
    NodeFS.mkdirSync(NodePath.dirname(keybindingsConfigPath), { recursive: true });
    NodeFS.writeFileSync(keybindingsConfigPath, CUSTOM);
    yield* keybindings.start;
    const seen = yield* Queue.unbounded<Keybindings.KeybindingsChangeEvent>();
    yield* keybindings.streamChanges.pipe(
      Stream.runForEach((event) => Queue.offer(seen, event)),
      Effect.forkScoped,
    );
    yield* Effect.yieldNow;
    const event = yield* Effect.raceFirst(
      Queue.take(seen),
      Effect.forever(
        Effect.andThen(
          Effect.sleep("300 millis"),
          Effect.sync(() => NodeFS.writeFileSync(keybindingsConfigPath, "[")),
        ),
      ),
    ).pipe(
      // Surviving events arrive many seconds late under load; stays under the 120 s test timeout.
      Effect.timeout("90 seconds"),
    );
    assert.isTrue(event.issues.some((issue) => issue.kind === "keybindings.malformed-config"));
  }).pipe(Effect.scoped, Effect.provide(Layer.provideMerge(layer(), NodeServices.layer))),
);
