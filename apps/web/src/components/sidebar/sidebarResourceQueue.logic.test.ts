import { describe, expect, it } from "vite-plus/test";
import type { ResourceQueueItem } from "@t3tools/contracts";

import {
  elapsedSeconds,
  estimatedTotalSeconds,
  parseEstimateSeconds,
  resourceAccent,
  rowProgress,
  splitReason,
} from "./sidebarResourceQueue.logic";

function item(overrides: Partial<ResourceQueueItem> = {}): ResourceQueueItem {
  return {
    resource: "gpu",
    state: "running",
    priority: "normal",
    reason: "",
    project: "proj",
    amount: 1,
    sinceMs: 0,
    ...overrides,
  };
}

describe("splitReason", () => {
  it("splits on an em-dash flanked by spaces", () => {
    expect(splitReason("atlas embedding build — reindex the masked catalog")).toEqual({
      name: "atlas embedding build",
      description: "reindex the masked catalog",
    });
  });
  it("splits on a colon", () => {
    expect(splitReason("NE21f VT crossover: depths {4,8,16} × baseline")).toEqual({
      name: "NE21f VT crossover",
      description: "depths {4,8,16} × baseline",
    });
  });
  it("does not split a bare hyphen range (no surrounding spaces)", () => {
    expect(splitReason("run cells 4-16 sweep")).toEqual({ name: "run cells 4-16 sweep" });
  });
  it("returns the whole reason as the name when there is no separator", () => {
    expect(splitReason("t3-rebuild deploy")).toEqual({ name: "t3-rebuild deploy" });
  });
  it("keeps the whole reason when the separator is leading", () => {
    expect(splitReason(": leading colon")).toEqual({ name: ": leading colon" });
  });
  it("trims and tolerates an empty reason", () => {
    expect(splitReason("   ")).toEqual({ name: "" });
    expect(splitReason("  name — desc  ")).toEqual({ name: "name", description: "desc" });
  });
  it("has no description when the tail is empty", () => {
    expect(splitReason("label — ")).toEqual({ name: "label" });
  });
});

describe("parseEstimateSeconds", () => {
  it("reads a plain minute estimate", () => {
    expect(parseEstimateSeconds("~14 min ETA on the full pass")).toBe(14 * 60);
  });
  it("takes the upper bound of a hyphenated range", () => {
    expect(parseEstimateSeconds("60 cells (d16 rambles), ~50-70min")).toBe(70 * 60);
  });
  it("reads compact minute/hour/second units", () => {
    expect(parseEstimateSeconds("queued ~3m")).toBe(3 * 60);
    expect(parseEstimateSeconds("about 2h to finish")).toBe(2 * 3600);
    expect(parseEstimateSeconds("~45s warmup")).toBe(45);
  });
  it("returns undefined when no duration is present", () => {
    expect(parseEstimateSeconds("t3code full verify gate")).toBeUndefined();
  });
});

describe("estimatedTotalSeconds", () => {
  it("prefers a reason-mined estimate", () => {
    expect(estimatedTotalSeconds(item({ reason: "build ~10m", etaSec: 999 }), 0)).toBe(600);
  });
  it("falls back to elapsed + broker eta (eta is remaining)", () => {
    // elapsed 60s + 120s remaining = 180s total
    expect(
      estimatedTotalSeconds(item({ reason: "no estimate", sinceMs: 0, etaSec: 120 }), 60_000),
    ).toBe(180);
  });
  it("is undefined with neither a reason estimate nor an eta", () => {
    expect(estimatedTotalSeconds(item({ reason: "no estimate" }), 0)).toBeUndefined();
  });
});

describe("rowProgress", () => {
  it("marks waiting jobs as not started", () => {
    expect(rowProgress(item({ state: "waiting" }), 1000)).toEqual({ state: "waiting" });
  });
  it("computes a clamped running percentage from elapsed vs estimate", () => {
    // reason estimate 10m = 600s; elapsed 300s → 50%
    expect(rowProgress(item({ reason: "job ~10m", sinceMs: 0 }), 300_000)).toEqual({
      state: "running",
      pct: 50,
    });
  });
  it("clamps to 100 when elapsed exceeds the estimate", () => {
    expect(rowProgress(item({ reason: "job ~1m", sinceMs: 0 }), 300_000)).toEqual({
      state: "running",
      pct: 100,
    });
  });
  it("returns a null percentage for a running job with no estimate", () => {
    expect(rowProgress(item({ reason: "no estimate" }), 1000)).toEqual({
      state: "running",
      pct: null,
    });
  });
});

describe("elapsedSeconds", () => {
  it("never goes negative when the clock skews", () => {
    expect(elapsedSeconds(item({ sinceMs: 5000 }), 1000)).toBe(0);
  });
});

describe("resourceAccent", () => {
  it("accents an exactly-named pool", () => {
    expect(resourceAccent("gpu")).toEqual({
      badge: "bg-violet-400/15 text-violet-300",
      bar: "bg-violet-400",
    });
  });
  it("gives the split cpu pools the same accent as cpu itself", () => {
    const base = resourceAccent("cpu");
    expect(base.bar).toBe("bg-emerald-400");
    expect(resourceAccent("cpu_perf")).toEqual(base);
    expect(resourceAccent("cpu_eff")).toEqual(base);
  });
  it("accents every device pool alike", () => {
    expect(resourceAccent("dev_pixel10")).toEqual({
      badge: "bg-sky-400/15 text-sky-300",
      bar: "bg-sky-400",
    });
    expect(resourceAccent("dev_tab_a9")).toEqual(resourceAccent("dev_pixel10"));
  });
  it("matches a prefix only on an underscore boundary", () => {
    expect(resourceAccent("devops")).toEqual({
      badge: "bg-muted text-muted-foreground",
      bar: "bg-foreground",
    });
  });
  it("falls back to a neutral accent for an unknown pool", () => {
    expect(resourceAccent("quantum_annealer")).toEqual({
      badge: "bg-muted text-muted-foreground",
      bar: "bg-foreground",
    });
  });
});
