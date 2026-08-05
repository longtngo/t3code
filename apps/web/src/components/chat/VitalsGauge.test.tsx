import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { ContextWindowSnapshot } from "~/lib/contextWindow";
import type { HostMetricsSample } from "~/lib/hostMetrics";
import type { AccountUsageView } from "~/lib/vitals";
import { FIVE_HOUR_MS } from "~/lib/vitals";
import { MachineDetailList, VitalsDetail, VitalsGauge, VitalsGaugeIcon } from "./VitalsGauge";

function countPaths(markup: string): number {
  return markup.split("<path").length - 1;
}

const emptyContext: ContextWindowSnapshot = {
  usedTokens: 92_000,
  totalProcessedTokens: null,
  maxTokens: 200_000,
  remainingTokens: 108_000,
  usedPercentage: 46,
  remainingPercentage: 54,
  inputTokens: null,
  cachedInputTokens: null,
  outputTokens: null,
  reasoningOutputTokens: null,
  lastUsedTokens: null,
  lastInputTokens: null,
  lastCachedInputTokens: null,
  lastOutputTokens: null,
  lastReasoningOutputTokens: null,
  toolUses: null,
  durationMs: null,
  compactsAutomatically: false,
  updatedAt: "2026-07-27T00:00:00.000Z",
};

const sample: HostMetricsSample = {
  ts: 0,
  cpu: { pct: 22, perCore: [], loadAvg: [] },
  mem: { usedBytes: 8_000_000_000, totalBytes: 16_000_000_000, pct: 50 },
  gpu: { pct: 44 },
};

describe("VitalsGaugeIcon", () => {
  it("renders a track for every ring half and a fill for each non-null metric", () => {
    const markup = renderToStaticMarkup(
      <VitalsGaugeIcon
        inputs={{ context: 40, fiveHour: 60, sevenDay: 30, cpu: 22, gpu: 44, mem: 50 }}
      />,
    );
    // 6 halves × (track + fill) = 12 paths when every metric is present.
    expect(countPaths(markup)).toBe(12);
  });

  it("omits the fill path for a null metric (track only)", () => {
    const markup = renderToStaticMarkup(
      <VitalsGaugeIcon
        inputs={{ context: null, fiveHour: null, sevenDay: null, cpu: null, gpu: null, mem: null }}
      />,
    );
    // 6 tracks, no fills.
    expect(countPaths(markup)).toBe(6);
  });
});

describe("VitalsGauge detail", () => {
  const host = { sample, streaming: true, enabled: true, onToggle: () => {} };

  it("shows context tokens, both usage windows, and machine rows", () => {
    const accountUsage: AccountUsageView = {
      fiveHour: { utilization: 70, resetsAt: new Date(FIVE_HOUR_MS / 2).toISOString() },
      sevenDay: { utilization: 30, resetsAt: null },
      extraWindows: [],
      balances: [],
    };
    const markup = renderToStaticMarkup(
      <VitalsDetail context={emptyContext} accountUsage={accountUsage} host={host} now={0} />,
    );
    expect(markup).toContain("Context");
    expect(markup).toContain("92k / 200k");
    expect(markup).toContain("Usage limits");
    expect(markup).toContain("5-hour");
    expect(markup).toContain("7-day");
    // 5h: usage 70 vs 50% projection → +20 over pace.
    expect(markup).toContain("+20% over pace");
    // 7d has no resetsAt → no projection → plain usage, no pace label.
    expect(markup).toContain("30% used");
    expect(markup).toContain("Machine");
    expect(markup).toContain("CPU");
    expect(markup).toContain("GPU");
    expect(markup).toContain("MEM");
  });

  it("omits the usage-limits block when no windows are present", () => {
    const markup = renderToStaticMarkup(
      <VitalsDetail
        context={emptyContext}
        accountUsage={{ fiveHour: null, sevenDay: null, extraWindows: [], balances: [] }}
        host={host}
        now={0}
      />,
    );
    expect(markup).not.toContain("Usage limits");
    expect(markup).toContain("Machine");
  });

  it("renders Codex and Cursor provider windows as extra limit rows", () => {
    const accountUsage: AccountUsageView = {
      fiveHour: null,
      sevenDay: null,
      extraWindows: [
        {
          label: "Codex 5h",
          utilization: 60,
          resetsAt: new Date(FIVE_HOUR_MS / 2).toISOString(),
          windowMs: FIVE_HOUR_MS,
        },
        { label: "Cursor auto", utilization: 25, resetsAt: null, windowMs: null },
      ],
      balances: [],
    };
    const markup = renderToStaticMarkup(
      <VitalsDetail context={emptyContext} accountUsage={accountUsage} host={host} now={0} />,
    );
    expect(markup).toContain("Usage limits");
    expect(markup).toContain("Codex 5h");
    // Codex window has a duration + resetsAt → pace projection (60 vs 50%).
    expect(markup).toContain("+10% over pace");
    expect(markup).toContain("Cursor auto");
    // Cursor has no fixed window → utilization only, no pace label.
    expect(markup).toContain("25% used");
  });

  it("shows a connecting state when host metrics are enabled but absent", () => {
    const markup = renderToStaticMarkup(
      <VitalsDetail
        context={emptyContext}
        accountUsage={null}
        host={{ sample: null, streaming: false, enabled: true, onToggle: () => {} }}
        now={0}
      />,
    );
    expect(markup).toContain("Connecting to host");
  });

  it("shows a paused state when host metrics are disabled", () => {
    const markup = renderToStaticMarkup(
      <VitalsDetail
        context={emptyContext}
        accountUsage={null}
        host={{ sample: null, streaming: false, enabled: false, onToggle: () => {} }}
        now={0}
      />,
    );
    expect(markup).toContain("Metrics paused");
  });
});

