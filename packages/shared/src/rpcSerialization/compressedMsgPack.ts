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
 *
 * The `-v2` suffix is load-bearing: the v1 framing (`[tag][body]`) shipped, was disabled,
 * and is still baked into cached client bundles that rank this format first and will
 * negotiate it the instant a server advertises it. v2 adds a length-delimited header
 * (`[tag][uint32 len][body]`) that is wire-INCOMPATIBLE with v1. Bumping the identifier
 * means a cached v1 client no longer finds a matching format in the server's advertised
 * list and cleanly downgrades to per-frame/JSON instead of speaking v1 framing into a v2
 * decoder (which would desync into a reconnect storm). Never reuse a retired identifier.
 */
export const WIRE_FORMAT_MSGPACK_DEFLATE_STREAM = "msgpack-deflate-stream-v2";

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
  WIRE_FORMAT_MSGPACK_DEFLATE_STREAM,
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
  // Fail loud rather than emit a frame the peer will reject on decode (the same
  // MAX_FRAME_BYTES ceiling is enforced there). A frame this large means an
  // un-windowed / unbounded payload slipped through upstream (e.g. a full-thread
  // snapshot) — surface it as an error instead of silently building a
  // multi-hundred-MB buffer that risks OOMing the process.
  if (payload.length > MAX_FRAME_BYTES) {
    throw new RangeError(
      `compressed-msgpack encode frame length ${payload.length} exceeds the ${MAX_FRAME_BYTES}-byte maximum; an unbounded payload (likely an un-windowed thread snapshot) reached the encoder`,
    );
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
// ## Wire format — a length-delimited frame header (see FRAME_* constants below)
//
// ```
//   byte 0        tag: 0x01 CONTROL → RAW (undeflated) self-delimiting msgpack
//                      0x00 STREAM  → next chunk of the connection's continuous
//                                     DEFLATE stream (flushed per message)
//   bytes 1..4    uint32 BE body length
//   bytes 5..     body (`length` bytes)
// ```
// The length prefix lets the decoder reassemble a frame the transport split across
// (or coalesced into) WebSocket reads before it touches the deflate window.
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

/** Content type advertised by the context-takeover compressed-msgpack serialization.
 * `-v2` paired with {@link WIRE_FORMAT_MSGPACK_DEFLATE_STREAM} — see the note there. */
export const COMPRESSED_MSGPACK_STREAM_CONTENT_TYPE = "application/x-t3-msgpack-deflate-stream-v2";

// Stream framing constants — the length-delimited header documented in the "## Wire
// format" block above. Mirrors the per-frame codec's `[flags][uint32 len]` header (see
// {@link encodeFrame}); the 1-byte tag replaces the flags byte.
const FRAME_STREAM = 0x00;
const FRAME_CONTROL = 0x01;
const STREAM_HEADER_SIZE = 5;

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
      // Inbound: one persistent inflate window; `inflateChunks` collects the callback
      // output for the current decode() only. TWO levels of leftover buffering:
      //  - `rawLeftover` reassembles a wire FRAME that the transport split across (or
      //    coalesced into) socket reads — this happens BEFORE the deflate window, so a
      //    re-chunked multi-MB frame no longer misaligns the tag byte and desyncs.
      //  - `inflatedLeftover` holds decompressed bytes not yet forming a complete
      //    msgpack value (fflate's Inflate doesn't emit clean per-message boundaries).
      let inflateChunks: Uint8Array[] = [];
      const inflate = new Inflate((chunk) => {
        inflateChunks.push(chunk);
      });
      let rawLeftover: Uint8Array = EMPTY;
      let inflatedLeftover: Uint8Array = EMPTY;

      const framed = (tag: number, body: Uint8Array): Uint8Array => {
        const frame = new Uint8Array(STREAM_HEADER_SIZE + body.length);
        frame[0] = tag;
        new DataView(frame.buffer).setUint32(1, body.length, false);
        frame.set(body, STREAM_HEADER_SIZE);
        return frame;
      };

      return {
        encode: (message) => {
          const packed = packr.pack(message);
          // Fail loud BEFORE mutating the persistent deflate window: reject on the
          // UNCOMPRESSED size so a rejected frame can never advance the window (which
          // would silently desync every later frame on this connection — unlike the
          // stateless per-frame codec, this window is connection-lifetime state). The
          // uncompressed bound is conservative (deflate output <= input + small
          // overhead) and also catches a compressible-but-huge payload that a
          // post-deflate check would wave through into the decoder's inflate-side
          // MAX_FRAME_BYTES guard. Stream is the default format, so this matters most here.
          if (packed.length > MAX_FRAME_BYTES) {
            throw new RangeError(
              `compressed-msgpack-stream encode payload length ${packed.length} exceeds the ${MAX_FRAME_BYTES}-byte maximum; an unbounded payload (likely an un-windowed thread snapshot) reached the encoder`,
            );
          }
          if (isControlMessage(message)) {
            // Stateless raw msgpack — never touches the deflate window (block comment above).
            return framed(FRAME_CONTROL, packed);
          }
          deflateChunks = [];
          deflate.push(packed, false);
          deflate.flush(); // MANDATORY: without it fflate buffers to ~8KB and small frames stall.
          return framed(FRAME_STREAM, concatChunks(deflateChunks));
        },
        decode: (data) => {
          // Reassemble complete frames (peel by the length header, buffer a partial
          // trailing frame in `rawLeftover`) BEFORE feeding any body to the window —
          // the reassembly rationale lives at the `rawLeftover` declaration above.
          const buffer = concat(rawLeftover, toUint8Array(data));
          rawLeftover = EMPTY;
          const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.length);
          const messages: unknown[] = [];
          let offset = 0;

          while (buffer.length - offset >= STREAM_HEADER_SIZE) {
            const tag = buffer[offset]!;
            const length = view.getUint32(offset + 1, false);
            if (length > MAX_FRAME_BYTES) {
              // A length this large is a misaligned/corrupt stream, not a real frame;
              // the window is unrecoverable, so tear down rather than buffer forever.
              onDecodeDesync?.();
              throw new Error(
                `compressed-msgpack-stream frame length ${length} exceeds the ${MAX_FRAME_BYTES}-byte maximum; corrupt stream or wire-format mismatch`,
              );
            }
            const bodyStart = offset + STREAM_HEADER_SIZE;
            if (buffer.length - bodyStart < length) {
              break; // Frame not fully arrived yet; buffer the partial header/body and wait.
            }
            const body = buffer.subarray(bodyStart, bodyStart + length);
            offset = bodyStart + length;

            if (tag === FRAME_CONTROL) {
              // Control frames (Ping/Pong) bypass the window and are stateless, so a
              // failure here does NOT desync the stream — let it throw without teardown.
              messages.push(unpackr.unpack(body));
              continue;
            }
            // STREAM frames advance / read the persistent inflate window. Any failure
            // means the window is unrecoverable (or the peer sent a non-stream frame),
            // so surface it to the transport for a fresh-window reconnect.
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
              // extractMsgpackValues no-ops on an empty buffer, so no empty-check needed.
              const extracted = extractMsgpackValues(unpackr, inflatedLeftover);
              inflatedLeftover = extracted.remainder;
              if (inflatedLeftover.length > MAX_FRAME_BYTES) {
                throw new Error(
                  `compressed-msgpack-stream: ${inflatedLeftover.length} buffered bytes without a complete message; corrupt stream`,
                );
              }
              for (const value of extracted.values) {
                messages.push(value);
              }
            } catch (error) {
              onDecodeDesync?.();
              throw error;
            }
          }

          // Persist any partial trailing frame (copied so the shared buffer is free).
          rawLeftover = offset < buffer.length ? buffer.slice(offset) : EMPTY;
          return messages;
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
