import { describe, expect, it } from "vite-plus/test";

import { applyUsageLimitsUpdate, resolveUsageLimitsAfterProbe } from "./providerUsageLimits.ts";

const checkedAt = "2026-09-03T12:00:00.000Z";
const session = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 40,
  windowDurationMins: 300,
  resetsAt: "2026-09-03T14:00:00.000Z",
} as const;
const weekly = {
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  usedPercent: 20,
  windowDurationMins: 10_080,
} as const;
const published = { checkedAt, windows: [session, weekly] };

describe("applyUsageLimitsUpdate", () => {
  it("returns the published object itself when no window moved", () => {
    // Codex repeats the same numbers beside every token-usage tick; the
    // ingestion path relies on identity to skip the publish.
    const next = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: {
        windows: [
          { ...weekly },
          { id: "five_hour", kind: "session", label: "Session", usedPercent: 40 },
        ],
      },
    });
    expect(next).toBe(published);
  });

  it("re-stamps an unchanged reading the provider confirms once it is 30 s old", () => {
    // The credit guard re-reads usage older than 60 s; a turn that keeps reporting the
    // same numbers must keep the reading current without republishing on every tick.
    const confirm = (at: string, windows: ReadonlyArray<typeof session | typeof weekly>) =>
      applyUsageLimitsUpdate({ previous: published, checkedAt: at, update: { windows } });
    expect(confirm("2026-09-03T12:00:29.999Z", [session, weekly])).toBe(published);
    expect(confirm("2026-09-03T12:00:30.000Z", [session, weekly])).toEqual({
      ...published,
      checkedAt: "2026-09-03T12:00:30.000Z",
    });
    // A one-window event (Claude's rate_limit_event) does not vouch for the weekly window.
    expect(confirm("2026-09-03T12:05:00.000Z", [session])).toBe(published);
  });

  it("upserts by id and keeps the reset a percent-only update omits", () => {
    const next = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: {
        windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 55 }],
      },
    });
    expect(next).not.toBe(published);
    expect(next).toEqual({
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [{ ...session, usedPercent: 55 }, weekly],
    });
  });

  it("leaves an unsupported account and an empty update alone", () => {
    const unsupported = { checkedAt, windows: [], unavailable: { reason: "unsupported" as const } };
    expect(
      applyUsageLimitsUpdate({ previous: unsupported, checkedAt, update: { windows: [session] } }),
    ).toBe(unsupported);
    expect(
      applyUsageLimitsUpdate({ previous: published, checkedAt, update: { windows: [] } }),
    ).toBe(published);
  });

  it("preserves reset credits and spend when a streamed window update changes usage", () => {
    const resetCredits = { availableCount: 2, nextExpiresAt: "2026-10-01T00:00:00.000Z" };
    const spend = { used: 0, limit: 200, currency: "CAD", usedPercent: 0 };
    const next = applyUsageLimitsUpdate({
      previous: { ...published, resetCredits, spend },
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: { windows: [{ ...session, usedPercent: 55 }] },
    });

    expect(next).toEqual({
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [{ ...session, usedPercent: 55 }, weekly],
      resetCredits,
      spend,
    });
  });
});

describe("resolveUsageLimitsAfterProbe", () => {
  it("keeps the last good windows through a failed probe but not an unsupported one", () => {
    const failed = { checkedAt, windows: [], unavailable: { reason: "probeFailed" as const } };
    const unsupported = { checkedAt, windows: [], unavailable: { reason: "unsupported" as const } };
    expect(resolveUsageLimitsAfterProbe({ published, probed: failed })).toBe(published);
    expect(resolveUsageLimitsAfterProbe({ published, probed: unsupported })).toBe(unsupported);
    expect(resolveUsageLimitsAfterProbe({ published: undefined, probed: failed })).toBe(failed);
  });

  it("keeps a newer runtime update over a probe that served an older cached read", () => {
    const runtime = { checkedAt: "2026-09-03T12:04:00.000Z", windows: [session] };
    const cached = { checkedAt: "2026-09-03T12:01:00.000Z", windows: [] };
    const fresh = { checkedAt: "2026-09-03T12:05:00.000Z", windows: [] };
    expect(resolveUsageLimitsAfterProbe({ published: runtime, probed: cached })).toEqual(runtime);
    expect(resolveUsageLimitsAfterProbe({ published: runtime, probed: fresh })).toBe(fresh);
  });

  it("keeps the probe's reset credits and spend when it keeps the runtime windows", () => {
    // The status check re-reads reset credits live while serving cached usage.
    const runtime = { checkedAt: "2026-09-03T12:04:00.000Z", windows: [session] };
    const cached = {
      checkedAt: "2026-09-03T12:01:00.000Z",
      windows: [weekly],
      resetCredits: { availableCount: 1, nextCreditId: "credit-1" },
      spend: { used: 12.5, limit: 200, currency: "CAD", usedPercent: 6.25 },
    };
    expect(resolveUsageLimitsAfterProbe({ published: runtime, probed: cached })).toEqual({
      checkedAt: runtime.checkedAt,
      windows: [session],
      resetCredits: cached.resetCredits,
      spend: cached.spend,
    });
  });
});
