import { describe, expect, it } from "vite-plus/test";

import {
  QUEUED_TURN_START_GRACE_MS,
  isQueuedTurnStart,
  latestTurnTimestampMs,
} from "./queuedTurnStart.ts";

/**
 * The server refuses to settle or snooze a thread with a queued turn start, and
 * the clients keep it off the settled shelf. Disagreement means the UI offers an
 * action the server then rejects, so this rule is worth testing directly rather
 * than only through each caller.
 */
const base = {
  latestUserMessageAtMs: 1_000_000,
  latestTurnAtMs: Number.NEGATIVE_INFINITY,
  sessionStatus: null,
  nowMs: 1_000_000,
};

describe("isQueuedTurnStart", () => {
  it("is true for a fresh user message no turn has adopted", () => {
    expect(isQueuedTurnStart(base)).toBe(true);
  });

  it("is false once a turn timestamp catches up with the message", () => {
    // Adoption stamps the new turn's requestedAt with the message time, so equal
    // timestamps mean adopted - hence `<=`, not `<`.
    expect(isQueuedTurnStart({ ...base, latestTurnAtMs: 1_000_000 })).toBe(false);
    expect(isQueuedTurnStart({ ...base, latestTurnAtMs: 1_000_001 })).toBe(false);
    expect(isQueuedTurnStart({ ...base, latestTurnAtMs: 999_999 })).toBe(true);
  });

  it("is false when the session failed to start", () => {
    // The failure is already visible; blocking on top of it strands the thread.
    expect(isQueuedTurnStart({ ...base, sessionStatus: "error" })).toBe(false);
    expect(isQueuedTurnStart({ ...base, sessionStatus: "running" })).toBe(true);
  });

  it("expires after the grace window", () => {
    const justInside = base.latestUserMessageAtMs + QUEUED_TURN_START_GRACE_MS;
    expect(isQueuedTurnStart({ ...base, nowMs: justInside })).toBe(true);
    expect(isQueuedTurnStart({ ...base, nowMs: justInside + 1 })).toBe(false);
  });

  it("bounds a message timestamp from a clock running ahead", () => {
    // The both-sides bound. A sending device ahead of this one yields a NEGATIVE
    // age; without the lower bound it satisfies `<= grace` for the whole skew and
    // holds the thread unsettleable far past the intended window.
    const ahead = base.latestUserMessageAtMs - QUEUED_TURN_START_GRACE_MS;
    expect(isQueuedTurnStart({ ...base, nowMs: ahead })).toBe(true);
    expect(isQueuedTurnStart({ ...base, nowMs: ahead - 1 })).toBe(false);
  });

  it("is false without a usable message or clock", () => {
    expect(isQueuedTurnStart({ ...base, latestUserMessageAtMs: Number.NaN })).toBe(false);
    expect(isQueuedTurnStart({ ...base, latestUserMessageAtMs: Number.NEGATIVE_INFINITY })).toBe(
      false,
    );
    expect(isQueuedTurnStart({ ...base, nowMs: Number.NaN })).toBe(false);
  });
});

describe("latestTurnTimestampMs", () => {
  it("is -Infinity when there is no turn, so any message counts as newer", () => {
    expect(latestTurnTimestampMs(null)).toBe(Number.NEGATIVE_INFINITY);
  });

  it("takes the newest of the three timestamps", () => {
    expect(
      latestTurnTimestampMs({
        requestedAt: "2026-01-01T00:00:01.000Z",
        startedAt: "2026-01-01T00:00:03.000Z",
        completedAt: "2026-01-01T00:00:02.000Z",
      }),
    ).toBe(Date.parse("2026-01-01T00:00:03.000Z"));
  });

  it("ignores nulls rather than treating them as now", () => {
    expect(
      latestTurnTimestampMs({
        requestedAt: "2026-01-01T00:00:01.000Z",
        startedAt: null,
        completedAt: null,
      }),
    ).toBe(Date.parse("2026-01-01T00:00:01.000Z"));
  });
});
