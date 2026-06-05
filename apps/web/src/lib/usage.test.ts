import { describe, expect, it } from "vite-plus/test";
import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";

import {
  deriveLatestUsageSnapshot,
  formatCredits,
  formatCreditsShort,
  formatResetTime,
  usageLevel,
} from "./usage";

function makeActivity(id: string, kind: string, payload: unknown): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: null,
    createdAt: "2026-06-04T00:00:00.000Z",
  };
}

const usagePayload = {
  fiveHour: { utilization: 18, resetsAt: "2026-06-04T19:30:00Z" },
  sevenDay: { utilization: 21, resetsAt: "2026-06-08T09:00:00Z" },
  extra: {
    isEnabled: true,
    usedCredits: 43540,
    monthlyLimit: 200000,
    utilization: 21.77,
    currency: "CAD",
  },
};

describe("deriveLatestUsageSnapshot", () => {
  it("returns the most recent account.usage.updated activity", () => {
    const snapshot = deriveLatestUsageSnapshot([
      makeActivity("a1", "account.usage.updated", {
        ...usagePayload,
        fiveHour: { utilization: 5, resetsAt: null },
      }),
      makeActivity("a2", "tool.started", {}),
      makeActivity("a3", "account.usage.updated", usagePayload),
    ]);
    expect(snapshot?.fiveHour?.utilization).toBe(18);
    expect(snapshot?.sevenDay?.resetsAt).toBe("2026-06-08T09:00:00Z");
    expect(snapshot?.extra?.usedCredits).toBe(43540);
    expect(snapshot?.extra?.currency).toBe("CAD");
  });

  it("returns null when no usage activity is present", () => {
    expect(deriveLatestUsageSnapshot([makeActivity("a1", "tool.started", {})])).toBeNull();
  });

  it("skips activities whose payload has no usable segments", () => {
    expect(
      deriveLatestUsageSnapshot([
        makeActivity("a1", "account.usage.updated", {
          fiveHour: null,
          sevenDay: null,
          extra: null,
        }),
      ]),
    ).toBeNull();
  });

  it("treats a disabled-only extra payload as having no usable segments", () => {
    expect(
      deriveLatestUsageSnapshot([
        makeActivity("a1", "account.usage.updated", {
          fiveHour: null,
          sevenDay: null,
          extra: { isEnabled: false, usedCredits: 0, monthlyLimit: 0, utilization: 0 },
        }),
      ]),
    ).toBeNull();
  });
});

describe("usageLevel", () => {
  it("matches statusline thresholds", () => {
    expect(usageLevel(0)).toBe("green");
    expect(usageLevel(49)).toBe("green");
    expect(usageLevel(50)).toBe("yellow");
    expect(usageLevel(69)).toBe("yellow");
    expect(usageLevel(70)).toBe("orange");
    expect(usageLevel(89)).toBe("orange");
    expect(usageLevel(90)).toBe("red");
    expect(usageLevel(100)).toBe("red");
  });
});

describe("formatCredits", () => {
  it("formats integer cents as dollars", () => {
    expect(formatCredits(43540)).toBe("$435.40");
    expect(formatCredits(200000)).toBe("$2000.00");
    expect(formatCredits(0)).toBe("$0.00");
  });
});

describe("formatCreditsShort", () => {
  it("abbreviates thousands and rounds dollars", () => {
    expect(formatCreditsShort(43540)).toBe("$435");
    expect(formatCreditsShort(200000)).toBe("$2k");
    expect(formatCreditsShort(182000)).toBe("$1.8k");
  });
});

describe("formatResetTime", () => {
  it("returns null for null/invalid input", () => {
    expect(formatResetTime(null, "time")).toBeNull();
    expect(formatResetTime("not-a-date", "time")).toBeNull();
  });

  it("formats a valid ISO timestamp without throwing", () => {
    const time = formatResetTime("2026-06-04T19:30:00Z", "time");
    expect(typeof time).toBe("string");
    expect(time).toMatch(/^\d{2}:\d{2}$/);
    const datetime = formatResetTime("2026-06-08T09:00:00Z", "datetime");
    expect(typeof datetime).toBe("string");
    expect(datetime?.length).toBeGreaterThan(0);
  });
});
