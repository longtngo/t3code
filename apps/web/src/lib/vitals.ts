import type { OrchestrationThreadActivity } from "@t3tools/contracts";

/**
 * Vitals gauge logic — the pure (testable) core behind the header's combined
 * context / usage-limit / host-resource affordance. Covers the two severity
 * ramps the user specified, the pace projection for rolling usage windows, the
 * client-side reader for the (previously unsurfaced) `account.usage.updated`
 * activity, and the split-ring arc geometry.
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
 * <20 green (0–20 over is "basically on pace"), <30 yellow, <40 orange, else red.
 */
export function paceLevel(diff: number): Severity {
  if (diff < 20) return "ok";
  if (diff < 30) return "warn";
  if (diff < 40) return "high";
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

export interface UsageWindowView {
  /** Float percent 0..100(+). */
  readonly utilization: number;
  /** ISO 8601 reset instant, or null when the provider doesn't expose one. */
  readonly resetsAt: string | null;
}

/**
 * A provider-native usage window (Codex primary/secondary, Cursor auto/api/total)
 * shown in the limits popover alongside — or instead of — Claude's 5h/7d. Carries
 * its own label and window length; `windowMs` is null when the provider exposes no
 * fixed window duration (then the row shows utilization only, no pace projection).
 */
export interface LabeledUsageWindowView extends UsageWindowView {
  readonly label: string;
  readonly windowMs: number | null;
}

/**
 * A limits row that is a balance rather than a window.
 *
 * Credits and on-demand spend have no reset time and no elapsed fraction, so
 * they cannot be paced and must not be rendered as a window: a pace bar implies
 * a deadline that these do not have. `detail` is already display-ready.
 */
export interface UsageBalanceView {
  readonly label: string;
  readonly detail: string;
  /** Present only when the balance genuinely has a ceiling to sit against. */
  readonly utilization: number | null;
}

export interface AccountUsageView {
  readonly fiveHour: UsageWindowView | null;
  readonly sevenDay: UsageWindowView | null;
  /**
   * Extra provider-native windows for the limits block (Codex/Cursor). Empty for
   * a Claude account. The ring glyph stays Claude-only (context + 5h + 7d); these
   * render as additional popover rows.
   */
  readonly extraWindows: ReadonlyArray<LabeledUsageWindowView>;
  /**
   * Provider balances that are not windows — Cursor on-demand spend and request
   * count, Codex credits. Empty for a Claude account.
   */
  readonly balances: ReadonlyArray<UsageBalanceView>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseUsageWindow(value: unknown): UsageWindowView | null {
  const record = asRecord(value);
  if (!record) return null;
  const utilization = asFiniteNumber(record.utilization);
  if (utilization === null) return null;
  const resetsAt = typeof record.resetsAt === "string" ? record.resetsAt : null;
  return { utilization, resetsAt };
}

/** Human label for a Codex window from its length in minutes, else a fallback. */
function codexWindowLabel(windowDurationMins: number | null, fallback: string): string {
  if (windowDurationMins === null || windowDurationMins <= 0) return fallback;
  if (windowDurationMins % 1440 === 0) return `Codex ${windowDurationMins / 1440}d`;
  if (windowDurationMins % 60 === 0) return `Codex ${windowDurationMins / 60}h`;
  return `Codex ${windowDurationMins}m`;
}

/** Codex primary/secondary usage windows, labelled by their window length. */
function parseCodexWindows(value: unknown): LabeledUsageWindowView[] {
  const record = asRecord(value);
  if (!record) return [];
  const windows: LabeledUsageWindowView[] = [];
  for (const [key, fallback] of [
    ["primary", "Codex primary"],
    ["secondary", "Codex secondary"],
  ] as const) {
    const parsed = parseUsageWindow(record[key]);
    if (!parsed) continue;
    const durationMins = asFiniteNumber(asRecord(record[key])?.windowDurationMins);
    windows.push({
      ...parsed,
      label: codexWindowLabel(durationMins, fallback),
      windowMs: durationMins !== null && durationMins > 0 ? durationMins * 60_000 : null,
    });
  }
  return windows;
}

/**
 * Cursor usage windows (auto / api / total). Cursor exposes a period utilization
 * but no fixed window length, so `windowMs` is null (utilization-only rows).
 */
function parseCursorWindows(value: unknown): LabeledUsageWindowView[] {
  const record = asRecord(value);
  if (!record) return [];
  const windows: LabeledUsageWindowView[] = [];
  for (const [key, label] of [
    ["auto", "Cursor auto"],
    ["api", "Cursor API"],
    ["total", "Cursor total"],
  ] as const) {
    const parsed = parseUsageWindow(record[key]);
    if (!parsed) continue;
    windows.push({ ...parsed, label, windowMs: null });
  }
  return windows;
}

/**
 * Format a spend figure with its currency, falling back to a bare number.
 *
 * A money amount keeps both decimals on both sides — "$12.50 of $50" reads as
 * two different kinds of number — while a currency-less figure is a plain count
 * and drops them.
 */
function formatSpend(used: number, limit: number | null, currency: string | null): string {
  const symbol = currency === "USD" ? "$" : currency === null ? "" : `${currency} `;
  const amount = (value: number) =>
    currency === null ? `${String(value)}` : `${symbol}${value.toFixed(2)}`;
  return limit === null ? amount(used) : `${amount(used)} of ${amount(limit)}`;
}

/**
 * Cursor's non-window rows: on-demand spend, and the enterprise request bucket.
 *
 * Both are ceilings you sit under rather than periods you burn through, so
 * neither carries a reset time.
 */
function parseCursorBalances(value: unknown): UsageBalanceView[] {
  const record = asRecord(value);
  if (!record) return [];
  const balances: UsageBalanceView[] = [];

  const onDemand = asRecord(record.onDemand);
  const used = asFiniteNumber(onDemand?.used);
  if (onDemand !== null && used !== null) {
    const limit = asFiniteNumber(onDemand.limit);
    const currency = typeof onDemand.currency === "string" ? onDemand.currency : null;
    const scope = record.onDemandScope;
    balances.push({
      label: scope === "team" ? "Cursor on-demand (team)" : "Cursor on-demand",
      detail: formatSpend(used, limit, currency),
      utilization: asFiniteNumber(onDemand.utilization),
    });
  }

  const requests = asRecord(record.requests);
  const requestsUsed = asFiniteNumber(requests?.used);
  const requestsLimit = asFiniteNumber(requests?.limit);
  if (requestsUsed !== null && requestsLimit !== null) {
    balances.push({
      label: "Cursor requests",
      detail: `${String(requestsUsed)} of ${String(requestsLimit)}`,
      utilization: asFiniteNumber(requests?.utilization),
    });
  }

  return balances;
}

/**
 * Codex credits. `balance` is a pre-formatted string from the app server, so it
 * is shown as given rather than reformatted into a number we did not parse.
 */
function parseCodexBalances(value: unknown): UsageBalanceView[] {
  const credits = asRecord(asRecord(value)?.credits);
  if (!credits) return [];
  if (credits.unlimited === true) {
    return [{ label: "Codex credits", detail: "Unlimited", utilization: null }];
  }
  const balance = typeof credits.balance === "string" ? credits.balance.trim() : "";
  if (balance.length > 0) {
    return [{ label: "Codex credits", detail: balance, utilization: null }];
  }
  // `hasCredits: false` with no balance string is still worth saying: it is the
  // difference between "none left" and "this account does not use credits".
  if (credits.hasCredits === false) {
    return [{ label: "Codex credits", detail: "None remaining", utilization: null }];
  }
  return [];
}

/**
 * Latest account-usage snapshot from the thread activity log. Mirrors
 * {@link deriveLatestContextWindowSnapshot}: the activity payload is untyped on
 * the wire (`Schema.Unknown`), so parse defensively. Returns `null` when no
 * `account.usage.updated` activity is present; a present-but-empty snapshot
 * (both windows null — e.g. Codex/Cursor, which populate other slots) returns a
 * view with null windows so the caller can omit the block.
 */
export function deriveLatestAccountUsage(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): AccountUsageView | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "account.usage.updated") {
      continue;
    }
    const payload = asRecord(activity.payload);
    if (!payload) {
      continue;
    }
    return {
      fiveHour: parseUsageWindow(payload.fiveHour),
      sevenDay: parseUsageWindow(payload.sevenDay),
      extraWindows: [...parseCodexWindows(payload.codex), ...parseCursorWindows(payload.cursor)],
      balances: [...parseCodexBalances(payload.codex), ...parseCursorBalances(payload.cursor)],
    };
  }
  return null;
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
 * evenly. The signed `diff` against actual usage is what the detail window shows
 * in place of a reset time.
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
export function windowSeverity(pace: WindowPace): Severity {
  return pace.diff === null ? vitalsLevel(pace.usage) : paceLevel(pace.diff);
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

/** An arc whose colour is absolute fullness: context and host resources. */
export function fullnessArc(pct: number | null): VitalsGaugeArc {
  return pct === null ? { pct: null, level: null } : { pct, level: vitalsLevel(clampPct(pct)) };
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
): VitalsGaugeArc {
  if (!window) return { pct: null, level: null };
  const pace = computeWindowPace(window, windowMs, nowMs);
  return { pct: pace.usage, level: windowSeverity(pace) };
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
