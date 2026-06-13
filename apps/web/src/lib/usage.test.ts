import { describe, expect, it } from "vite-plus/test";
import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";

import {
  USAGE_WINDOW_MS,
  computePace,
  deriveLatestUsageSnapshot,
  deriveSegmentPace,
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

const claudeUsagePayload = {
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

const cursorUsagePayload = {
  fiveHour: null,
  sevenDay: null,
  extra: null,
  cursor: {
    auto: { utilization: 0, resetsAt: "2026-07-01T00:00:00.000Z" },
    api: { utilization: 5.925, resetsAt: "2026-07-01T00:00:00.000Z" },
    total: { utilization: 5.925, resetsAt: "2026-07-01T00:00:00.000Z" },
    onDemand: {
      isEnabled: true,
      usedCredits: 391993,
      monthlyLimit: 800000,
      utilization: 49,
      currency: "USD",
    },
    onDemandScope: "team",
  },
};

const codexUsagePayload = {
  fiveHour: null,
  sevenDay: null,
  extra: null,
  codex: {
    primary: {
      utilization: 42,
      resetsAt: "2026-06-04T19:30:00Z",
      windowDurationMins: 300,
    },
    secondary: {
      utilization: 8,
      resetsAt: "2026-06-11T09:00:00Z",
      windowDurationMins: 10_080,
    },
    credits: {
      balance: "25.50",
      hasCredits: true,
      unlimited: false,
    },
    planType: "pro",
    limitName: "codex",
  },
};

describe("deriveLatestUsageSnapshot", () => {
  it("returns Claude segments from the legacy payload shape", () => {
    const snapshot = deriveLatestUsageSnapshot([
      makeActivity("a1", "account.usage.updated", {
        ...claudeUsagePayload,
        fiveHour: { utilization: 5, resetsAt: null },
      }),
      makeActivity("a2", "tool.started", {}),
      makeActivity("a3", "account.usage.updated", claudeUsagePayload),
    ]);
    expect(snapshot?.source).toBe("claude");
    expect(snapshot?.segments.map((segment) => segment.key)).toEqual(["5h", "7d", "extra"]);
    expect(snapshot?.segments[0]?.utilization).toBe(18);
    expect(snapshot?.segments[1]?.resetsAt).toBe("2026-06-08T09:00:00Z");
    expect(snapshot?.segments[2]?.inlineValue).toContain("$");
  });

  it("returns Cursor-native segments when cursor payload is present", () => {
    const snapshot = deriveLatestUsageSnapshot([
      makeActivity("a1", "account.usage.updated", cursorUsagePayload),
    ]);
    expect(snapshot?.source).toBe("cursor");
    expect(snapshot?.segments.map((segment) => segment.key)).toEqual(["api", "total", "on-demand"]);
    expect(snapshot?.segments[0]?.label).toBe("api");
    expect(snapshot?.segments[1]?.popoverLabel).toBe("Included usage");
    expect(snapshot?.segments[2]?.label).toBe("pool");
  });

  it("returns Codex-native segments when codex payload is present", () => {
    const snapshot = deriveLatestUsageSnapshot([
      makeActivity("a1", "account.usage.updated", codexUsagePayload),
    ]);
    expect(snapshot?.source).toBe("codex");
    expect(snapshot?.segments.map((segment) => segment.key)).toEqual([
      "primary",
      "secondary",
      "credits",
    ]);
    expect(snapshot?.segments[0]?.label).toBe("5h");
    expect(snapshot?.segments[1]?.label).toBe("7d");
    expect(snapshot?.segments[2]?.inlineValue).toBe("$25.50");
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
});

describe("deriveSegmentPace", () => {
  it("derives pace only for Claude time-window segments", () => {
    const snapshot = deriveLatestUsageSnapshot([
      makeActivity("a1", "account.usage.updated", claudeUsagePayload),
    ]);
    const fiveHour = snapshot?.segments.find((segment) => segment.key === "5h");
    expect(fiveHour?.showPace).toBe(true);
    expect(deriveSegmentPace(fiveHour!, Date.parse("2026-06-04T17:30:00Z"))).not.toBeNull();

    const cursorSnapshot = deriveLatestUsageSnapshot([
      makeActivity("a1", "account.usage.updated", cursorUsagePayload),
    ]);
    const api = cursorSnapshot?.segments.find((segment) => segment.key === "api");
    expect(api?.showPace).toBe(false);
    expect(deriveSegmentPace(api!, Date.now())).toBeNull();
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

describe("computePace", () => {
  const reset = Date.parse("2026-06-04T05:00:00Z");
  const win = USAGE_WINDOW_MS.fiveHour;
  const at40pct = reset - 0.6 * win;

  it("returns null without a reset time or with an unparseable one", () => {
    expect(computePace(50, null, win, at40pct)).toBeNull();
    expect(computePace(50, "not-a-date", win, at40pct)).toBeNull();
  });

  it("reports ahead when usage outpaces elapsed time", () => {
    const pace = computePace(62, "2026-06-04T05:00:00Z", win, at40pct);
    expect(pace?.state).toBe("ahead");
    expect(Math.round(pace?.elapsedPct ?? 0)).toBe(40);
    expect(Math.round(pace?.delta ?? 0)).toBe(22);
  });

  it("reports behind when usage trails elapsed time", () => {
    const pace = computePace(22, "2026-06-04T05:00:00Z", win, at40pct);
    expect(pace?.state).toBe("behind");
    expect(Math.round(pace?.delta ?? 0)).toBe(-18);
  });

  it("treats usage within the dead-zone as on pace", () => {
    expect(computePace(42, "2026-06-04T05:00:00Z", win, at40pct)?.state).toBe("onPace");
    expect(computePace(38, "2026-06-04T05:00:00Z", win, at40pct)?.state).toBe("onPace");
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
