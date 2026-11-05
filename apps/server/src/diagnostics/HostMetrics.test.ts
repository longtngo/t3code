import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  type CpuTimesSnapshot,
  cpuBusy,
  hostMetricsStream,
  make,
  makeWith,
  parseMacGpu,
  rampSampleInterval,
} from "./HostMetrics.ts";
import { makeHostDisks } from "./HostDisks.ts";

/** No test here spawns (gpu is read only on darwin and every test pins linux or win32). */
const noSpawner = ChildProcessSpawner.make(() => Effect.die("unexpected spawn"));

const firstSample = (stream: ReturnType<typeof hostMetricsStream>) =>
  stream.pipe(
    Stream.take(1),
    Stream.runCollect,
    Effect.map((samples) => samples[0]!),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner),
    Effect.provideService(HostProcess.Platform, "linux"),
  );

it.live("adds disks to a sample when the reader has them", () =>
  Effect.gen(function* () {
    const disks = [{ mount: "/", usedBytes: 1, totalBytes: 2, pct: 50, readAt: 3 }];
    const sample = yield* firstSample(hostMetricsStream(500, () => disks));
    expect(sample.disks).toEqual(disks);
  }),
);

it.live("omits disks from a sample while the reader has none", () =>
  Effect.gen(function* () {
    const sample = yield* firstSample(hostMetricsStream(500, () => undefined));
    expect("disks" in sample).toBe(false);
  }),
);

it.live("the first sample after a long idle carries a fresh disk reading", () =>
  Effect.gen(function* () {
    const clock = { mono: 0, epoch: 1_000 };
    const disks = makeHostDisks({
      statfs: () => Promise.resolve({ bsize: 4096, blocks: 100, bfree: 40, bavail: 30 }),
      readMounts: () => "/dev/a / ext4 rw 0 0\n",
      monoNow: () => clock.mono,
      epochNow: () => clock.epoch,
      log: { warn: () => {}, info: () => {} },
      platform: "linux",
      stat: async () => ({ isDirectory: () => true }),
      exists: () => false,
    });
    // Let the construct-time read's promise chain settle.
    yield* Effect.promise(async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    });
    expect(disks.snapshot()?.[0]?.readAt).toBe(1_000);
    // An hour with no subscriber: nothing called snapshot, so nothing refreshed.
    clock.mono += 3_600_000;
    clock.epoch += 3_600_000;
    const sample = yield* firstSample(hostMetricsStream(500, () => disks.snapshot()));
    expect(sample.disks?.[0]?.readAt).toBe(3_601_000);
  }),
);

it.live("make reads the real mount table on linux", () =>
  Effect.gen(function* () {
    const service = yield* make.pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner),
      Effect.provideService(HostProcess.Platform, "linux"),
    );
    const sample = yield* firstSample(service.stream(500));
    // A container root (overlay) is not allowlisted, so the list may be empty, but it is present.
    expect(Array.isArray(sample.disks)).toBe(true);
    for (const disk of sample.disks ?? []) expect(disk.totalBytes).toBeGreaterThan(0);
  }),
);

it.live("make reports no disks on an unsupported platform", () =>
  Effect.gen(function* () {
    const service = yield* make.pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner),
      Effect.provideService(HostProcess.Platform, "win32"),
    );
    const sample = yield* firstSample(service.stream(500));
    expect("disks" in sample).toBe(false);
  }),
);

/** Fake file system calls for `makeWith`, counting each call by its path. */
function fakeDiskFs(options: { mounts?: string; dataVolume?: boolean } = {}) {
  const calls = { readMounts: 0, statfs: [] as string[], exists: [] as string[] };
  const fs = {
    statfs: async (path: string) => {
      calls.statfs.push(path);
      return { bsize: 4096, blocks: 100, bfree: 40, bavail: 30 };
    },
    stat: async () => ({ isDirectory: () => true }),
    readMounts: () => {
      calls.readMounts += 1;
      return options.mounts ?? "/dev/a /a ext4 rw 0 0\n/dev/b /b\\040$x ext4 rw 0 0\n";
    },
    exists: (path: string) => {
      calls.exists.push(path);
      return options.dataVolume === true;
    },
  };
  return { fs, calls };
}

it.live("F5 every stream of one service shares one disk reader", () =>
  Effect.gen(function* () {
    const { fs, calls } = fakeDiskFs();
    const service = yield* makeWith(fs).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner),
      Effect.provideService(HostProcess.Platform, "linux"),
    );
    const samples = yield* Effect.all(
      [firstSample(service.stream(500)), firstSample(service.stream(500))],
      {
        concurrency: "unbounded",
      },
    );
    for (const sample of samples)
      expect(sample.disks?.map((d) => d.mount)).toEqual(["/a", "/b $x"]);
    // One reader: one mount-table read and one statfs per disk, however many streams.
    expect(calls.readMounts).toBe(1);
    expect(calls.statfs).toEqual(["/a", "/b $x"]);
  }),
);

it.live("N3 on macOS the service reads the data volume when it exists, else /", () =>
  Effect.gen(function* () {
    const commands: unknown[] = [];
    // Records the gpu probe's command, then fails it (the sample reports gpu null).
    const recordingSpawner = ChildProcessSpawner.make((command) => {
      commands.push(command);
      return Effect.die("no ioreg in tests");
    });
    const sampleOn = (dataVolume: boolean) =>
      Effect.gen(function* () {
        const { fs, calls } = fakeDiskFs({ dataVolume });
        const service = yield* makeWith(fs).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, recordingSpawner),
          Effect.provideService(HostProcess.Platform, "darwin"),
        );
        const sample = yield* service.stream(500).pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.map((all) => all[0]!),
          Effect.provideService(HostProcess.Platform, "darwin"),
        );
        return { sample, calls };
      });
    const withData = yield* sampleOn(true);
    expect(withData.calls.exists).toEqual(["/System/Volumes/Data"]);
    expect(withData.calls.statfs).toEqual(["/System/Volumes/Data"]);
    expect(withData.calls.readMounts).toBe(0);
    expect(withData.sample.disks?.map((d) => d.mount)).toEqual(["/"]);
    const without = yield* sampleOn(false);
    expect(without.calls.statfs).toEqual(["/"]);
    expect(without.sample.disks?.map((d) => d.mount)).toEqual(["/"]);
    // The gpu probe runs without a cwd: `process.cwd()` throws once the server's cwd is deleted.
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect((command as { options: { cwd?: string } }).options.cwd).toBeUndefined();
    }
  }),
);

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
