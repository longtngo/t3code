import { EnvironmentThemeFile } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "./config.ts";
import * as EnvironmentTheme from "./environmentTheme.ts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

const encodeThemeFile = Schema.encodeSync(Schema.fromJsonString(EnvironmentThemeFile));

const NIGHTFALL_THEME: EnvironmentThemeFile = {
  name: "Nightfall",
  appearance: "dark",
  canvas: "#1a1b26",
  accent: "#7aa2f7",
};

/** The standard exported form: a full palette, no seeds. */
const SHARED_THEME: EnvironmentThemeFile = {
  version: 1,
  name: "Shared Light",
  appearance: "light",
  colors: { canvas: "#eff1f5", accent: "#1e66f5" },
};

/** Seeds theme files before the service starts, as a real machine would. */
const withEnvironmentThemes = <A, E>(
  seeds: Readonly<Record<string, string>>,
  body: Effect.Effect<
    A,
    E,
    | EnvironmentTheme.EnvironmentThemeService
    | ServerConfig.ServerConfig
    | FileSystem.FileSystem
    | Path.Path
    | Scope.Scope
  >,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-environment-theme-" });
    const themesDir = path.join(baseDir, "userdata", "themes");
    yield* fs.makeDirectory(themesDir, { recursive: true });
    for (const [filename, contents] of Object.entries(seeds)) {
      yield* fs.writeFileString(path.join(themesDir, filename), contents);
    }

    return yield* body.pipe(
      Effect.provide(
        EnvironmentTheme.layer.pipe(
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
        ),
      ),
    );
  }).pipe(Effect.scoped);

const currentThemes = Effect.gen(function* () {
  const environmentTheme = yield* EnvironmentTheme.EnvironmentThemeService;
  return yield* environmentTheme.current;
});

const warned: Array<string> = [];
const captureWarnings = Logger.make(({ message, logLevel }) => {
  if (logLevel === "Warn")
    warned.push(Array.isArray(message) ? String(message[0]) : String(message));
});
const invalidWarnings = () =>
  warned.filter((line) => line.includes("ignoring invalid environment theme")).length;

