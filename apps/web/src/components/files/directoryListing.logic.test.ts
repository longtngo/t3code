import { describe, expect, it } from "vite-plus/test";

import {
  isDirectoryListing,
  listedFileTarget,
  workspaceListingPath,
} from "./directoryListing.logic";

describe("workspaceListingPath", () => {
  it("joins the panel's cwd to the relative path", () => {
    expect(workspaceListingPath("/Users/me/proj", "src/components")).toBe(
      "/Users/me/proj/src/components",
    );
  });

  it("does not double the separator, whichever side carries it", () => {
    expect(workspaceListingPath("/Users/me/proj/", "src")).toBe("/Users/me/proj/src");
    expect(workspaceListingPath("/Users/me/proj", "/src")).toBe("/Users/me/proj/src");
    expect(workspaceListingPath("/Users/me/proj//", "//src")).toBe("/Users/me/proj/src");
  });

  it("joins a Windows cwd with the separator it already uses", () => {
    // "/" here would build `C:\Users\me\proj/src`, which listedFileTarget then
    // refuses to recognise as its own root, so every workspace file on Windows
    // would open read-only.
    expect(workspaceListingPath("C:\\Users\\me\\proj", "src\\components")).toBe(
      "C:\\Users\\me\\proj\\src\\components",
    );
    expect(workspaceListingPath("C:\\Users\\me\\proj\\", "\\src")).toBe("C:\\Users\\me\\proj\\src");
  });

  it("keeps forward slashes when a Windows path is written with them", () => {
    expect(workspaceListingPath("C:/Users/me/proj", "src")).toBe("C:/Users/me/proj/src");
  });

  it("joins a UNC share the same way", () => {
    expect(workspaceListingPath("\\\\server\\share\\proj", "src")).toBe(
      "\\\\server\\share\\proj\\src",
    );
  });

  it("keeps a trailing separator the author wrote on the relative path", () => {
    // `docs/` is how an agent usually writes a folder, and the listing request
    // appends its own separator anyway — what matters is that the root stays a
    // path under cwd rather than growing an empty segment in the middle.
    expect(workspaceListingPath("/Users/me/proj", "docs/")).toBe("/Users/me/proj/docs/");
  });
});

describe("listedFileTarget", () => {
  it("keeps a workspace-relative path for a file under the project root", () => {
    expect(listedFileTarget("/Users/me/proj", "/Users/me/proj/src/index.ts")).toEqual({
      kind: "workspace",
      relativePath: "src/index.ts",
    });
  });

  it("tolerates a trailing separator on the root", () => {
    expect(listedFileTarget("/Users/me/proj/", "/Users/me/proj/README.md")).toEqual({
      kind: "workspace",
      relativePath: "README.md",
    });
  });

  it("keeps a workspace-relative path on Windows, separators and all", () => {
    expect(listedFileTarget("C:\\Users\\me\\proj", "C:\\Users\\me\\proj\\src\\index.ts")).toEqual({
      kind: "workspace",
      relativePath: "src\\index.ts",
    });
  });

  it("matches a Windows root against a listing written with the other separator", () => {
    // Mixed separators are legal on Windows, and the two sides of this
    // comparison do not have to come from the same writer.
    expect(listedFileTarget("C:\\Users\\me\\proj", "C:/Users/me/proj/src/index.ts")).toEqual({
      kind: "workspace",
      relativePath: "src/index.ts",
    });
  });

  it("sends a Windows file outside the workspace to the absolute viewer", () => {
    expect(listedFileTarget("C:\\Users\\me\\proj", "D:\\scratch\\notes.md")).toEqual({
      kind: "absolute",
      absolutePath: "D:\\scratch\\notes.md",
    });
  });

  it("sends a file outside the workspace to the absolute viewer", () => {
    expect(listedFileTarget("/Users/me/proj", "/Users/me/reports/2026-08/summary.md")).toEqual({
      kind: "absolute",
      absolutePath: "/Users/me/reports/2026-08/summary.md",
    });
  });

  it("does not treat a sibling with the same prefix as inside the workspace", () => {
    // `/Users/me/proj-old` starts with `/Users/me/proj`, so a prefix test that
    // forgot the separator would hand the editor a relative path beginning
    // "-old/", which resolves to nothing.
    expect(listedFileTarget("/Users/me/proj", "/Users/me/proj-old/index.ts")).toEqual({
      kind: "absolute",
      absolutePath: "/Users/me/proj-old/index.ts",
    });
  });

  it("treats the root itself as outside, since it has no relative path", () => {
    expect(listedFileTarget("/Users/me/proj", "/Users/me/proj")).toEqual({
      kind: "absolute",
      absolutePath: "/Users/me/proj",
    });
  });
});

describe("isDirectoryListing", () => {
  it("accepts a listing the server confirmed it produced", () => {
    expect(isDirectoryListing({ listedFiles: true })).toBe(true);
  });

  it("rejects a legacy answer from a server that dropped includeFiles", () => {
    // The shape is a perfectly valid success — an empty directories-only
    // listing — which is why the flag has to carry the answer. Without this,
    // a folder of files reads as empty and its subfolders read as files.
    expect(isDirectoryListing({})).toBe(false);
    expect(isDirectoryListing({ listedFiles: undefined })).toBe(false);
  });

  it("rejects nothing at all", () => {
    expect(isDirectoryListing(null)).toBe(false);
  });
});
