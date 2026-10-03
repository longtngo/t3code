// @effect-diagnostics nodeBuiltinImport:off - builds a real executable in a tmpdir and counts how
// many times it actually runs, so the dedupe is measured against the real spawner rather than a mock.
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { listCursorModels } from "./cursorModels.ts";

/** A real `--list-models` stand-in that records every invocation. */
function countingBinary(dir: string, name: string): { path: string; runs: () => number } {
  const path = NodePath.join(dir, name);
  const log = `${path}.runs`;
  NodeFS.writeFileSync(
    path,
    `#!/bin/bash\necho run >> "${log}"\nsleep 0.3\necho "Available models"\necho ""\necho "auto - Auto (default)"\n`,
    { mode: 0o755 },
  );
  return {
    path,
    runs: () =>
      NodeFS.existsSync(log) ? NodeFS.readFileSync(log, "utf8").trim().split("\n").length : 0,
  };
}

describe("listCursorModels concurrency", () => {
  it.effect(
    "spawns the probe once when several callers ask for the same binary at the same time",
    () =>
      Effect.gen(function* () {
        // A panel opening while a flip is in flight puts `get` and `set` on the same
        // binary at the same moment. The TTL cache cannot help: both miss it, because
        // neither has finished writing to it yet.
        const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cm-dedupe-"));
        const binary = countingBinary(dir, "agent-concurrent");

        const results = yield* Effect.all(
          [
            listCursorModels(binary.path),
            listCursorModels(binary.path),
            listCursorModels(binary.path),
          ],
          { concurrency: "unbounded" },
        );

        expect(binary.runs()).toBe(1);
        for (const models of results) {
          expect(models.map((model) => model.id)).toEqual(["auto"]);
        }
      }).pipe(Effect.provide(NodeServices.layer)),
    { timeout: 20_000 },
  );

  it.effect(
    "still serves a later caller from the cache without respawning",
    () =>
      Effect.gen(function* () {
        const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cm-dedupe-"));
        const binary = countingBinary(dir, "agent-sequential");

        yield* listCursorModels(binary.path);
        yield* listCursorModels(binary.path);

        expect(binary.runs()).toBe(1);
      }).pipe(Effect.provide(NodeServices.layer)),
    { timeout: 20_000 },
  );
});
