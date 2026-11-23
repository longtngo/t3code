import { describe, expect, it } from "vite-plus/test";

import { clampPct, vitalsLevel } from "./vitals";

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
