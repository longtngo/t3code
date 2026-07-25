import { describe, expect, it } from "vite-plus/test";

import { computeResizedDimensions, resizeImageForUpload } from "./imageResize.ts";

describe("computeResizedDimensions", () => {
  it("caps the longest edge and preserves aspect ratio", () => {
    expect(computeResizedDimensions(4000, 3000, 2048)).toEqual({ width: 2048, height: 1536 });
    expect(computeResizedDimensions(3000, 4000, 2048)).toEqual({ width: 1536, height: 2048 });
  });

  it("never upscales an already-small image", () => {
    expect(computeResizedDimensions(800, 600, 2048)).toEqual({ width: 800, height: 600 });
  });

  it("handles the exact-cap and degenerate cases", () => {
    expect(computeResizedDimensions(2048, 1024, 2048)).toEqual({ width: 2048, height: 1024 });
    expect(computeResizedDimensions(0, 0, 2048)).toEqual({ width: 0, height: 0 });
  });
});

describe("resizeImageForUpload passthrough", () => {
  it("returns non-image files unchanged", async () => {
    const file = new File(["plain text"], "notes.txt", { type: "text/plain" });
    expect(await resizeImageForUpload(file)).toBe(file);
  });

  it("returns small images unchanged (not worth re-encoding)", async () => {
    const file = new File([new Uint8Array(1024)], "small.png", { type: "image/png" });
    expect(await resizeImageForUpload(file)).toBe(file);
  });

  it("returns the original when the environment cannot resize (no canvas)", async () => {
    // Node has no DOM/canvas, so even a large image passes through untouched rather
    // than blocking the upload.
    const file = new File([new Uint8Array(1024 * 1024)], "big.png", { type: "image/png" });
    expect(await resizeImageForUpload(file)).toBe(file);
  });
});
