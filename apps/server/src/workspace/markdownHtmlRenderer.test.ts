import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  ProcessRunner,
  ProcessSpawnError,
  type ProcessRunError,
  type ProcessRunInput,
  type ProcessRunOutput,
} from "../processRunner.ts";
import { MarkdownHtmlRenderer, make, resolveRendererCommand } from "./markdownHtmlRenderer.ts";

const BRANDED = '<!DOCTYPE html><html><body><div class="masthead">Branded</div></body></html>';

/** Locate the `-o <path>` argument the renderer passes to the CLI. */
function outputPath(input: ProcessRunInput): string {
  const flagIndex = input.args.indexOf("-o");
  const path = flagIndex >= 0 ? input.args[flagIndex + 1] : undefined;
  if (path === undefined) throw new Error("renderer did not pass -o <path>");
  return path;
}

const SUCCESS: ProcessRunOutput = {
  stdout: "",
  stderr: "",
  code: 0 as ProcessRunOutput["code"],
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
};

type RunHandler = (
  input: ProcessRunInput,
  fileSystem: FileSystem.FileSystem,
) => Effect.Effect<ProcessRunOutput, ProcessRunError>;

/** Build the renderer with a stubbed ProcessRunner; FileSystem/Path are real. */
function rendererWith(handler: RunHandler) {
  const runnerLayer = Layer.effect(
    ProcessRunner,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      return ProcessRunner.of({ run: (input) => handler(input, fileSystem) });
    }),
  );
  return Layer.effect(MarkdownHtmlRenderer, make()).pipe(
    Layer.provide(runnerLayer),
    Layer.provide(NodeServices.layer),
  );
}

/** A handler that mimics the CLI writing `body` to its `-o` path, then exits 0. */
const writesOutput =
  (body: string): RunHandler =>
  (input, fileSystem) =>
    fileSystem.writeFileString(outputPath(input), body).pipe(Effect.orDie, Effect.as(SUCCESS));

