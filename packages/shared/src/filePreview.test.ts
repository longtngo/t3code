import { describe, expect, it } from "vite-plus/test";

import {
  filePreviewKind,
  decodeFilePreviewText,
  FILE_TEXT_PREVIEW_MAX_BYTES,
  hostPreviewMimeTypeFromExtension,
  isWorkspaceFontPreviewPath,
  isWorkspaceImagePreviewPath,
  isWorkspacePreviewEntryPath,
  isWorkspaceVideoPreviewPath,
  mediaKindFromPath,
  VIDEO_CONTENT_TYPE_BY_EXTENSION,
  WORKSPACE_TEXT_VIEWER_EXTENSIONS,
  WORKSPACE_VIDEO_PREVIEW_EXTENSIONS,
  officePreviewKind,
} from "./filePreview.ts";

describe("workspace file previews", () => {
  it.each([
    ["zip", "archive", "application/zip"],
    ["jar", "archive", "application/java-archive"],
    ["tar", "archive", "application/x-tar"],
    ["gz", "archive", "application/gzip"],
    ["tgz", "archive", "application/gzip"],
    ["sqlite", "sqlite", "application/vnd.sqlite3"],
    ["sqlite3", "sqlite", "application/vnd.sqlite3"],
    ["db", "sqlite", "application/vnd.sqlite3"],
  ])("recognizes binary preview %s", (extension, kind, mimeType) => {
    const name = `files#draft/sample.${extension.toUpperCase()}`;
    expect(filePreviewKind({ name, mimeType: "application/octet-stream" })).toBe(kind);
    expect(filePreviewKind({ name: "download", mimeType })).toBe(kind);
    expect(isWorkspacePreviewEntryPath(name)).toBe(true);
    expect(isWorkspacePreviewEntryPath(`${name}?download=1`)).toBe(false);
    expect(hostPreviewMimeTypeFromExtension(`.${extension}`)).toBe(mimeType);
  });
  it("recognizes compound archives and MIME aliases", () => {
    expect(filePreviewKind({ name: "archive.tar.gz" })).toBe("archive");
    expect(filePreviewKind({ name: "download", mimeType: "application/x-gzip" })).toBe("archive");
    expect(filePreviewKind({ name: "download", mimeType: "application/x-sqlite3" })).toBe("sqlite");
    expect(filePreviewKind({ name: "misleading.zip", mimeType: "application/pdf" })).toBe("pdf");
  });
  it.each(["ttf", "otf", "woff", "woff2"])(
    "previews %s fonts through signed host assets",
    (extension) => {
      expect(
        filePreviewKind({ name: `sample.${extension}`, mimeType: "application/octet-stream" }),
      ).toBe("font");
      expect(filePreviewKind({ name: "download", mimeType: `font/${extension}` })).toBe("font");
      expect(isWorkspaceFontPreviewPath(`/tmp/sample.${extension.toUpperCase()}`)).toBe(true);
      expect(isWorkspacePreviewEntryPath(`sample.${extension}`)).toBe(true);
      expect(hostPreviewMimeTypeFromExtension(`.${extension}`)).toBe(`font/${extension}`);
      expect(isWorkspaceFontPreviewPath(`sample.${extension}?download=1`)).toBe(false);
      expect(filePreviewKind({ name: `sample.${extension}`, mimeType: "application/zip" })).toBe(
        "archive",
      );
    },
  );
  it.each([
    [
      "quarterly-report.DOCX",
      "docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    [
      "finance#q4/operating-plan.xlsx",
      "xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
    [
      "slides?review/quarterly-review.pptx",
      "pptx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
    ["notes.odt", "odt", "application/vnd.oasis.opendocument.text"],
    ["budget.ods", "ods", "application/vnd.oasis.opendocument.spreadsheet"],
    ["deck.odp", "odp", "application/vnd.oasis.opendocument.presentation"],
    ["notes.rtf", "rtf", "application/rtf"],
    ["guide.epub", "epub", "application/epub+zip"],
    ["analysis.ipynb", "ipynb", "application/x-ipynb+json"],
  ])("recognizes Office assets at literal path %s", (name, kind, mimeType) => {
    expect(officePreviewKind({ name })).toBe(kind);
    expect(filePreviewKind({ name, mimeType: "application/octet-stream" })).toBe(kind);
    expect(isWorkspacePreviewEntryPath(name)).toBe(true);
    expect(hostPreviewMimeTypeFromExtension(`.${kind}`)).toBe(mimeType);
    expect(filePreviewKind({ name: "download", mimeType })).toBe(kind);
    expect(filePreviewKind({ name, mimeType: "application/zip" })).toBe("archive");
  });
  // regression: #10311 previews classify by the literal filename, not URL-like suffixes
  it.each([
    "image.png.ts",
    "image.png#notes.txt",
    "image%2Epng",
    "report.docx#notes.txt",
    "report.xlsx?download=1",
    "slides%2Epptx",
    "report.docm",
    "guide.epub?download=1",
    "analysis.ipynb#notes.txt",
    "report.odt.ts",
    "slides.ppt",
  ])("rejects non-preview path %s", (path) => {
    expect(isWorkspacePreviewEntryPath(path)).toBe(false);
  });

  it.each(["picture.bmp", "photo.heic", "photo.heif", "scan.tif", "scan.TIFF"])(
    "recognizes image preview path %s",
    (path) => {
      expect(isWorkspaceImagePreviewPath(path)).toBe(true);
      expect(isWorkspacePreviewEntryPath(path)).toBe(true);
    },
  );

  it("serves audio in place from the host like video and browser documents", () => {
    expect(hostPreviewMimeTypeFromExtension(".m4a")).toBe("audio/mp4");
    expect(hostPreviewMimeTypeFromExtension(".weba")).toBe("audio/webm");
    expect(hostPreviewMimeTypeFromExtension(".mp4")).toBe("video/mp4");
    expect(hostPreviewMimeTypeFromExtension(".txt")).toBeNull();
    expect(hostPreviewMimeTypeFromExtension(".constructor")).toBeNull();
    expect(hostPreviewMimeTypeFromExtension(".toString")).toBeNull();
    expect(hostPreviewMimeTypeFromExtension(".__proto__")).toBeNull();
    expect(hostPreviewMimeTypeFromExtension(".webm-audio")).toBe("audio/webm");
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
  it("recognises the five video extensions, case-insensitively, on the literal filename", () => {
    expect(isWorkspaceVideoPreviewPath("/Users/me/demo.mp4")).toBe(true);
    expect(isWorkspaceVideoPreviewPath("/Users/me/demo.WEBM")).toBe(true);
    expect(isWorkspaceVideoPreviewPath("/Users/me/clip.mov")).toBe(true);
    expect(isWorkspaceVideoPreviewPath("/Users/me/clip.m4v")).toBe(true);
    expect(isWorkspaceVideoPreviewPath("/Users/me/clip.ogv")).toBe(true);
    // Callers pass filesystem paths, so `?` and `#` are filename characters.
    expect(isWorkspaceVideoPreviewPath("/Users/me/demo#v2.mp4")).toBe(true);
    expect(isWorkspaceVideoPreviewPath("/Users/me/demo.mp4?raw=1")).toBe(false);
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
  // regression: #9023 media kind comes from the decoded pathname, ignoring query and hash
  it.each([
    ["https://cdn.example/clip.webm?download=1#t=2", "video"],
    ["https://example.com/download?name=recording.mp4", null],
    ["images%2Fresult%2Epng", "image"],
    ["images/result.png%23secret.txt", null],
    ["/tmp/tone.MP3", "audio"],
    ["./tone.wav", "audio"],
    ["tone.ogg", "audio"],
    ["tone.m4a", "audio"],
    ["tone.flac", "audio"],
    ["tone.aac", "audio"],
    ["tone.opus", "audio"],
    ["tone.webm-audio", "audio"],
    ["tone.webm", "video"],
    ["https://example.com/tone%2Emp3?download=1", "audio"],
    ["data.csv", null],
    ["report.pdf", null],
    ["report.docx", null],
    ["archive.zip", null],
  ])("classifies the decoded pathname of %s", (source, kind) => {
    expect(mediaKindFromPath(source)).toBe(kind);
  });
});

describe("attachment preview classification", () => {
  it.each([
    ["example.json", "application/octet-stream", "text"],
    ["report.pdf", "application/pdf", "pdf"],
    ["page.HTML", "", "html"],
    ["diagram.mmd", "", "mermaid"],
    ["diagram.MERMAID", "text/plain", "mermaid"],
    ["download", "text/vnd.mermaid", "mermaid"],
    ["source-code.otf", "application/vnd.oasis.opendocument.formula-template", "font"],
    ["notes.rtf", "application/rtf", "rtf"],
    ["notes.rtf", "", "rtf"],
    ["download", "text/rtf", "rtf"],
    ["analysis.IPYNB", "application/json", "ipynb"],
    ["clip.weba", "", "audio"],
    ["image.bmp", "application/octet-stream", "image"],
    ["photo.heic", "application/octet-stream", "image"],
    ["scan.tiff", "application/octet-stream", "image"],
    ["recording.mp3", "", "audio"],
    ["recording.webm-audio", "", "audio"],
    ["recording.webm", "audio/webm", "audio"],
    ["payload", "application/problem+json", "text"],
    ["archive.zip", "application/zip", "archive"],
    ["misleading.json", "application/pdf", "pdf"],
    ["misleading.pdf", "application/zip", "archive"],
  ])("classifies %s (%s) as %s", (name, mimeType, expected) => {
    expect(filePreviewKind({ name, mimeType })).toBe(expected);
  });
  it("rejects binary and invalid UTF-8 data", () => {
    expect(() => decodeFilePreviewText(new Uint8Array([65, 0, 66]))).toThrow("binary");
    expect(() => decodeFilePreviewText(new Uint8Array([255]))).toThrow("UTF-8");
  });
  it.each(["doc", "xls", "ppt", "7z", "rar"])(
    "retains the binary fallback for %s, which opencode does not render",
    (extension) => {
      expect(filePreviewKind({ name: `sample.${extension}` })).toBe("unsupported");
    },
  );
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
