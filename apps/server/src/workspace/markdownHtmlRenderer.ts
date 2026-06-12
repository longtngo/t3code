/**
 * MarkdownHtmlRenderer - renders markdown to a standalone HTML document, preferring
 * the user's `uni-md2html` CLI (UniUni-branded "report" theme) and degrading to the
 * in-process `marked` renderer when the tool is unavailable or fails.
 *
 * The resolved command is a file-based console script, so it is driven through a
 * temp-file round-trip rather than stdin. `render` never fails — any failure of the
 * tool (not installed, non-zero exit, timeout, empty output) falls back to
 * `renderMarkdownDocument`, so the file viewer always gets a document.
 *
 * @module markdownHtmlRenderer
 */
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ProcessRunner, layer as ProcessRunnerLive } from "../processRunner.ts";
import { renderMarkdownDocument } from "./markdownHtml.ts";

/**
 * Environment variable naming the `uni-md2html` executable. A single executable
 * path or name — not a command line (e.g. point it at
 * `…/md-html-converer/.venv/bin/uni-md2html` to use a dev venv without installing).
 * When unset, the renderer resolves `uni-md2html` from `PATH`.
 */
export const MD2HTML_COMMAND_ENV = "T3CODE_MD2HTML_CMD";
const DEFAULT_COMMAND = "uni-md2html";

/** Bound the external tool so a hung process can't wedge a viewer request. */
const RENDER_TIMEOUT = "30 seconds";

/** Internal sentinel signalling "the tool didn't produce usable output" → fall back. */
class MarkdownToolUnavailable extends Data.TaggedError("MarkdownToolUnavailable")<{
  readonly reason: string;
}> {}

export interface MarkdownHtmlRendererShape {
  /** Render markdown to a standalone HTML document. Never fails. */
  readonly render: (markdown: string) => Effect.Effect<string>;
}

export class MarkdownHtmlRenderer extends Context.Service<
  MarkdownHtmlRenderer,
  MarkdownHtmlRendererShape
>()("t3/workspace/markdownHtmlRenderer") {}

export const make = Effect.fn("makeMarkdownHtmlRenderer")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner;
  const command = process.env[MD2HTML_COMMAND_ENV]?.trim() || DEFAULT_COMMAND;

  const renderViaTool = (markdown: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-md2html-" });
        const inputPath = path.join(dir, "in.md");
        const outputPath = path.join(dir, "out.html");
        yield* fileSystem.writeFileString(inputPath, markdown);

        // stdout/stderr are irrelevant (we read the output file), so truncate noisy
        // diagnostics rather than let them trip the output-size limit.
        const result = yield* processRunner.run({
          command,
          args: [inputPath, "--theme", "report", "-o", outputPath],
          timeout: RENDER_TIMEOUT,
          // Surface a timeout as a value (`timedOut`) rather than a failure, so the
          // fallback decision below stays in one place.
          timeoutBehavior: "timedOutResult",
          outputMode: "truncate",
        });

        if (result.timedOut) {
          return yield* new MarkdownToolUnavailable({ reason: `${command} timed out` });
        }
        if (result.code !== 0) {
          return yield* new MarkdownToolUnavailable({
            reason: `${command} exited with code ${String(result.code)}`,
          });
        }

        const html = yield* fileSystem.readFileString(outputPath);
        if (html.trim().length === 0) {
          return yield* new MarkdownToolUnavailable({ reason: `${command} produced no output` });
        }
        return html;
      }),
    );

  const render: MarkdownHtmlRendererShape["render"] = (markdown) =>
    renderViaTool(markdown).pipe(
      Effect.catch((cause) =>
        Effect.logDebug("markdownHtmlRenderer: falling back to in-process renderer", cause).pipe(
          Effect.andThen(Effect.sync(() => renderMarkdownDocument(markdown))),
        ),
      ),
    );

  return MarkdownHtmlRenderer.of({ render });
});

export const MarkdownHtmlRendererLive = Layer.effect(MarkdownHtmlRenderer, make()).pipe(
  Layer.provide(ProcessRunnerLive),
);
