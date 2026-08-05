import { describe, expect, it } from "vite-plus/test";

import {
  absolutePathFromViewerSplat,
  resolveAddressBarCommit,
  resolveViewerNavigation,
  viewerSplatFromPath,
} from "./viewerPath";


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

describe("resolveAddressBarCommit", () => {
  const loaded = { value: "/Users/me/report.md", reverting: false };

  it("submits a path the user actually changed", () => {
    expect(resolveAddressBarCommit({ ...loaded, draft: "/Users/me/other.md" })).toEqual({
      kind: "submit",
      path: "/Users/me/other.md",
    });
  });

  it("trims before deciding, so trailing whitespace is not a new path", () => {
    expect(resolveAddressBarCommit({ ...loaded, draft: "  /Users/me/report.md  " })).toEqual({
      kind: "revert",
    });
  });

  it("reverts an emptied field instead of asking the viewer to open nothing", () => {
    expect(resolveAddressBarCommit({ ...loaded, draft: "   " })).toEqual({ kind: "revert" });
  });

  it("reverts when Escape ended the edit, even though the draft differs", () => {
    // Escape and focus loss both end the edit through the same blur, so without
    // this flag abandoning an edit would commit it.
    expect(
      resolveAddressBarCommit({ ...loaded, draft: "/Users/me/other.md", reverting: true }),
    ).toEqual({ kind: "revert" });
  });
});

describe("resolveViewerNavigation", () => {
  it("returns the splat to navigate to", () => {
    expect(resolveViewerNavigation("/Users/me/x.md", "Users/me/report.md")).toBe("Users/me/x.md");
  });

  it("declines a path the viewer is already showing", () => {
    // Navigating to the current location pushes a history entry that goes
    // nowhere, so Back stops working as the user expects.
    expect(resolveViewerNavigation("/Users/me/report.md", "Users/me/report.md")).toBeNull();
  });

  it("declines a relative path the route cannot express", () => {
    expect(resolveViewerNavigation("report.md", "Users/me/report.md")).toBeNull();
  });

  it("navigates from a viewer that has nothing open", () => {
    expect(resolveViewerNavigation("/Users/me/x.md", undefined)).toBe("Users/me/x.md");
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
