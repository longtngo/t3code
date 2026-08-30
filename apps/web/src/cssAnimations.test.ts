import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

/**
 * A standing guard for the repo's "no continuously repainting animations" rule.
 *
 * Animating `transform` or `opacity` stays on the compositor and is fine forever.
 * Animating `background-position`, `filter`, `box-shadow` and friends repaints
 * every frame, and an `infinite` one never stops - on a 120Hz display that is a
 * permanent GPU cost for as long as the element is mounted. Those must at least
 * stand still under `prefers-reduced-motion: reduce`.
 */
const CSS = readFileSync(new URL("./index.css", import.meta.url), "utf8");

/** Properties whose animation forces paint rather than compositing. */
const REPAINTING = [
  "background-position",
  "background-image",
  "background-color",
  "filter",
  "backdrop-filter",
  "box-shadow",
  "border-color",
  "color",
  "width",
  "height",
  "top",
  "left",
  "mask-position",
];

const keyframeBlocks = (): Map<string, string> => {
  const blocks = new Map<string, string>();
  const re = /@keyframes\s+([\w-]+)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(CSS)) !== null) {
    let depth = 1;
    let index = re.lastIndex;
    while (index < CSS.length && depth > 0) {
      if (CSS[index] === "{") depth += 1;
      else if (CSS[index] === "}") depth -= 1;
      index += 1;
    }
    blocks.set(match[1]!, CSS.slice(re.lastIndex, index));
  }
  return blocks;
};

/** The CSS rule body containing `position`, so a nested @media is visible. */
const enclosingRule = (position: number): string => {
  let start = position;
  let depth = 0;
  while (start > 0) {
    start -= 1;
    if (CSS[start] === "}") depth += 1;
    else if (CSS[start] === "{") {
      if (depth === 0) break;
      depth -= 1;
    }
  }
  let end = position;
  depth = 1;
  while (end < CSS.length && depth > 0) {
    if (CSS[end] === "{") depth += 1;
    else if (CSS[end] === "}") depth -= 1;
    end += 1;
  }
  return CSS.slice(start, end);
};

const infiniteAnimations = () => {
  const frames = keyframeBlocks();
  const found: Array<{ name: string; repaints: string[]; guarded: boolean }> = [];
  const re = /animation:\s*([\w-]+)[^;]*\binfinite\b[^;]*;/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(CSS)) !== null) {
    const name = match[1]!;
    const body = frames.get(name);
    if (body === undefined) continue;
    const repaints = REPAINTING.filter((property) =>
      new RegExp(`(^|[;{\\s])${property}\\s*:`).test(body),
    );
    found.push({
      name,
      repaints,
      guarded: enclosingRule(match.index).includes("prefers-reduced-motion"),
    });
  }
  return found;
};

describe("continuously repainting animations", () => {
  it("finds the infinite animations it is meant to police", () => {
    // The detector must be able to see something, or a clean result below is
    // vacuous: an empty scan and a compliant stylesheet look identical.
    const all = infiniteAnimations();
    expect(all.length).toBeGreaterThan(3);
    expect(all.some((entry) => entry.repaints.length > 0)).toBe(true);
  });

  it("guards every infinite animation that repaints with prefers-reduced-motion", () => {
    const offenders = infiniteAnimations()
      .filter((entry) => entry.repaints.length > 0 && !entry.guarded)
      .map((entry) => `${entry.name} (animates ${entry.repaints.join(", ")})`);

    expect(offenders).toEqual([]);
  });
});
