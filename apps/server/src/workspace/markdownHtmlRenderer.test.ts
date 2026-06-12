import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import {
  ProcessRunner,
  ProcessSpawnError,
  type ProcessRunError,
  type ProcessRunInput,
  type ProcessRunOutput,
} from "../processRunner.ts";
import { MarkdownHtmlRenderer, make } from "./markdownHtmlRenderer.ts";

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

describe("MarkdownHtmlRenderer", () => {
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
            new ProcessSpawnError({ command: input.command, args: input.args, cause: "ENOENT" }),
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
