import type { HostMetricsSample } from "@t3tools/contracts";

export type { HostMetricsSample };

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
