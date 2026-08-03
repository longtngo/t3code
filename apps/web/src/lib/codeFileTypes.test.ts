import { describe, expect, it } from "vite-plus/test";

import {
  TEXT_FILE_EXTENSIONS,
  classifyFileViewerKind,
  languageForPath,
} from "./codeFileTypes";

describe("classifyFileViewerKind", () => {
  it("classifies html and markdown specially", () => {
    expect(classifyFileViewerKind("/a/b/report.html")).toBe("html");
    expect(classifyFileViewerKind("page.HTM")).toBe("html");
    expect(classifyFileViewerKind("~/notes.md")).toBe("markdown");
    expect(classifyFileViewerKind("notes.MARKDOWN")).toBe("markdown");
  });

  it("classifies allow-listed text/code files as code", () => {
    expect(classifyFileViewerKind("~/src/x/validate_sql_qa.py")).toBe("code");
    expect(classifyFileViewerKind("notes.txt")).toBe("code");
    expect(classifyFileViewerKind("server.log")).toBe("code");
    expect(classifyFileViewerKind("main.rs")).toBe("code");
    expect(classifyFileViewerKind("/etc/app/config.toml")).toBe("code");
    expect(classifyFileViewerKind("Component.tsx")).toBe("code");
    expect(classifyFileViewerKind("query.SQL")).toBe("code"); // case-insensitive
  });

  it("returns null for unsupported, binary, secret, and extension-less files", () => {
    expect(classifyFileViewerKind("photo.png")).toBeNull();
    expect(classifyFileViewerKind("archive.zip")).toBeNull();
    expect(classifyFileViewerKind("video.mp4")).toBeNull();
    expect(classifyFileViewerKind(".env")).toBeNull(); // dotfile / secret
    expect(classifyFileViewerKind("Makefile")).toBeNull(); // no extension
    expect(classifyFileViewerKind("/a/b/")).toBeNull(); // directory
    expect(classifyFileViewerKind("plainname")).toBeNull();
  });

  it("strips query/hash before classifying", () => {
    expect(classifyFileViewerKind("script.py?v=2")).toBe("code");
    expect(classifyFileViewerKind("notes.md#section")).toBe("markdown");
  });

  it("matches the real extension of a dotfile-with-extension", () => {
    expect(classifyFileViewerKind(".eslintrc.json")).toBe("code");
  });

  it("excludes the ambiguous single-letter .m / .mm extensions", () => {
    expect(TEXT_FILE_EXTENSIONS.has("m")).toBe(false);
    expect(TEXT_FILE_EXTENSIONS.has("mm")).toBe(false);
    expect(classifyFileViewerKind("model.m")).toBeNull();
  });
});

describe("languageForPath", () => {
  it("resolves a Shiki language id from the extension", () => {
    // Exact ids come from @pierre/diffs; assert it resolves to a real (non-text) lang.
    expect(languageForPath("a.py")).not.toBe("text");
    expect(languageForPath("a.ts")).not.toBe("text");
  });

  it("falls back to 'text' for unknown extensions", () => {
    expect(languageForPath("a.unknownxyz")).toBe("text");
  });

  it("resolves from the basename, not parent directories", () => {
    expect(languageForPath("/a.py/b/c.unknownxyz")).toBe("text");
  });
});
