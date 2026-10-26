// @effect-diagnostics nodeBuiltinImport:off - The invariant is about files on disk: which
// class selectors index.css defines, and which ones the components actually use.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

/**
 * Upstream owns the composer chrome's CSS and once deleted every `.chat-composer-*` selector in
 * one commit; markup still pointing at them passes everything but renders unstyled. These two
 * checks close that in both directions on every reconcile (13 orphans and 11 dead selectors when
 * written). Only bare class tokens: `data-`/`--chat-composer-*` are a different contract.
 */
const SOURCE_ROOT = NodePath.join(import.meta.dirname, "..", "..");
const STYLESHEET = NodePath.join(SOURCE_ROOT, "index.css");

/**
 * Identity markers: referenced in `className` so other rules and tests can find the element,
 * deliberately carrying no styling of their own. Anything else unmatched is a real orphan.
 */
const MARKER_CLASSES = new Set(["chat-composer-stash-tab", "chat-composer-tasks-tab"]);

function* sourceFiles(directory: string): Generator<string> {
  for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
    const full = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(full);
    else if (/\.(ts|tsx)$/.test(entry.name)) yield full;
  }
}

function definedSelectors(): ReadonlySet<string> {
  const css = NodeFS.readFileSync(STYLESHEET, "utf8");
  return new Set(Array.from(css.matchAll(/\.(chat-composer-[a-z0-9-]+)/g), (m) => m[1]!));
}

/** Class tokens only: a bare `chat-composer-x`, never `data-…` or `--…`. */
function usedClassTokens(): ReadonlyMap<string, string[]> {
  const used = new Map<string, string[]>();
  for (const file of sourceFiles(SOURCE_ROOT)) {
    if (file.endsWith("composerCssContract.test.ts")) continue;
    const text = NodeFS.readFileSync(file, "utf8");
    for (const match of text.matchAll(/(^|[\s"'`])(chat-composer-[a-z0-9-]+)/g)) {
      const token = match[2]!;
      used.set(token, [...(used.get(token) ?? []), NodePath.relative(SOURCE_ROOT, file)]);
    }
  }
  return used;
}

describe("composer CSS contract", () => {
  it("styles every chat-composer class the components use", () => {
    const defined = definedSelectors();
    const orphans = Array.from(usedClassTokens().entries())
      .filter(([token]) => !defined.has(token) && !MARKER_CLASSES.has(token))
      .map(([token, files]) => `${token} <- ${files.join(", ")}`);

    expect(orphans).toEqual([]);
  });

  it("leaves no chat-composer selector behind once its markup is gone", () => {
    const used = usedClassTokens();
    const dead = Array.from(definedSelectors()).filter((token) => !used.has(token));

    expect(dead).toEqual([]);
  });
});
