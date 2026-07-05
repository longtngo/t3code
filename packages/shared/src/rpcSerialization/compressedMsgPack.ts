/**
 * Compressed MessagePack RPC serialization — Phase 1 of the low-bandwidth roadmap.
 *
 * The client↔server socket carries Effect RPC as plain JSON today. This replaces
 * that with MessagePack (compact binary, native `Uint8Array`) and per-message
 * DEFLATE above a size threshold, cutting on-wire bytes 70–90% on large frames.
 *
 * ## Wire format
 *
 * MessagePack values are self-delimiting, but DEFLATE output is not, so this
 * serialization frames every message explicitly rather than relying on
 * msgpackr's built-in multi-message parsing:
 *
 * ```
 *   byte 0        flags       bit0 = payload is DEFLATE-compressed
 *   bytes 1..4    length      uint32 big-endian, payload byte length
 *   bytes 5..     payload     msgpack of one message, optionally deflated
 * ```
 *
 * Small frames (Pong, acks) stay below the threshold and ship as raw msgpack —
 * deflating them would only add ~11 bytes of overhead. Both ends must use the
 * same serialization; the `/ws` handshake negotiates it (see the query-param
 * constants below) and falls back to JSON for clients that do not request it.
 *
 * DEFLATE uses `fflate` (pure-JS, identical on browser / React Native / Node), so
 * client and server compress with the same implementation — no cross-library
 * compatibility surface.
 */

import * as Layer from "effect/Layer";
import { RpcSerialization } from "effect/unstable/rpc";
import { deflateSync, inflateSync } from "fflate";
import { Packr, Unpackr } from "msgpackr";

/** Content type advertised by the compressed-msgpack serialization. */
export const COMPRESSED_MSGPACK_CONTENT_TYPE = "application/x-t3-msgpack-deflate";

/** `/ws` query parameter a client uses to advertise its preferred wire format. */
export const WIRE_FORMAT_QUERY_PARAM = "fmt";

/** Value of {@link WIRE_FORMAT_QUERY_PARAM} that selects compressed MessagePack. */
export const WIRE_FORMAT_MSGPACK_DEFLATE = "msgpack-deflate";

/**
 * Frames larger than this (in msgpack bytes) are DEFLATE-compressed; smaller ones
 * ship raw because deflate's fixed overhead would make them bigger. Mirrors the
 * Phase 0 benchmark's threshold.
 */
export const COMPRESSED_MSGPACK_DEFLATE_THRESHOLD_BYTES = 1024;

const HEADER_SIZE = 5;
const FLAG_DEFLATED = 0b0000_0001;
// A declared frame length above this is treated as a corrupt stream or a wire-format
// mismatch (e.g. a peer that answered JSON to a msgpack client) rather than a real
// frame, so the decoder fails loud instead of buffering unbounded bytes forever. Well
// above the largest legitimate frame (a ~27MB attachment upload).
const MAX_FRAME_BYTES = 64 * 1024 * 1024;

const EMPTY = new Uint8Array(0);
const sharedTextEncoder = new TextEncoder();

function toUint8Array(data: Uint8Array | string): Uint8Array {
  if (typeof data === "string") {
    return sharedTextEncoder.encode(data);
  }
  if (data instanceof Uint8Array) {
    return data;
  }
  // Some transports hand us an ArrayBuffer/ArrayBufferView; normalize it.
  return new Uint8Array(data as ArrayBufferLike);
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length === 0) {
    return right;
  }
  if (right.length === 0) {
    return left;
  }
  const merged = new Uint8Array(left.length + right.length);
  merged.set(left);
  merged.set(right, left.length);
  return merged;
}

/** Encodes one message into a framed, optionally-deflated msgpack payload. */
function encodeFrame(packr: Packr, message: unknown): Uint8Array {
  const packed = packr.pack(message);
  let payload: Uint8Array = packed;
  let flags = 0;
  if (packed.length > COMPRESSED_MSGPACK_DEFLATE_THRESHOLD_BYTES) {
    const deflated = deflateSync(packed);
    // Only pay the deflate marker if it actually shrank the frame.
    if (deflated.length < packed.length) {
      payload = deflated;
      flags = FLAG_DEFLATED;
    }
  }
  const frame = new Uint8Array(HEADER_SIZE + payload.length);
  frame[0] = flags;
  new DataView(frame.buffer).setUint32(1, payload.length, false);
  frame.set(payload, HEADER_SIZE);
  return frame;
}

/**
 * Creates the RPC serialization service. `makeUnsafe` returns a per-connection
 * parser whose only cross-call state is the `leftover` buffer for reassembling
 * partial frames across socket chunks; each frame is a self-contained msgpack
 * value (msgpackr re-embeds record definitions per message), so frame order and
 * reconnect never desync the decoder.
 */
export const makeCompressedMsgPackSerialization =
  (): RpcSerialization.RpcSerialization["Service"] => ({
    contentType: COMPRESSED_MSGPACK_CONTENT_TYPE,
    includesFraming: true,
    makeUnsafe: () => {
      const packr = new Packr({ useRecords: true });
      const unpackr = new Unpackr({ useRecords: true });
      let leftover = EMPTY;

      return {
        encode: (response) => encodeFrame(packr, response),
        decode: (data) => {
          const buffer = concat(leftover, toUint8Array(data));
          leftover = EMPTY;
          const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.length);
          const messages: unknown[] = [];
          let offset = 0;

          while (buffer.length - offset >= HEADER_SIZE) {
            const flags = buffer[offset]!;
            const length = view.getUint32(offset + 1, false);
            if (length > MAX_FRAME_BYTES) {
              throw new Error(
                `compressed-msgpack frame length ${length} exceeds the ${MAX_FRAME_BYTES}-byte maximum; corrupt stream or wire-format mismatch`,
              );
            }
            const payloadStart = offset + HEADER_SIZE;
            if (buffer.length - payloadStart < length) {
              break; // Frame not fully arrived yet; wait for more bytes.
            }
            const payload = buffer.subarray(payloadStart, payloadStart + length);
            const msgpackBytes = (flags & FLAG_DEFLATED) === 0 ? payload : inflateSync(payload);
            messages.push(unpackr.unpack(msgpackBytes));
            offset = payloadStart + length;
          }

          // Persist any partial trailing frame (copied so the shared buffer is free).
          leftover = offset < buffer.length ? buffer.slice(offset) : EMPTY;
          return messages;
        },
      };
    },
  });

/** RPC serialization layer using compressed MessagePack. Drop-in for `RpcSerialization.layerJson`. */
export const layerCompressedMsgPack: Layer.Layer<RpcSerialization.RpcSerialization> =
  Layer.succeed(RpcSerialization.RpcSerialization, makeCompressedMsgPackSerialization());
