import { assert, describe, it } from "@effect/vitest";

import { normalizeUsage, type RawUsageResponse } from "./OAuthUsage.ts";

describe("OAuthUsage.normalizeUsage", () => {
  // Shape verified against the live GET /api/oauth/usage response (2026-06-04).
  const liveSample: RawUsageResponse = {
    five_hour: { utilization: 45.0, resets_at: "2026-06-04T19:30:00.236199+00:00" },
    seven_day: { utilization: 24.0, resets_at: "2026-06-08T09:00:00.236223+00:00" },
    extra_usage: {
      is_enabled: true,
      monthly_limit: 200000,
      used_credits: 43540.0,
      utilization: 21.77,
      currency: "CAD",
    },
  };

  it("maps the live sample to the normalized contract shape", () => {
    const result = normalizeUsage(liveSample);
    assert.deepStrictEqual(result, {
      fiveHour: { utilization: 45, resetsAt: "2026-06-04T19:30:00.236199+00:00" },
      sevenDay: { utilization: 24, resetsAt: "2026-06-08T09:00:00.236223+00:00" },
      extra: {
        isEnabled: true,
        usedCredits: 43540,
        monthlyLimit: 200000,
        utilization: 21.77,
        currency: "CAD",
      },
    });
  });

  it("tolerates null seven_day / missing extra_usage", () => {
    const result = normalizeUsage({
      five_hour: { utilization: 10, resets_at: "2026-06-04T19:30:00Z" },
      seven_day: null,
    });
    assert.deepStrictEqual(result, {
      fiveHour: { utilization: 10, resetsAt: "2026-06-04T19:30:00Z" },
      sevenDay: null,
      extra: null,
    });
  });

  it("defaults missing numeric fields to 0 and missing currency to null", () => {
    const result = normalizeUsage({
      five_hour: {},
      extra_usage: { is_enabled: true },
    });
    assert.deepStrictEqual(result, {
      fiveHour: { utilization: 0, resetsAt: null },
      sevenDay: null,
      extra: { isEnabled: true, usedCredits: 0, monthlyLimit: 0, utilization: 0, currency: null },
    });
  });
});
