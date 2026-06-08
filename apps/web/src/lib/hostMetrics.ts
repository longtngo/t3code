import type { HostMetricsSample } from "@t3tools/contracts";
import { type UsageLevel, usageLevel } from "./usage";

export type { HostMetricsSample };

/**
 * Severity level for a host-metric percentage. Reuses the account-usage
 * thresholds (≥90 red, ≥70 orange, ≥50 yellow) so the two meters read alike.
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
