import { describe, expect, it } from "vite-plus/test";

import { urlBase64ToUint8Array } from "./webPush.ts";

describe("urlBase64ToUint8Array", () => {
  it("decodes a URL-safe base64 VAPID key to the expected bytes", () => {
    // "-_-_" is URL-safe base64 for bytes [0xFB, 0xFF, 0xBF].
    const bytes = urlBase64ToUint8Array("-_-_");
    expect(Array.from(bytes)).toEqual([0xfb, 0xff, 0xbf]);
  });

  it("pads unpadded input correctly", () => {
    // "TQ" (unpadded) → "TQ==" → single byte 0x4d ('M').
    const bytes = urlBase64ToUint8Array("TQ");
    expect(Array.from(bytes)).toEqual([0x4d]);
  });

  it("produces an ArrayBuffer-backed Uint8Array of the right length", () => {
    const bytes = urlBase64ToUint8Array("AAAA"); // 3 zero bytes
    expect(bytes.length).toBe(3);
    expect(bytes.buffer).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(bytes)).toEqual([0, 0, 0]);
  });
});
