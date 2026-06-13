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

export type UsageSource = "claude" | "cursor" | "codex";

export interface UsageSegment {
  readonly key: string;
  readonly label: string;
  readonly popoverLabel: string;
  readonly utilization: number;
  readonly inlineValue: string;
  readonly popoverValue: string;
  readonly resetsAt: string | null;
  readonly resetDetailStyle: "time" | "datetime" | null;
  readonly showPace: boolean;
  readonly paceWindowMs?: number;
  readonly popoverDetail?: string | null;
  readonly isCurrency?: boolean;
}

export interface UsageSnapshot {
  readonly source: UsageSource;
  readonly segments: readonly UsageSegment[];
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
  if (record.isEnabled !== true) return null;
  return {
    isEnabled: true,
    usedCredits: asFiniteNumber(record.usedCredits) ?? 0,
    monthlyLimit: asFiniteNumber(record.monthlyLimit) ?? 0,
    utilization: asFiniteNumber(record.utilization) ?? 0,
    currency: asString(record.currency),
  };
}

function percentSegment(input: {
  readonly key: string;
  readonly label: string;
  readonly popoverLabel: string;
  readonly window: UsageWindow;
  readonly showPace: boolean;
  readonly paceWindowMs?: number;
  readonly resetDetailStyle: "time" | "datetime" | null;
}): UsageSegment {
  const pct = input.window.utilization;
  const rounded = Math.round(pct);
  return {
    key: input.key,
    label: input.label,
    popoverLabel: input.popoverLabel,
    utilization: pct,
    inlineValue: `${rounded}%`,
    popoverValue: `${rounded}%`,
    resetsAt: input.window.resetsAt,
    resetDetailStyle: input.resetDetailStyle,
    showPace: input.showPace,
    ...(input.paceWindowMs !== undefined ? { paceWindowMs: input.paceWindowMs } : {}),
  };
}

function buildClaudeSegments(payload: Record<string, unknown>): UsageSegment[] {
  const segments: UsageSegment[] = [];
  const fiveHour = deriveWindow(payload.fiveHour);
  const sevenDay = deriveWindow(payload.sevenDay);
  const extra = deriveExtra(payload.extra);

  if (fiveHour) {
    segments.push(
      percentSegment({
        key: "5h",
        label: "5h",
        popoverLabel: "5-hour",
        window: fiveHour,
        showPace: true,
        paceWindowMs: USAGE_WINDOW_MS.fiveHour,
        resetDetailStyle: "time",
      }),
    );
  }
  if (sevenDay) {
    segments.push(
      percentSegment({
        key: "7d",
        label: "7d",
        popoverLabel: "7-day",
        window: sevenDay,
        showPace: true,
        paceWindowMs: USAGE_WINDOW_MS.sevenDay,
        resetDetailStyle: "datetime",
      }),
    );
  }
  if (extra) {
    segments.push({
      key: "extra",
      label: "extra",
      popoverLabel: "Extra usage",
      utilization: extra.utilization,
      inlineValue: `${formatCreditsShort(extra.usedCredits)}/${formatCreditsShort(extra.monthlyLimit)}`,
      popoverValue: `${formatCredits(extra.usedCredits)} / ${formatCredits(extra.monthlyLimit)}`,
      resetsAt: null,
      resetDetailStyle: null,
      showPace: false,
      isCurrency: true,
      popoverDetail: `${Math.round(extra.utilization)}% of monthly limit${
        extra.currency ? ` · ${extra.currency}` : ""
      }`,
    });
  }
  return segments;
}

function shouldShowCursorPercentWindow(window: UsageWindow | null): window is UsageWindow {
  if (!window) return false;
  return window.utilization > 0;
}

