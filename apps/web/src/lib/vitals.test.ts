import { describe, expect, it } from "vite-plus/test";
import { EventId, type OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";

import {
  arcPathD,
  clampPct,
  computeWindowPace,
  deriveLatestAccountUsage,
  FIVE_HOUR_MS,
  formatWindowReset,
  paceDiffLabel,
  paceLevel,
  rightHalfArc,
  SEVEN_DAY_MS,
  vitalsLevel,
  windowSeverity,
} from "./vitals";

function makeActivity(id: string, kind: string, payload: unknown): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-07-27T00:00:00.000Z",
  };
}

describe("vitalsLevel", () => {
  it("uses the ≤50 / ≤75 / ≤90 / >90 ramp", () => {
    expect(vitalsLevel(0)).toBe("ok");
    expect(vitalsLevel(50)).toBe("ok");
    expect(vitalsLevel(50.1)).toBe("warn");
    expect(vitalsLevel(75)).toBe("warn");
    expect(vitalsLevel(75.1)).toBe("high");
    expect(vitalsLevel(90)).toBe("high");
    expect(vitalsLevel(90.1)).toBe("crit");
    expect(vitalsLevel(100)).toBe("crit");
  });
});

describe("paceLevel", () => {
  it("keys on the signed diff: <20 / <30 / <40 / else", () => {
    expect(paceLevel(-10)).toBe("ok");
    expect(paceLevel(0)).toBe("ok");
    expect(paceLevel(19)).toBe("ok");
    expect(paceLevel(20)).toBe("warn");
    expect(paceLevel(29)).toBe("warn");
    expect(paceLevel(30)).toBe("high");
    expect(paceLevel(39)).toBe("high");
    expect(paceLevel(40)).toBe("crit");
    expect(paceLevel(80)).toBe("crit");
  });
});

