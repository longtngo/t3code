import { describe, expect, it } from "vite-plus/test";

import {
  isWorkspaceBrowserPreviewPath,
  isWorkspaceImagePreviewPath,
  isWorkspacePreviewEntryPath,
  isWorkspaceVideoPreviewPath,
  VIDEO_CONTENT_TYPE_BY_EXTENSION,
  WORKSPACE_TEXT_VIEWER_EXTENSIONS,
  WORKSPACE_VIDEO_PREVIEW_EXTENSIONS,
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

describe("workspace video preview paths", () => {
  it("recognises the five video extensions, case-insensitively and past a query string", () => {
    expect(isWorkspaceVideoPreviewPath("/Users/me/demo.mp4")).toBe(true);
    expect(isWorkspaceVideoPreviewPath("/Users/me/demo.WEBM")).toBe(true);
    expect(isWorkspaceVideoPreviewPath("/Users/me/clip.mov")).toBe(true);
    expect(isWorkspaceVideoPreviewPath("/Users/me/clip.m4v")).toBe(true);
    expect(isWorkspaceVideoPreviewPath("/Users/me/clip.ogv")).toBe(true);
    expect(isWorkspaceVideoPreviewPath("/Users/me/demo.mp4?raw=1")).toBe(true);
  });

  it("rejects non-video paths, including lookalikes", () => {
    expect(isWorkspaceVideoPreviewPath("/Users/me/photo.png")).toBe(false);
    expect(isWorkspaceVideoPreviewPath("/Users/me/notes.md")).toBe(false);
    expect(isWorkspaceVideoPreviewPath("/Users/me/mp4")).toBe(false);
    expect(isWorkspaceVideoPreviewPath("/Users/me/archive.mp4.zip")).toBe(false);
  });

  it("maps every listed extension to a content type", () => {
    for (const extension of WORKSPACE_VIDEO_PREVIEW_EXTENSIONS) {
      expect(VIDEO_CONTENT_TYPE_BY_EXTENSION[extension]).toMatch(/^video\//);
    }
  });

  // `/api/assets` admits video by naming this predicate's sibling explicitly.
  // Widening the entry predicate instead would also turn on "open in a browser
  // preview" for video, which is a different feature nobody asked for.
  it("leaves the browser-preview entry predicate untouched", () => {
    expect(isWorkspacePreviewEntryPath("/Users/me/demo.mp4")).toBe(false);
  });
});
