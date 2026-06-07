import type { OrchestrationThreadActivity } from "@t3tools/contracts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export interface UsageWindow {
  readonly utilization: number;
  readonly resetsAt: string | null;
}

export interface UsageExtra {
  readonly isEnabled: boolean;
  readonly usedCredits: number; // cents
  readonly monthlyLimit: number; // cents
  readonly utilization: number;
  readonly currency: string | null;
}

export interface UsageSnapshot {
  readonly fiveHour: UsageWindow | null;
  readonly sevenDay: UsageWindow | null;
  readonly extra: UsageExtra | null;
  readonly updatedAt: string;
}

function deriveWindow(value: unknown): UsageWindow | null {
  const record = asRecord(value);
  if (!record) return null;
  const utilization = asFiniteNumber(record.utilization);
  if (utilization === null) return null;
  return { utilization, resetsAt: asString(record.resetsAt) };
}

function deriveExtra(value: unknown): UsageExtra | null {
  const record = asRecord(value);
  if (!record) return null;
  // A disabled extra-credits segment is never rendered (buildSegments and the
  // popover both gate on isEnabled), so treat it as absent — otherwise a
  // disabled-only payload looks "usable" and yields an empty meter.
  if (record.isEnabled !== true) return null;
  return {
    isEnabled: true,
    usedCredits: asFiniteNumber(record.usedCredits) ?? 0,
    monthlyLimit: asFiniteNumber(record.monthlyLimit) ?? 0,
    utilization: asFiniteNumber(record.utilization) ?? 0,
    currency: asString(record.currency),
  };
}

/**
 * Find the most recent `account.usage.updated` activity and project it to a
 * typed snapshot. Mirrors `deriveLatestContextWindowSnapshot`.
 */
export function deriveLatestUsageSnapshot(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): UsageSnapshot | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "account.usage.updated") {
      continue;
    }
    const payload = asRecord(activity.payload);
    const fiveHour = deriveWindow(payload?.fiveHour);
    const sevenDay = deriveWindow(payload?.sevenDay);
    const extra = deriveExtra(payload?.extra);
    if (fiveHour === null && sevenDay === null && extra === null) {
      continue;
    }
    return { fiveHour, sevenDay, extra, updatedAt: activity.createdAt };
  }
  return null;
}

/** Fixed window lengths, used to derive elapsed time from `resetsAt`. */
export const USAGE_WINDOW_MS = {
  fiveHour: 5 * 60 * 60 * 1000,
  sevenDay: 7 * 24 * 60 * 60 * 1000,
} as const;

/** Below this |delta| (percentage points) we treat usage as tracking the pace. */
export const PACE_DEADZONE = 3;

export type PaceState = "ahead" | "behind" | "onPace";

export interface Pace {
  /** Where usage "should" be by now: share of the window elapsed, 0–100. */
  readonly elapsedPct: number;
  /** utilization − elapsedPct. Positive = ahead (burning faster than allowance). */
  readonly delta: number;
  readonly state: PaceState;
}

/**
 * Compare current utilization against the share of the window that has elapsed.
 * The API gives us the reset time, not the window start, so elapsed is derived
 * as `windowMs − (resetsAt − now)`. In a 5-hour window, "on pace" is 1% every
 * 3 minutes; being above that line means you'll exhaust the window early.
 *
 * Returns null when we can't place ourselves in the window — no `resetsAt`, an
 * unparseable value, or a reset time that sits outside one window length (stale
 * data or a clock skew), where a pace comparison would be misleading.
 */
export function computePace(
  utilization: number,
  resetsAt: string | null,
  windowMs: number,
  now: number,
): Pace | null {
  if (!resetsAt) return null;
  const resetMs = new Date(resetsAt).getTime();
  if (!Number.isFinite(resetMs)) return null;
  const elapsedPct = ((windowMs - (resetMs - now)) / windowMs) * 100;
  if (elapsedPct <= 0 || elapsedPct > 100) return null;
  const delta = utilization - elapsedPct;
  const state: PaceState =
    Math.abs(delta) < PACE_DEADZONE ? "onPace" : delta > 0 ? "ahead" : "behind";
  return { elapsedPct, delta, state };
}

export type UsageLevel = "green" | "yellow" | "orange" | "red";

/**
 * Map a utilization percentage to a severity level. Thresholds match the
 * reference `statusline.sh` `usage_color`: ≥90 red, ≥70 orange, ≥50 yellow.
 */
export function usageLevel(pct: number): UsageLevel {
  if (pct >= 90) return "red";
  if (pct >= 70) return "orange";
  if (pct >= 50) return "yellow";
  return "green";
}

/** Format a reset timestamp in local time: "14:30" (time) or "Mon Jun 8, 04:00" (datetime). */
export function formatResetTime(iso: string | null, style: "time" | "datetime"): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  if (style === "time") {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

/** Format integer cents as a currency-ish dollar amount: 43540 → "$435.40". */
export function formatCredits(cents: number): string {
  const safe = Number.isFinite(cents) && cents > 0 ? cents : 0;
  return `$${(safe / 100).toFixed(2)}`;
}

/** Short dollar amount for tight inline rendering: 43540 → "$435", 200000 → "$2k". */
export function formatCreditsShort(cents: number): string {
  const dollars = (Number.isFinite(cents) && cents > 0 ? cents : 0) / 100;
  if (dollars >= 1000) {
    const thousands = dollars / 1000;
    const rounded = Math.round(thousands * 10) / 10;
    return `$${rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1)}k`;
  }
  return `$${Math.round(dollars)}`;
}
