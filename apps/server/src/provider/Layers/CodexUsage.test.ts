// @effect-diagnostics globalDate:off
import { assert, describe, it } from "@effect/vitest";

import { hasCodexUsageSignal, normalizeCodexRateLimits } from "./CodexUsage.ts";

const formatEpochSeconds = (seconds: number): string => new Date(seconds * 1000).toISOString();

describe("CodexUsage.normalizeCodexRateLimits", () => {
  const primaryReset = 1_704_074_400;
  const secondaryReset = 1_704_160_800;

  it("maps the backward-compatible rateLimits bucket", () => {
    const result = normalizeCodexRateLimits({
      rateLimits: {
        primary: {
          usedPercent: 42,
          windowDurationMins: 300,
          resetsAt: primaryReset,
        },
        secondary: {
          usedPercent: 8,
          windowDurationMins: 10_080,
          resetsAt: secondaryReset,
        },
        credits: {
          balance: "25.50",
          hasCredits: true,
          unlimited: false,
        },
        planType: "pro",
        limitName: "codex",
      },
    });

    assert.isDefined(result);
    assert.deepStrictEqual(result?.fiveHour, null);
    assert.deepStrictEqual(result?.codex?.primary, {
      utilization: 42,
      resetsAt: formatEpochSeconds(primaryReset),
      windowDurationMins: 300,
    });
    assert.deepStrictEqual(result?.codex?.secondary, {
      utilization: 8,
      resetsAt: formatEpochSeconds(secondaryReset),
      windowDurationMins: 10_080,
    });
    assert.deepStrictEqual(result?.codex?.credits, {
      balance: "25.50",
      hasCredits: true,
      unlimited: false,
    });
  });

  it("prefers the codex entry from rateLimitsByLimitId", () => {
    const result = normalizeCodexRateLimits({
      rateLimits: {
        primary: { usedPercent: 1, windowDurationMins: 60, resetsAt: primaryReset },
      },
      rateLimitsByLimitId: {
        codex: {
          primary: { usedPercent: 55, windowDurationMins: 300, resetsAt: primaryReset },
          secondary: null,
          credits: null,
          planType: "plus",
          limitName: "codex",
        },
      },
    });

    assert.equal(result?.codex?.primary?.utilization, 55);
    assert.equal(result?.codex?.planType, "plus");
  });

  it("returns null when no displayable signal is present", () => {
    assert.isNull(
      normalizeCodexRateLimits({
        rateLimits: {
          primary: null,
          secondary: null,
          credits: { balance: null, hasCredits: false, unlimited: false },
        },
      }),
    );
  });
});

describe("CodexUsage.hasCodexUsageSignal", () => {
  it("detects primary, secondary, and credits signals", () => {
    assert.equal(
      hasCodexUsageSignal({
        primary: { utilization: 0, resetsAt: null, windowDurationMins: 300 },
        secondary: null,
        credits: null,
      }),
      true,
    );
    assert.equal(
      hasCodexUsageSignal({
        primary: null,
        secondary: { utilization: 1, resetsAt: null, windowDurationMins: 10_080 },
        credits: null,
      }),
      true,
    );
    assert.equal(
      hasCodexUsageSignal({
        primary: null,
        secondary: null,
        credits: { balance: "10", hasCredits: true, unlimited: false },
      }),
      true,
    );
    assert.equal(
      hasCodexUsageSignal({
        primary: null,
        secondary: null,
        credits: { balance: null, hasCredits: false, unlimited: false },
      }),
      false,
    );
  });
});
