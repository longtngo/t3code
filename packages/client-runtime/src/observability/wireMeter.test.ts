import { describe, expect, it } from "vite-plus/test";

import {
  WireMeter,
  formatBytes,
  frameByteLength,
  getSharedWireMeter,
} from "./wireMeter.ts";

describe("WireMeter", () => {
  it("accumulates bytes and frames per direction", () => {
    const meter = new WireMeter();
    meter.record("sent", 100);
    meter.record("sent", 50);
    meter.record("recv", 2000);

    expect(meter.snapshot()).toEqual({
      sent: { bytes: 150, frames: 2 },
      recv: { bytes: 2000, frames: 1 },
    });
  });

  it("ignores negative and non-finite byte counts", () => {
    const meter = new WireMeter();
    meter.record("sent", -10);
    meter.record("sent", Number.NaN);
    meter.record("sent", Number.POSITIVE_INFINITY);

    expect(meter.snapshot()).toEqual({
      sent: { bytes: 0, frames: 0 },
      recv: { bytes: 0, frames: 0 },
    });
  });

  it("resets to zero", () => {
    const meter = new WireMeter();
    meter.record("sent", 100);
    meter.record("recv", 100);
    meter.reset();

    expect(meter.snapshot()).toEqual({
      sent: { bytes: 0, frames: 0 },
      recv: { bytes: 0, frames: 0 },
    });
  });

  it("formats a human-readable summary", () => {
    const meter = new WireMeter();
    meter.record("sent", 512);
    meter.record("recv", 4096);
    expect(meter.format()).toContain("↑");
    expect(meter.format()).toContain("↓");
  });
});

describe("formatBytes", () => {
  it("scales bytes/KB/MB", () => {
    expect(formatBytes(512)).toBe("512B");
    expect(formatBytes(2048)).toBe("2.0KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.00MB");
  });

  it("guards bad input", () => {
    expect(formatBytes(-1)).toBe("0B");
    expect(formatBytes(Number.NaN)).toBe("0B");
  });
});

describe("frameByteLength", () => {
  it("measures UTF-8 string byte length, not char count", () => {
    expect(frameByteLength("abc")).toBe(3);
    // "€" is 3 UTF-8 bytes; a naive .length would report 1.
    expect(frameByteLength("€")).toBe(3);
  });

  it("measures ArrayBuffer and typed-array views", () => {
    const buffer = new ArrayBuffer(16);
    expect(frameByteLength(buffer)).toBe(16);
    expect(frameByteLength(new Uint8Array(8))).toBe(8);
  });

  it("returns 0 for unknown payload types", () => {
    expect(frameByteLength(undefined)).toBe(0);
    expect(frameByteLength(42)).toBe(0);
  });
});

describe("getSharedWireMeter", () => {
  it("returns a stable process-wide instance", () => {
    const first = getSharedWireMeter();
    const second = getSharedWireMeter();
    expect(first).toBe(second);
  });
});
