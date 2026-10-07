import { describe, expect, it } from "vite-plus/test";

import { claudeRateLimitEventToUpdate, claudeUsageResponseToLimits } from "./claudeUsageLimits.ts";

const checkedAt = "2026-07-18T10:00:00.000Z";
const noNames = { overageIncluded: undefined } as const;

describe("claudeUsageResponseToLimits", () => {
  it("maps the session, weekly, and model-scoped weekly windows", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: {
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: 54, resets_at: "2026-07-18T14:39:00Z" },
            seven_day: { utilization: 18.4, resets_at: "2026-07-24T08:59:00+00:00" },
            seven_day_opus: { utilization: 3, resets_at: null },
            // Newer CLIs add this on top of the typed keys; the pinned SDK
            // typings do not know it yet.
            ...({
              model_scoped: [
                { display_name: "Fable", utilization: 73, resets_at: "2026-07-24T08:59:00Z" },
                { display_name: "Ghost", utilization: null, resets_at: null },
              ],
            } as object),
            extra_usage: {
              is_enabled: false,
              monthly_limit: null,
              used_credits: null,
              utilization: null,
            },
          },
        },
      }),
    ).toEqual({
      names: { overageIncluded: "Fable" },
      limits: {
        checkedAt,
        windows: [
          {
            id: "five_hour",
            kind: "session",
            label: "Session",
            usedPercent: 54,
            windowDurationMins: 300,
            resetsAt: "2026-07-18T14:39:00.000Z",
          },
          {
            id: "seven_day",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 18.4,
            windowDurationMins: 10080,
            resetsAt: "2026-07-24T08:59:00.000Z",
          },
          {
            id: "seven_day_fable",
            kind: "weekly",
            label: "Weekly · Fable",
            usedPercent: 73,
            windowDurationMins: 10080,
            resetsAt: "2026-07-24T08:59:00.000Z",
          },
        ],
      },
    });
  });

  it("names the overage-included bucket only from a scoped entry that drew a row", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: {
          rate_limits_available: true,
          rate_limits: {
            ...({
              model_scoped: [
                { display_name: "Ghost", utilization: null, resets_at: null },
                { display_name: "Fable", utilization: 5, resets_at: null },
              ],
            } as object),
          },
        },
      }).names,
    ).toEqual({ overageIncluded: "Fable" });
  });

  it("reports API key and Bedrock accounts as unsupported", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: { rate_limits_available: false, rate_limits: null },
      }).limits,
    ).toEqual({ checkedAt, windows: [], unavailable: { reason: "unsupported" } });
  });

  it("skips a window the endpoint reports without a utilization", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: {
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: null, resets_at: null },
            seven_day: { utilization: 250, resets_at: null },
          },
        },
      }).limits.windows,
    ).toEqual([
      {
        id: "seven_day",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 100,
        windowDurationMins: 10080,
      },
    ]);
  });
});

describe("claudeUsageResponseToLimits spend", () => {
  // Verbatim from a real team account's `get_usage` (2026-10-03): extra usage
  // enabled with a CAD 200 monthly cap and nothing spent yet.
  const realSpend = {
    extra_usage: {
      is_enabled: true,
      monthly_limit: 20000,
      used_credits: 0,
      utilization: null,
      currency: "CAD",
      disabled_reason: null,
      decimal_places: 2,
      user_disabled: false,
      spend_limit_reached: false,
      credits_ever_enabled: true,
      daily: null,
      weekly: null,
    },
    spend: {
      used: { amount_minor: 0, currency: "CAD", exponent: 2 },
      limit: { amount_minor: 20000, currency: "CAD", exponent: 2 },
      percent: 0,
      severity: "normal",
      enabled: true,
      disabled_reason: null,
      cap: { money: { amount_minor: 20000, currency: "CAD", exponent: 2 }, credits: null },
      balance: null,
      auto_reload: null,
      can_purchase_credits: false,
      can_toggle: false,
    },
  };
  const limitsFor = (rateLimits: object) =>
    claudeUsageResponseToLimits({
      checkedAt,
      response: { rate_limits_available: true, rate_limits: rateLimits as never },
    }).limits;

  it("reads the structured spend block a real account returns", () => {
    expect(limitsFor(realSpend).spend).toEqual({
      used: 0,
      limit: 200,
      currency: "CAD",
      usedPercent: 0,
    });
    const spending = {
      ...realSpend,
      spend: {
        ...realSpend.spend,
        used: { amount_minor: 15050, currency: "CAD", exponent: 2 },
        percent: 75.25,
      },
    };
    expect(limitsFor(spending).spend).toEqual({
      used: 150.5,
      limit: 200,
      currency: "CAD",
      usedPercent: 75.25,
    });
  });

  it("falls back to the extra_usage cents record, and omits spending that is off", () => {
    expect(
      limitsFor({ extra_usage: { ...realSpend.extra_usage, used_credits: 5000 } }).spend,
    ).toEqual({ used: 50, limit: 200, currency: "CAD", usedPercent: 25 });
    expect(
      limitsFor({
        extra_usage: { ...realSpend.extra_usage, is_enabled: false },
        spend: { ...realSpend.spend, enabled: false },
      }).spend,
    ).toBeUndefined();
  });
});

