/**
 * Dev-only per-RPC-method byte/frame counter for the server → client direction.
 *
 * Phase 0 of the low-bandwidth roadmap. The client-side {@link WireMeter} gives
 * the exact on-wire totals; this gives the *attribution* — which subscription or
 * method is spending the bytes — so later phases can prove their specific gate
 * (e.g. "host-metrics/llm-models drop to ~zero when backgrounded").
 *
 * It measures the decoded payload value (approximated as JSON byte length, the
 * current wire format) just above the serialization layer, so it is a close
 * proxy for the real frame size rather than the exact post-deflate size.
 *
 * Enabled only when `T3CODE_WIRE_METER=1`; otherwise every entry point is a
 * cheap no-op and no timer is ever started.
 */

export interface MethodTotals {
  readonly frames: number;
  readonly bytes: number;
}

/** Approximate serialized byte size of a payload value (JSON wire format today). */
export function approxWireBytes(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : Buffer.byteLength(json);
  } catch {
    // Circular refs or non-serializable payloads — not something the wire carries.
    return 0;
  }
}

/** Pure per-method accumulator; framework-free for straightforward unit testing. */
export class WireByteMeter {
  readonly #perMethod = new Map<string, { frames: number; bytes: number }>();

  record(method: string, value: unknown): void {
    const totals = this.#perMethod.get(method) ?? { frames: 0, bytes: 0 };
    totals.frames += 1;
    totals.bytes += approxWireBytes(value);
    this.#perMethod.set(method, totals);
  }

  snapshot(): Record<string, MethodTotals> {
    const out: Record<string, MethodTotals> = {};
    for (const [method, totals] of this.#perMethod) {
      out[method] = { frames: totals.frames, bytes: totals.bytes };
    }
    return out;
  }

  format(): string {
    const rows = [...this.#perMethod.entries()].sort((a, b) => b[1].bytes - a[1].bytes);
    if (rows.length === 0) {
      return "[wire-meter] no frames recorded";
    }
    const totalFrames = rows.reduce((sum, [, totals]) => sum + totals.frames, 0);
    const totalBytes = rows.reduce((sum, [, totals]) => sum + totals.bytes, 0);
    const lines = rows.map(([method, totals]) => `  ${method}  ${totals.frames}f  ${totals.bytes}B`);
    return `[wire-meter] server→client per method — ${totalFrames}f ${totalBytes}B total\n${lines.join("\n")}`;
  }

  reset(): void {
    this.#perMethod.clear();
  }
}

export const wireByteMeterEnabled = (): boolean => process.env.T3CODE_WIRE_METER === "1";

const sharedMeter = new WireByteMeter();

export function getSharedWireByteMeter(): WireByteMeter {
  return sharedMeter;
}

let loggerStarted = false;

function ensurePeriodicLogger(): void {
  if (loggerStarted || !wireByteMeterEnabled()) {
    return;
  }
  loggerStarted = true;
  // @effect-diagnostics-next-line globalTimers:off - dev-only bandwidth instrument; a bare unref'd interval, not fiber scheduling.
  const timer = setInterval(() => {
    const snapshot = sharedMeter.snapshot();
    if (Object.keys(snapshot).length > 0) {
      // @effect-diagnostics-next-line globalConsole:off - dev-only bandwidth instrument on a plain setInterval, not an Effect fiber.
      console.info(sharedMeter.format());
    }
  }, 15_000);
  // Never let the meter hold the process open.
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
}

/**
 * Records one server→client frame for `method`. No-op unless the meter is
 * enabled; starts the periodic logger on first use.
 */
export function recordMethodBytes(method: string, value: unknown): void {
  if (!wireByteMeterEnabled()) {
    return;
  }
  ensurePeriodicLogger();
  sharedMeter.record(method, value);
}
