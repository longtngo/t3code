import { describe, expect, it } from "vite-plus/test";

import {
  DEFLATE_THRESHOLD_BYTES,
  HOST_METRICS_INTERVAL_SECONDS,
  LLM_MODELS_INTERVAL_SECONDS,
  agenticTurnBudgetBytes,
  attachmentUploadFrame,
  computeBudgetReport,
  idleBackgroundedBudgetBytes,
  jsonBytes,
  measureFrame,
  reconnectBudgetBytes,
  threadSnapshotFrame,
} from "./wireBudget.ts";

describe("measureFrame", () => {
  it("reports raw JSON size for small frames without deflating", () => {
    const sizes = measureFrame({ a: 1 });
    expect(sizes.json).toBe(jsonBytes({ a: 1 }));
    // Below the threshold, the wire size is the raw JSON size (no deflate applied).
    expect(sizes.jsonDeflated).toBe(sizes.json);
    expect(sizes.json).toBeLessThan(DEFLATE_THRESHOLD_BYTES);
  });

  it("deflates large frames below their raw size", () => {
    const sizes = measureFrame(threadSnapshotFrame);
    expect(sizes.json).toBeGreaterThan(DEFLATE_THRESHOLD_BYTES);
    expect(sizes.jsonDeflated).toBeLessThan(sizes.json);
  });
});

describe("scenario budgets", () => {
  it("reconnect budget is N full snapshots", () => {
    expect(reconnectBudgetBytes(10, 500)).toBe(5000);
    expect(reconnectBudgetBytes(0, 500)).toBe(0);
  });

  it("idle budget sums both streams over the window", () => {
    const seconds = 600;
    const hostFrames = Math.floor(seconds / HOST_METRICS_INTERVAL_SECONDS);
    const llmFrames = Math.floor(seconds / LLM_MODELS_INTERVAL_SECONDS);
    expect(idleBackgroundedBudgetBytes(seconds, 100, 200)).toBe(
      hostFrames * 100 + llmFrames * 200,
    );
  });

  it("agentic-turn budget is K activity frames plus the message", () => {
    expect(agenticTurnBudgetBytes(12, 300, 2000)).toBe(12 * 300 + 2000);
  });
});

describe("attachmentUploadFrame", () => {
  it("carries a base64 payload larger than the raw bytes (base64 inflation)", () => {
    const frame = attachmentUploadFrame(1024);
    // base64 is ~4/3 the raw size.
    expect(frame.dataBase64.length).toBeGreaterThan(1024);
    expect(jsonBytes(frame)).toBeGreaterThan(1024);
  });
});

describe("computeBudgetReport", () => {
  it("produces frame and scenario rows with positive, deflate-improving budgets", () => {
    const report = computeBudgetReport();
    expect(report.frames.length).toBeGreaterThan(0);
    expect(report.scenarios.length).toBe(3);

    for (const frame of report.frames) {
      expect(frame.sizes.json).toBeGreaterThan(0);
      expect(frame.sizes.jsonDeflated).toBeLessThanOrEqual(frame.sizes.json);
      // The actual Phase 1 wire format must beat the raw JSON baseline.
      expect(frame.sizes.msgpackDeflated).toBeLessThan(frame.sizes.json);
    }
    for (const scenario of report.scenarios) {
      expect(scenario.json).toBeGreaterThan(0);
      expect(scenario.jsonDeflated).toBeLessThanOrEqual(scenario.json);
      expect(scenario.msgpackDeflated).toBeLessThan(scenario.json);
    }
  });

  it("measures the real Phase 1 wire frame (framed msgpack+deflate) below the JSON baseline", () => {
    const report = computeBudgetReport();
    const snapshot = report.frames.find((frame) =>
      frame.name.includes("thread snapshot"),
    );
    // The large snapshot is the reconnect cost; msgpack+deflate should shrink it dramatically.
    expect(snapshot).toBeDefined();
    expect(snapshot!.sizes.msgpackDeflated).toBeLessThan(snapshot!.sizes.json / 2);
  });

  it("keeps the default cadence constants in sync with the server defaults", () => {
    // These mirror ws.ts subscribeHostMetrics/subscribeLlmModels defaults; a drift
    // here means the idle budget no longer models reality.
    expect(HOST_METRICS_INTERVAL_SECONDS).toBe(1.5);
    expect(LLM_MODELS_INTERVAL_SECONDS).toBe(4);
  });
});
