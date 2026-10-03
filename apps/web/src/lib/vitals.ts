import type { ServerProviderUsageLimits, ServerProviderUsageSpend } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";

import { formatShortTimestamp } from "../timestampFormat";

/**
 * Vitals gauge logic — the pure (testable) core behind the header's combined
 * context / usage-limit / host-resource affordance. Covers the two severity
 * ramps the user specified, the pace projection for rolling usage windows, the
 * view of a provider's usage limits, and the split-ring arc geometry.
 */

export type Severity = "ok" | "warn" | "high" | "crit";

/**
 * Absolute-fullness severity (context + host resources): ≤50 green, ≤75 yellow,
 * ≤90 orange, >90 red. Distinct from the host panel's old `usageLevel` (70/90) —
 * these are the thresholds the user specified for the gauge.
 */
export function vitalsLevel(pct: number): Severity {
  if (pct <= 50) return "ok";
  if (pct <= 75) return "warn";
  if (pct <= 90) return "high";
  return "crit";
}

/**
 * Pace severity for a usage window, keyed on `diff = utilization − projection`:
 * green at or under pace, yellow up to `tolerance` points over, red beyond. There
 * is no orange step: `tolerance` is the user's "Pace tolerance" setting.
 */
export function paceLevel(diff: number, tolerance: number): Severity {
  if (diff <= 0) return "ok";
  if (diff <= tolerance) return "warn";
  return "crit";
}

/** Severity → the app's Tailwind palette (matches the old host panel's mapping). */
export const SEVERITY_STROKE: Record<Severity, string> = {
  ok: "var(--color-green-500)",
  warn: "var(--color-yellow-500)",
  high: "var(--color-orange-400)",
  crit: "var(--color-red-500)",
};
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

/** Unfilled arc / bar track — matches the context meter's track tint. */
export const VITALS_TRACK_STROKE =
  "color-mix(in oklab, var(--color-muted-foreground) 24%, transparent)";