describe("claudeUsageResponseToLimits spend source", () => {
  const extra = {
    is_enabled: true,
    monthly_limit: 20000,
    used_credits: 300,
    utilization: null,
    currency: "CAD",
    decimal_places: 2,
  };
  const spendBlock = {
    used: { amount_minor: 0, currency: "CAD", exponent: 2 },
    limit: { amount_minor: 20000, currency: "CAD", exponent: 2 },
    percent: 0,
    enabled: true,
  };
  const spendOf = (rateLimits: object) =>
    claudeUsageResponseToLimits({
      checkedAt,
      response: { rate_limits_available: true, rate_limits: rateLimits as never },
    }).limits.spend;

  it("treats a present spend block as authoritative when it says spending is off", () => {
    expect(
      spendOf({ spend: { ...spendBlock, enabled: false }, extra_usage: extra }),
    ).toBeUndefined();
  });

  it("falls back to extra_usage when an enabled spend block cannot be read", () => {
    expect(spendOf({ spend: { ...spendBlock, used: null }, extra_usage: extra })).toEqual({
      used: 3,
      limit: 200,
      currency: "CAD",
      usedPercent: 1.5,
    });
  });

  it("scales extra_usage by its own decimal places", () => {
    const spend = spendOf({
      extra_usage: {
        ...extra,
        currency: "JPY",
        decimal_places: 0,
        used_credits: 7,
        monthly_limit: 100,
      },
    });
    expect(spend).toMatchObject({ used: 7, limit: 100, currency: "JPY" });
    expect(spend?.usedPercent).toBeCloseTo(7);
  });
});

describe("claudeRateLimitEventToUpdate", () => {
  it("scales the 0–1 utilization and epoch-second reset onto the probe's window id", () => {
    expect(
      claudeRateLimitEventToUpdate(
        {
          status: "allowed_warning",
          rateLimitType: "seven_day",
          utilization: 0.85,
          resetsAt: 1_784_000_000,
        },
        noNames,
      ),
    ).toEqual({
      windows: [
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 85,
          windowDurationMins: 10080,
          resetsAt: "2026-07-14T03:33:20.000Z",
        },
      ],
    });
  });

  it("lands the streamed overage-included bucket on the row the probe named", () => {
    const event = {
      status: "allowed",
      rateLimitType: "seven_day_overage_included" as never,
      utilization: 0.4,
    } as const;
    // No probe has named the bucket yet: guessing would open a stray row.
    expect(claudeRateLimitEventToUpdate(event, noNames)).toBeUndefined();
    expect(claudeRateLimitEventToUpdate(event, { overageIncluded: "Fable" })).toEqual({
      windows: [
        {
          id: "seven_day_fable",
          kind: "weekly",
          label: "Weekly · Fable",
          usedPercent: 40,
          windowDurationMins: 10080,
        },
      ],
    });
  });

  it("updates both account windows from the unifiedWindows a real event carries", () => {
    // Verbatim from a real CLI rate_limit_event (2026-10-03, team account):
    // no top-level utilization, the numbers live only in unifiedWindows.
    const event = {
      status: "allowed",
      resetsAt: 1791021000,
      rateLimitType: "five_hour",
      overageStatus: "rejected",
      overageDisabledReason: "org_level_disabled",
      isUsingOverage: false,
      unifiedWindows: {
        five_hour: { utilization: 0.18, resetsAt: 1791021000 },
        seven_day: { utilization: 0.57, resetsAt: 1791352800 },
      },
    } as never;
    const update = claudeRateLimitEventToUpdate(event, noNames);
    expect(update?.windows.map(({ id, resetsAt }) => ({ id, resetsAt }))).toEqual([
      { id: "five_hour", resetsAt: "2026-10-03T09:50:00.000Z" },
      { id: "seven_day", resetsAt: "2026-10-07T06:00:00.000Z" },
    ]);
    expect(update?.windows[0]?.usedPercent).toBeCloseTo(18);
    expect(update?.windows[1]?.usedPercent).toBeCloseTo(57);
  });

  it("ignores windows the page does not render and events without a utilization", () => {
    expect(
      claudeRateLimitEventToUpdate(
        { status: "allowed", rateLimitType: "seven_day_opus", utilization: 0.1 },
        noNames,
      ),
    ).toBeUndefined();
    expect(
      claudeRateLimitEventToUpdate({ status: "rejected", rateLimitType: "five_hour" }, noNames),
    ).toBeUndefined();
  });
});
