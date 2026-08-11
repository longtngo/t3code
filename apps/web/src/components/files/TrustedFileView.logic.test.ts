import { describe, expect, it } from "vite-plus/test";

import { directoryOfAbsolutePath, trustedViewKind } from "./TrustedFileView";

describe("trustedViewKind", () => {
  it("renders html as a document, which is what gives it a source toggle", () => {
    expect(trustedViewKind("/Users/me/report.html")).toBe("html");
    expect(trustedViewKind("/Users/me/report.HTM")).toBe("html");
  });

  it("classifies images, which are read as bytes rather than text", () => {
    expect(trustedViewKind("/Users/me/dashboard.png")).toBe("image");
    expect(trustedViewKind("/Users/me/logo.svg")).toBe("image");
  });

  it("keeps .mdx as markdown, which the shared classifier alone would drop", () => {
    // classifyFileViewerKind covers only md|markdown; losing mdx here would demote
    // it from rendered markdown to source.
    expect(trustedViewKind("/Users/me/notes.mdx")).toBe("markdown");
    expect(trustedViewKind("/Users/me/notes.md")).toBe("markdown");
  });

  it("falls back to code for anything unclassified, so the address bar still works", () => {
    // A null classification means "do not make this a chip", NOT "unviewable".
    expect(trustedViewKind("/Users/me/Makefile")).toBe("code");
    expect(trustedViewKind("/Users/me/Dockerfile")).toBe("code");
    expect(trustedViewKind("/Users/me/.env")).toBe("code");
    expect(trustedViewKind("/Users/me/data.weirdext")).toBe("code");
    expect(trustedViewKind("/Users/me/main.ts")).toBe("code");
  });
});

describe("directoryOfAbsolutePath", () => {
  it("returns the parent directory, which markdown relative links resolve against", () => {
    expect(directoryOfAbsolutePath("/Users/me/reports/a.md")).toBe("/Users/me/reports");
  });

  it("keeps root as root rather than collapsing to an empty cwd", () => {
    expect(directoryOfAbsolutePath("/a.md")).toBe("/");
  });
});