export function clampPct(value: number): number {
  // Coerce non-finite input to 0 so a stray NaN percentage never paints a full
  // (red) ring or a "NaN%" readout.
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

// ---------------------------------------------------------------------------
// Account usage (rolling 5-hour / 7-day windows)
// ---------------------------------------------------------------------------

/** Rolling-window durations, in ms, used to turn `resetsAt` into an elapsed fraction. */
export const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
export const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;
const ONE_MINUTE_MS = 60 * 1000;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

export interface UsageWindowView {
  /** Float percent 0..100. */
  readonly utilization: number;
  /** ISO 8601 reset instant, or null when the provider doesn't expose one. */
  readonly resetsAt: string | null;
}

/**
 * Any window other than Claude's 5h/7d (Codex session/weekly, Cursor's cycle
 * pools, Claude's model-scoped weekly), shown as a popover row. `windowMs` is
 * null when the provider sends no window length, and the row then shows
 * utilization without a pace projection.
 */
export interface LabeledUsageWindowView extends UsageWindowView {
  readonly id: string;
  readonly label: string;
  readonly windowMs: number | null;
  readonly segmentCount?: number | undefined;
}

/**
 * A spend row rendered as a paced window rather than a bare balance.
 *
 * The reset instant is DERIVED (see {@link billingMonthWindow}), not sent by the
 * provider, which is why this is a distinct shape from
 * {@link LabeledUsageWindowView}: `detail` carries the money figure that a
 * percentage-only window row would drop, and `segmentCount` the days in the
 * month.
 */
export interface SpendWindowView extends UsageWindowView {
  readonly label: string;
  readonly detail: string;
  readonly windowMs: number;
  readonly segmentCount: number;
}

export interface AccountUsageView {
  readonly fiveHour: UsageWindowView | null;
  readonly sevenDay: UsageWindowView | null;
  /** Claude's extra usage, when spending is enabled. Paced by {@link extraUsageWindow}. */
  readonly spend: ServerProviderUsageSpend | null;
  /**
   * When the provider last reported these numbers. Honest for the ring's
   * 5h/7d, which every turn event updates together; the model-scoped and
   * spend rows only refresh with a probe, so they can be up to one probe
   * interval older than this label says.
   */
  readonly fetchedAt: string | null;
  /** Every other window, in the provider's order. The ring glyph draws only 5h/7d. */
  readonly extraWindows: ReadonlyArray<LabeledUsageWindowView>;
}

/**
 * The gauge's view of one provider instance's usage limits: the same
 * `ServerProvider.usageLimits` snapshot the Limits tab reads, so the two
 * surfaces cannot disagree. Claude's `five_hour` / `seven_day` windows feed
 * the ring; everything else becomes a popover row.
 *
 * Null when there is nothing to draw: no snapshot, an account that can never
 * report windows, or a probe that has not produced any yet.
 */
export function accountUsageFromLimits(
  limits: ServerProviderUsageLimits | null | undefined,
): AccountUsageView | null {
  if (
    !limits ||
    limits.unavailable?.reason === "unsupported" ||
    (limits.windows.length === 0 && !limits.spend)
  ) {
    return null;
  }
  let fiveHour: UsageWindowView | null = null;
  let sevenDay: UsageWindowView | null = null;
  const extraWindows: LabeledUsageWindowView[] = [];
  for (const window of limits.windows) {
    const view = { utilization: window.usedPercent, resetsAt: window.resetsAt ?? null };
    if (window.id === "five_hour") {
      fiveHour = view;
      continue;
    }
    if (window.id === "seven_day") {
      sevenDay = view;
      continue;
    }
    const windowMs =
      window.windowDurationMins !== undefined && window.windowDurationMins > 0
        ? window.windowDurationMins * 60_000
        : null;
    extraWindows.push({
      ...view,
      id: window.id,
      label: window.label,
      windowMs,
      ...(windowMs !== null ? { segmentCount: windowSegments(windowMs) } : {}),
    });
  }
  return {
    fiveHour,
    sevenDay,
    spend: limits.spend ?? null,
    fetchedAt: limits.checkedAt,
    extraWindows,
  };
}

/**
 * Format a spend figure with its currency. A money amount keeps both decimals
 * on both sides — "$12.50 of $50" reads as two different kinds of number.
 */
function formatSpend(used: number, limit: number | null, currency: string): string {
  const symbol = currency === "USD" ? "$" : `${currency} `;
  const amount = (value: number) => `${symbol}${value.toFixed(2)}`;
  return limit === null ? amount(used) : `${amount(used)} of ${amount(limit)}`;
}

/**
 * Extra usage as a paced billing-month row. Null until spending has started,
 * as on the fork (an enabled cap with nothing spent is not worth a row), and
 * when the provider gave no percentage to pace (a spend with no cap). The
 * reset instant is derived, not reported. See {@link billingMonthWindow}.
 *
 * Overspend: the bar is capped at 100% by the server's `usedPercent`, while
 * `detail` shows the real amount, which can exceed the limit.
 */
export function extraUsageWindow(
  spend: ServerProviderUsageSpend | null,
  nowMs: number,
): SpendWindowView | null {
  if (!spend || spend.used <= 0 || spend.usedPercent === undefined) return null;
  const { resetsAt, windowMs } = billingMonthWindow(nowMs);
  return {
    label: "Extra usage",
    detail: formatSpend(spend.used, spend.limit ?? null, spend.currency),
    utilization: spend.usedPercent,
    resetsAt,
    windowMs,
    segmentCount: daysInUtcMonth(nowMs),
  };
}

/** Day dividers for windows of a day or longer, hour dividers below that. */
function windowSegments(windowMs: number): number {
  return Math.max(1, Math.round(windowMs / (windowMs >= ONE_DAY_MS ? ONE_DAY_MS : ONE_HOUR_MS)));
}

export interface WindowPace {
  /** Rounded utilization, for display and bar width. */
  readonly usage: number;
  /**
   * Rounded on-pace target — the fraction of the window's time elapsed — or null
   * when `resetsAt` is missing/invalid (no pace can be computed).
   */
  readonly projection: number | null;
  /** `usage − projection`, or null when there is no projection. */
  readonly diff: number | null;
}

/**
 * Projection = the share of the window's clock that has already elapsed
 * (`1 − timeUntilReset / windowMs`), which is where usage *would* sit if spent
 * evenly. The signed `diff` against actual usage is the row's headline figure.
 *
 * This once replaced the reset time outright; the row now shows both, since pace
 * ("am I burning this too fast?") and {@link formatWindowReset} ("when do I get
 * it back?") answer different questions.
 */
export function computeWindowPace(
  window: UsageWindowView,
  windowMs: number | null,
  nowMs: number,
): WindowPace {
  const usage = Math.round(window.utilization);
  let projection: number | null = null;
  if (windowMs !== null && window.resetsAt !== null) {
    const resetMs = Date.parse(window.resetsAt);
    if (Number.isFinite(resetMs)) {
      projection = Math.round(clampPct((1 - (resetMs - nowMs) / windowMs) * 100));
    }
  }
  const diff = projection === null ? null : usage - projection;
  return { usage, projection, diff };
}

/** Severity for a window row: by pace when a projection exists, else by fullness. */
export function windowSeverity(pace: WindowPace, tolerance: number): Severity {
  return pace.diff === null ? vitalsLevel(pace.usage) : paceLevel(pace.diff, tolerance);
}

/** Date half of a distant reset. System locale, matching `formatShortTimestamp`. */
const resetDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "numeric",
  day: "numeric",
});

