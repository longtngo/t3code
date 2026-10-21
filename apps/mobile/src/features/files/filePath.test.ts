import { describe, expect, it } from "vite-plus/test";

import {
  fileRoutePathSegments,
  isBrowserPreviewFile,
  isImagePreviewFile,
  isVideoPreviewFile,
  rendersFromAssetUrl,
  resolveFileLinkPath,
  resolveWorkspaceRelativeFilePath,
} from "./filePath";

describe("resolveFileLinkPath", () => {
  it.each([
    ["/home/maria/project", "~/.agents/AGENTS.md", "/home/maria/.agents/AGENTS.md"],
    ["/Users/maria/project", "~/notes.md", "/Users/maria/notes.md"],
    ["C:\\Users\\maria\\project", "~\\.agents\\AGENTS.md", "C:\\Users\\maria\\.agents\\AGENTS.md"],
  ])("expands a home link from %s", (cwd, path, expected) => {
    expect(resolveFileLinkPath(cwd, path)).toBe(expected);
    expect(fileRoutePathSegments(expected).join("/")).toBe(expected);
  });

  it("does not turn an unresolved home into a workspace path", () => {
    expect(resolveFileLinkPath("/repo", "~/notes.md")).toBeNull();
    expect(resolveFileLinkPath(null, "~/notes.md")).toBeNull();
    expect(resolveFileLinkPath("/repo", "../notes.md")).toBeNull();
  });
});

describe("resolveWorkspaceRelativeFilePath", () => {
  it("converts absolute paths inside the workspace", () => {
    expect(
      resolveWorkspaceRelativeFilePath("/Users/julius/repo", "/Users/julius/repo/src/main.ts"),
    ).toBe("src/main.ts");
    expect(resolveWorkspaceRelativeFilePath("C:\\repo", "c:\\repo\\src\\main.ts")).toBe(
      "src/main.ts",
    );
  });

  it("recognizes home links inside the workspace", () => {
    expect(resolveWorkspaceRelativeFilePath("/home/maria/project", "~/project/src/main.ts")).toBe(
      "src/main.ts",
    );
    expect(
      resolveWorkspaceRelativeFilePath("/home/maria/project", "~/.agents/AGENTS.md"),
    ).toBeNull();
  });

  it("rejects paths outside the workspace", () => {
    expect(resolveWorkspaceRelativeFilePath("/repo", "/other/main.ts")).toBeNull();
    expect(resolveWorkspaceRelativeFilePath("/repo", "../other/main.ts")).toBeNull();
    expect(resolveWorkspaceRelativeFilePath("/repo", "/repo/../outside.txt")).toBeNull();
    expect(resolveWorkspaceRelativeFilePath(null, "/repo/main.ts")).toBeNull();
  });
});

describe("file preview types", () => {
  it("recognizes browser and image previews", () => {
    expect(isBrowserPreviewFile("reports/summary.html")).toBe(true);
    expect(isImagePreviewFile("assets/icon.png")).toBe(true);
    expect(isImagePreviewFile("assets/diagram.SVG")).toBe(true);
    // Paths are literal filenames: `?` does not start a query.
    expect(isImagePreviewFile("assets/diagram.SVG?raw=1")).toBe(false);
    expect(isImagePreviewFile("src/image.ts")).toBe(false);
  });

  it("recognizes video previews", () => {
    expect(isVideoPreviewFile("media/demo.mp4")).toBe(true);
    expect(isVideoPreviewFile("media/clip.MOV")).toBe(true);
    expect(isVideoPreviewFile("src/player.ts")).toBe(false);
  });
});

describe("rendersFromAssetUrl", () => {
  // Drives both the file screen's default view mode and the text preload skip.
  // A video answering false is preloaded as text and opens on the binary read
  // error, which is exactly the bug this branch fixes.
  it("covers every kind the screen previews from its asset URL", () => {
    expect(rendersFromAssetUrl("media/demo.mp4")).toBe(true);
    expect(rendersFromAssetUrl("assets/icon.png")).toBe(true);
    expect(rendersFromAssetUrl("reports/summary.html")).toBe(true);
    expect(rendersFromAssetUrl("media/voice.mp3")).toBe(true);
  });

  it("leaves text and markdown on the source path", () => {
    expect(rendersFromAssetUrl("src/main.ts")).toBe(false);
    expect(rendersFromAssetUrl("README.md")).toBe(false);
  });
});