it.layer(NodeServices.layer)("environment theme", (it) => {
  it.effect("publishes nothing when the machine has no theme files", () =>
    withEnvironmentThemes(
      {},
      Effect.gen(function* () {
        assert.deepEqual(yield* currentThemes, []);
      }),
    ),
  );

  it.effect("publishes each file under its filename as the id", () =>
    withEnvironmentThemes(
      {
        "nightfall.json": encodeThemeFile(NIGHTFALL_THEME),
        "shared-light.json": encodeThemeFile(SHARED_THEME),
      },
      Effect.gen(function* () {
        const themes = yield* currentThemes;
        assert.deepEqual(
          themes.map((theme) => theme.id),
          ["nightfall", "shared-light"],
        );
        assert.deepEqual(themes[0], { id: "nightfall", ...NIGHTFALL_THEME });
        assert.deepEqual(themes[1], { id: "shared-light", ...SHARED_THEME });
      }),
    ),
  );

  // Read from disk rather than from the watcher's last observation, so a
  // client connecting after a missed filesystem event still sees the truth.
  it.effect("follows the directory rather than the set read at start", () =>
    withEnvironmentThemes(
      { "nightfall.json": encodeThemeFile(NIGHTFALL_THEME) },
      Effect.gen(function* () {
        const { environmentThemesDir } = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* fs.writeFileString(
          path.join(environmentThemesDir, "shared-light.json"),
          encodeThemeFile(SHARED_THEME),
        );
        assert.equal((yield* currentThemes).length, 2);

        yield* fs.remove(path.join(environmentThemesDir, "nightfall.json"));
        assert.deepEqual(
          (yield* currentThemes).map((theme) => theme.id),
          ["shared-light"],
        );
      }),
    ),
  );

  // The 30 s rescan backstop's theme step is `current`: it must re-read the directory and
  // publish what it finds, with the watcher delivering nothing.
  it.effect("current publishes a new file to subscribers with no watch event", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-theme-backstop-" });
      const themesDir = path.join(baseDir, "userdata", "themes");
      yield* fs.makeDirectory(themesDir, { recursive: true });
      const deafFs = Layer.succeed(FileSystem.FileSystem, { ...fs, watch: () => Stream.never });

      yield* Effect.gen(function* () {
        const environmentTheme = yield* EnvironmentTheme.EnvironmentThemeService;
        const seen = yield* Queue.unbounded<ReadonlyArray<{ readonly id: string }>>();
        yield* Stream.runForEach(environmentTheme.streamChanges, (themes) =>
          Queue.offer(seen, themes),
        ).pipe(Effect.forkScoped);
        assert.deepEqual(yield* Queue.take(seen), []);

        yield* fs.writeFileString(
          path.join(themesDir, "nightfall.json"),
          encodeThemeFile(NIGHTFALL_THEME),
        );
        assert.deepEqual(
          (yield* environmentTheme.current).map((theme) => theme.id),
          ["nightfall"],
        );
        assert.deepEqual(
          (yield* Queue.take(seen)).map((theme) => theme.id),
          ["nightfall"],
        );
      }).pipe(
        Effect.provide(
          EnvironmentTheme.layer.pipe(
            Layer.provide(deafFs),
            Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
          ),
        ),
      );
    }).pipe(Effect.scoped),
  );

  // One bad file must not take down the machine's other themes: a theme
  // script that leaves a template placeholder unresolved, a half-written
  // file, or a stray name are each that file's problem alone.
  // The subscription is acquired before the current set is read, so nothing
  // published while a client connects can fall between snapshot and stream.
  it.effect("streams the current set first", () =>
    withEnvironmentThemes(
      { "nightfall.json": encodeThemeFile(NIGHTFALL_THEME) },
      Effect.gen(function* () {
        const environmentTheme = yield* EnvironmentTheme.EnvironmentThemeService;
        const first = yield* environmentTheme.streamChanges.pipe(Stream.runHead);
        assert.deepEqual(Option.getOrNull(first), [{ id: "nightfall", ...NIGHTFALL_THEME }]);
      }),
    ),
  );

  // Subscribing happens before the snapshot read, so a publish landing in
  // between is queued. It must not replay after the newer snapshot and walk
  // clients back onto colors the machine has already moved past.
  it.effect("never replays a set older than the snapshot it started from", () =>
    withEnvironmentThemes(
      { "nightfall.json": encodeThemeFile(NIGHTFALL_THEME) },
      Effect.gen(function* () {
        const environmentTheme = yield* EnvironmentTheme.EnvironmentThemeService;
        const { environmentThemesDir } = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        // Advance the directory twice without the watcher running, so the
        // second read is strictly newer than anything already observed.
        yield* fs.writeFileString(
          path.join(environmentThemesDir, "shared-light.json"),
          encodeThemeFile(SHARED_THEME),
        );
        const first = yield* environmentTheme.streamChanges.pipe(Stream.runHead);
        assert.deepEqual(
          Option.getOrNull(first)?.map((theme) => theme.id),
          ["nightfall", "shared-light"],
        );
      }),
    ),
  );

  it.effect("skips invalid files while keeping valid ones", () =>
    withEnvironmentThemes(
      {
        "nightfall.json": encodeThemeFile(NIGHTFALL_THEME),
        "unresolved.json":
          '{ "name": "X", "appearance": "dark", "canvas": "{{ background }}", "accent": "#7aa2f7" }',
        "malformed.json": "{ not json",
        "no-colors.json": '{ "name": "Empty", "appearance": "dark" }',
        "Bad Name.json": encodeThemeFile(SHARED_THEME),
        "ocean.json": encodeThemeFile(SHARED_THEME),
        "dark.json": encodeThemeFile(SHARED_THEME),
        "notes.txt": "not a theme",
      },
      Effect.gen(function* () {
        assert.deepEqual(
          (yield* currentThemes).map((theme) => theme.id),
          ["nightfall"],
        );
      }),
    ),
  );

  it.effect("logs a broken file once per incident, not on every refresh", () =>
    Effect.gen(function* () {
      warned.length = 0;
      yield* withEnvironmentThemes(
        { "nightfall.json": encodeThemeFile(NIGHTFALL_THEME), "broken.json": "{" },
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { environmentThemesDir } = yield* ServerConfig.ServerConfig;
          const write = (name: string) =>
            fs.writeFileString(path.join(environmentThemesDir, name), "{");
          const remove = (name: string) => fs.remove(path.join(environmentThemesDir, name));

          yield* currentThemes;
          yield* currentThemes;
          yield* currentThemes;
          assert.equal(invalidWarnings(), 1);

          yield* write("second.json");
          yield* currentThemes;
          yield* currentThemes;
          assert.equal(invalidWarnings(), 2);

          yield* remove("broken.json");
          yield* remove("second.json");
          yield* currentThemes;
          yield* write("broken.json");
          yield* currentThemes;
          assert.equal(invalidWarnings(), 3);
        }),
      ).pipe(Effect.provide(Logger.layer([captureWarnings], { mergeWithExisting: false })));
    }),
  );

  it.effect("readPublishedThemes still logs every warning on each call", () =>
    Effect.gen(function* () {
      warned.length = 0;
      yield* withEnvironmentThemes(
        { "broken.json": "{" },
        Effect.gen(function* () {
          const { environmentThemesDir } = yield* ServerConfig.ServerConfig;
          yield* EnvironmentTheme.readPublishedThemes(environmentThemesDir);
          yield* EnvironmentTheme.readPublishedThemes(environmentThemesDir);
          // One from the service starting, plus one per direct call.
          assert.equal(invalidWarnings(), 3);
        }),
      ).pipe(Effect.provide(Logger.layer([captureWarnings], { mergeWithExisting: false })));
    }),
  );

  // A symlinked themes directory stays usable, but a symlinked file inside it
  // must not publish whatever it points at.
  it.effect.skipIf(!symlinksSupported)("ignores a symlinked theme file", () =>
    withEnvironmentThemes(
      {},
      Effect.gen(function* () {
        const { environmentThemesDir } = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const outside = path.join(environmentThemesDir, "..", "outside.json");
        yield* fs.writeFileString(outside, encodeThemeFile(NIGHTFALL_THEME));
        yield* fs.symlink(outside, path.join(environmentThemesDir, "nightfall.json"));
        assert.deepEqual(yield* currentThemes, []);
      }),
    ),
  );

  // The aggregate size cap charges only accepted themes, so a pile of
  // malformed files cannot spend the budget and hide a valid theme sorted
  // after them.
  it.effect("does not charge skipped files against the total size limit", () =>
    withEnvironmentThemes(
      {
        ...Object.fromEntries(
          Array.from({ length: 7 }, (_, index) => [`junk-${index}.json`, "{".repeat(30_000)]),
        ),
        "zz-valid.json": encodeThemeFile(NIGHTFALL_THEME),
      },
      Effect.gen(function* () {
        assert.deepEqual(
          (yield* currentThemes).map((theme) => theme.id),
          ["zz-valid"],
        );
      }),
    ),
  );
});

