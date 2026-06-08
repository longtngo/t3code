import * as os from "node:os";

import type { HostMetricsSample } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";

/** Best-effort GPU probe is bounded so a slow/missing tool never stalls a tick. */
const GPU_TIMEOUT = Duration.millis(800);
const GPU_MAX_OUTPUT_BYTES = 2_000_000;
/** Floor on the requested cadence; a delta needs a non-trivial window to be meaningful. */
const MIN_INTERVAL_MS = 500;
/** First sample uses a short window so the UI fills in quickly instead of after a full tick. */
const BOOTSTRAP_DELAY_MS = 300;

export interface CpuTimesSnapshot {
  readonly idle: number;
  readonly total: number;
  readonly perCore: ReadonlyArray<{ readonly idle: number; readonly total: number }>;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

/** Snapshot cumulative CPU times; busy % is derived from the delta between two snapshots. */
function readCpuTimes(): CpuTimesSnapshot {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  const perCore = cpus.map((cpu) => {
    const t = cpu.times;
    const coreTotal = t.user + t.nice + t.sys + t.idle + t.irq;
    idle += t.idle;
    total += coreTotal;
    return { idle: t.idle, total: coreTotal };
  });
  return { idle, total, perCore };
}

export function cpuBusy(
  prev: CpuTimesSnapshot,
  current: CpuTimesSnapshot,
): { readonly pct: number; readonly perCore: number[] } {
  const deltaIdle = current.idle - prev.idle;
  const deltaTotal = current.total - prev.total;
  const pct = deltaTotal > 0 ? clampPercent(100 * (1 - deltaIdle / deltaTotal)) : 0;
  const perCore = current.perCore.map((core, index) => {
    const before = prev.perCore[index] ?? core;
    const coreIdle = core.idle - before.idle;
    const coreTotal = core.total - before.total;
    return coreTotal > 0 ? clampPercent(100 * (1 - coreIdle / coreTotal)) : 0;
  });
  return { pct, perCore };
}

function readMemory(): HostMetricsSample["mem"] {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  return {
    usedBytes,
    totalBytes,
    pct: totalBytes > 0 ? clampPercent((100 * usedBytes) / totalBytes) : 0,
  };
}

/** Parse macOS `ioreg` IOAccelerator output for GPU device utilization + VRAM in use. */
export function parseMacGpu(ioregOutput: string): HostMetricsSample["gpu"] {
  const utilizationMatch = ioregOutput.match(/"Device Utilization %"=(\d+)/);
  if (!utilizationMatch) return null;
  const gpu: { pct: number; name?: string; vramUsedBytes?: number } = {
    pct: clampPercent(Number(utilizationMatch[1])),
  };
  const vramMatch = ioregOutput.match(/"In use system memory"=(\d+)/);
  if (vramMatch) {
    const vram = Number(vramMatch[1]);
    if (Number.isFinite(vram)) gpu.vramUsedBytes = vram;
  }
  return gpu;
}

/**
 * Read GPU utilization for the current platform, degrading to `null` (rather than
 * failing the whole sample) on timeout, spawn error, or an unsupported platform.
 * v1 supports macOS via `ioreg`; other platforms report null.
 */
const readGpu: Effect.Effect<
  HostMetricsSample["gpu"],
  never,
  ChildProcessSpawner.ChildProcessSpawner
> = Effect.suspend(() => {
  if (process.platform !== "darwin") return Effect.succeed(null);
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make("ioreg", ["-r", "-c", "IOAccelerator", "-d", "1"], { cwd: process.cwd() }),
    );
    const collected = yield* collectUint8StreamText({
      stream: child.stdout,
      maxBytes: GPU_MAX_OUTPUT_BYTES,
    });
    return parseMacGpu(collected.text);
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(GPU_TIMEOUT),
    Effect.map((result) => (Option.isSome(result) ? result.value : null)),
    Effect.catchCause(() => Effect.succeed(null)),
  );
});

const HOST_INFO: HostMetricsSample["host"] = {
  platform: process.platform,
  arch: process.arch,
  cores: os.cpus().length,
};

interface SamplerState {
  readonly prevCpu: CpuTimesSnapshot;
  /** The first tick uses a short window; subsequent ticks use the full interval. */
  readonly first: boolean;
}

/**
 * A per-subscriber stream of host CPU/GPU/memory samples. Carrying the previous
 * CPU-times snapshot in the unfold state lets each tick report busy % over the
 * interval just elapsed. The stream never completes on its own; it ends when the
 * subscriber's scope closes (i.e. the client unsubscribes), which also stops
 * sampling — no background work runs without a listener.
 */
export function hostMetricsStream(
  intervalMs: number,
): Stream.Stream<HostMetricsSample, never, ChildProcessSpawner.ChildProcessSpawner> {
  const interval = Duration.millis(Math.max(MIN_INTERVAL_MS, Math.round(intervalMs)));
  const bootstrap = Duration.millis(BOOTSTRAP_DELAY_MS);
  const initial: SamplerState = { prevCpu: readCpuTimes(), first: true };

  return Stream.unfold(initial, (state) =>
    Effect.gen(function* () {
      yield* Effect.sleep(state.first ? bootstrap : interval);
      const currentCpu = readCpuTimes();
      const cpu = cpuBusy(state.prevCpu, currentCpu);
      const gpu = yield* readGpu;
      const now = yield* DateTime.now;
      const sample: HostMetricsSample = {
        ts: DateTime.toEpochMillis(now),
        cpu: { pct: cpu.pct, perCore: cpu.perCore, loadAvg: os.loadavg() },
        mem: readMemory(),
        gpu,
        // Sent on every sample (not just the first) so the client, which replaces
        // the whole sample each tick, never loses the host descriptor.
        host: HOST_INFO,
      };
      const next: SamplerState = { prevCpu: currentCpu, first: false };
      return [sample, next] as const;
    }),
  );
}
