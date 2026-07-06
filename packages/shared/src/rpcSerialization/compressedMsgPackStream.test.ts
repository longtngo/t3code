import { Packr, Unpackr } from "msgpackr";
import { describe, expect, it } from "vite-plus/test";

import {
  COMPRESSED_MSGPACK_STREAM_CONTENT_TYPE,
  makeCompressedMsgPackStreamSerialization,
} from "./compressedMsgPack.ts";

const FRAME_STREAM = 0x00;
const FRAME_CONTROL = 0x01;

const ping = { _tag: "Ping" } as const;
const pong = { _tag: "Pong" } as const;

/** A realistic repetitive event frame — the traffic context-takeover targets. */
function eventFrame(sequence: number) {
  return {
    _tag: "Response",
    id: `req_${sequence}`,
    payload: {
      sequence,
      eventId: `evt_${sequence}_0f8a1c2b3d4e5f60`,
      aggregateKind: "thread",
      aggregateId: "thr_9a8b7c6d5e4f",
      occurredAt: "2026-07-05T00:12:00.000Z",
      commandId: `provider:1a2b3c4d-5e6f-7081-9a2b-3c4d5e6f7081:tag:9a8b7c6d-5e4f-3a2b-1c0d-9e8f7a6b5c4d`,
      correlationId: `provider:1a2b3c4d-5e6f-7081-9a2b-3c4d5e6f7081:tag:9a8b7c6d-5e4f-3a2b-1c0d-9e8f7a6b5c4d`,
      type: "thread.activity-appended",
      activity: { id: `act_${sequence}`, kind: "tool.started", summary: `running step ${sequence}` },
    },
  };
}

/** Encoder (client) and decoder (server) are separate parsers, as on a real socket. */
function pair() {
  return {
    client: makeCompressedMsgPackStreamSerialization().makeUnsafe(),
    server: makeCompressedMsgPackStreamSerialization().makeUnsafe(),
  };
}

