// @effect-diagnostics nodeBuiltinImport:off - The invariant is about the bytes on disk, so the test has to read them.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

/**
 * A raw NUL byte makes a source file opaque to merge-audit tools (BSD `sed` truncates, `grep`
 * says "Binary file"), which has misled reconciles here twice. `\0` is identical at runtime.
 * The walker is duplicated from the web guard rather than shared: it is a dozen lines.
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
