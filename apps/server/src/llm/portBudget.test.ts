import { describe, expect, it } from "vite-plus/test";
import { assignPort, budgetBytes, fits, providerPortRange } from "./portBudget.ts";

describe("portBudget", () => {
  it("mlx range starts at 8765", () =>
    expect(providerPortRange("mlx-serve")).toEqual({ min: 8765, max: 8799 }));

  // An id the catalog does not know (a retired engine still named in an old settings file)
  // falls back to the mlx window rather than throwing. The launch itself still refuses it.
  it("falls back to the mlx window for an unknown provider", () =>
    expect(providerPortRange("ds4")).toEqual({ min: 8765, max: 8799 }));

  it("assigns the first free port", () =>
    expect(assignPort("mlx-serve", new Set([8765, 8766]))).toBe(8767));

  it("returns null when the range is full", () => {
    const full = new Set(Array.from({ length: 35 }, (_, i) => 8765 + i));
    expect(assignPort("mlx-serve", full)).toBeNull();
  });

  it("budget falls back to 80% of total memory", () => expect(budgetBytes(0, 1000)).toBe(800));
  it("budget honors an explicit value", () => expect(budgetBytes(500, 1000)).toBe(500));

  it("fits respects the budget", () => {
    expect(fits(100, 500, 100, 800)).toBe(true);
    expect(fits(300, 500, 100, 800)).toBe(false);
  });
});
