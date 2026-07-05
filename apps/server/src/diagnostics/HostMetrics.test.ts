import { expect, it } from "@effect/vitest";

import {
  type CpuTimesSnapshot,
  cpuBusy,
  parseMacGpu,
  rampSampleInterval,
} from "./HostMetrics.ts";

const REAL_IOREG_FRAGMENT =
  '"PerformanceStatistics" = {"In use system memory (driver)"=0,"Alloc system memory"=6930890752,' +
  '"Tiler Utilization %"=0,"recoveryCount"=0,"lastRecoveryTime"=0,"Renderer Utilization %"=0,' +
  '"TiledSceneBytes"=1179648,"Device Utilization %"=97,"SplitSceneCount"=0,' +
  '"Allocated PB Size"=128974848,"In use system memory"=1444118528}';

it("ramps the sample interval up toward the ceiling one step at a time", () => {
  const max = 5000;
  // Starting at the fast 1.5s rate, walk the ramp to the ceiling and confirm it caps.
  const sequence: number[] = [];
  let current = 1500;
  for (let tick = 0; tick < 10; tick++) {
    current = rampSampleInterval(current, max);
    sequence.push(current);
  }
  expect(sequence.slice(0, 4)).toEqual([2000, 2500, 3000, 3500]);
  expect(sequence.at(-1)).toBe(5000);
  // Never exceeds the ceiling.
  expect(Math.max(...sequence)).toBe(5000);
});

it("never ramps an already-slow interval below its start", () => {
  // A caller that explicitly requested a slow cadence at/above the ceiling stays put.
  expect(rampSampleInterval(8000, 8000)).toBe(8000);
});

it("parses GPU utilization and VRAM from real ioreg output", () => {
  const gpu = parseMacGpu(REAL_IOREG_FRAGMENT);
  expect(gpu).not.toBeNull();
  expect(gpu?.pct).toBe(97);
  expect(gpu?.vramUsedBytes).toBe(1_444_118_528);
});

it("returns null when ioreg output lacks a utilization field", () => {
  expect(parseMacGpu('"SomethingElse"=5')).toBeNull();
  expect(parseMacGpu("")).toBeNull();
});

it("clamps an out-of-range utilization reading", () => {
  expect(parseMacGpu('"Device Utilization %"=250')?.pct).toBe(100);
});

const cpuSnapshot = (idle: number, busy: number): CpuTimesSnapshot => ({
  idle,
  total: idle + busy,
  perCore: [{ idle, total: idle + busy }],
});

it("computes busy percentage from the delta between two snapshots", () => {
  // Between snapshots: idle advanced 25, busy advanced 75 → 75% busy.
  const prev = cpuSnapshot(100, 100);
  const current = cpuSnapshot(125, 175);
  const result = cpuBusy(prev, current);
  expect(result.pct).toBe(75);
  expect(result.perCore[0]).toBe(75);
});

it("reports 0% when no time elapsed between snapshots", () => {
  const snapshot = cpuSnapshot(100, 100);
  expect(cpuBusy(snapshot, snapshot).pct).toBe(0);
});

it("handles a fully idle interval", () => {
  const prev = cpuSnapshot(100, 50);
  const current = cpuSnapshot(200, 50);
  expect(cpuBusy(prev, current).pct).toBe(0);
});
