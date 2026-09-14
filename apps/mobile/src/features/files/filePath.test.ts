import { describe, expect, it } from "vite-plus/test";

import {
  fileRoutePathSegments,
  isBrowserPreviewFile,
  isImagePreviewFile,
  isSvgImagePreviewFile,
  isVideoPreviewFile,
  rendersFromAssetUrl,
  resolveWorkspaceRelativeFilePath,
  fileHeaderSubtitle,
} from "./filePath";

describe("fileRoutePathSegments", () => {
  it("round-trips workspace-relative and host paths through the route", () => {
    expect(fileRoutePathSegments("src/main.ts")).toEqual(["src", "main.ts"]);
    expect(fileRoutePathSegments("/tmp/t3-cleanup/report.md").join("/")).toBe(
      "/tmp/t3-cleanup/report.md",
    );
  });
});

describe("resolveWorkspaceRelativeFilePath", () => {
  it("keeps normalized workspace-relative paths", () => {
    expect(resolveWorkspaceRelativeFilePath("/repo", "./src/../src/main.ts")).toBe("src/main.ts");
  });

  it("converts absolute paths inside the workspace", () => {
    expect(
      resolveWorkspaceRelativeFilePath("/Users/julius/repo", "/Users/julius/repo/src/main.ts"),
    ).toBe("src/main.ts");
    expect(resolveWorkspaceRelativeFilePath("C:\\repo", "c:\\repo\\src\\main.ts")).toBe(
      "src/main.ts",
    );
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
    expect(isImagePreviewFile("assets/diagram.SVG?raw=1")).toBe(true);
    expect(isImagePreviewFile("src/image.ts")).toBe(false);
  });

  it("recognizes video previews", () => {
    expect(isVideoPreviewFile("media/demo.mp4")).toBe(true);
    expect(isVideoPreviewFile("media/clip.MOV")).toBe(true);
    expect(isVideoPreviewFile("src/player.ts")).toBe(false);
  });

  it("identifies SVG images that need web rendering", () => {
    expect(isSvgImagePreviewFile("assets/diagram.svg#icon")).toBe(true);
    expect(isSvgImagePreviewFile("assets/photo.png")).toBe(false);
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

describe("fileHeaderSubtitle", () => {
  it("places a workspace file under its project", () => {
    expect(
      fileHeaderSubtitle("t3code", "apps/mobile/src/features/threads/fileChipMenu.test.ts"),
    ).toBe("t3code · apps/mobile/src/features/threads");
  });

  it("shows only the directory for a host file outside the workspace", () => {
    // It is not under the project, so naming the project there would be a lie.
    expect(fileHeaderSubtitle("t3code", "/tmp/report.md")).toBe("/tmp");
  });

  it("shows only the project for a file at the workspace root", () => {
    expect(fileHeaderSubtitle("t3code", "README.md")).toBe("t3code");
  });
});
