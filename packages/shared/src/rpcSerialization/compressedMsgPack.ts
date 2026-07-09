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
import { Deflate, deflateSync, Inflate, inflateSync } from "fflate";
import { Packr, Unpackr } from "msgpackr";

/** Content type advertised by the compressed-msgpack serialization. */
export const COMPRESSED_MSGPACK_CONTENT_TYPE = "application/x-t3-msgpack-deflate";

/** `/ws` query parameter a client uses to advertise its preferred wire format. */
export const WIRE_FORMAT_QUERY_PARAM = "fmt";

/** Value of {@link WIRE_FORMAT_QUERY_PARAM} that selects compressed MessagePack. */
export const WIRE_FORMAT_MSGPACK_DEFLATE = "msgpack-deflate";

/**
 * Value of {@link WIRE_FORMAT_QUERY_PARAM} that selects context-takeover
 * (streaming) compressed MessagePack — ONE persistent DEFLATE window per
 * connection, so each frame compresses against the frames before it. Measured
 * ~−60% blended wire bytes vs the stateless per-frame {@link WIRE_FORMAT_MSGPACK_DEFLATE}
 * on realistic thread-load traffic. See {@link makeCompressedMsgPackStreamSerialization}.
 */
export const WIRE_FORMAT_MSGPACK_DEFLATE_STREAM = "msgpack-deflate-stream";

/**
 * The always-available fallback wire format. JSON is NOT deprecated-for-removal:
 * it is the compatibility floor a client drops to when it cannot confirm the
 * server understands compressed msgpack (see {@link WS_CAPABILITIES_PATH}), and
 * the only format msw's WebSocket mock can carry, so the browser test suite runs
 * on it. Removing it would break both.
 */
export const WIRE_FORMAT_JSON = "json";

/**
 * Wire formats this build's server can decode, advertised at {@link WS_CAPABILITIES_PATH}.
 * A client probes this list before opening the socket and picks the best format it and
 * the server both support (client precedence: stream → per-frame → json); otherwise it
 * stays on JSON. Order here is NOT authoritative — the client chooses by its own precedence.
 */
export const SUPPORTED_WIRE_FORMATS = [
  WIRE_FORMAT_JSON,
  WIRE_FORMAT_MSGPACK_DEFLATE,
  // Temporarily disabled — stream codec still ships in this build but is not
  // advertised or negotiated until re-enabled here.
  // WIRE_FORMAT_MSGPACK_DEFLATE_STREAM,
] as const;

/**
 * Unauthenticated capability-probe endpoint. Returns `{ wireFormats: [...] }` so a
 * newer client can learn whether an independently-deployed server understands
 * compressed msgpack BEFORE it commits to sending binary frames the server might
 * not parse. An old server without this route 404s, which the client reads as
 * "JSON only" — the safe default.
 */
export const WS_CAPABILITIES_PATH = "/ws/capabilities";

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

// ---------------------------------------------------------------------------
// Context-takeover (streaming) compressed MessagePack
// ---------------------------------------------------------------------------
//
// One persistent DEFLATE window per connection instead of deflating each frame
// from scratch. Because RPC frames are highly repetitive (the same envelope
// field names, the same ~105-char commandId/correlationId on every event), a
// window that carries over from prior frames compresses the sub-1KB frames that
// the per-frame codec leaves uncompressed — measured ~−60% blended wire bytes.
//
// ## Wire format — a 1-byte frame-type tag
//
// ```
//   byte 0   0x01 CONTROL  → bytes 1.. are RAW (undeflated) self-delimiting msgpack
//            0x00 STREAM   → bytes 1.. are the next chunk of the connection's
//                           continuous DEFLATE stream (flushed per message)
// ```
//
// ### Why CONTROL frames bypass the window (load-bearing)
// Effect's `RpcClient.makeProtocolSocket` pre-encodes the heartbeat Ping ONCE
// (against a throwaway parser) and resends those exact bytes every 5s, while the
// data frames flow through a *different* parser — yet the server has a single
// inflate window. A stateful window cannot survive a frozen frame resent against
// an advanced window, nor two deflate streams multiplexed into one inflate. So
// Ping/Pong are encoded as STATELESS raw-msgpack CONTROL frames that never touch
// (or advance) the deflate window: the frozen Ping stays a valid constant forever,
// and only real data frames form the single stateful stream. This is what makes a
// stateful codec compatible with Effect's stateless-codec transport.
//
// ### Decode boundaries
// fflate's streaming `Inflate` does not emit clean per-message boundaries (it holds
// bytes back across flushes), so STREAM decode inflates into a running buffer and
// slices complete values off using MessagePack's own self-delimiting framing
// (msgpackr re-embeds record definitions per message, so each value is standalone —
// verified). The un-consumed inflated tail is bounded by {@link MAX_FRAME_BYTES}.
//
// ### Ordering & reset
// The window is order-dependent: a dropped/reordered STREAM frame desyncs the rest
// of the stream. This is safe because (a) BOTH ends serialize outbound sends under a
// single permit so encode-order == wire-order (client `sendMutex`; server
// {@link toHttpEffectWebsocketOrdered}), (b) TCP delivers a socket's frames in order
// or drops the connection, (c) every reconnect builds a fresh session → fresh
// `makeUnsafe()` → fresh window (never resumed across a gap), and (d) the client
// interrupts an in-flight send when its socket drops, so a frame encoded against the
// dying window can never flush to the next socket. Prevention — not detection — is the
// real guarantee here: a desynced inflate does NOT always fail loudly (a gap can decode
// to in-window garbage silently), so the codec cannot be relied on to catch every
// desync. As a best-effort backstop, a DETECTED STREAM decode failure (invalid deflate,
// unknown tag, or buffered bytes past the frame cap) both throws AND invokes the
// `onDecodeDesync` callback, so the transport tears the socket down and reconnects with
// a fresh window instead of limping on a corruption it did happen to notice.