describe("clampPct", () => {
  it("clamps to [0,100]", () => {
    expect(clampPct(-5)).toBe(0);
    expect(clampPct(42)).toBe(42);
    expect(clampPct(150)).toBe(100);
  });

  it("coerces non-finite input to 0", () => {
    expect(clampPct(Number.NaN)).toBe(0);
    expect(clampPct(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("deriveLatestAccountUsage", () => {
  it("returns null when no usage activity is present", () => {
    expect(deriveLatestAccountUsage([])).toBeNull();
    expect(
      deriveLatestAccountUsage([makeActivity("a", "context-window.updated", { usedTokens: 1 })]),
    ).toBeNull();
  });

  it("reads the latest usage snapshot with both windows", () => {
    const view = deriveLatestAccountUsage([
      makeActivity("old", "account.usage.updated", {
        fiveHour: { utilization: 10, resetsAt: "2026-07-27T01:00:00.000Z" },
        sevenDay: { utilization: 5, resetsAt: null },
      }),
      makeActivity("new", "account.usage.updated", {
        fiveHour: { utilization: 88, resetsAt: "2026-07-27T02:00:00.000Z" },
        sevenDay: { utilization: 41, resetsAt: "2026-08-01T00:00:00.000Z" },
      }),
    ]);
    expect(view).toEqual({
      fiveHour: { utilization: 88, resetsAt: "2026-07-27T02:00:00.000Z" },
      sevenDay: { utilization: 41, resetsAt: "2026-08-01T00:00:00.000Z" },
      extraWindows: [],
      balances: [],
    });
  });

  it("defensively parses malformed windows to null", () => {
    const view = deriveLatestAccountUsage([
      makeActivity("bad", "account.usage.updated", {
        fiveHour: { resetsAt: "2026-07-27T02:00:00.000Z" }, // missing utilization
        sevenDay: "nonsense",
      }),
    ]);
    expect(view).toEqual({ fiveHour: null, sevenDay: null, extraWindows: [], balances: [] });
  });

  it("coerces a non-string resetsAt to null but keeps utilization", () => {
    const view = deriveLatestAccountUsage([
      makeActivity("x", "account.usage.updated", {
        fiveHour: { utilization: 33, resetsAt: 12345 },
        sevenDay: null,
      }),
    ]);
    expect(view).toEqual({
      fiveHour: { utilization: 33, resetsAt: null },
      sevenDay: null,
      extraWindows: [],
      balances: [],
    });
  });

  it("skips activities whose payload is not an object", () => {
    expect(deriveLatestAccountUsage([makeActivity("x", "account.usage.updated", null)])).toBeNull();
  });

  it("surfaces Codex primary/secondary windows, labelled by window length", () => {
    const view = deriveLatestAccountUsage([
      makeActivity("codex", "account.usage.updated", {
        fiveHour: null,
        sevenDay: null,
        codex: {
          primary: {
            utilization: 60,
            resetsAt: "2026-07-27T02:00:00.000Z",
            windowDurationMins: 300,
          },
          secondary: { utilization: 12, resetsAt: null, windowDurationMins: 10080 },
        },
      }),
    ]);
    expect(view?.fiveHour).toBeNull();
    expect(view?.extraWindows).toEqual([
      {
        label: "Codex 5h",
        utilization: 60,
        resetsAt: "2026-07-27T02:00:00.000Z",
        windowMs: 300 * 60_000,
      },
      { label: "Codex 7d", utilization: 12, resetsAt: null, windowMs: 10080 * 60_000 },
    ]);
  });

  it("falls back to a generic Codex label when the window length is missing", () => {
    const view = deriveLatestAccountUsage([
      makeActivity("codex", "account.usage.updated", {
        codex: { primary: { utilization: 5, resetsAt: null }, secondary: null },
      }),
    ]);
    expect(view?.extraWindows).toEqual([
      { label: "Codex primary", utilization: 5, resetsAt: null, windowMs: null },
    ]);
  });

  it("surfaces Cursor windows with no fixed duration (utilization only)", () => {
    const view = deriveLatestAccountUsage([
      makeActivity("cursor", "account.usage.updated", {
        cursor: {
          auto: { utilization: 25, resetsAt: null },
          api: null,
          total: { utilization: 40, resetsAt: "2026-08-01T00:00:00.000Z" },
        },
      }),
    ]);
    expect(view?.extraWindows).toEqual([
      { label: "Cursor auto", utilization: 25, resetsAt: null, windowMs: null },
      {
        label: "Cursor total",
        utilization: 40,
        resetsAt: "2026-08-01T00:00:00.000Z",
        windowMs: null,
      },
    ]);
  });
});

describe("computeWindowPace", () => {
  it("projects the elapsed fraction of the window from resetsAt", () => {
    // 2.5h until reset on a 5h window → 50% elapsed.
    const resetsAt = new Date(FIVE_HOUR_MS / 2).toISOString();
    const pace = computeWindowPace({ utilization: 70, resetsAt }, FIVE_HOUR_MS, 0);
    expect(pace.usage).toBe(70);
    expect(pace.projection).toBe(50);
    expect(pace.diff).toBe(20);
  });

  it("clamps a past reset to 100% elapsed and a far-future reset to 0%", () => {
    const past = computeWindowPace(
      { utilization: 20, resetsAt: new Date(-1000).toISOString() },
      FIVE_HOUR_MS,
      0,
    );
    expect(past.projection).toBe(100);
    const future = computeWindowPace(
      { utilization: 20, resetsAt: new Date(FIVE_HOUR_MS * 2).toISOString() },
      FIVE_HOUR_MS,
      0,
    );
    expect(future.projection).toBe(0);
  });

  it("yields a null projection and diff when resetsAt is missing", () => {
    const pace = computeWindowPace({ utilization: 42, resetsAt: null }, SEVEN_DAY_MS, 0);
    expect(pace).toEqual({ usage: 42, projection: null, diff: null });
  });

  it("yields a null projection when resetsAt is unparseable", () => {
    const pace = computeWindowPace({ utilization: 42, resetsAt: "not-a-date" }, SEVEN_DAY_MS, 0);
    expect(pace.projection).toBeNull();
    expect(pace.diff).toBeNull();
  });

  it("yields a null projection when the window has no fixed duration", () => {
    // Cursor windows carry a resetsAt but no length, so no pace can be computed.
    const pace = computeWindowPace(
      { utilization: 42, resetsAt: "2026-08-01T00:00:00.000Z" },
      null,
      0,
    );
    expect(pace).toEqual({ usage: 42, projection: null, diff: null });
  });

  it("rounds utilization for display and diff", () => {
    const resetsAt = new Date(FIVE_HOUR_MS / 2).toISOString();
    const pace = computeWindowPace({ utilization: 70.6, resetsAt }, FIVE_HOUR_MS, 0);
    expect(pace.usage).toBe(71);
    expect(pace.diff).toBe(21);
  });
});

describe("windowSeverity", () => {
  it("uses pace when a projection exists", () => {
    expect(windowSeverity({ usage: 91, projection: 34, diff: 57 })).toBe("crit");
    expect(windowSeverity({ usage: 40, projection: 44, diff: -4 })).toBe("ok");
  });

  it("falls back to absolute fullness when there is no projection", () => {
    expect(windowSeverity({ usage: 95, projection: null, diff: null })).toBe("crit");
    expect(windowSeverity({ usage: 30, projection: null, diff: null })).toBe("ok");
  });
});

describe("paceDiffLabel", () => {
  it("labels on / under / over pace", () => {
    expect(paceDiffLabel(0)).toBe("on pace");
    expect(paceDiffLabel(-4)).toBe("4% under pace");
    expect(paceDiffLabel(57)).toBe("+57% over pace");
  });
});

describe("arcPathD", () => {
  it("emits a deterministic move+arc command", () => {
    expect(arcPathD(10, 0, 90)).toBe("M32.00 22.00 A10 10 0 0 1 22.00 32.00");
  });

  it("sets the large-arc flag past 180°", () => {
    expect(arcPathD(10, 0, 200)).toContain("A10 10 0 1 1");
    expect(arcPathD(10, 0, 90)).toContain("A10 10 0 0 1");
  });
});

describe("rightHalfArc", () => {
  it("always has a track and no fill for a null or zero metric", () => {
    const nullArc = rightHalfArc(18.5, null);
    expect(nullArc.trackD.startsWith("M")).toBe(true);
    expect(nullArc.fillD).toBeNull();
    expect(rightHalfArc(18.5, 0).fillD).toBeNull();
  });

  it("produces a fill for a positive metric", () => {
    const full = rightHalfArc(18.5, 100);
    expect(full.fillD).not.toBeNull();
    expect(full.fillD?.startsWith("M")).toBe(true);
  });

  it("floors a tiny sweep so a rounded cap still renders", () => {
    expect(rightHalfArc(18.5, 0.01).fillD).not.toBeNull();
  });
});

describe("deriveLatestAccountUsage balances", () => {
  const usageActivity = (payload: unknown) => [makeActivity("a", "account.usage.updated", payload)];

  it("surfaces Claude extra credits as a balance", () => {
    // A real account's payload, over its monthly limit. Amounts are cents.
    const view = deriveLatestAccountUsage(
      usageActivity({
        fiveHour: { utilization: 1, resetsAt: "2026-08-20T21:39:59.563953+00:00" },
        sevenDay: { utilization: 59, resetsAt: "2026-08-24T08:59:59.563973+00:00" },
        extra: {
          isEnabled: true,
          usedCredits: 20166,
          monthlyLimit: 20000,
          utilization: 100,
          currency: "CAD",
        },
      }),
    );

    expect(view?.balances).toEqual([
      { label: "Extra usage", detail: "CAD 201.66 of CAD 200.00", utilization: 100 },
    ]);
  });

  it("omits extra credits for an account that has not turned them on", () => {
    const view = deriveLatestAccountUsage(
      usageActivity({
        fiveHour: { utilization: 1, resetsAt: null },
        sevenDay: null,
        extra: {
          isEnabled: false,
          usedCredits: 0,
          monthlyLimit: 0,
          utilization: 0,
          currency: null,
        },
      }),
    );

    expect(view?.balances).toEqual([]);
  });

  it("omits an enabled-but-empty account, which isEnabled alone does not catch", () => {
    // `OAuthUsage` maps an `extra_usage` carrying only `is_enabled` to this
    // all-zeros record, asserted by its own test. Gating on `isEnabled` renders
    // "$0.00 of $0.00" in green, and that row alone opens the limits block on
    // an account with nothing else in it.
    const view = deriveLatestAccountUsage(
      usageActivity({
        extra: { isEnabled: true, usedCredits: 0, monthlyLimit: 0, utilization: 0, currency: null },
      }),
    );

    expect(view?.balances).toEqual([]);
  });

  it("leaves utilization null when the payload omits it, rather than reading as 0%", () => {
    // A balance row colours null as neutral and 0 as green, so defaulting a
    // missing utilization would claim a healthy reading nobody sent.
    const view = deriveLatestAccountUsage(
      usageActivity({ extra: { isEnabled: true, usedCredits: 4354, monthlyLimit: 200000 } }),
    );

    expect(view?.balances[0]?.utilization).toBeNull();
  });

  it("treats a missing used amount as zero spent against the limit", () => {
    const view = deriveLatestAccountUsage(
      usageActivity({ extra: { isEnabled: true, monthlyLimit: 200000, utilization: 0 } }),
    );

    expect(view?.balances[0]?.detail).toBe("$0.00 of $2000.00");
  });

  it("ignores an empty currency instead of printing it as a prefix", () => {
    // `formatSpend` builds "<currency> <amount>", so an empty string renders a
    // leading space and a doubled one before the limit.
    const view = deriveLatestAccountUsage(
      usageActivity({
        extra: {
          isEnabled: true,
          usedCredits: 43540,
          monthlyLimit: 200000,
          utilization: 21.77,
          currency: "",
        },
      }),
    );

    expect(view?.balances[0]?.detail).toBe("$435.40 of $2000.00");
  });

  it("falls back to dollars when the payload names no currency", () => {
    const view = deriveLatestAccountUsage(
      usageActivity({
        extra: { isEnabled: true, usedCredits: 4354, monthlyLimit: 20000, utilization: 21 },
      }),
    );

    expect(view?.balances[0]?.detail).toBe("$43.54 of $200.00");
  });

  it("surfaces Cursor on-demand spend as a balance, not a window", () => {
    // A window implies a reset time and therefore a pace. Spend has neither, and
    // rendering it with a pace bar would claim a deadline that does not exist.
    const view = deriveLatestAccountUsage(
      usageActivity({
        cursor: {
          auto: null,
          api: null,
          total: null,
          onDemand: { used: 12.5, limit: 50, utilization: 25, currency: "USD" },
        },
      }),
    );

    expect(view?.extraWindows).toEqual([]);
    expect(view?.balances).toEqual([
      { label: "Cursor on-demand", detail: "$12.50 of $50.00", utilization: 25 },
    ]);
  });

  it("names a team-scoped on-demand budget as the team's", () => {
    const view = deriveLatestAccountUsage(
      usageActivity({
        cursor: {
          auto: null,
          api: null,
          total: null,
          onDemand: { used: 3, limit: null, utilization: 0, currency: null },
          onDemandScope: "team",
        },
      }),
    );

    expect(view?.balances[0]?.label).toBe("Cursor on-demand (team)");
    expect(view?.balances[0]?.detail).toBe("3");
  });

  it("surfaces the enterprise request bucket", () => {
    const view = deriveLatestAccountUsage(
      usageActivity({
        cursor: {
          auto: null,
          api: null,
          total: null,
          onDemand: null,
          requests: { used: 120, limit: 500, utilization: 24 },
        },
      }),
    );

    expect(view?.balances).toEqual([
      { label: "Cursor requests", detail: "120 of 500", utilization: 24 },
    ]);
  });

  it("shows a Codex credits balance exactly as the server formatted it", () => {
    const view = deriveLatestAccountUsage(
      usageActivity({
        codex: {
          primary: null,
          secondary: null,
          credits: { balance: "$4.20", hasCredits: true, unlimited: false },
        },
      }),
    );

    expect(view?.balances).toEqual([
      { label: "Codex credits", detail: "$4.20", utilization: null },
    ]);
  });

  it("distinguishes an unlimited plan from an exhausted one", () => {
    const unlimited = deriveLatestAccountUsage(
      usageActivity({
        codex: {
          primary: null,
          secondary: null,
          credits: { hasCredits: true, unlimited: true },
        },
      }),
    );
    const exhausted = deriveLatestAccountUsage(
      usageActivity({
        codex: {
          primary: null,
          secondary: null,
          credits: { hasCredits: false, unlimited: false },
        },
      }),
    );

    expect(unlimited?.balances[0]?.detail).toBe("Unlimited");
    expect(exhausted?.balances[0]?.detail).toBe("None remaining");
  });

  it("leaves a Claude account with no balance rows at all", () => {
    const view = deriveLatestAccountUsage(
      usageActivity({ fiveHour: { utilization: 10, resetsAt: null }, sevenDay: null }),
    );

    expect(view?.balances).toEqual([]);
  });
});

// Local-time constructor so reset formatting is timezone-stable in tests
// (Intl renders in local time; fixed ISO inputs would assert differently per TZ).
function localDate(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

describe("formatWindowReset", () => {
  const now = localDate(2026, 8, 14, 12, 0).getTime();

  it("has nothing to say when the provider exposes no reset instant", () => {
    expect(formatWindowReset(null, now, "24-hour")).toBeNull();
  });

  it("has nothing to say when the reset instant is unparseable", () => {
    // formatShortTimestamp returns "" rather than null for a bad date, so an
    // unguarded delegate would render a bare "resets" with no time after it.
    expect(formatWindowReset("not-a-date", now, "24-hour")).toBeNull();
  });

  it("reads 'now' once the reset moment has passed", () => {
    // Providers refresh lazily, so an elapsed timestamp lingers briefly.
    const past = localDate(2026, 8, 14, 11, 30).toISOString();
    expect(formatWindowReset(past, now, "24-hour")).toBe("now");
  });

  it("reads 'now' at the exact reset instant", () => {
    expect(formatWindowReset(new Date(now).toISOString(), now, "24-hour")).toBe("now");
  });

  it("shows the time alone for a reset inside 24 hours", () => {
    const soon = localDate(2026, 8, 14, 14, 20).toISOString();
    const label = formatWindowReset(soon, now, "24-hour");
    expect(label).toBe("14:20");
  });

  it("adds the date for a reset beyond 24 hours", () => {
    const later = localDate(2026, 8, 21, 14, 20).toISOString();
    const label = formatWindowReset(later, now, "24-hour") ?? "";
    // Asserted structurally, not as a literal: the date half follows the system
    // locale, so day/month ORDER and separator vary. What must hold everywhere
    // is that both parts appear and the time still trails the date.
    expect(label).toMatch(/\b8\b/);
    expect(label).toMatch(/\b21\b/);
    expect(label.endsWith("14:20")).toBe(true);
    expect(label).not.toBe("14:20");
  });

  it("honours the 12-hour preference", () => {
    const soon = localDate(2026, 8, 14, 14, 20).toISOString();
    expect(formatWindowReset(soon, now, "12-hour")).toMatch(/2:20\s?PM/i);
  });

  it("honours the 12-hour preference on the dated form too", () => {
    const later = localDate(2026, 8, 21, 14, 20).toISOString();
    expect(formatWindowReset(later, now, "12-hour")).toMatch(/2:20\s?PM$/i);
  });
});
