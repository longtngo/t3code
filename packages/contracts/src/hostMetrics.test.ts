import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { HostMetricsSample } from "./hostMetrics.ts";
import { ResourceQueueSnapshot } from "./server.ts";

const base = {
  ts: 1,
  cpu: { pct: 1, perCore: [1], loadAvg: [0, 0, 0] },
  mem: { usedBytes: 1, totalBytes: 2, pct: 50 },
  gpu: null,
};
const disk = { mount: "/", usedBytes: 1, totalBytes: 2, pct: 50, readAt: 5 };
const decode = Schema.decodeUnknownSync(HostMetricsSample);
const snap = {
  ts: 1,
  available: false,
  maintenance: false,
  resources: [],
  running: [],
  waiting: [],
};
const decodeSnap = Schema.decodeUnknownSync(ResourceQueueSnapshot);

describe("HostMetricsSample disks", () => {
  it("decodes a sample without disks", () => {
    expect(decode(base).disks).toBeUndefined();
  });
  it("decodes a sample with disks", () => {
    expect(decode({ ...base, disks: [disk] }).disks).toEqual([disk]);
  });
  it("rejects a disk without readAt", () => {
    const { readAt: _r, ...noRead } = disk;
    expect(() => decode({ ...base, disks: [noRead] })).toThrow();
  });
  it("old sample schema decodes a new sample and drops disks", () => {
    const { disks: _d, ...fields } = HostMetricsSample.fields;
    const old = Schema.decodeUnknownSync(Schema.Struct(fields));
    expect("disks" in old({ ...base, disks: [disk] })).toBe(false);
  });
});

describe("ResourceQueueSnapshot unavailableReason", () => {
  it("decodes with and without it", () => {
    expect(decodeSnap(snap).unavailableReason).toBeUndefined();
    expect(decodeSnap({ ...snap, unavailableReason: "resctl missing" }).unavailableReason).toBe(
      "resctl missing",
    );
  });
  it("rejects blank unavailableReason", () => {
    expect(() => decodeSnap({ ...snap, unavailableReason: "  " })).toThrow();
  });
});
