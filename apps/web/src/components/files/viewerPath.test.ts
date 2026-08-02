import { describe, expect, it } from "vite-plus/test";

import { absolutePathFromViewerSplat, viewerSplatFromPath } from "./viewerPath";


describe("absolutePathFromViewerSplat", () => {
  it("restores the leading slash the router strips from the splat", () => {
    expect(absolutePathFromViewerSplat("Users/foo/report.md")).toBe("/Users/foo/report.md");
  });

  it("collapses accidental duplicate leading slashes to a single root slash", () => {
    expect(absolutePathFromViewerSplat("/Users/foo/report.md")).toBe("/Users/foo/report.md");
    expect(absolutePathFromViewerSplat("///Users/foo")).toBe("/Users/foo");
  });

  it("returns null for an empty, missing, or slash-only splat", () => {
    expect(absolutePathFromViewerSplat("")).toBeNull();
    expect(absolutePathFromViewerSplat(undefined)).toBeNull();
    expect(absolutePathFromViewerSplat(null)).toBeNull();
    expect(absolutePathFromViewerSplat("/")).toBeNull();
    expect(absolutePathFromViewerSplat("///")).toBeNull();
  });
});

describe("viewerSplatFromPath", () => {
  it("strips the leading slash so the router can rebuild the /viewer/<abs> URL", () => {
    expect(viewerSplatFromPath("/Users/foo/report.md")).toBe("Users/foo/report.md");
  });

  it("trims whitespace and a file:// scheme before validating", () => {
    expect(viewerSplatFromPath("  /Users/foo/report.md  ")).toBe("Users/foo/report.md");
    expect(viewerSplatFromPath("file:///Users/foo/report.md")).toBe("Users/foo/report.md");
  });

  it("rejects a relative or empty path (the trusted read requires an absolute path)", () => {
    expect(viewerSplatFromPath("reports/report.md")).toBeNull();
    expect(viewerSplatFromPath("")).toBeNull();
    expect(viewerSplatFromPath("   ")).toBeNull();
  });

  it("round-trips with absolutePathFromViewerSplat", () => {
    const abs = "/Users/foo/deep/nested/report.md";
    const splat = viewerSplatFromPath(abs);
    expect(splat).not.toBeNull();
    expect(absolutePathFromViewerSplat(splat)).toBe(abs);
  });
});
