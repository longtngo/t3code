import { describe, expect, it, vi } from "vite-plus/test";

import type { HostMetricsSample } from "~/lib/hostMetrics";
import { renderDom } from "../../testing/renderDom";
import { MachineDetailList, MachineUsage } from "./MachineUsage";

const base: HostMetricsSample = {
  ts: 1_000_000,
  cpu: { pct: 6, perCore: [], loadAvg: [] },
  mem: { usedBytes: 1_000, totalBytes: 2_000, pct: 19 },
  gpu: null,
};

describe("MachineUsage", () => {
  it("renders CPU, GPU and MEM rows with GPU null as a dash", async () => {
    const view = await renderDom(<MachineUsage sample={base} />);
    const text = view.text();
    expect(text).toContain("CPU");
    expect(text).toContain("6%");
    expect(text).toContain("MEM");
    expect(text).toContain("19%");
    const gpuRow = [...view.findAll("span")].find((el) => el.textContent === "GPU")?.parentElement;
    expect(gpuRow).toBeDefined();
    const gpuValue = gpuRow?.lastElementChild;
    expect(gpuValue?.textContent).toBe("-");
    expect(text).not.toContain("DISK");
  });

  it("renders one DISK row per mount, including a mount with a space", async () => {
    const view = await renderDom(
      <MachineUsage
        sample={{
          ...base,
          disks: [
            { mount: "/", usedBytes: 1, totalBytes: 2, pct: 94, readAt: base.ts },
            { mount: "/mnt/My Disk", usedBytes: 1, totalBytes: 2, pct: 40, readAt: base.ts },
          ],
        }}
      />,
    );
    const text = view.text();
    const labels = view.findAll("span[title]");
    // The whole label is the text, so it needs no aria-label (which a generic span cannot carry).
    expect(labels.map((el) => el.textContent)).toEqual(["DISK /", "DISK /mnt/My Disk"]);
    expect(labels.map((el) => el.getAttribute("title"))).toEqual(["/", "/mnt/My Disk"]);
    expect(view.findAll("span[aria-label]")).toEqual([]);
    expect(text).toContain("94%");
    expect(text).toContain("40%");
    expect(view.find('[title="stale"]')).toBeNull();
  });

  it("two disks that share a label are two rows without a key clash", async () => {
    // The server drops control characters from labels, so two real paths can share one.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const view = await renderDom(
        <MachineUsage
          sample={{
            ...base,
            disks: [
              { mount: "/mnt/a", usedBytes: 1, totalBytes: 2, pct: 10, readAt: base.ts },
              { mount: "/mnt/a", usedBytes: 1, totalBytes: 2, pct: 70, readAt: base.ts },
            ],
          }}
        />,
      );
      expect(view.findAll("span[title='/mnt/a']")).toHaveLength(2);
      expect(errors.mock.calls.flat().join(" ")).not.toContain("same key");
    } finally {
      errors.mockRestore();
    }
  });

  it("dims a disk read more than 60 s before the sample, not one at exactly 60 s", async () => {
    const view = await renderDom(
      <MachineUsage
        sample={{
          ...base,
          disks: [
            { mount: "/old", usedBytes: 1, totalBytes: 2, pct: 50, readAt: base.ts - 61_000 },
            { mount: "/edge", usedBytes: 1, totalBytes: 2, pct: 50, readAt: base.ts - 60_000 },
          ],
        }}
      />,
    );
    const stale = view.findAll('[title="stale"]');
    expect(stale).toHaveLength(1);
    expect(stale[0]?.textContent).toContain("/old");
    expect(stale[0]?.className).toContain("opacity-50");
    expect(view.findAll(".opacity-50")).toHaveLength(1);
  });

  it("renders no DISK row for an empty disks list", async () => {
    const view = await renderDom(<MachineUsage sample={{ ...base, disks: [] }} />);
    expect(view.text()).not.toContain("DISK");
  });
});

describe("MachineDetailList", () => {
  const detailed: HostMetricsSample = {
    ts: 0,
    cpu: { pct: 22, perCore: [10, 90, 45], loadAvg: [1.5, 2.25, 0.75] },
    mem: { usedBytes: 8_000_000_000, totalBytes: 16_000_000_000, pct: 50 },
    gpu: { pct: 44, name: "Apple M5 Max", vramUsedBytes: 3_000_000_000 },
    host: { platform: "darwin", arch: "arm64", cores: 3 },
  };

  it("restores the detail the three summary bars leave out", async () => {
    const view = await renderDom(<MachineDetailList sample={detailed} />);
    const text = view.text();

    expect(text).toContain("1.50  2.25  0.75");
    expect(text).toContain("Apple M5 Max");
    expect(text).toContain("darwin arm64");
    // Bytes, not just the percentage the summary bar already shows.
    expect(text).toContain("8 GB of 16 GB");
    expect(text).toContain("3 GB");
  });

  it("draws one bar per core, labelled with its own utilization", async () => {
    const view = await renderDom(<MachineDetailList sample={detailed} />);

    // The hover text moved into a Tooltip popup, which is portalled and only
    // mounts on hover — so the per-core value rides on the bar's accessible
    // name, which is where a screen reader could reach it anyway.
    expect(view.find('[aria-label="Core 0: 10%"]')?.getAttribute("role")).toBe("img");
    expect(view.find('[aria-label="Core 1: 90%"]')).not.toBeNull();
    expect(view.find('[aria-label="Core 2: 45%"]')).not.toBeNull();
  });

  it("omits every row the host does not report rather than showing an empty one", async () => {
    const bare: HostMetricsSample = {
      ts: 0,
      cpu: { pct: 22, perCore: [], loadAvg: [] },
      mem: { usedBytes: 1_000, totalBytes: 2_000, pct: 50 },
      gpu: null,
    };
    const view = await renderDom(<MachineDetailList sample={bare} />);
    const text = view.text();

    expect(text).not.toContain("Load");
    expect(text).not.toContain("GPU");
    expect(text).not.toContain("VRAM");
    expect(text).not.toContain("Host");
    // Memory always reports, so it is always shown.
    expect(text).toContain("Memory");
  });
});