describe("VitalsGauge trigger", () => {
  it("names every present metric in the button aria-label, including usage windows", () => {
    const markup = renderToStaticMarkup(
      <VitalsGauge
        context={emptyContext}
        accountUsage={{
          fiveHour: { utilization: 88, resetsAt: null },
          sevenDay: { utilization: 41, resetsAt: null },
          extraWindows: [],
          balances: [],
        }}
        host={{ sample, streaming: true, enabled: true, onToggle: () => {} }}
      />,
    );
    expect(markup).toContain(
      'aria-label="Vitals — context 46%, 5-hour 88%, 7-day 41%, CPU 22%, GPU 44%, memory 50%"',
    );
  });
});

describe("machine details", () => {
  const detailedSample: HostMetricsSample = {
    ts: 0,
    cpu: { pct: 22, perCore: [10, 90, 45], loadAvg: [1.5, 2.25, 0.75] },
    mem: { usedBytes: 8_000_000_000, totalBytes: 16_000_000_000, pct: 50 },
    gpu: { pct: 44, name: "Apple M5 Max", vramUsedBytes: 3_000_000_000 },
    host: { platform: "darwin", arch: "arm64", cores: 3 },
  };
  const detailedHost = {
    sample: detailedSample,
    streaming: true,
    enabled: true,
    onToggle: () => {},
  };

  it("keeps the detail collapsed so the summary bars stay the answer", () => {
    const markup = renderToStaticMarkup(
      <VitalsDetail context={emptyContext} accountUsage={null} host={detailedHost} now={0} />,
    );

    expect(markup).toContain("details");
    // Collapsed, so none of the values are in the markup yet.
    expect(markup).not.toContain("Apple M5 Max");
    expect(markup).not.toContain('aria-expanded="true"');
  });

  it("still renders the three summary bars alongside the toggle", () => {
    const markup = renderToStaticMarkup(
      <VitalsDetail context={emptyContext} accountUsage={null} host={detailedHost} now={0} />,
    );

    expect(markup).toContain("CPU");
    expect(markup).toContain("GPU");
    expect(markup).toContain("MEM");
  });

  it("offers no detail toggle before a sample arrives", () => {
    const markup = renderToStaticMarkup(
      <VitalsDetail
        context={emptyContext}
        accountUsage={null}
        host={{ sample: null, streaming: false, enabled: true, onToggle: () => {} }}
        now={0}
      />,
    );

    expect(markup).toContain("Connecting to host…");
    expect(markup).not.toContain("details");
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

  it("restores the detail the three summary bars leave out", () => {
    const markup = renderToStaticMarkup(<MachineDetailList sample={detailed} />);

    expect(markup).toContain("1.50  2.25  0.75");
    expect(markup).toContain("Apple M5 Max");
    expect(markup).toContain("darwin arm64");
    // Bytes, not just the percentage the summary bar already shows.
    expect(markup).toContain("8 GB of 16 GB");
    expect(markup).toContain("3 GB");
  });

  it("draws one bar per core, titled with its own utilization", () => {
    const markup = renderToStaticMarkup(<MachineDetailList sample={detailed} />);

    expect(markup).toContain('title="Core 0: 10%"');
    expect(markup).toContain('title="Core 1: 90%"');
    expect(markup).toContain('title="Core 2: 45%"');
  });

  it("omits every row the host does not report rather than showing an empty one", () => {
    const bare: HostMetricsSample = {
      ts: 0,
      cpu: { pct: 22, perCore: [], loadAvg: [] },
      mem: { usedBytes: 1_000, totalBytes: 2_000, pct: 50 },
      gpu: null,
    };
    const markup = renderToStaticMarkup(<MachineDetailList sample={bare} />);

    expect(markup).not.toContain("Load");
    expect(markup).not.toContain("GPU");
    expect(markup).not.toContain("VRAM");
    expect(markup).not.toContain("Host");
    // Memory always reports, so it is always shown.
    expect(markup).toContain("Memory");
  });
});
