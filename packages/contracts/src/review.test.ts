import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ReviewDiffFileContentsInput, ReviewDiffPreviewInput } from "./review.ts";

const decodePreview = Schema.decodeUnknownSync(ReviewDiffPreviewInput);
const decodeFileContents = Schema.decodeUnknownSync(ReviewDiffFileContentsInput);

const fileContents = (overrides: Record<string, unknown>) => ({
  cwd: "/repo",
  sourceKind: "branch-range",
  changeType: "change",
  baseRef: "main",
  headRef: "HEAD",
  oldPath: "src/a.ts",
  newPath: "src/a.ts",
  ...overrides,
});

describe("review revision inputs", () => {
  it("accepts the revision shapes review actually sends", () => {
    expect(decodePreview({ cwd: "/repo", baseRef: "origin/main" }).baseRef).toBe("origin/main");
    for (const revision of ["HEAD", "HEAD~3", "v1.2.3", "abc1234", "feature/x"]) {
      expect(decodePreview({ cwd: "/repo", baseRef: revision }).baseRef).toBe(revision);
    }
  });

  it("rejects an option-shaped revision, which git would parse as a flag", () => {
    // `git diff --output=<path>` creates and truncates <path> while parsing arguments —
    // before it fails — so an unvalidated ref turns these read-only RPCs into a file
    // clobber. Git will not create a ref beginning with "-", so nothing real is refused.
    expect(() => decodePreview({ cwd: "/repo", baseRef: "--output=/tmp/pwned" })).toThrow();
    expect(() => decodePreview({ cwd: "/repo", baseRef: "-o/tmp/pwned" })).toThrow();
  });

  it("rejects option-shaped refs and paths on the file-contents input", () => {
    for (const field of ["baseRef", "headRef", "oldPath", "newPath"]) {
      expect(() => decodeFileContents(fileContents({ [field]: "--output=/tmp/pwned" }))).toThrow();
    }
    expect(decodeFileContents(fileContents({})).baseRef).toBe("main");
  });
});
