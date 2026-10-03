/**
 * Claude Code subscription usage. Both sources produce windows with the same
 * ids so a turn-driven `rate_limit_event` lands on the row the SDK's
 * `get_usage` read established:
 *
 * - `get_usage` (on demand, during the capabilities probe) reports every
 *   window at once as 0–100 percentages with ISO reset times.
 * - `rate_limit_event` (streamed during a turn) names one window at a time
 *   with a 0–1 utilization fraction and an epoch-seconds reset.
 *
 * @module provider/Layers/claudeUsageLimits
 */
import type { SDKControlGetUsageResponse, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import type {
  ProviderUsageLimitsUpdate,
  ServerProviderUsageLimits,
  ServerProviderUsageSpend,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "../providerUsageLimits.ts";

const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;

/**
 * The account-wide windows, keyed by the SDK's `rateLimitType`. Model-scoped
 * weeklies are additive on top of these: the CLI reports them under
 * `rate_limits.model_scoped[]` on `get_usage` and streams the overage-included
 * model bucket (Fable today) as `seven_day_overage_included`.
 */
const WINDOWS: Readonly<
  Record<string, Pick<ServerProviderUsageWindow, "kind" | "label" | "windowDurationMins">>
> = {
  five_hour: { kind: "session", label: "Session", windowDurationMins: SESSION_MINS },
  seven_day: { kind: "weekly", label: "Weekly", windowDurationMins: WEEK_MINS },
};

/**
 * The streamed event names the overage-included bucket by type
 * (`seven_day_overage_included`), while `get_usage` names it by the model's
 * `display_name`. Which model that is changes over time, so the probe records
 * the name it saw and the event mapper reuses it; the mid-turn update then
 * lands on the row the probe drew instead of opening a second one.
 */
const OVERAGE_INCLUDED_EVENT_TYPE = "seven_day_overage_included";

export interface ClaudeScopedLimitNames {
  readonly overageIncluded: string | undefined;
}

export const makeClaudeScopedLimitNames = Ref.make<ClaudeScopedLimitNames>({
  overageIncluded: undefined,
});

function scopedWindowId(displayName: string): string {
  return `seven_day_${displayName.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
}

function scopedWindow(
  displayName: string,
  usedPercent: number,
  resetsAt: string | undefined,
): ServerProviderUsageWindow {
  return {
    id: scopedWindowId(displayName),
    kind: "weekly",
    label: `Weekly · ${displayName}`,
    windowDurationMins: WEEK_MINS,
    usedPercent: clampPercent(usedPercent),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

/**
 * `model_scoped` shipped in the CLI after the SDK typings we pin, so it is
 * read structurally until the `.d.ts` catches up.
 */
interface ModelScopedWindow {
  readonly display_name: string;
  readonly utilization: number | null;
  readonly resets_at: string | null;
}

function readModelScoped(rateLimits: object): ReadonlyArray<ModelScopedWindow> {
  const raw = (rateLimits as { readonly model_scoped?: unknown }).model_scoped;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is ModelScopedWindow =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as ModelScopedWindow).display_name === "string",
  );
}

function isoFromEpochSeconds(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  const dt = DateTime.make(value * 1000);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

function isoFromString(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const dt = DateTime.make(value);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

function makeWindow(
  id: keyof typeof WINDOWS & string,
  usedPercent: number,
  resetsAt: string | undefined,
): ServerProviderUsageWindow {
  const window = WINDOWS[id]!;
  return {
    id,
    ...window,
    usedPercent: clampPercent(usedPercent),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

/**
 * Utilization is a 0–1 fraction on the streamed event. An overage-included
 * event before any probe has named the bucket is dropped: guessing a name
 * would draw a row the next probe cannot reconcile.
 */
export function claudeRateLimitEventToUpdate(
  info: SDKRateLimitInfo,
  names: ClaudeScopedLimitNames,
): ProviderUsageLimitsUpdate | undefined {
  // FORK: the CLI reports every account-wide window in `unifiedWindows`
  // while the top-level `utilization` names only the window the event is
  // about, and is usually absent. Measured on 853 real events: 852 carried
  // the 5-hour window only here, and the top level updated it 0 times.
  const windows = new Map<string, ServerProviderUsageWindow>();
  for (const [id, window] of readUnifiedWindows(info)) {
    windows.set(id, makeWindow(id, window.utilization * 100, isoFromEpochSeconds(window.resetsAt)));
  }
  const type: string | undefined = info.rateLimitType;
  if (type && typeof info.utilization === "number") {
    const usedPercent = info.utilization * 100;
    const resetsAt = isoFromEpochSeconds(info.resetsAt);
    if (type in WINDOWS) {
      windows.set(type, makeWindow(type, usedPercent, resetsAt));
    } else if (type === OVERAGE_INCLUDED_EVENT_TYPE && names.overageIncluded) {
      const window = scopedWindow(names.overageIncluded, usedPercent, resetsAt);
      windows.set(window.id, window);
    }
  }
  return windows.size > 0 ? { windows: [...windows.values()] } : undefined;
}

/**
 * `unifiedWindows` ships in the CLI ahead of the SDK typings we pin, so it is
 * read structurally: `{ five_hour: { utilization: 0.18, resetsAt: <epoch s> } }`.
 */
function readUnifiedWindows(
  info: SDKRateLimitInfo,
): ReadonlyArray<readonly [string, { readonly utilization: number; readonly resetsAt?: number }]> {
  const raw = (info as { readonly unifiedWindows?: unknown }).unifiedWindows;
  if (typeof raw !== "object" || raw === null) return [];
  const entries: Array<readonly [string, { utilization: number; resetsAt?: number }]> = [];
  for (const id of Object.keys(WINDOWS)) {
    const window = (raw as Record<string, unknown>)[id];
    if (typeof window !== "object" || window === null) continue;
    const { utilization, resetsAt } = window as { utilization?: unknown; resetsAt?: unknown };
    if (typeof utilization !== "number" || !Number.isFinite(utilization)) continue;
    entries.push([id, typeof resetsAt === "number" ? { utilization, resetsAt } : { utilization }]);
  }
  return entries;
}

/**
 * Percentages on the `get_usage` response are already 0–100. Also yields the
 * scoped-bucket names the response carried, for the event mapper to reuse.
 */
export function claudeUsageResponseToLimits(input: {
  readonly response: Pick<SDKControlGetUsageResponse, "rate_limits_available" | "rate_limits">;
  readonly checkedAt: string;
}): { readonly limits: ServerProviderUsageLimits; readonly names: ClaudeScopedLimitNames } {
  const { response, checkedAt } = input;
  if (!response.rate_limits_available || !response.rate_limits) {
    return {
      limits: makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" }),
      names: { overageIncluded: undefined },
    };
  }
  const windows: ServerProviderUsageWindow[] = [];
  for (const id of Object.keys(WINDOWS)) {
    const window = response.rate_limits[id as "five_hour" | "seven_day"];
    if (!window || typeof window.utilization !== "number") continue;
    windows.push(makeWindow(id, window.utilization, isoFromString(window.resets_at)));
  }
  // The CLI filters `model_scoped` to the overage-included allowlist, which
  // today holds one model; the first entry is the one the event refers to.
  let overageIncluded: string | undefined;
  for (const entry of readModelScoped(response.rate_limits)) {
    if (typeof entry.utilization !== "number") continue;
    windows.push(
      scopedWindow(entry.display_name, entry.utilization, isoFromString(entry.resets_at)),
    );
    // Only a bucket that drew a row may receive events; naming one that was
    // skipped would let a mid-turn event open a row the probe never showed.
    overageIncluded ??= entry.display_name;
  }
  const spend = readSpend(response.rate_limits);
  return {
    limits: { ...makeUsageLimits({ checkedAt, windows }), ...(spend ? { spend } : {}) },
    names: { overageIncluded },
  };
}

interface Money {
  readonly amount_minor: number;
  readonly currency: string;
  readonly exponent: number;
}

function readMoney(value: unknown): Money | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { amount_minor, currency, exponent } = value as Partial<Money>;
  return typeof amount_minor === "number" &&
    typeof currency === "string" &&
    currency.length > 0 &&
    typeof exponent === "number"
    ? { amount_minor, currency, exponent }
    : undefined;
}

const toMajor = (money: Money) => money.amount_minor / 10 ** money.exponent;

/**
 * FORK: extra usage, from the structured `spend` block `get_usage` returns
 * beside the windows, else the older `extra_usage` record (minor units).
 * Both ship ahead of the SDK typings, so both are read structurally. Absent
 * when spending is off, or when there is neither a limit nor any spend.
 *
 * `usedPercent` is clamped to 100 while `used` keeps the real figure, so an
 * overspent month draws a full bar beside text like "CAD 201.66 of CAD 200.00".
 */
function readSpend(rateLimits: object): ServerProviderUsageSpend | undefined {
  const { spend, extra_usage: extra } = rateLimits as {
    readonly spend?: unknown;
    readonly extra_usage?: unknown;
  };
  let used: number | undefined;
  let limit: number | undefined;
  let currency: string | undefined;
  let percent: unknown;
  // `spend` is authoritative when present: an explicit `enabled: false` means
  // no row even if the older `extra_usage` record still says enabled. Only an
  // enabled block too malformed to read falls back to `extra_usage`.
  const spendEnabled =
    typeof spend === "object" && spend !== null
      ? (spend as { enabled?: unknown }).enabled
      : undefined;
  if (spendEnabled === false) return undefined;
  if (spendEnabled === true) {
    const usedMoney = readMoney((spend as { used?: unknown }).used);
    const limitMoney = readMoney((spend as { limit?: unknown }).limit);
    if (usedMoney) {
      used = toMajor(usedMoney);
      currency = usedMoney.currency;
      limit = limitMoney ? toMajor(limitMoney) : undefined;
      percent = (spend as { percent?: unknown }).percent;
    }
  }
  if (
    used === undefined &&
    typeof extra === "object" &&
    extra !== null &&
    (extra as { is_enabled?: unknown }).is_enabled === true
  ) {
    const record = extra as {
      used_credits?: unknown;
      monthly_limit?: unknown;
      currency?: unknown;
      utilization?: unknown;
      decimal_places?: unknown;
    };
    // Amounts are minor units at the record's own precision (2 for CAD/USD).
    const scale =
      10 **
      (typeof record.decimal_places === "number" && Number.isInteger(record.decimal_places)
        ? record.decimal_places
        : 2);
    used = typeof record.used_credits === "number" ? record.used_credits / scale : 0;
    limit = typeof record.monthly_limit === "number" ? record.monthly_limit / scale : undefined;
    currency =
      typeof record.currency === "string" && record.currency.length > 0 ? record.currency : "USD";
    percent = record.utilization;
  }
  if (used === undefined || currency === undefined) return undefined;
  if (used <= 0 && (limit ?? 0) <= 0) return undefined;
  const usedPercent =
    typeof percent === "number" && Number.isFinite(percent)
      ? clampPercent(percent)
      : limit !== undefined && limit > 0
        ? clampPercent((used / limit) * 100)
        : undefined;
  return {
    used: Math.max(0, used),
    ...(limit !== undefined ? { limit } : {}),
    currency,
    ...(usedPercent !== undefined ? { usedPercent } : {}),
  };
}

/** Probe-side helper: map the response and remember the scoped names for events. */
export const recordClaudeUsageResponse = (
  namesRef: Ref.Ref<ClaudeScopedLimitNames>,
  input: Parameters<typeof claudeUsageResponseToLimits>[0],
): Effect.Effect<ServerProviderUsageLimits> => {
  const { limits, names } = claudeUsageResponseToLimits(input);
  return Ref.set(namesRef, names).pipe(Effect.as(limits));
};
