import { describe, expect, it } from "vite-plus/test";

import { WireByteMeter, approxWireBytes } from "./WireByteMeter.ts";

describe("approxWireBytes", () => {
  it("measures JSON byte length of a payload", () => {
    expect(approxWireBytes({ a: 1 })).toBe(Buffer.byteLength('{"a":1}'));
  });

  it("counts multi-byte UTF-8 correctly", () => {
    // "€" serializes to `"€"` = 2 quotes + 3 UTF-8 bytes = 5.
    expect(approxWireBytes("€")).toBe(5);
  });

  it("returns 0 for non-serializable values", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(approxWireBytes(circular)).toBe(0);
    expect(approxWireBytes(undefined)).toBe(0);
  });
});

describe("WireByteMeter", () => {
  it("accumulates frames and bytes per method", () => {
    const meter = new WireByteMeter();
    meter.record("subscribeHostMetrics", { ts: 1, cpu: 0.5 });
    meter.record("subscribeHostMetrics", { ts: 2, cpu: 0.6 });
    meter.record("subscribeThread", { big: "x".repeat(100) });

    const snapshot = meter.snapshot();
    const host = snapshot.subscribeHostMetrics;
    const thread = snapshot.subscribeThread;
    if (!host || !thread) {
      throw new Error("expected both methods to be recorded");
    }
    expect(host.frames).toBe(2);
    expect(host.bytes).toBeGreaterThan(0);
    expect(thread.frames).toBe(1);
    expect(thread.bytes).toBeGreaterThan(host.bytes);
  });

  it("formats a per-method table sorted by bytes descending", () => {
    const meter = new WireByteMeter();
    meter.record("small", { a: 1 });
    meter.record("large", { blob: "y".repeat(500) });
    const formatted = meter.format();

    expect(formatted).toContain("per method");
    // "large" spends more bytes so it sorts before "small".
    expect(formatted.indexOf("large")).toBeLessThan(formatted.indexOf("small"));
  });

  it("reports an empty meter clearly", () => {
    expect(new WireByteMeter().format()).toBe("[wire-meter] no frames recorded");
  });

  it("resets accumulated totals", () => {
    const meter = new WireByteMeter();
    meter.record("m", { a: 1 });
    meter.reset();
    expect(meter.snapshot()).toEqual({});
  });
});
