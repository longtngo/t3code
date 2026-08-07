import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as ReviewService from "./ReviewService.ts";

/**
 * Deliberately does NOT provide `ServerConfig`.
 *
 * That omission is the regression guard. Review reads used to be refused unless
 * the cwd sat under the server's own `config.cwd`, which is wherever the
 * process happens to be launched — so every repository the user reviews was out
 * of bounds. Re-introducing any config-derived bound makes `ReviewService.layer`
 * require `ServerConfig` again and breaks this file at build time, before any
 * assertion runs.
 */
function makeLayer(input: { readonly detectCalls: Array<{ readonly cwd: string }> }) {
  return ReviewService.layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        get: () => Effect.die("unexpected VCS registry get"),
        resolve: () => Effect.die("unexpected VCS registry resolve"),
        detect: (request) =>
          Effect.sync(() => {
            input.detectCalls.push({ cwd: request.cwd });
            return null;
          }),
      }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provideMerge(NodeServices.layer),
  );
}

describe("ReviewService", () => {
  // `detectCalls` is the assertion that carries the regression: it proves the
  // caller's own cwd reached the VCS registry, rather than being turned away or
  // quietly answered about some other directory.
  it.effect("previews a diff at the caller's cwd, wherever it lives", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-elsewhere-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const result = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd });
      }).pipe(Effect.provide(makeLayer({ detectCalls })));

      assert.strictEqual(result.cwd, cwd);
      assert.deepStrictEqual(result.sources, []);
      assert.deepStrictEqual(detectCalls, [{ cwd }]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads diff file contents at the caller's cwd, wherever it lives", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-elsewhere-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review
          .getDiffFileContents({
            cwd,
            sourceKind: "working-tree",
            changeType: "change",
            baseRef: "HEAD",
            headRef: null,
            oldPath: "file.ts",
            newPath: "file.ts",
          })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(makeLayer({ detectCalls })));

      // The registry mock detects nothing, so this stops on "not a Git
      // repository" — the honest answer for that directory, and reachable only
      // because the cwd was no longer refused up front.
      assert.strictEqual(error._tag, "VcsUnsupportedOperationError");
      assert.strictEqual(error.operation, "ReviewService.getDiffFileContents");
      assert.deepStrictEqual(detectCalls, [{ cwd }]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
