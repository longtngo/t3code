import * as Schema from "effect/Schema";

/** Instantaneous CPU utilization of the host running the server. */
export const HostMetricsCpu = Schema.Struct({
  /** Aggregate busy percentage across all logical cores, 0–100. */
  pct: Schema.Number,
  /** Per-logical-core busy percentage, 0–100. */
  perCore: Schema.Array(Schema.Number),
  /** 1/5/15-minute load averages (0 on platforms that don't report it). */
  loadAvg: Schema.Array(Schema.Number),
});

/** Host physical memory utilization. */
export const HostMetricsMem = Schema.Struct({
  usedBytes: Schema.Number,
  totalBytes: Schema.Number,
  /** usedBytes / totalBytes, 0–100. */
  pct: Schema.Number,
});

/** Host GPU utilization, when the platform exposes it (else the sample's gpu is null). */
export const HostMetricsGpu = Schema.Struct({
  /** Device utilization percentage, 0–100. */
  pct: Schema.Number,
  name: Schema.optional(Schema.String),
  vramUsedBytes: Schema.optional(Schema.Number),
});

/** Static host descriptor, sent once on the first sample of a subscription. */
export const HostMetricsHost = Schema.Struct({
  platform: Schema.String,
  arch: Schema.String,
  cores: Schema.Number,
});

/** One push from the host-metrics subscription, emitted roughly every 1–2s. */
export const HostMetricsSample = Schema.Struct({
  /** Sample wall-clock time (epoch ms). */
  ts: Schema.Number,
  cpu: HostMetricsCpu,
  mem: HostMetricsMem,
  /** null when the host/platform doesn't expose GPU utilization. */
  gpu: Schema.NullOr(HostMetricsGpu),
  /** Static host descriptor; sent on every sample so the client never loses it. */
  host: Schema.optional(HostMetricsHost),
});
export type HostMetricsSample = typeof HostMetricsSample.Type;
