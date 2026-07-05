import { describe, expect, it } from "vite-plus/test";

import { resizeImageForUpload } from "~/lib/imageResize";

// Exercises the real canvas resize path in a browser — the environment web/desktop
// uploads actually run in (the node unit test only covers the passthrough cases).
describe("resizeImageForUpload (browser)", () => {
  it("downscales a large image and re-encodes it smaller and within the cap", async () => {
    const width = 4000;
    const height = 3000;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("2d canvas context unavailable in the test browser");
    }
    // Fill with deterministic pseudo-random noise so the source PNG is genuinely
    // large (incompressible) and the smaller-dimension JPEG re-encode wins.
    const imageData = context.createImageData(width, height);
    let state = 0x12345678;
    const nextByte = () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return (state >>> 16) & 0xff;
    };
    for (let index = 0; index < imageData.data.length; index += 4) {
      imageData.data[index] = nextByte();
      imageData.data[index + 1] = nextByte();
      imageData.data[index + 2] = nextByte();
      imageData.data[index + 3] = 255;
    }
    context.putImageData(imageData, 0, 0);
    const sourceBlob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((blob) => resolve(blob), "image/png");
    });
    if (!sourceBlob) {
      throw new Error("failed to build the source image blob");
    }
    const file = new File([sourceBlob], "photo.png", { type: "image/png" });
    expect(file.size).toBeGreaterThan(100 * 1024);

    // Lower the size floor so this test image qualifies; the dimension cap + JPEG
    // re-encode are what we're verifying, not the threshold.
    const resized = await resizeImageForUpload(file, { minBytesToResize: 100 * 1024 });
    expect(resized).not.toBe(file);
    expect(resized.type).toBe("image/jpeg");
    expect(resized.size).toBeLessThan(file.size);

    const decoded = await createImageBitmap(resized);
    expect(Math.max(decoded.width, decoded.height)).toBeLessThanOrEqual(2048);
    decoded.close();
  });
});
