import { describe, expect, it } from "vite-plus/test";

import {
  COMPRESSED_MSGPACK_CONTENT_TYPE,
  COMPRESSED_MSGPACK_DEFLATE_THRESHOLD_BYTES,
  makeCompressedMsgPackSerialization,
} from "./compressedMsgPack.ts";

const HEADER_SIZE = 5;
const FLAG_DEFLATED = 0b0000_0001;

const smallMessage = { _tag: "Pong" };
const largeMessage = {
  _tag: "Response",
  id: "req-1",
  payload: {
    thread: {
      id: "thr_1",
      activities: Array.from({ length: 40 }, (_unused, index) => ({
        id: `act_${index}`,
        kind: "tool_use",
        text: "the quick brown fox jumps over the lazy dog ".repeat(3),
      })),
    },
  },
};

describe("compressed msgpack serialization", () => {
  it("advertises framing and a stable content type", () => {
    const service = makeCompressedMsgPackSerialization();
    expect(service.includesFraming).toBe(true);
    expect(service.contentType).toBe(COMPRESSED_MSGPACK_CONTENT_TYPE);
  });

  it("round-trips a single message", () => {
    const parser = makeCompressedMsgPackSerialization().makeUnsafe();
    const encoded = parser.encode(largeMessage) as Uint8Array;
    expect(parser.decode(encoded)).toEqual([largeMessage]);
  });

  it("leaves small frames uncompressed and deflates large ones", () => {
    const parser = makeCompressedMsgPackSerialization().makeUnsafe();

    const small = parser.encode(smallMessage) as Uint8Array;
    expect(small[0]! & FLAG_DEFLATED).toBe(0);

    const large = parser.encode(largeMessage) as Uint8Array;
    expect(large[0]! & FLAG_DEFLATED).toBe(FLAG_DEFLATED);
    // Deflate must actually help — the frame is far smaller than the JSON form.
    expect(large.length).toBeLessThan(Buffer.byteLength(JSON.stringify(largeMessage)));
  });

  it("decodes several messages delivered in one chunk", () => {
    const encoder = makeCompressedMsgPackSerialization().makeUnsafe();
    const a = encoder.encode({ _tag: "A", n: 1 }) as Uint8Array;
    const b = encoder.encode({ _tag: "B", n: 2 }) as Uint8Array;
    const c = encoder.encode(largeMessage) as Uint8Array;
    const combined = new Uint8Array(a.length + b.length + c.length);
    combined.set(a);
    combined.set(b, a.length);
    combined.set(c, a.length + b.length);

    // Fresh decoder (independent structure table) mirrors the receiving end.
    const decoder = makeCompressedMsgPackSerialization().makeUnsafe();
    expect(decoder.decode(combined)).toEqual([{ _tag: "A", n: 1 }, { _tag: "B", n: 2 }, largeMessage]);
  });

  it("reassembles a frame split across two chunks", () => {
    const encoder = makeCompressedMsgPackSerialization().makeUnsafe();
    const frame = encoder.encode(largeMessage) as Uint8Array;
    const splitAt = Math.floor(frame.length / 2);

    const decoder = makeCompressedMsgPackSerialization().makeUnsafe();
    // First half: header may be complete but payload isn't — nothing decodes yet.
    expect(decoder.decode(frame.subarray(0, splitAt))).toEqual([]);
    // Second half completes the frame.
    expect(decoder.decode(frame.subarray(splitAt))).toEqual([largeMessage]);
  });

  it("handles a header split across chunks", () => {
    const encoder = makeCompressedMsgPackSerialization().makeUnsafe();
    const frame = encoder.encode({ _tag: "X", v: 7 }) as Uint8Array;

    const decoder = makeCompressedMsgPackSerialization().makeUnsafe();
    expect(decoder.decode(frame.subarray(0, 2))).toEqual([]); // header incomplete
    expect(decoder.decode(frame.subarray(2))).toEqual([{ _tag: "X", v: 7 }]);
  });

  it("decodes a stream of same-shaped messages independently of order", () => {
    const encoder = makeCompressedMsgPackSerialization().makeUnsafe();
    const decoder = makeCompressedMsgPackSerialization().makeUnsafe();
    // Each frame is a self-contained msgpack value (records re-embedded per message),
    // so a stream of same-shaped messages round-trips without cross-frame state.
    const messages = Array.from({ length: 5 }, (_unused, index) => ({
      kind: "event",
      seq: index,
      body: { a: index, b: `v${index}` },
    }));
    for (const message of messages) {
      const frame = encoder.encode(message) as Uint8Array;
      expect(decoder.decode(frame)).toEqual([message]);
    }
  });

  it("round-trips native binary payloads (Uint8Array) without base64", () => {
    const parser = makeCompressedMsgPackSerialization().makeUnsafe();
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255]);
    const [decoded] = parser.decode(parser.encode({ _tag: "Blob", data: bytes }) as Uint8Array) as [
      { data: Uint8Array },
    ];
    expect(Array.from(decoded.data)).toEqual(Array.from(bytes));
  });

  it("frames carry the 5-byte header", () => {
    const parser = makeCompressedMsgPackSerialization().makeUnsafe();
    const frame = parser.encode(smallMessage) as Uint8Array;
    const view = new DataView(frame.buffer, frame.byteOffset, frame.length);
    const declaredLength = view.getUint32(1, false);
    expect(frame.length).toBe(HEADER_SIZE + declaredLength);
  });

  it("keeps the deflate threshold aligned with the design", () => {
    expect(COMPRESSED_MSGPACK_DEFLATE_THRESHOLD_BYTES).toBe(1024);
  });

  it("fails loud on an absurd frame length rather than buffering forever", () => {
    const decoder = makeCompressedMsgPackSerialization().makeUnsafe();
    // Hand-craft a header claiming a ~4GB payload (what a wire-format mismatch or a
    // corrupt stream looks like): the decoder must throw, not grow leftover unbounded.
    const bogus = new Uint8Array(HEADER_SIZE);
    new DataView(bogus.buffer).setUint32(1, 0xffff_ffff, false);
    expect(() => decoder.decode(bogus)).toThrow(/exceeds the .* maximum/);
  });
});