/** Content type advertised by the context-takeover compressed-msgpack serialization. */
export const COMPRESSED_MSGPACK_STREAM_CONTENT_TYPE = "application/x-t3-msgpack-deflate-stream";

const FRAME_STREAM = 0x00;
const FRAME_CONTROL = 0x01;

/**
 * Control frames (Ping/Pong) are kept OUT of the deflate window — see the block
 * comment above. Everything else (Request, responses, acks, interrupts, Eof) is
 * real payload and flows through the stateful stream.
 */
function isControlMessage(message: unknown): boolean {
  if (typeof message !== "object" || message === null) {
    return false;
  }
  const tag = (message as { readonly _tag?: unknown })._tag;
  return tag === "Ping" || tag === "Pong";
}

function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
  if (chunks.length === 1) {
    return chunks[0]!;
  }
  let total = 0;
  for (const chunk of chunks) {
    total += chunk.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Extract every COMPLETE MessagePack value from `buffer`, returning them plus the
 * trailing partial bytes (a message split across inflate/socket boundaries).
 *
 * msgpackr 2.0.2 has no clean "decode as many as possible" API: `unpackMultiple`
 * THROWS on a trailing partial value and exposes the recovered prefix only via
 * undocumented error fields. This encapsulates that (and its edge cases: a partial
 * FIRST value gives `values: undefined` / `lastPosition: 0`; an empty buffer throws
 * `incomplete`). A codec unit test pins these fields against the installed version.
 */
function extractMsgpackValues(
  unpackr: Unpackr,
  buffer: Uint8Array,
): { readonly values: unknown[]; readonly remainder: Uint8Array } {
  if (buffer.length === 0) {
    return { values: [], remainder: EMPTY };
  }
  try {
    const values = unpackr.unpackMultiple(buffer) as unknown[];
    return { values, remainder: EMPTY };
  } catch (error) {
    if ((error as { incomplete?: unknown }).incomplete !== true) {
      throw error; // Genuine corruption / wire-format mismatch — fail loud.
    }
    const values = ((error as { values?: unknown[] }).values ?? []) as unknown[];
    const lastPosition = (error as { lastPosition?: unknown }).lastPosition;
    const consumed = typeof lastPosition === "number" ? lastPosition : 0;
    return { values, remainder: consumed > 0 ? buffer.slice(consumed) : buffer };
  }
}

/**
 * Creates the context-takeover RPC serialization. Each `makeUnsafe()` builds ONE
 * persistent `Deflate` (outbound) and `Inflate` (inbound) that live for the whole
 * connection — so it MUST be called once per connection (the transport does: a
 * per-session/per-connection serialization layer). Never share the returned parser
 * across connections; that would multiplex independent streams into one window.
 *
 * `onDecodeDesync` (optional) is invoked whenever a STREAM-frame decode fails — the
 * persistent inflate window is then unrecoverable, so the transport should close the
 * socket and reconnect with a fresh window rather than limp on a desync. The client
 * transport wires this to `socket.close()`; the server (and tests) leave it unset.
 */
export const makeCompressedMsgPackStreamSerialization = (
  onDecodeDesync?: () => void,
): RpcSerialization.RpcSerialization["Service"] => ({
    contentType: COMPRESSED_MSGPACK_STREAM_CONTENT_TYPE,
    includesFraming: true,
    makeUnsafe: () => {
      const packr = new Packr({ useRecords: true });
      const unpackr = new Unpackr({ useRecords: true });
      // Outbound: one persistent deflate window; `deflateChunks` collects the
      // callback output for the current encode() only.
      let deflateChunks: Uint8Array[] = [];
      const deflate = new Deflate((chunk) => {
        deflateChunks.push(chunk);
      });
      // Inbound: one persistent inflate window; `inflateChunks` collects the
      // callback output for the current decode() only; `inflatedLeftover` holds
      // inflated bytes not yet forming a complete msgpack value.
      let inflateChunks: Uint8Array[] = [];
      const inflate = new Inflate((chunk) => {
        inflateChunks.push(chunk);
      });
      let inflatedLeftover: Uint8Array = EMPTY;

      return {
        encode: (message) => {
          const packed = packr.pack(message);
          if (isControlMessage(message)) {
            const frame = new Uint8Array(1 + packed.length);
            frame[0] = FRAME_CONTROL;
            frame.set(packed, 1);
            return frame;
          }
          deflateChunks = [];
          deflate.push(packed, false);
          deflate.flush(); // MANDATORY: without it fflate buffers to ~8KB and small frames stall.
          const body = concatChunks(deflateChunks);
          const frame = new Uint8Array(1 + body.length);
          frame[0] = FRAME_STREAM;
          frame.set(body, 1);
          return frame;
        },
        decode: (data) => {
          const bytes = toUint8Array(data);
          if (bytes.length === 0) {
            return [];
          }
          const tag = bytes[0];
          const body = bytes.subarray(1);
          // Control frames (Ping/Pong) bypass the window and are stateless, so a
          // failure here does NOT desync the stream — let it throw without teardown.
          if (tag === FRAME_CONTROL) {
            return [unpackr.unpack(body)];
          }
          // Everything below advances / reads the persistent inflate window. Any
          // failure means the window is unrecoverable (or the peer sent a non-stream
          // frame), so surface it to the transport for a fresh-window reconnect.
          try {
            if (tag !== FRAME_STREAM) {
              throw new Error(
                `compressed-msgpack-stream: unknown frame tag ${tag}; corrupt stream or wire-format mismatch`,
              );
            }
            inflateChunks = [];
            inflate.push(body, false);
            if (inflateChunks.length > 0) {
              inflatedLeftover = concat(inflatedLeftover, concatChunks(inflateChunks));
            }
            if (inflatedLeftover.length === 0) {
              return [];
            }
            const extracted = extractMsgpackValues(unpackr, inflatedLeftover);
            inflatedLeftover = extracted.remainder;
            if (inflatedLeftover.length > MAX_FRAME_BYTES) {
              throw new Error(
                `compressed-msgpack-stream: ${inflatedLeftover.length} buffered bytes without a complete message; corrupt stream`,
              );
            }
            return extracted.values;
          } catch (error) {
            onDecodeDesync?.();
            throw error;
          }
        },
      };
    },
  });

/** RPC serialization layer using context-takeover compressed MessagePack. */
export const layerCompressedMsgPackStream: Layer.Layer<RpcSerialization.RpcSerialization> =
  Layer.succeed(RpcSerialization.RpcSerialization, makeCompressedMsgPackStreamSerialization());

/**
 * Single source of truth mapping a negotiated wire format → its serialization layer,
 * used by BOTH the client protocol layer and the server `/ws` handler so the socket
 * `?fmt` and the codec can never disagree. Unknown/JSON → the always-safe JSON layer.
 *
 * `onStreamDecodeDesync` (optional, stream format only) is wired by the client so a
 * desynced inflate window tears the socket down and reconnects fresh. When omitted,
 * the shared stateless {@link layerCompressedMsgPackStream} singleton is reused.
 */
export function serializationLayerForWireFormat(
  format: string,
  onStreamDecodeDesync?: () => void,
): Layer.Layer<RpcSerialization.RpcSerialization> {
  switch (format) {
    case WIRE_FORMAT_MSGPACK_DEFLATE_STREAM:
      return onStreamDecodeDesync
        ? Layer.succeed(
            RpcSerialization.RpcSerialization,
            makeCompressedMsgPackStreamSerialization(onStreamDecodeDesync),
          )
        : layerCompressedMsgPackStream;
    case WIRE_FORMAT_MSGPACK_DEFLATE:
      return layerCompressedMsgPack;
    default:
      return RpcSerialization.layerJson;
  }
}
