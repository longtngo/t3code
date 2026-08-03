/**
 * Dev-only on-wire byte/frame counter for the client WebSocket transport.
 *
 * Phase 0 of the low-bandwidth roadmap: it establishes the baseline every later
 * phase re-measures against, by counting the raw bytes the client actually sends
 * and receives on the socket (before any transport framing, after serialization).
 *
 * Counting is cheap — a byte-length plus an add per frame — so the meter runs
 * unconditionally and is exposed on `globalThis` (`__t3WireMeter`) for console
 * inspection at any time. A one-line summary is logged on socket close only when
 * {@link wireMeterLoggingEnabled} is set, so it is silent for normal users.
 *
 * NOT currently wired to the transport, deliberately. This meter measures
 * *application-level* payload bytes, which is a different quantity from what
 * goes over the socket: the server negotiates `permessage-deflate`, and the
 * browser inflates a frame before JavaScript ever sees `event.data`. Wiring the
 * meter up today would therefore report pre-compression sizes and show no effect
 * from compression at all — measure that end with the server's TCP byte counters
 * or the DevTools network panel instead. The meter becomes the right instrument
 * again for a change that alters the payload the client itself encodes (the
 * deferred JSON→msgpack work), which is why it is kept rather than deleted.
 */

export type WireDirection = "sent" | "recv";

export interface WireMeterTotals {
  readonly bytes: number;
  readonly frames: number;
}

export interface WireMeterSnapshot {
  readonly sent: WireMeterTotals;
  readonly recv: WireMeterTotals;
}

interface MutableTotals {
  bytes: number;
  frames: number;
}

const emptyTotals = (): MutableTotals => ({ bytes: 0, frames: 0 });

/**
 * Accumulates sent/received byte and frame counts. Not tied to any framework so
 * it is trivially unit-testable and safe to construct in web, React Native,
 * Electron, and Node contexts alike.
 */
export class WireMeter {
  #sent: MutableTotals = emptyTotals();
  #recv: MutableTotals = emptyTotals();

  record(direction: WireDirection, bytes: number): void {
    if (!Number.isFinite(bytes) || bytes < 0) {
      return;
    }
    const totals = direction === "sent" ? this.#sent : this.#recv;
    totals.bytes += bytes;
    totals.frames += 1;
  }

  snapshot(): WireMeterSnapshot {
    return {
      sent: { bytes: this.#sent.bytes, frames: this.#sent.frames },
      recv: { bytes: this.#recv.bytes, frames: this.#recv.frames },
    };
  }

  reset(): void {
    this.#sent = emptyTotals();
    this.#recv = emptyTotals();
  }

  format(): string {
    const { sent, recv } = this.snapshot();
    return `wire ↑ ${formatBytes(sent.bytes)} / ${sent.frames}f  ↓ ${formatBytes(recv.bytes)} / ${recv.frames}f`;
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "0B";
  }
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

// One reused encoder — allocating a TextEncoder per frame would defeat the point
// of a cheap meter. TextEncoder exists in browsers, Hermes (RN), Node, Electron.
const sharedTextEncoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

/** Best-effort on-wire byte size of a WebSocket frame payload (string or binary). */
export function frameByteLength(data: unknown): number {
  if (typeof data === "string") {
    return utf8ByteLength(data);
  }
  if (data instanceof ArrayBuffer) {
    return data.byteLength;
  }
  if (ArrayBuffer.isView(data)) {
    return data.byteLength;
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return data.size;
  }
  return 0;
}

function utf8ByteLength(str: string): number {
  if (sharedTextEncoder) {
    return sharedTextEncoder.encode(str).length;
  }
  // Manual UTF-8 length fallback for exotic runtimes without TextEncoder.
  let bytes = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i++;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

const WIRE_METER_GLOBAL_KEY = "__t3WireMeter";

/** The process-wide meter, lazily created and stashed on `globalThis` for console access. */
export function getSharedWireMeter(): WireMeter {
  const globals = globalThis as Record<string, unknown>;
  const existing = globals[WIRE_METER_GLOBAL_KEY];
  if (existing instanceof WireMeter) {
    return existing;
  }
  const meter = new WireMeter();
  globals[WIRE_METER_GLOBAL_KEY] = meter;
  return meter;
}

/**
 * Whether the meter should log its summary on socket close. Off by default;
 * flip on via `localStorage["t3.wireMeter"] = "1"` (browser/RN) or the
 * `T3CODE_WIRE_METER=1` env var (Node/Electron main).
 */
export function wireMeterLoggingEnabled(): boolean {
  try {
    const withStorage = globalThis as {
      localStorage?: { getItem(key: string): string | null };
    };
    if (withStorage.localStorage?.getItem("t3.wireMeter") === "1") {
      return true;
    }
  } catch {
    // Accessing localStorage can throw in sandboxed/partitioned contexts.
  }
  const withProcess = globalThis as {
    process?: { env?: Record<string, string | undefined> };
  };
  return withProcess.process?.env?.T3CODE_WIRE_METER === "1";
}
