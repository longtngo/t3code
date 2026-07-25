import * as NodeOS from "node:os";

import type { HostMetricsSample } from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";

/** Best-effort GPU probe is bounded so a slow/missing tool never stalls a tick. */
const GPU_TIMEOUT = Duration.millis(800);
const GPU_MAX_OUTPUT_BYTES = 2_000_000;
/** Floor on the requested cadence; a delta needs a non-trivial window to be meaningful. */
const MIN_INTERVAL_MS = 500;
/** First sample uses a short window so the UI fills in quickly instead of after a full tick. */
const BOOTSTRAP_DELAY_MS = 300;
/** Default cadence when the subscriber doesn't request one — a "feels live" first look. */
const DEFAULT_INTERVAL_MS = 1500;
/**
 * Low-bandwidth cadence ramp: the stream starts at the requested interval (a fast,
 * "feels live" first look) and relaxes toward this ceiling as it runs, so a
 * long-lived idle-but-foreground subscription costs a fraction of the bytes. The
 * client tears the stream down when the tab hides and resubscribes fresh when it
 * shows again, so returning to the tab naturally resets the ramp to the fast rate.
 */
const RAMP_MAX_INTERVAL_MS = 5000;
/** Each tick lengthens the next interval by this much until the ceiling is reached. */
const RAMP_STEP_MS = 500;

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
  const cpus = NodeOS.cpus();
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
  const totalBytes = NodeOS.totalmem();
  const freeBytes = NodeOS.freemem();
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
> = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
  if (platform !== "darwin") return null;
  return yield* Effect.gen(function* () {
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

/** Static host descriptor (platform/arch injected via References; cores from the OS). */
const readHostInfo: Effect.Effect<HostMetricsSample["host"]> = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
  const arch = yield* HostProcessArchitecture;
  return {
    platform,
    arch,
    cores: NodeOS.cpus().length,
  };
});

interface SamplerState {
  readonly prevCpu: CpuTimesSnapshot;
  /** The first tick uses a short window; subsequent ticks use the full interval. */
  readonly first: boolean;
  /** Current inter-sample interval; ramps up toward {@link RAMP_MAX_INTERVAL_MS}. */
  readonly intervalMs: number;
}

/**
 * Next inter-sample interval for the cadence ramp: relax toward `maxMs` by one
 * {@link RAMP_STEP_MS} step per tick. A start interval already at/above the ceiling
 * never ramps down.
 */
export function rampSampleInterval(currentMs: number, maxMs: number): number {
  return Math.min(maxMs, currentMs + RAMP_STEP_MS);
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
  const requested = Number.isFinite(intervalMs) ? intervalMs : DEFAULT_INTERVAL_MS;
  const startInterval = Math.max(MIN_INTERVAL_MS, Math.round(requested));
  const maxInterval = Math.max(startInterval, RAMP_MAX_INTERVAL_MS);
  const bootstrap = Duration.millis(BOOTSTRAP_DELAY_MS);
  const initial: SamplerState = {
    prevCpu: readCpuTimes(),
    first: true,
    intervalMs: startInterval,
  };

  return Stream.unfold(initial, (state) =>
    Effect.gen(function* () {
      yield* Effect.sleep(state.first ? bootstrap : Duration.millis(state.intervalMs));
      const currentCpu = readCpuTimes();
      const cpu = cpuBusy(state.prevCpu, currentCpu);
      const gpu = yield* readGpu;
      const host = yield* readHostInfo;
      const now = yield* DateTime.now;
      const sample: HostMetricsSample = {
        ts: DateTime.toEpochMillis(now),
        cpu: { pct: cpu.pct, perCore: cpu.perCore, loadAvg: NodeOS.loadavg() },
        mem: readMemory(),
        gpu,
        // Sent on every sample (not just the first) so the client, which replaces
        // the whole sample each tick, never loses the host descriptor.
        host,
      };
      // Keep the first real interval at the fast rate, then relax toward the ceiling.
      const nextInterval = state.first
        ? state.intervalMs
        : rampSampleInterval(state.intervalMs, maxInterval);
      const next: SamplerState = {
        prevCpu: currentCpu,
        first: false,
        intervalMs: nextInterval,
      };
      return [sample, next] as const;
    }),
  );
}

/**
 * Service wrapper mirroring the sibling diagnostics services (e.g. ResourceQueue):
 * it captures the process spawner from the layer context so the WS handler can call
 * `stream` as a dependency-free stream. Provided via `layer` in the server DI
 * composition; sampling only runs while a subscriber holds the stream's scope.
 */
export class HostMetrics extends Context.Service<
  HostMetrics,
  {
    readonly stream: (intervalMs?: number | undefined) => Stream.Stream<HostMetricsSample>;
  }
>()("t3/diagnostics/HostMetrics") {}

export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const stream: HostMetrics["Service"]["stream"] = (intervalMs) =>
    hostMetricsStream(intervalMs ?? DEFAULT_INTERVAL_MS).pipe(
      Stream.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
  return HostMetrics.of({ stream });
});

export const layer = Layer.effect(HostMetrics, make);