function buildCursorSegments(payload: Record<string, unknown>): UsageSegment[] {
  const cursor = asRecord(payload.cursor);
  if (!cursor) return [];

  const segments: UsageSegment[] = [];
  const auto = deriveWindow(cursor.auto);
  const api = deriveWindow(cursor.api);
  const total = deriveWindow(cursor.total);
  const onDemand = deriveExtra(cursor.onDemand);
  const onDemandScope = asString(cursor.onDemandScope);
  const requests = asRecord(cursor.requests);
  const requestUsed = asFiniteNumber(requests?.used);
  const requestLimit = asFiniteNumber(requests?.limit);
  const requestUtilization = asFiniteNumber(requests?.utilization);

  if (shouldShowCursorPercentWindow(auto)) {
    segments.push(
      percentSegment({
        key: "auto",
        label: "auto",
        popoverLabel: "Auto usage",
        window: auto,
        showPace: false,
        resetDetailStyle: "datetime",
      }),
    );
  }
  if (shouldShowCursorPercentWindow(api)) {
    segments.push(
      percentSegment({
        key: "api",
        label: "api",
        popoverLabel: "API usage",
        window: api,
        showPace: false,
        resetDetailStyle: "datetime",
      }),
    );
  }
  if (total) {
    segments.push(
      percentSegment({
        key: "total",
        label: "plan",
        popoverLabel: "Included usage",
        window: total,
        showPace: false,
        resetDetailStyle: "datetime",
      }),
    );
  }
  if (onDemand) {
    const isTeamPool = onDemandScope === "team";
    segments.push({
      key: "on-demand",
      label: isTeamPool ? "pool" : "ondemand",
      popoverLabel: isTeamPool ? "Team on-demand pool" : "On-demand usage",
      utilization: onDemand.utilization,
      inlineValue: `${formatCreditsShort(onDemand.usedCredits)}/${formatCreditsShort(onDemand.monthlyLimit)}`,
      popoverValue: `${formatCredits(onDemand.usedCredits)} / ${formatCredits(onDemand.monthlyLimit)}`,
      resetsAt: null,
      resetDetailStyle: null,
      showPace: false,
      isCurrency: true,
      popoverDetail: `${Math.round(onDemand.utilization)}% of ${isTeamPool ? "team pool" : "on-demand limit"}${
        onDemand.currency ? ` · ${onDemand.currency}` : ""
      }`,
    });
  }
  if (
    requestUsed !== null &&
    requestLimit !== null &&
    requestLimit > 0 &&
    requestUtilization !== null
  ) {
    segments.push({
      key: "requests",
      label: "reqs",
      popoverLabel: "Included requests",
      utilization: requestUtilization,
      inlineValue: `${requestUsed}/${requestLimit}`,
      popoverValue: `${requestUsed} / ${requestLimit} requests`,
      resetsAt: null,
      resetDetailStyle: null,
      showPace: false,
      popoverDetail: `${Math.round(requestUtilization)}% of request limit`,
    });
  }

  return segments;
}

function deriveCodexWindow(
  value: unknown,
): (UsageWindow & { windowDurationMins?: number | null }) | null {
  const record = asRecord(value);
  if (!record) return null;
  const utilization = asFiniteNumber(record.utilization);
  if (utilization === null) return null;
  return {
    utilization,
    resetsAt: asString(record.resetsAt),
    windowDurationMins: asFiniteNumber(record.windowDurationMins),
  };
}

function formatCodexWindowLabel(
  windowDurationMins: number | null | undefined,
  fallback: string,
): string {
  if (windowDurationMins == null || !Number.isFinite(windowDurationMins)) return fallback;
  if (windowDurationMins >= 7 * 24 * 60) return "7d";
  if (windowDurationMins >= 24 * 60) return "1d";
  if (windowDurationMins >= 60) {
    const hours = Math.round(windowDurationMins / 60);
    return `${hours}h`;
  }
  return `${windowDurationMins}m`;
}

function formatCodexCreditsBalance(balance: string | null): string {
  if (!balance) return "—";
  const trimmed = balance.trim();
  if (trimmed.startsWith("$")) return trimmed;
  const parsed = Number.parseFloat(trimmed);
  if (Number.isFinite(parsed)) return `$${parsed.toFixed(2)}`;
  return trimmed;
}

