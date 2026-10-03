import { describe, expect, it } from "vite-plus/test";

import {
  accountUsageFromLimits,
  arcPathD,
  billingMonthWindow,
  clampPct,
  computeWindowPace,
  daysInUtcMonth,
  extraUsageWindow,
  formatSnapshotAge,
  segmentBoundariesBackground,
  FIVE_HOUR_MS,
  formatWindowReset,
  paceDiffLabel,
  paceLevel,
  rightHalfArc,
  SEVEN_DAY_MS,
  vitalsLevel,
  windowSeverity,
} from "./vitals";

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
  it("is green at or under pace, yellow up to the tolerance over, red beyond", () => {
    expect(paceLevel(-10, 15)).toBe("ok");
    expect(paceLevel(0, 15)).toBe("ok");
    expect(paceLevel(1, 15)).toBe("warn");
    expect(paceLevel(15, 15)).toBe("warn");
    expect(paceLevel(16, 15)).toBe("crit");
    expect(paceLevel(80, 15)).toBe("crit");
  });

  it("moves the red boundary with the tolerance and never returns orange", () => {
    expect(paceLevel(25, 30)).toBe("warn");
    expect(paceLevel(31, 30)).toBe("crit");
    expect(paceLevel(1, 0)).toBe("crit");
    expect(paceLevel(0, 0)).toBe("ok");
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

describe("accountUsageFromLimits", () => {
  const checkedAt = "2026-08-15T11:58:00.000Z";

  it("has nothing to draw without windows", () => {
    expect(accountUsageFromLimits(undefined)).toBeNull();
    expect(accountUsageFromLimits({ checkedAt, windows: [] })).toBeNull();
    expect(
      accountUsageFromLimits({
        checkedAt,
        windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 10 }],
        unavailable: { reason: "unsupported" },
      }),
    ).toBeNull();
  });

  it("puts Claude's 5h/7d on the ring and stamps freshness from the snapshot", () => {
    const view = accountUsageFromLimits({
      checkedAt,
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          usedPercent: 42,
          windowDurationMins: 300,
          resetsAt: "2026-08-15T14:00:00.000Z",
        },
        { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 17 },
        {
          id: "seven_day_fable",
          kind: "weekly",
          label: "Weekly · Fable",
          usedPercent: 60,
          windowDurationMins: 10_080,
        },
      ],
    });
    expect(view?.fiveHour).toEqual({ utilization: 42, resetsAt: "2026-08-15T14:00:00.000Z" });
    expect(view?.sevenDay).toEqual({ utilization: 17, resetsAt: null });
    expect(view?.fetchedAt).toBe(checkedAt);
    expect(view?.extraWindows).toEqual([
      {
        id: "seven_day_fable",
        label: "Weekly · Fable",
        utilization: 60,
        resetsAt: null,
        windowMs: SEVEN_DAY_MS,
        segmentCount: 7,
      },
    ]);
  });

  it("shows other providers' windows as rows, paced only when they carry a length", () => {
    const view = accountUsageFromLimits({
      checkedAt,
      windows: [
        {
          id: "primary",
          kind: "session",
          label: "Session",
          usedPercent: 8,
          windowDurationMins: 300,
        },
        { id: "totalPercentUsed", kind: "monthly", label: "Overall", usedPercent: 72 },
        {
          id: "autoPercentUsed",
          kind: "monthly",
          label: "Cursor Models",
          usedPercent: 50,
          windowDurationMins: 43_200,
        },
      ],
    });
    expect(view?.fiveHour).toBeNull();
    expect(view?.sevenDay).toBeNull();
    expect(
      view?.extraWindows.map(({ id, windowMs, segmentCount }) => ({ id, windowMs, segmentCount })),
    ).toEqual([
      { id: "primary", windowMs: FIVE_HOUR_MS, segmentCount: 5 },
      { id: "totalPercentUsed", windowMs: null, segmentCount: undefined },
      { id: "autoPercentUsed", windowMs: 30 * 24 * 60 * 60 * 1000, segmentCount: 30 },
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
    expect(windowSeverity({ usage: 91, projection: 34, diff: 57 }, 15)).toBe("crit");
    expect(windowSeverity({ usage: 40, projection: 44, diff: -4 }, 15)).toBe("ok");
  });

  it("falls back to absolute fullness when there is no projection", () => {
    expect(windowSeverity({ usage: 95, projection: null, diff: null }, 15)).toBe("crit");
    expect(windowSeverity({ usage: 30, projection: null, diff: null }, 15)).toBe("ok");
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

describe("segmentBoundariesBackground", () => {
  it("draws segments-1 interior boundaries and none at the ends", () => {
    const background = segmentBoundariesBackground(5) ?? "";
    // 4 interior boundaries at 20/40/60/80. A boundary at 100% would land
    // inside the track's rounded cap and render as a sliver darkening the end.
    expect(background.match(/calc\(\d/g)?.length).toBe(4 * 4);
    expect(background).toContain("20%");
    expect(background).toContain("80%");
    expect(background).not.toContain("100%");
    expect(background).not.toContain("calc(0%");
  });

  it("has nothing to draw below two segments", () => {
    expect(segmentBoundariesBackground(1)).toBeUndefined();
    expect(segmentBoundariesBackground(0)).toBeUndefined();
    expect(segmentBoundariesBackground(Number.NaN)).toBeUndefined();
  });

  it("still produces boundaries at a month's worth of segments", () => {
    expect(segmentBoundariesBackground(31)).toContain("linear-gradient");
  });

  it("uses a segment-gap custom property with popover fallback", () => {
    const background = segmentBoundariesBackground(5) ?? "";
    expect(background).toContain("var(--segment-gap, var(--popover))");
  });
});

describe("billingMonthWindow", () => {
  it("spans the first instant of this UTC month to the first of the next", () => {
    const august = billingMonthWindow(Date.UTC(2026, 7, 15, 12));
    expect(august.resetsAt).toBe("2026-09-01T00:00:00.000Z");
    expect(august.windowMs).toBe(31 * 24 * 60 * 60 * 1000);
  });

  it("rolls into January across a year boundary", () => {
    const december = billingMonthWindow(Date.UTC(2026, 11, 31, 23, 59));
    expect(december.resetsAt).toBe("2027-01-01T00:00:00.000Z");
    expect(december.windowMs).toBe(31 * 24 * 60 * 60 * 1000);
  });

  it("measures February from its own boundaries, not a 30-day assumption", () => {
    expect(billingMonthWindow(Date.UTC(2026, 1, 10)).windowMs).toBe(28 * 24 * 60 * 60 * 1000);
    // 2028 is a leap year.
    expect(billingMonthWindow(Date.UTC(2028, 1, 10)).windowMs).toBe(29 * 24 * 60 * 60 * 1000);
  });

  it("anchors in UTC, so the boundary is one instant for every reader", () => {
    // Derived locally, a UTC+14 reader crosses into the next month 14 hours
    // before the provider's counter resets — long enough to read "+98% over
    // pace" in the most severe colour on an account behaving normally.
    const justBeforeMidnightUtc = Date.UTC(2026, 7, 31, 23, 0);
    expect(billingMonthWindow(justBeforeMidnightUtc).resetsAt).toBe("2026-09-01T00:00:00.000Z");
    expect(daysInUtcMonth(justBeforeMidnightUtc)).toBe(31);
  });
});

describe("formatSnapshotAge", () => {
  const at = "2026-08-15T12:00:00.000Z";
  const base = Date.parse(at);

  it("counts up through minutes, hours and days", () => {
    expect(formatSnapshotAge(at, base + 30_000)).toBe("just now");
    expect(formatSnapshotAge(at, base + 5 * 60_000)).toBe("5m ago");
    expect(formatSnapshotAge(at, base + 3 * 60 * 60_000)).toBe("3h ago");
    expect(formatSnapshotAge(at, base + 50 * 60 * 60_000)).toBe("2d ago");
  });

  it("floors a client clock running ahead of the server, rather than going negative", () => {
    // The instant is server-stamped and `now` is the client's, so on a remote
    // or relayed connection this difference is routine.
    expect(formatSnapshotAge(at, base - 4 * 60_000)).toBe("just now");
  });

  it("has nothing to say without a timestamp", () => {
    expect(formatSnapshotAge(null, base)).toBeNull();
    expect(formatSnapshotAge("not-a-date", base)).toBeNull();
  });
});

describe("extraUsageWindow", () => {
  // Mid-August 2026, clear of either month boundary.
  const nowMs = Date.UTC(2026, 7, 15, 12, 0, 0);

  it("paces the real CAD 200 extra-usage cap as a billing-month row", () => {
    // `spend` as `claudeUsageResponseToLimits` maps the real team account.
    const window = extraUsageWindow(
      { used: 150.5, limit: 200, currency: "CAD", usedPercent: 75.25 },
      nowMs,
    );
    expect(window).toEqual({
      label: "Extra usage",
      detail: "CAD 150.50 of CAD 200.00",
      utilization: 75.25,
      resetsAt: "2026-09-01T00:00:00.000Z",
      windowMs: 31 * 24 * 60 * 60 * 1000,
      segmentCount: 31,
    });
  });

  it("has no row until spending has started", () => {
    // The real team account today: extra usage enabled, CAD 200 cap, nothing spent.
    expect(
      extraUsageWindow({ used: 0, limit: 200, currency: "CAD", usedPercent: 0 }, nowMs),
    ).toBeNull();
    expect(
      extraUsageWindow({ used: 0.01, limit: 200, currency: "CAD", usedPercent: 0.005 }, nowMs),
    ).not.toBeNull();
  });

  it("has no row without spending or without a percentage to pace", () => {
    expect(extraUsageWindow(null, nowMs)).toBeNull();
    expect(extraUsageWindow({ used: 3, currency: "USD" }, nowMs)).toBeNull();
  });

  it("carries the snapshot's spend into the gauge view", () => {
    const spend = { used: 0, limit: 200, currency: "CAD", usedPercent: 0 };
    expect(
      accountUsageFromLimits({
        checkedAt: "2026-10-03T07:13:37.215Z",
        windows: [{ id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 99 }],
        spend,
      })?.spend,
    ).toBe(spend);
  });
});
