// @effect-diagnostics nodeBuiltinImport:off - The invariant is about the bytes on disk, so the test has to read them.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

/**
 * A raw NUL byte in a source file is legal TypeScript and survives every normal
 * review, but it makes the file opaque to the tools we audit merges with: BSD
 * `sed` aborts mid-file and returns a plausible truncated answer, and `grep`
 * reports `Binary file … matches` and prints nothing. Both have already misled
 * a reconcile on this fork — once faking 130 phantom deletions, once hiding a
 * whole report from a follow-up sweep.
 *
 * The web app has carried this guard since `ChatComposer.tsx` was cleaned up;
 * `ActivityPayloadProjection.ts` used NULs the same way, as dedup-key
 * delimiters, and was outside its reach. `\0` produces the identical string, so
 * the escape costs nothing at runtime. The walker is duplicated rather than
 * shared: it is a dozen lines, and a package to hold it would be more machinery
 * than the thing it holds.
 */
const SOURCE_ROOT = import.meta.dirname;

function* sourceFiles(directory: string): Generator<string> {
  for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
    const full = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(full);
    else if (/\.(ts|tsx)$/.test(entry.name)) yield full;
  }
}

describe("server source bytes", () => {
  it("uses \\0 escapes rather than raw NUL bytes", () => {
    const offenders = Array.from(sourceFiles(SOURCE_ROOT))
      .filter((file) => NodeFS.readFileSync(file).includes(0))
      .map((file) => NodePath.relative(SOURCE_ROOT, file));

    expect(offenders).toEqual([]);
  });
});
