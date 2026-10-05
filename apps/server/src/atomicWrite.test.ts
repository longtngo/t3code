import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

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

  it.effect("keeps a symlinked file linked and rewrites its destination", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
      const destination = path.join(root, "dotfiles", "settings.json");
      const link = path.join(root, "home", "settings.json");
      yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
      yield* fs.makeDirectory(path.dirname(link), { recursive: true });
      yield* fs.writeFileString(destination, "before");
      yield* fs.symlink(destination, link);

      yield* writeFileStringAtomically({ filePath: link, contents: "after" });

      assert.strictEqual(yield* fs.readLink(link), destination);
      assert.strictEqual(yield* fs.readFileString(destination), "after");
    }),
  );

  it.effect("keeps a dangling symlink linked and creates its destination", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
      const destination = path.join(root, "dotfiles", "settings.json");
      const link = path.join(root, "home", "settings.json");
      yield* fs.makeDirectory(path.dirname(link), { recursive: true });
      yield* fs.symlink(destination, link);

      yield* writeFileStringAtomically({ filePath: link, contents: "fresh" });

      assert.strictEqual(yield* fs.readLink(link), destination);
      assert.strictEqual(yield* fs.readFileString(destination), "fresh");
    }),
  );

  it.effect("fails on a symlink cycle without replacing either link", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
      const first = path.join(root, "first.json");
      const second = path.join(root, "second.json");
      yield* fs.symlink(second, first);
      yield* fs.symlink(first, second);

      const result = yield* Effect.exit(
        writeFileStringAtomically({ filePath: first, contents: "after" }),
      );

      assert.isTrue(Exit.isFailure(result));
      assert.strictEqual(yield* fs.readLink(first), second);
      assert.strictEqual(yield* fs.readLink(second), first);
    }),
  );

  it.effect("resolves a relative link through a symlinked parent directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
      const destination = path.join(root, "dotfiles", "config", "settings.json");
      const linkedState = path.join(root, "dotfiles", "state");
      const home = path.join(root, "home");
      const link = path.join(home, "state", "settings.json");
      yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
      yield* fs.makeDirectory(linkedState, { recursive: true });
      yield* fs.makeDirectory(home, { recursive: true });
      yield* fs.symlink(linkedState, path.join(home, "state"));
      yield* fs.writeFileString(destination, "before");
      yield* fs.symlink("../config/settings.json", link);

      yield* writeFileStringAtomically({ filePath: link, contents: "after" });

      assert.strictEqual(yield* fs.readLink(link), "../config/settings.json");
      assert.strictEqual(yield* fs.readFileString(destination), "after");
    }),
  );

  it.effect("creates a missing file and its directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
      const filePath = path.join(root, "nested", "settings.json");

      yield* writeFileStringAtomically({ filePath, contents: "fresh" });

      assert.strictEqual(yield* fs.readFileString(filePath), "fresh");
    }),
  );
});

it.effect("surfaces an unreadable link instead of writing over it", () =>
  Effect.gen(function* () {
    const readLinkFailure = PlatformError.systemError({
      _tag: "Unknown",
      module: "FileSystem",
      method: "readLink",
      pathOrDescriptor: "/home/settings.json",
    });

    const result = yield* Effect.exit(
      writeFileStringAtomically({ filePath: "/home/settings.json", contents: "after" }),
    );

    assert.deepStrictEqual(result, Exit.fail(readLinkFailure));
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Path.layer,
        FileSystem.layerNoop({
          readLink: () =>
            Effect.fail(
              PlatformError.systemError({
                _tag: "Unknown",
                module: "FileSystem",
                method: "readLink",
                pathOrDescriptor: "/home/settings.json",
              }),
            ),
          rename: () => Effect.die("an unreadable link must not be replaced"),
        }),
      ),
    ),
  ),
);
