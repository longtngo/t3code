import { describe, expect, it } from "vite-plus/test";

import {
  filePreviewKind,
  decodeFilePreviewText,
  FILE_TEXT_PREVIEW_MAX_BYTES,
  hostPreviewMimeTypeFromExtension,
  isWorkspaceAudioPreviewPath,
  isWorkspaceBrowserPreviewPath,
  isWorkspaceImagePreviewPath,
  isWorkspacePreviewEntryPath,
  isWorkspaceVideoPreviewPath,
  mediaKindFromPath,
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

  it("serves audio in place from the host like video and browser documents", () => {
    expect(isWorkspaceAudioPreviewPath("notes/recording.WAV")).toBe(true);
    expect(isWorkspaceAudioPreviewPath("recording.wav.ts")).toBe(false);
    expect(hostPreviewMimeTypeFromExtension(".m4a")).toBe("audio/mp4");
    expect(hostPreviewMimeTypeFromExtension(".mp4")).toBe("video/mp4");
    expect(hostPreviewMimeTypeFromExtension(".txt")).toBeNull();
  });
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

describe("media path parsing", () => {
  it.each([
    ["https://cdn.example/clip.webm?download=1#t=2", "video"],
    ["https://example.com/download?name=recording.mp4", null],
    ["https://example.png", null],
    ["images%2Fresult%2Epng", "image"],
    ["images/result%23v2.png", "image"],
    ["images/result.png%23secret.txt", null],
    ["images/result.png%3Fsecret.txt", null],
    ["/tmp/100%.png", "image"],
  ])("classifies the decoded pathname of %s", (source, kind) => {
    expect(mediaKindFromPath(source)).toBe(kind);
  });

  // FORK: the third column is retargeted. Upstream's `isWorkspaceVideoPreviewPath`
  // reads the literal filename, so a trailing `#t=2` keeps it a video and a bare
  // `recording#take2.mp4` is one too. This fork's predicate strips the query and
  // fragment first, because its own viewer appends `?raw=1` to every media URL
  // (asserted above). The `mediaKindFromPath` column is upstream's, unchanged.
  it.each([
    ["recording.mp4#t=2", "video", true],
    ["recording%2Emp4", "video", false],
    ["recording#take2.mp4", null, false],
    ["recording?take2.mp4", null, false],
  ])(
    "parses authored URLs while the viewer predicate strips query and fragment in %s",
    (source, kind, literalVideo) => {
      expect(mediaKindFromPath(source)).toBe(kind);
      expect(isWorkspaceVideoPreviewPath(source)).toBe(literalVideo);
    },
  );
});

describe("attachment preview classification", () => {
  it.each([
    ["example.json", "application/octet-stream", "text"],
    ["README.md", "text/plain", "markdown"],
    ["component.tsx", "", "text"],
    ["report.pdf", "application/pdf", "pdf"],
    ["page.HTML", "", "html"],
    ["recording.mp3", "", "audio"],
    ["payload", "application/problem+json", "text"],
    ["archive.zip", "application/zip", "unsupported"],
    ["misleading.json", "application/pdf", "pdf"],
    ["misleading.pdf", "application/zip", "unsupported"],
  ])("classifies %s (%s) as %s", (name, mimeType, expected) => {
    expect(filePreviewKind({ name, mimeType })).toBe(expected);
  });
  it("rejects binary and invalid UTF-8 data", () => {
    expect(() => decodeFilePreviewText(new Uint8Array([65, 0, 66]))).toThrow("binary");
    expect(() => decodeFilePreviewText(new Uint8Array([255]))).toThrow("UTF-8");
  });
  it("does not corrupt a multi-byte character at the preview boundary", () => {
    const bytes = new Uint8Array(FILE_TEXT_PREVIEW_MAX_BYTES + 1).fill(97);
    bytes[FILE_TEXT_PREVIEW_MAX_BYTES - 1] = 0xe2;
    bytes[FILE_TEXT_PREVIEW_MAX_BYTES] = 0x82;
    const preview = decodeFilePreviewText(bytes);
    expect(preview.truncated).toBe(true);
    expect(preview.text.endsWith("�")).toBe(false);
    expect(preview.text.length).toBe(FILE_TEXT_PREVIEW_MAX_BYTES - 1);
  });
});