/**
 * When a window resets: `14:20` inside 24 hours, `8/21 14:20` beyond, and `now`
 * once the instant has passed — providers refresh lazily, so an elapsed reset
 * timestamp lingers briefly and would otherwise render as a time in the past.
 * Null when there is no reset clock to show, in which case the row omits it.
 *
 * Pace answers "am I burning this too fast?"; this answers "when do I get it
 * back?". The gauge showed only the former (see `computeWindowPace`), so both
 * are rendered now rather than one replacing the other.
 *
 * The time half delegates to `formatShortTimestamp` so the user's 12/24-hour
 * preference is honoured. The predecessor helper this revives hardcoded
 * `hourCycle: "h23"`, which is the bug class upstream fixed in #4438.
 */
export function formatWindowReset(
  resetsAt: string | null,
  nowMs: number,
  timestampFormat: TimestampFormat,
): string | null {
  if (resetsAt === null) return null;
  const at = Date.parse(resetsAt);
  // Guarded here rather than left to the delegate: formatShortTimestamp answers
  // "" for an unparseable date, which would render a bare "resets" with no time.
  if (!Number.isFinite(at)) return null;
  if (at <= nowMs) return "now";
  const time = formatShortTimestamp(resetsAt, timestampFormat);
  if (time === "") return null;
  return at - nowMs < ONE_DAY_MS ? time : `${resetDateFormatter.format(at)} ${time}`;
}

/**
 * Where a bar's unit boundaries fall, as a CSS `background-image`.
 *
 * Built stop-by-stop rather than with `repeating-linear-gradient` because the
 * repeating form also emits a boundary at 100%, which lands inside the track's
 * rounded cap and renders as a sliver darkening the right-hand end at every
 * segment count. This draws `segments - 1` interior boundaries and nothing else.
 *
 * The caller must paint this ABOVE the fill, not on the track. A background on
 * the track is painted before its positioned children, so separators drawn
 * there are hidden under the fill — invisible in exactly the case the segments
 * exist to explain. Measured at the real popover width: at 31 segments and 97%
 * used, zero of them were visible.
 */