describe("resolveRendererCommand", () => {
  /** A real executable and a real non-executable file, in a real temp dir. */
  const withCandidates = <A, E, R>(
    body: (input: {
      readonly dir: string;
      readonly executable: string;
      readonly plainFile: string;
      readonly fileSystem: FileSystem.FileSystem;
      readonly path: Path.Path;
    }) => Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-md2html-probe-" });
      const executable = path.join(dir, "uni-md2html");
      const plainFile = path.join(dir, "not-executable");
      yield* fileSystem.writeFileString(executable, "#!/bin/sh\n");
      yield* fileSystem.chmod(executable, 0o755);
      yield* fileSystem.writeFileString(plainFile, "");
      yield* fileSystem.chmod(plainFile, 0o644);
      return yield* body({ dir, executable, plainFile, fileSystem, path });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

  it.effect("finds a bare command name on PATH", () =>
    withCandidates(({ dir, executable, fileSystem, path }) =>
      Effect.gen(function* () {
        const resolved = yield* resolveRendererCommand({
          command: "uni-md2html",
          pathEnv: `/nonexistent-first:${dir}`,
          fileSystem,
          path,
        });
        expect(resolved).toBe(executable);
      }),
    ),
  );

  it.effect("returns null when the command is on no PATH entry", () =>
    withCandidates(({ fileSystem, path }) =>
      Effect.gen(function* () {
        const resolved = yield* resolveRendererCommand({
          command: "uni-md2html",
          pathEnv: "/nonexistent-a:/nonexistent-b",
          fileSystem,
          path,
        });
        expect(resolved).toBeNull();
      }),
    ),
  );

  it.effect("rejects a file that carries the right name but is not executable", () =>
    withCandidates(({ plainFile, fileSystem, path }) =>
      Effect.gen(function* () {
        // Reporting this one as found would announce a renderer that then fails
        // at spawn time — the exact confusion the startup line exists to remove.
        const resolved = yield* resolveRendererCommand({
          command: plainFile,
          pathEnv: undefined,
          fileSystem,
          path,
        });
        expect(resolved).toBeNull();
      }),
    ),
  );

  it.effect("takes a command containing a separator as a direct path, not a PATH search", () =>
    withCandidates(({ executable, fileSystem, path }) =>
      Effect.gen(function* () {
        const resolved = yield* resolveRendererCommand({
          command: executable,
          pathEnv: "/nonexistent",
          fileSystem,
          path,
        });
        expect(resolved).toBe(executable);
      }),
    ),
  );

  it.effect("survives an unset PATH", () =>
    withCandidates(({ fileSystem, path }) =>
      Effect.gen(function* () {
        const resolved = yield* resolveRendererCommand({
          command: "uni-md2html",
          pathEnv: undefined,
          fileSystem,
          path,
        });
        expect(resolved).toBeNull();
      }),
    ),
  );
});

describe("MarkdownHtmlRenderer", () => {
  it.effect("asks the CLI to drop its webfont CDN link", () =>
    Effect.gen(function* () {
      const captured: Array<ProcessRunInput> = [];
      const renderer = yield* Effect.provide(
        MarkdownHtmlRenderer,
        rendererWith((input, fileSystem) => {
          captured.push(input);
          return writesOutput(BRANDED)(input, fileSystem);
        }),
      );
      yield* renderer.render("# Title");

      const input = captured[0];
      expect(input).toBeDefined();
      // Without this flag the tool emits a Google Fonts <link>, which would make
      // the viewer's iframe reach the network for a local file — the app itself
      // loads no external resources, and the viewer must work offline. (A doc
      // containing a mermaid fence still carries the tool's mermaid CDN <script>;
      // that one is inert because the viewer's iframe disables scripting.)
      expect(input?.args).toContain("--self-contained");
    }),
  );

  it.effect("returns the tool's output when the CLI succeeds", () =>
    Effect.gen(function* () {
      const renderer = yield* MarkdownHtmlRenderer;
      const html = yield* renderer.render("# Title\n\nbody");
      expect(html).toBe(BRANDED);
    }).pipe(Effect.provide(rendererWith(writesOutput(BRANDED)))),
  );

  it.effect("falls back to the in-process renderer when the command is not found", () =>
    Effect.gen(function* () {
      const renderer = yield* MarkdownHtmlRenderer;
      const html = yield* renderer.render("# Title\n\nbody");
      // The marked fallback wraps the body in <article class="markdown-body">.
      expect(html).toContain('class="markdown-body"');
      expect(html).not.toContain("masthead");
    }).pipe(
      Effect.provide(
        rendererWith((input) =>
          Effect.fail(
            new ProcessSpawnError({
              command: input.command,
              argumentCount: input.args.length,
              cause: "ENOENT",
            }),
          ),
        ),
      ),
    ),
  );

  it.effect("falls back when the CLI exits non-zero", () =>
    Effect.gen(function* () {
      const renderer = yield* MarkdownHtmlRenderer;
      const html = yield* renderer.render("# Title\n\nbody");
      expect(html).toContain('class="markdown-body"');
    }).pipe(
      Effect.provide(
        rendererWith(() =>
          Effect.succeed({ ...SUCCESS, code: 1 as ProcessRunOutput["code"], stderr: "boom" }),
        ),
      ),
    ),
  );

  it.effect("falls back when the CLI times out", () =>
    Effect.gen(function* () {
      const renderer = yield* MarkdownHtmlRenderer;
      const html = yield* renderer.render("# Title\n\nbody");
      expect(html).toContain('class="markdown-body"');
    }).pipe(
      Effect.provide(
        rendererWith(() => Effect.succeed({ ...SUCCESS, timedOut: true, code: null })),
      ),
    ),
  );

  it.effect("falls back when the CLI produces an empty output file", () =>
    Effect.gen(function* () {
      const renderer = yield* MarkdownHtmlRenderer;
      const html = yield* renderer.render("# Title\n\nbody");
      expect(html).toContain('class="markdown-body"');
    }).pipe(Effect.provide(rendererWith(writesOutput("   \n")))),
  );
});
