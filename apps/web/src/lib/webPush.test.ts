import { describe, expect, it } from "vite-plus/test";

import { pushSubscriptionMatchesKey, urlBase64ToUint8Array } from "./webPush.ts";

function fakeSubscription(key: ArrayBuffer | null): Pick<PushSubscription, "options"> {
  return { options: { applicationServerKey: key, userVisibleOnly: true } };
}

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

describe("pushSubscriptionMatchesKey", () => {
  const key = urlBase64ToUint8Array("BEbQs3aJ");

  it("matches when the applicationServerKey bytes are identical", () => {
    const buffer = new ArrayBuffer(key.length);
    new Uint8Array(buffer).set(key);
    expect(pushSubscriptionMatchesKey(fakeSubscription(buffer), key)).toBe(true);
  });

  it("does not match a different key (the spike-residue bug)", () => {
    const other = urlBase64ToUint8Array("Zm9vYmFy");
    const buffer = new ArrayBuffer(other.length);
    new Uint8Array(buffer).set(other);
    expect(pushSubscriptionMatchesKey(fakeSubscription(buffer), key)).toBe(false);
  });

  it("does not match a different length", () => {
    const buffer = new ArrayBuffer(key.length - 1);
    expect(pushSubscriptionMatchesKey(fakeSubscription(buffer), key)).toBe(false);
  });

  it("does not match when the subscription has no applicationServerKey", () => {
    expect(pushSubscriptionMatchesKey(fakeSubscription(null), key)).toBe(false);
  });
});
