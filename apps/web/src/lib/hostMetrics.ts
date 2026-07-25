import type { HostMetricsSample } from "@t3tools/contracts";

export type { HostMetricsSample };

/** Fixed-width value slot so a segment's width never changes as digits/dashes swap in. */
export const METER_VALUE_SLOT = "inline-block min-w-[1.85rem] tabular-nums";

export type UsageLevel = "green" | "yellow" | "orange" | "red";

/** Severity thresholds shared by every host-metric meter (≥90 red, ≥70 orange, ≥50 yellow). */
export function usageLevel(pct: number): UsageLevel {
  if (pct >= 90) return "red";
  if (pct >= 70) return "orange";
  if (pct >= 50) return "yellow";
  return "green";
}

/**
 * Severity level for a host-metric percentage. Named alias of {@link usageLevel}
 * so callers read as "metric" severity at the call site.
 */
export function metricLevel(pct: number): UsageLevel {
  return usageLevel(pct);
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** Human-readable bytes in base-1000 units (matches how RAM is advertised). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const exponent = Math.min(BYTE_UNITS.length - 1, Math.floor(Math.log10(bytes) / 3));
  const value = bytes / 1000 ** exponent;
  // Whole bytes; one decimal for KB and up (e.g. "137.4 GB", "2 MB").
  const rounded = exponent === 0 ? Math.round(value) : Number(value.toFixed(1));
  return `${rounded} ${BYTE_UNITS[exponent]}`;
}