function buildCodexSegments(payload: Record<string, unknown>): UsageSegment[] {
  const codex = asRecord(payload.codex);
  if (!codex) return [];

  const segments: UsageSegment[] = [];
  const primary = deriveCodexWindow(codex.primary);
  const secondary = deriveCodexWindow(codex.secondary);
  const credits = asRecord(codex.credits);
  const creditsBalance = asString(credits?.balance);
  const creditsHasCredits = credits?.hasCredits === true;
  const creditsUnlimited = credits?.unlimited === true;

  if (primary) {
    const label = formatCodexWindowLabel(primary.windowDurationMins, "5h");
    segments.push(
      percentSegment({
        key: "primary",
        label,
        popoverLabel: "Session limit",
        window: primary,
        showPace: true,
        paceWindowMs: primary.windowDurationMins
          ? primary.windowDurationMins * 60 * 1000
          : USAGE_WINDOW_MS.fiveHour,
        resetDetailStyle: "time",
      }),
    );
  }
  if (secondary) {
    const label = formatCodexWindowLabel(secondary.windowDurationMins, "week");
    segments.push(
      percentSegment({
        key: "secondary",
        label,
        popoverLabel: "Weekly limit",
        window: secondary,
        showPace: true,
        paceWindowMs: secondary.windowDurationMins
          ? secondary.windowDurationMins * 60 * 1000
          : USAGE_WINDOW_MS.sevenDay,
        resetDetailStyle: "datetime",
      }),
    );
  }
  if (creditsHasCredits) {
    segments.push({
      key: "credits",
      label: "credits",
      popoverLabel: "Credits balance",
      utilization: 0,
      inlineValue: creditsUnlimited ? "∞" : formatCodexCreditsBalance(creditsBalance),
      popoverValue: creditsUnlimited
        ? "Unlimited credits"
        : formatCodexCreditsBalance(creditsBalance),
      resetsAt: null,
      resetDetailStyle: null,
      showPace: false,
      isCurrency: !creditsUnlimited,
      popoverDetail: creditsUnlimited ? "Unlimited credits enabled" : null,
    });
  }

  return segments;
}

function buildUsageSegments(payload: Record<string, unknown>): UsageSnapshot | null {
  const cursorSegments = buildCursorSegments(payload);
  if (cursorSegments.length > 0) {
    return { source: "cursor", segments: cursorSegments, updatedAt: "" };
  }
  const codexSegments = buildCodexSegments(payload);
  if (codexSegments.length > 0) {
    return { source: "codex", segments: codexSegments, updatedAt: "" };
  }
  const claudeSegments = buildClaudeSegments(payload);
  if (claudeSegments.length > 0) {
    return { source: "claude", segments: claudeSegments, updatedAt: "" };
  }
  return null;
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
    if (!payload) continue;
    const snapshot = buildUsageSegments(payload);
    if (!snapshot) continue;
    return { ...snapshot, updatedAt: activity.createdAt };
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
  readonly elapsedPct: number;
  readonly delta: number;
  readonly state: PaceState;
}

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

export function deriveSegmentPace(segment: UsageSegment, now: number): Pace | null {
  if (!segment.showPace || segment.paceWindowMs === undefined) return null;
  return computePace(segment.utilization, segment.resetsAt, segment.paceWindowMs, now);
}

/** Percentage readout (`ctx`/`5h`/`7d`, `cpu`/`gpu`/`mem`): `100%` ≈ 1.70rem. */
export const METER_VALUE_SLOT = "inline-block min-w-[1.85rem] tabular-nums";
/** Pace readout: sized for the proportional `on pace` text (≈2.58rem, wider than `↑100%`). */
export const METER_PACE_SLOT = "inline-flex min-w-[2.75rem] items-center";
/** Extra-credit cost (`$…/$…`): common case `$1.9k/$2k` ≈ 2.95rem; rarer larger values grow it. */
export const METER_EXTRA_SLOT = "inline-block min-w-[3rem] tabular-nums";

export type UsageLevel = "green" | "yellow" | "orange" | "red";

export function usageLevel(pct: number): UsageLevel {
  if (pct >= 90) return "red";
  if (pct >= 70) return "orange";
  if (pct >= 50) return "yellow";
  return "green";
}

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

export function formatCredits(cents: number): string {
  const safe = Number.isFinite(cents) && cents > 0 ? cents : 0;
  return `$${(safe / 100).toFixed(2)}`;
}

export function formatCreditsShort(cents: number): string {
  const dollars = (Number.isFinite(cents) && cents > 0 ? cents : 0) / 100;
  if (dollars >= 1000) {
    const thousands = dollars / 1000;
    const rounded = Math.round(thousands * 10) / 10;
    return `$${rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1)}k`;
  }
  return `$${Math.round(dollars)}`;
}
