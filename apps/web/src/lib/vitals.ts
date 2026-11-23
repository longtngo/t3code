/**
 * Severity ramp and bar helpers for the sidebar's host-resource and resource-queue rows.
 */

export type Severity = "ok" | "warn" | "high" | "crit";

/** Absolute-fullness severity: ≤50 green, ≤75 yellow, ≤90 orange, >90 red. */
export function vitalsLevel(pct: number): Severity {
  if (pct <= 50) return "ok";
  if (pct <= 75) return "warn";
  if (pct <= 90) return "high";
  return "crit";
}

export const SEVERITY_TEXT: Record<Severity, string> = {
  ok: "text-green-500",
  warn: "text-yellow-500",
  high: "text-orange-400",
  crit: "text-red-500",
};
export const SEVERITY_BG: Record<Severity, string> = {
  ok: "bg-green-500",
  warn: "bg-yellow-500",
  high: "bg-orange-400",
  crit: "bg-red-500",
};

/** Classes for a thin horizontal usage track. */
export const TRACK_CLASS = "overflow-hidden rounded-full bg-muted";

export function clampPct(value: number): number {
  // Coerce non-finite input to 0 so a stray NaN percentage never paints a full
  // (red) bar or a "NaN%" readout.
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

export interface VitalsGaugeArc {
  /** Fill, 0–100, or null when there is no reading yet. */
  readonly pct: number | null;
  /** Fill colour, or null when there is nothing to fill. */
  readonly level: Severity | null;
}

/**
 * A reading coloured by absolute fullness. Readings show rounded, so severity buckets the
 * rounded value too, or 50.4 shows "50%" (green) while colouring as yellow.
 */
export function fullnessArc(pct: number | null): VitalsGaugeArc {
  if (pct === null || !Number.isFinite(pct)) return { pct: null, level: null };
  const reading = Math.round(clampPct(pct));
  return { pct: reading, level: vitalsLevel(reading) };
}
