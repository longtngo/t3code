import { describe, expect, it } from "vite-plus/test";

import {
  isWorkspaceBrowserPreviewPath,
  isWorkspaceImagePreviewPath,
  isWorkspacePreviewEntryPath,
  WORKSPACE_TEXT_VIEWER_EXTENSIONS,
} from "./filePreview.ts";

describe("workspace file previews", () => {
  it.each(["report.html", "report.HTM", "document.pdf?download=1"])(
    "recognizes browser preview path %s",
    (path) => {
      expect(isWorkspaceBrowserPreviewPath(path)).toBe(true);
      expect(isWorkspacePreviewEntryPath(path)).toBe(true);
    },
  );

  it.each([
    "icon.png",
    "photo.JPEG",
    "animation.gif",
    "vector.svg#mark",
    "texture.webp",
    "image.avif",
  ])("recognizes image preview path %s", (path) => {
    expect(isWorkspaceImagePreviewPath(path)).toBe(true);
    expect(isWorkspacePreviewEntryPath(path)).toBe(true);
  });

  it.each(["README.md", "src/index.ts", "image.png.ts", "png"])(
    "rejects non-preview path %s",
    (path) => {
      expect(isWorkspacePreviewEntryPath(path)).toBe(false);
    },
  );
});

describe("workspace text viewer extensions", () => {
  // The client matches on a bare extension and the server on a dotted one, so
  // this list is only shareable while every entry is dotted and lowercase.
  it("is uniformly dotted, lowercase and free of duplicates", () => {
    const malformed = WORKSPACE_TEXT_VIEWER_EXTENSIONS.filter(
      (extension) => !/^\.[a-z0-9]+$/.test(extension),
    );

    expect(malformed).toEqual([]);
    expect(new Set(WORKSPACE_TEXT_VIEWER_EXTENSIONS).size).toBe(
      WORKSPACE_TEXT_VIEWER_EXTENSIONS.length,
    );
  });

  // These are not oversights, so an addition should have to argue with a test
  // rather than silently widen the one gate that keeps prose like `example.com`
  // from turning into a clickable chip.
  it.each([".md", ".markdown", ".html", ".htm", ".env", ".png", ".pdf", ".m", ".mm"])(
    "deliberately excludes %s",
    (extension) => {
      expect(WORKSPACE_TEXT_VIEWER_EXTENSIONS).not.toContain(extension);
    },
  );

  it("still covers the common cases both surfaces rely on", () => {
    // The pair to the exclusions above: an empty or gutted list would satisfy
    // every "not.toContain" in this block.
    expect(WORKSPACE_TEXT_VIEWER_EXTENSIONS).toContain(".ts");
    expect(WORKSPACE_TEXT_VIEWER_EXTENSIONS).toContain(".json");
    expect(WORKSPACE_TEXT_VIEWER_EXTENSIONS).toContain(".py");
    expect(WORKSPACE_TEXT_VIEWER_EXTENSIONS.length).toBeGreaterThan(60);
  });
});