export function segmentBoundariesBackground(segments: number): string | undefined {
  if (!Number.isFinite(segments) || segments < 2) return undefined;
  const count = Math.min(Math.round(segments), 62);
  const stops: string[] = [];
  for (let index = 1; index < count; index += 1) {
    const at = (index / count) * 100;
    stops.push(
      `transparent calc(${at}% - 0.5px)`,
      `var(--segment-gap, var(--popover)) calc(${at}% - 0.5px)`,
      `var(--segment-gap, var(--popover)) calc(${at}% + 0.5px)`,
      `transparent calc(${at}% + 0.5px)`,
    );
  }
  return stops.length > 0 ? `linear-gradient(to right, ${stops.join(", ")})` : undefined;
}

/** Days in the UTC month containing `nowMs`; the extra-usage bar's segment count. */
export function daysInUtcMonth(nowMs: number): number {
  const now = new Date(nowMs);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
}

/**
 * The billing month as a pace-able window: when it resets, and how long it is.
 *
 * The provider sends neither. `GET /api/oauth/usage` returns `extra_usage`
 * with `is_enabled`, `monthly_limit`, `used_credits`, `utilization` and
 * `currency` and no reset instant at all, so this is DERIVED from the
 * maintainer's statement that the anchor is the 1st — it is not provider data,
 * and if the account's billing anchor is not the 1st the pace is wrong.
 *
 * Derived in UTC, deliberately. Anchoring on the local month makes the boundary
 * cross at a different real instant for every user: at UTC+14 the local month
 * turns over 14 hours before the provider's counter resets, so a normal account
 * reads "+98% over pace" in the most severe colour for those 14 hours, every
 * month. `windowMs` is the distance between the two boundaries rather than
 * `days * 86_400_000`, so the length always matches the month it describes.
 */
export function billingMonthWindow(nowMs: number): { resetsAt: string; windowMs: number } {
  const now = new Date(nowMs);
  const startedAt = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const resetsAt = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return { resetsAt: new Date(resetsAt).toISOString(), windowMs: resetsAt - startedAt };
}

/**
 * How old a polled snapshot is, for the refresh control's label.
 *
 * Floored at "just now" rather than allowed to go negative: the instant is
 * stamped by the server and `nowMs` is the client's clock, so on a remote or
 * relayed connection a phone a few minutes ahead would otherwise render
 * "-4m ago".
 */
export function formatSnapshotAge(fetchedAt: string | null, nowMs: number): string | null {
  if (fetchedAt === null) return null;
  const at = Date.parse(fetchedAt);
  if (!Number.isFinite(at)) return null;
  const elapsed = nowMs - at;
  if (elapsed < ONE_MINUTE_MS) return "just now";
  if (elapsed < ONE_HOUR_MS) return `${Math.floor(elapsed / ONE_MINUTE_MS)}m ago`;
  if (elapsed < ONE_DAY_MS) return `${Math.floor(elapsed / ONE_HOUR_MS)}h ago`;
  return `${Math.floor(elapsed / ONE_DAY_MS)}d ago`;
}

/**
 * One gauge arc: how far it sweeps, and what colour it is.
 *
 * The two are NOT the same question, and conflating them is what made the icon
 * disagree with the detail panel: a usage window sweeps by fullness but is
 * coloured by *pace*, so a window at 74% that is comfortably under pace reads
 * green in the panel while colouring it by fullness alone would paint it
 * yellow. Carrying the severity on the arc — rather than re-deriving it from
 * the percentage at draw time — is what keeps the two surfaces from drifting.
 */
export interface VitalsGaugeArc {
  /** Sweep, 0–100, or null when there is no reading yet. */
  readonly pct: number | null;
  /** Fill colour, or null when there is nothing to fill. */
  readonly level: Severity | null;
}

/**
 * The single percentage a surface both DISPLAYS and colours by.
 *
 * Every reading is shown rounded, so the severity has to be bucketed from the
 * rounded value too — otherwise a reading of 50.4 renders as "50%" (which
 * `vitalsLevel` calls green) while colouring itself from 50.4 (which it calls
 * yellow), and the number disagrees with its own colour. Round once, here, and
 * derive both from the result.
 */
