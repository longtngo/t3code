import { assert, describe, it } from "vite-plus/test";
import { formatBytes, metricLevel } from "./hostMetrics";

describe("formatBytes", () => {
  it("formats base-1000 units", () => {
    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(1500), "1.5 KB");
    assert.equal(formatBytes(2_000_000), "2 MB");
    assert.equal(formatBytes(137_400_000_000), "137.4 GB");
  });

  it("rounds large mantissas to whole numbers", () => {
    assert.equal(formatBytes(137_400_000_000_000), "137.4 TB");
    assert.equal(formatBytes(250_000_000), "250 MB");
  });

  it("guards against non-finite and negative input", () => {
    assert.equal(formatBytes(-1), "0 B");
    assert.equal(formatBytes(Number.NaN), "0 B");
  });
});

describe("metricLevel", () => {
  it("maps utilization to severity thresholds", () => {
    assert.equal(metricLevel(10), "green");
    assert.equal(metricLevel(55), "yellow");
    assert.equal(metricLevel(75), "orange");
    assert.equal(metricLevel(95), "red");
  });
});
