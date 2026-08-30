import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { writeFileStringAtomically } from "./atomicWrite.ts";

/**
 * `writeFileStringAtomically` backs every durable config write on the server -
 * settings.json, keybindings, runtime state, the provider status cache, themes.
 * A partial write to any of them is unrecoverable for the user, so the temp-file
 * + rename contract is worth pinning directly rather than only through callers.
 */
const withTempDirectory = <A, E, R>(use: (directory: string) => Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-atomic-write-" });
      return yield* use(directory);
    }),
  );

it.layer(NodeServices.layer)("writeFileStringAtomically", (it) => {
  it.effect("writes the file and creates missing parent directories", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // Nested path: callers write into a T3 home that may not exist yet.
        const filePath = path.join(directory, "nested", "deeper", "settings.json");

        yield* writeFileStringAtomically({ filePath, contents: '{"a":1}' });

        assert.strictEqual(yield* fs.readFileString(filePath), '{"a":1}');
      }),
    ),
  );

  it.effect("replaces existing contents rather than appending", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const filePath = path.join(directory, "settings.json");

        yield* writeFileStringAtomically({ filePath, contents: "the longer original" });
        yield* writeFileStringAtomically({ filePath, contents: "short" });

        // A rename cannot leave a tail behind; a naive truncating write could.
        assert.strictEqual(yield* fs.readFileString(filePath), "short");
      }),
    ),
  );

  it.effect("leaves no temporary files or directories behind", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const filePath = path.join(directory, "settings.json");

        yield* writeFileStringAtomically({ filePath, contents: "one" });
        yield* writeFileStringAtomically({ filePath, contents: "two" });

        // The scoped temp directory must be released, or every settings write
        // would litter the T3 home with `settings.json.XXXX/` directories.
        assert.deepEqual(yield* fs.readDirectory(directory), ["settings.json"]);
      }),
    ),
  );

  it.effect("routes the write through a temp file renamed onto the target", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const filePath = path.join(directory, "settings.json");
        const calls: string[] = [];

        // Atomicity here is the rename, and a rename is only atomic within one
        // filesystem - so the temp file must live in the TARGET directory, not
        // in /tmp. Neither property survives a crash-free black-box assertion
        // (a plain overwrite produces identical final contents), so pin the
        // mechanism instead by recording what the module asks the filesystem to do.
        const recording = FileSystem.FileSystem.of({
          ...fs,
          writeFileString: (file: string, data: string) => {
            calls.push(`write:${file}`);
            return fs.writeFileString(file, data);
          },
          rename: (from: string, to: string) => {
            calls.push(`rename:${from}->${to}`);
            return fs.rename(from, to);
          },
        });

        yield* writeFileStringAtomically({ filePath, contents: "durable" }).pipe(
          Effect.provideService(FileSystem.FileSystem, recording),
        );

        const written = calls.find((entry) => entry.startsWith("write:"));
        const renamed = calls.find((entry) => entry.startsWith("rename:"));
        assert.isDefined(written, "expected a write");
        assert.isDefined(renamed, "expected a rename onto the target");
        // The write never targets the destination directly...
        assert.notStrictEqual(written, `write:${filePath}`);
        // ...it lands beside it, inside the target directory, then is renamed on.
        assert.isTrue(written!.slice("write:".length).startsWith(`${directory}${path.sep}`));
        assert.isTrue(renamed!.endsWith(`->${filePath}`));
        assert.strictEqual(yield* fs.readFileString(filePath), "durable");
      }),
    ),
  );

  it.effect("writes empty contents", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const filePath = path.join(directory, "empty.json");

        yield* writeFileStringAtomically({ filePath, contents: "" });

        assert.strictEqual(yield* fs.readFileString(filePath), "");
      }),
    ),
  );
});