export function readingPct(pct: number): number {
  return Math.round(clampPct(pct));
}

/** An arc whose colour is absolute fullness: context and host resources. */
export function fullnessArc(pct: number | null): VitalsGaugeArc {
  if (pct === null || !Number.isFinite(pct)) return { pct: null, level: null };
  const reading = readingPct(pct);
  return { pct: reading, level: vitalsLevel(reading) };
}

/**
 * An arc for a rolling usage window: swept by usage, coloured by pace — the
 * same `computeWindowPace` → `windowSeverity` pair the detail panel's row uses,
 * so the glyph and the row cannot report different severities for one window.
 */
export function windowArc(
  window: UsageWindowView | null | undefined,
  windowMs: number | null,
  nowMs: number,
  tolerance: number,
): VitalsGaugeArc {
  if (!window) return { pct: null, level: null };
  const pace = computeWindowPace(window, windowMs, nowMs);
  return { pct: pace.usage, level: windowSeverity(pace, tolerance) };
}

/** Signed pace label, e.g. "on pace", "4% under pace", "+57% over pace". */
export function paceDiffLabel(diff: number): string {
  if (diff === 0) return "on pace";
  if (diff < 0) return `${Math.abs(diff)}% under pace`;
  return `+${diff}% over pace`;
}

// ---------------------------------------------------------------------------
// Split-ring geometry
// ---------------------------------------------------------------------------

/** SVG side length of the gauge's viewBox (square). */
export const GAUGE_VIEWBOX = 44;
const CENTER = GAUGE_VIEWBOX / 2;

/** Ring radii: outer = context/CPU, middle = 5h/GPU, inner = 7d/memory. */
export const GAUGE_RINGS = { outer: 18.5, middle: 13, inner: 7.6 } as const;
export const GAUGE_STROKE_WIDTH = 3;

/**
 * Half-width of the straight vertical channel down the middle. Each ring's arc
 * ends where its circle crosses `x = CENTER ± DX`, so every radius's endpoints
 * land on one vertical line (a straight seam, not a V-splay).
 */
const DX = 2.3;

/** Mirror transform that turns a right-side arc group into its left-side twin. */
export const GAUGE_MIRROR_TRANSFORM = `translate(${GAUGE_VIEWBOX} 0) scale(-1 1)`;

function polar(r: number, deg: number): [number, number] {
  const radians = (deg * Math.PI) / 180;
  return [CENTER + r * Math.cos(radians), CENTER + r * Math.sin(radians)];
}

/** SVG path `d` for an arc of radius `r` sweeping clockwise from `a0` to `a1` (degrees). */
export function arcPathD(r: number, a0: number, a1: number): string {
  const [x0, y0] = polar(r, a0);
  const [x1, y1] = polar(r, a1);
  const largeArc = (((a1 - a0) % 360) + 360) % 360 > 180 ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${largeArc} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

export interface HalfArc {
  /** The full (unfilled) half-ring track. */
  readonly trackD: string;
  /** The filled prefix, or null when `pct` is null/0. */
  readonly fillD: string | null;
}

/**
 * Right-side half-ring cut by the vertical seam, filling from the top down.
 * `pct === null` (unknown metric) yields a track with no fill.
 */
export function rightHalfArc(r: number, pct: number | null): HalfArc {
  const t = (Math.acos(Math.min(0.999, DX / r)) * 180) / Math.PI;
  const a0 = -t;
  const a1 = t;
  const span = a1 - a0;
  const trackD = arcPathD(r, a0, a1);
  let fillD: string | null = null;
  if (pct !== null) {
    const p = clampPct(pct);
    if (p > 0) {
      const end = a0 + (span * p) / 100;
      // Floor the sweep so a tiny non-zero value still renders a rounded cap.
      fillD = arcPathD(r, a0, Math.max(a0 + 0.4, end));
    }
  }
  return { trackD, fillD };
}