// The feature's headline claim: rewrite a file and connected clients retint
// without a restart. Live clock and a real filesystem event, so this proves
// the watcher rather than a direct read. Kept outside the it.layer block above
// because only the top-level `it` exposes `live`.
describe("environment theme watching", () => {
  it.live("streams a set for every change to the directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-theme-watch-" });
      const themesDir = path.join(baseDir, "userdata", "themes");
      yield* fs.makeDirectory(themesDir, { recursive: true });

      yield* Effect.gen(function* () {
        const environmentTheme = yield* EnvironmentTheme.EnvironmentThemeService;
        const seen = yield* Queue.unbounded<ReadonlyArray<{ readonly id: string }>>();
        yield* Stream.runForEach(environmentTheme.streamChanges, (themes) =>
          Queue.offer(seen, themes),
        ).pipe(Effect.forkScoped);

        // Empty to start.
        assert.deepEqual(yield* Queue.take(seen), []);

        // macOS drops directory events without notice when fseventsd is busy (a full test run), so
        // keep touching a non-theme file until one event gets through; any event re-reads the folder.
        const takeAfterChange = Effect.raceFirst(
          Queue.take(seen),
          Effect.forever(
            Effect.andThen(
              Effect.sleep("500 millis"),
              fs.writeFileString(path.join(themesDir, "poke.txt"), ""),
            ),
          ),
        );

        // Published atomically, the way a theme hook writes it.
        const staging = path.join(baseDir, "staged.json");
        yield* fs.writeFileString(staging, encodeThemeFile(NIGHTFALL_THEME));
        yield* fs.rename(staging, path.join(themesDir, "nightfall.json"));
        assert.deepEqual(
          (yield* takeAfterChange).map((theme) => theme.id),
          ["nightfall"],
        );

        // Removed again, and the set empties without a restart.
        yield* fs.remove(path.join(themesDir, "nightfall.json"));
        assert.deepEqual(yield* takeAfterChange, []);
      }).pipe(
        Effect.provide(
          EnvironmentTheme.layer.pipe(
            Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
          ),
        ),
        // Surviving events arrive many seconds late under load; stays under the 120 s test timeout.
        Effect.timeout("90 seconds"),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
