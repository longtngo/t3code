// @effect-diagnostics nodeBuiltinImport:off - The invariant is about the bytes on disk, so the test has to read them.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

/**
 * A raw NUL byte in a source file is legal TypeScript but makes BSD `sed` truncate and `grep`
 * report "Binary file matches", which has misled reconcile audits on this fork twice. Use `\0`
 * escapes instead (identical string); this guard is the only thing that objects.
 */
const SOURCE_ROOT = NodePath.join(import.meta.dirname, "..", "..");

function* sourceFiles(directory: string): Generator<string> {
  for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
    const full = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(full);
    else if (/\.(ts|tsx)$/.test(entry.name)) yield full;
  }
}

describe("web source bytes", () => {
  it("uses \\0 escapes rather than raw NUL bytes", () => {
    const offenders = Array.from(sourceFiles(SOURCE_ROOT))
      .filter((file) => NodeFS.readFileSync(file).includes(0))
      .map((file) => NodePath.relative(SOURCE_ROOT, file));

    expect(offenders).toEqual([]);
  });
});