describe("context-takeover compressed msgpack serialization", () => {
  it("advertises framing and a stable content type", () => {
    const service = makeCompressedMsgPackStreamSerialization();
    expect(service.includesFraming).toBe(true);
    expect(service.contentType).toBe(COMPRESSED_MSGPACK_STREAM_CONTENT_TYPE);
  });

  it("round-trips a single data message across a paired encoder/decoder", () => {
    const { client, server } = pair();
    const frame = client.encode(eventFrame(1)) as Uint8Array;
    expect(frame[0]).toBe(FRAME_STREAM);
    expect(server.decode(frame)).toEqual([eventFrame(1)]);
  });

  it("round-trips a long in-order stream (exercises inflate-leftover accumulation)", () => {
    const { client, server } = pair();
    const decoded: unknown[] = [];
    for (let i = 0; i < 200; i++) {
      const frame = client.encode(eventFrame(i)) as Uint8Array;
      decoded.push(...server.decode(frame));
    }
    expect(decoded).toHaveLength(200);
    expect(decoded).toEqual(Array.from({ length: 200 }, (_u, i) => eventFrame(i)));
  });

  it("carries the deflate window across frames (later frames shrink)", () => {
    const { client } = pair();
    const first = (client.encode(eventFrame(1)) as Uint8Array).length;
    let last = first;
    for (let i = 2; i <= 10; i++) {
      last = (client.encode(eventFrame(i)) as Uint8Array).length;
    }
    // Context takeover: the 10th near-identical frame compresses far smaller than the 1st.
    expect(last).toBeLessThan(first * 0.6);
  });

  it("keeps Ping/Pong stateless (CONTROL frames bypass the window) without desyncing data", () => {
    const { client, server } = pair();
    // Interleave control frames between data frames — the frozen-ping hazard.
    const d1 = client.encode(eventFrame(1)) as Uint8Array;
    const p = client.encode(ping) as Uint8Array;
    const d2 = client.encode(eventFrame(2)) as Uint8Array;
    const q = client.encode(pong) as Uint8Array;
    const d3 = client.encode(eventFrame(3)) as Uint8Array;

    expect(p[0]).toBe(FRAME_CONTROL);
    expect(q[0]).toBe(FRAME_CONTROL);
    // A CONTROL frame is a constant — re-encoding Ping yields identical bytes (the
    // "resent forever" heartbeat stays valid because it never touches the window).
    expect(Array.from(client.encode(ping) as Uint8Array)).toEqual(Array.from(p));

    expect(server.decode(d1)).toEqual([eventFrame(1)]);
    expect(server.decode(p)).toEqual([ping]);
    expect(server.decode(d2)).toEqual([eventFrame(2)]);
    expect(server.decode(q)).toEqual([pong]);
    expect(server.decode(d3)).toEqual([eventFrame(3)]); // data window intact despite the control frames
  });

  it("decodes a Ping resent verbatim after the data window has advanced", () => {
    const { client, server } = pair();
    const frozenPing = client.encode(ping) as Uint8Array; // encoded once, up front
    for (let i = 0; i < 20; i++) {
      server.decode(client.encode(eventFrame(i)) as Uint8Array);
    }
    // The same frozen bytes still decode after 20 data frames advanced the window.
    expect(server.decode(frozenPing)).toEqual([ping]);
  });

  it("ignores empty frames and rejects an unknown frame tag", () => {
    const { server } = pair();
    expect(server.decode(new Uint8Array(0))).toEqual([]);
    expect(() => server.decode(new Uint8Array([0x7f, 1, 2, 3]))).toThrow(/unknown frame tag/);
  });

  it("does not invoke onDecodeDesync while a clean stream (data + control) decodes", () => {
    let desyncs = 0;
    const client = makeCompressedMsgPackStreamSerialization().makeUnsafe();
    const server = makeCompressedMsgPackStreamSerialization(() => {
      desyncs++;
    }).makeUnsafe();
    for (let i = 0; i < 50; i++) {
      server.decode(client.encode(eventFrame(i)) as Uint8Array);
    }
    server.decode(client.encode(ping) as Uint8Array);
    server.decode(client.encode(pong) as Uint8Array);
    expect(desyncs).toBe(0);
  });

  it("invokes onDecodeDesync (and throws) on a corrupt STREAM body (invalid deflate)", () => {
    // A STREAM frame whose body is not a valid deflate continuation makes fflate's
    // inflate throw — the callback lets the transport reconnect with a fresh window.
    // (NOTE: this backstop catches DETECTED corruption — invalid deflate, unknown
    // tags, buffer overflow — only. A gap that happens to decode to in-window garbage
    // can desync silently, which is why prevention upstream, not this backstop, is the
    // real guarantee: ordered sends both ends + the client's disconnect-race + TCP.)
    let desyncs = 0;
    const server = makeCompressedMsgPackStreamSerialization(() => {
      desyncs++;
    }).makeUnsafe();
    // 0x00 = FRAME_STREAM tag; 0xff… = an invalid deflate block header.
    expect(() => server.decode(new Uint8Array([0x00, 0xff, 0xff, 0xff, 0xff]))).toThrow();
    expect(desyncs).toBe(1);
  });

  it("invokes onDecodeDesync (and throws) on an unknown frame tag (wire-format mismatch)", () => {
    let desyncs = 0;
    const server = makeCompressedMsgPackStreamSerialization(() => {
      desyncs++;
    }).makeUnsafe();
    expect(() => server.decode(new Uint8Array([0x7f, 1, 2, 3]))).toThrow(/unknown frame tag/);
    expect(desyncs).toBe(1);
  });

  it("pins the msgpackr partial-decode contract the stream decoder depends on", () => {
    // The stream decoder relies on `unpackMultiple` throwing `incomplete` with a
    // recoverable prefix on a truncated trailing value. Guard against a silent
    // msgpackr behavior change on upgrade.
    const packr = new Packr({ useRecords: true });
    const unpackr = new Unpackr({ useRecords: true });
    const v1 = Uint8Array.from(packr.pack({ a: 1, b: "hello" }));
    const v2 = Uint8Array.from(packr.pack({ a: 2, b: "world" }));
    const complete = new Uint8Array(v1.length + v2.length);
    complete.set(v1);
    complete.set(v2, v1.length);
    // Complete buffer → both values, no throw.
    expect(unpackr.unpackMultiple(complete)).toEqual([
      { a: 1, b: "hello" },
      { a: 2, b: "world" },
    ]);
    // Truncated mid-second value → throws `incomplete` with the first value recovered
    // and a `lastPosition` cursor at the end of the first value.
    const truncated = complete.subarray(0, v1.length + 1);
    try {
      unpackr.unpackMultiple(truncated);
      throw new Error("expected unpackMultiple to throw on a partial trailing value");
    } catch (error) {
      expect((error as { incomplete?: unknown }).incomplete).toBe(true);
      expect((error as { values?: unknown[] }).values).toEqual([{ a: 1, b: "hello" }]);
      expect((error as { lastPosition?: unknown }).lastPosition).toBe(v1.length);
    }
  });
});
