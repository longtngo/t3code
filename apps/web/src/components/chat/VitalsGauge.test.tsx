import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { ContextWindowSnapshot } from "~/lib/contextWindow";
import type { HostMetricsSample } from "~/lib/hostMetrics";
import type { AccountUsageView } from "~/lib/vitals";
import { FIVE_HOUR_MS } from "~/lib/vitals";
import { VitalsDetail, VitalsGauge, VitalsGaugeIcon } from "./VitalsGauge";

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
        accountUsage={{ fiveHour: null, sevenDay: null }}
        host={host}
        now={0}
      />,
    );
    expect(markup).not.toContain("Usage limits");
    expect(markup).toContain("Machine");
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
        }}
        host={{ sample, streaming: true, enabled: true, onToggle: () => {} }}
      />,
    );
    expect(markup).toContain('aria-label="Vitals — context 46%, 5-hour 88%, 7-day 41%, CPU 22%, GPU 44%, memory 50%"');
  });
});
