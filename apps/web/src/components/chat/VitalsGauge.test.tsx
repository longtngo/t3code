import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { ContextWindowSnapshot } from "~/lib/contextWindow";
import type { HostMetricsSample } from "~/lib/hostMetrics";
import type { AccountUsageView } from "~/lib/vitals";
import { FIVE_HOUR_MS, SEVERITY_STROKE, fullnessArc, vitalsLevel, windowArc } from "~/lib/vitals";
import {
  MachineDetailList,
  VitalsDetail,
  VitalsGauge,
  VitalsGaugeIcon,
  VITALS_GAUGE_TRIGGER_SIZE,
} from "./VitalsGauge";

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

const COMPACT_SENTENCE = "automatically compacts its context when needed";

const compactionHost = { sample, streaming: true, enabled: true, onToggle: () => {} };

function renderCompactionNote(overrides: Partial<ContextWindowSnapshot>): string {
  return renderToStaticMarkup(
    <VitalsDetail
      context={{ ...emptyContext, compactsAutomatically: true, ...overrides }}
      accountUsage={{
        fiveHour: null,
        sevenDay: null,
        extraUsage: null,
        fetchedAt: null,
        extraWindows: [],
        balances: [],
      }}
      host={compactionHost}
      now={0}
      timestampFormat="24-hour"
      providerDisplayName="Claude"
    />,
  );
}

describe("VitalsDetail auto-compaction note", () => {
  it("stays hidden when the provider resolved the window as auto", () => {
    // "auto" is exactly the case where Claude Code refuses to compact, so the
    // sentence would be a lie. The inverted case below is what proves this
    // assertion can fail - an absence check that never renders the string for
    // some unrelated reason would pass either way.
    expect(renderCompactionNote({ autoCompactSource: "auto" })).not.toContain(COMPACT_SENTENCE);
  });

  it("shows once the provider resolved a real window", () => {
    expect(renderCompactionNote({ autoCompactSource: "settings" })).toContain(COMPACT_SENTENCE);
  });

  it("shows for a provider that reports no source at all", () => {
    expect(renderCompactionNote({})).toContain(COMPACT_SENTENCE);
  });

  it("stays hidden when the provider does not auto-compact", () => {
    expect(
      renderToStaticMarkup(
        <VitalsDetail
          context={{ ...emptyContext, compactsAutomatically: false }}
          accountUsage={{
            fiveHour: null,
            sevenDay: null,
            extraUsage: null,
            fetchedAt: null,
            extraWindows: [],
            balances: [],
          }}
          host={compactionHost}
          now={0}
          timestampFormat="24-hour"
          providerDisplayName="Claude"
        />,
      ),
    ).not.toContain(COMPACT_SENTENCE);
  });
});

describe("VitalsGaugeIcon", () => {
  const NO_ARCS = {
    context: { pct: null, level: null },
    fiveHour: { pct: null, level: null },
    sevenDay: { pct: null, level: null },
    cpu: { pct: null, level: null },
    gpu: { pct: null, level: null },
    mem: { pct: null, level: null },
  } as const;

  it("renders a track for every ring half and a fill for each non-null metric", () => {
    const markup = renderToStaticMarkup(
      <VitalsGaugeIcon
        inputs={{
          context: fullnessArc(40),
          fiveHour: fullnessArc(60),
          sevenDay: fullnessArc(30),
          cpu: fullnessArc(22),
          gpu: fullnessArc(44),
          mem: fullnessArc(50),
        }}
      />,
    );
    // 6 halves × (track + fill) = 12 paths when every metric is present.
    expect(countPaths(markup)).toBe(12);
  });

  it("omits the fill path for a null metric (track only)", () => {
    const markup = renderToStaticMarkup(<VitalsGaugeIcon inputs={NO_ARCS} />);
    // 6 tracks, no fills.
    expect(countPaths(markup)).toBe(6);
  });

  it("colours an under-pace window by pace, matching the detail row, not by fullness", () => {
    // The reported mismatch: a 5-hour window 74% used but 22% UNDER pace reads
    // green in the detail panel, while colouring by fullness alone paints it
    // yellow (vitalsLevel(74) === "warn"). Only the 5-hour arc is populated so
    // the asserted stroke can only have come from it.
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    // 4% of the window's clock left => projection 96%; 74 − 96 = −22 => "ok".
    const resetsAt = new Date(now + FIVE_HOUR_MS * 0.04).toISOString();
    const arc = windowArc({ utilization: 74, resetsAt }, FIVE_HOUR_MS, now);

    expect(arc).toEqual({ pct: 74, level: "ok" });
    expect(vitalsLevel(74)).toBe("warn");

    const markup = renderToStaticMarkup(<VitalsGaugeIcon inputs={{ ...NO_ARCS, fiveHour: arc }} />);
    expect(markup).toContain(SEVERITY_STROKE.ok);
    expect(markup).not.toContain(SEVERITY_STROKE.warn);
  });

  it("buckets the rounded reading, so a fraction over a boundary is not yellow at 50%", () => {
    // The reported split: context at 50.4 renders "50%" in the panel — which
    // rounds first and calls it green — while the glyph bucketed 50.4 and
    // painted it yellow. Both must now read the same number.
    const arc = fullnessArc(50.4);

    expect(arc).toEqual({ pct: 50, level: "ok" });
    expect(vitalsLevel(50.4)).toBe("warn"); // what the glyph used to use

    const markup = renderToStaticMarkup(<VitalsGaugeIcon inputs={{ ...NO_ARCS, context: arc }} />);
    expect(markup).toContain(SEVERITY_STROKE.ok);
    expect(markup).not.toContain(SEVERITY_STROKE.warn);
  });

  it("still crosses a boundary once the rounded reading crosses it", () => {
    // Guard against "fix" by clamping: 50.6 rounds to 51, which is genuinely
    // past the ≤50 green bucket and must stay yellow.
    expect(fullnessArc(50.6)).toEqual({ pct: 51, level: "warn" });
  });

  it("still colours a window by fullness when there is no pace projection", () => {
    // No `resetsAt` => no projection => windowSeverity falls back to fullness,
    // so this path must keep behaving exactly as it did before.
    const arc = windowArc({ utilization: 74, resetsAt: null }, FIVE_HOUR_MS, Date.now());

    expect(arc).toEqual({ pct: 74, level: "warn" });

    const markup = renderToStaticMarkup(<VitalsGaugeIcon inputs={{ ...NO_ARCS, fiveHour: arc }} />);
    expect(markup).toContain(SEVERITY_STROKE.warn);
  });
});

describe("VitalsGauge detail", () => {
  const host = { sample, streaming: true, enabled: true, onToggle: () => {} };

  it("shows context tokens, both usage windows, and machine rows", () => {
    const accountUsage: AccountUsageView = {
      fiveHour: { utilization: 70, resetsAt: new Date(FIVE_HOUR_MS / 2).toISOString() },
      sevenDay: { utilization: 30, resetsAt: null },
      extraUsage: null,
      fetchedAt: null,
      extraWindows: [],
      balances: [],
    };
    const markup = renderToStaticMarkup(
      <VitalsDetail
        context={emptyContext}
        accountUsage={accountUsage}
        host={host}
        now={0}
        timestampFormat="24-hour"
      />,
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
        accountUsage={{
          fiveHour: null,
          sevenDay: null,
          extraUsage: null,
          fetchedAt: null,
          extraWindows: [],
          balances: [],
        }}
        host={host}
        now={0}
        timestampFormat="24-hour"
      />,
    );
    expect(markup).not.toContain("Usage limits");
    expect(markup).toContain("Machine");
  });

  it("renders Codex and Cursor provider windows as extra limit rows", () => {
    const accountUsage: AccountUsageView = {
      fiveHour: null,
      sevenDay: null,
      extraUsage: null,
      fetchedAt: null,
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
      <VitalsDetail
        context={emptyContext}
        accountUsage={accountUsage}
        host={host}
        now={0}
        timestampFormat="24-hour"
      />,
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
        timestampFormat="24-hour"
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
        timestampFormat="24-hour"
      />,
    );
    expect(markup).toContain("Metrics paused");
  });
});

describe("VitalsDetail usage refresh", () => {
  const usageWithLimits = {
    fiveHour: { utilization: 88, resetsAt: null },
    sevenDay: { utilization: 41, resetsAt: null },
    extraUsage: null,
    fetchedAt: null,
    extraWindows: [],
    balances: [],
  };

  it("offers a refresh control on the limits block when one is wired", () => {
    const markup = renderToStaticMarkup(
      <VitalsDetail
        context={emptyContext}
        accountUsage={usageWithLimits}
        host={{ sample: null, streaming: false, enabled: false, onToggle: () => {} }}
        now={0}
        timestampFormat="24-hour"
        refreshUsage={{ run: () => {}, pending: false }}
      />,
    );

    expect(markup).toContain('aria-label="Refresh usage from the provider"');
    expect(markup).not.toContain("animate-spin");
  });

  it("spins and refuses a second press while the refresh is in flight", () => {
    // The numbers arrive later as an activity, so the button is the only place
    // the request is visible at all. Without the disabled state a slow provider
    // reads as a dead control and invites repeat presses.
    const markup = renderToStaticMarkup(
      <VitalsDetail
        context={emptyContext}
        accountUsage={usageWithLimits}
        host={{ sample: null, streaming: false, enabled: false, onToggle: () => {} }}
        now={0}
        timestampFormat="24-hour"
        refreshUsage={{ run: () => {}, pending: true }}
      />,
    );

    expect(markup).toContain("animate-spin");
    expect(markup).toContain("disabled");
  });

  it("renders without the control when nothing is wired, so the detail stays pure", () => {
    const markup = renderToStaticMarkup(
      <VitalsDetail
        context={emptyContext}
        accountUsage={usageWithLimits}
        host={{ sample: null, streaming: false, enabled: false, onToggle: () => {} }}
        now={0}
        timestampFormat="24-hour"
      />,
    );

    expect(markup).toContain("Usage limits");
    expect(markup).not.toContain('aria-label="Refresh usage from the provider"');
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
          extraUsage: null,
          fetchedAt: null,
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

  it("draws the glyph at the full size of its button, with nothing insetting it", () => {
    const markup = renderToStaticMarkup(
      <VitalsGauge
        context={emptyContext}
        accountUsage={null}
        host={{ sample, streaming: true, enabled: true, onToggle: () => {} }}
      />,
    );

    // The button is `size-8`. The glyph used to be a 24px svg inside a `size-6`
    // wrapper inside a transparent border, so a quarter of the control was
    // padding. Asserted through the trigger rather than on the icon alone,
    // which would pass whatever size the trigger chose to hand it.
    expect(VITALS_GAUGE_TRIGGER_SIZE).toBe(32);
    expect(markup).toContain('width="32" height="32"');
    expect(markup).not.toContain("size-6");
    // The border counts as inset too: `box-sizing: border-box` means a 1px
    // border shrinks the content box to 30px around a 32px glyph, and asserting
    // only on the wrapper would not see that come back.
    expect(markup).not.toContain("border-transparent");
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
      <VitalsDetail
        context={emptyContext}
        accountUsage={null}
        host={detailedHost}
        now={0}
        timestampFormat="24-hour"
      />,
    );

    expect(markup).toContain("details");
    // Collapsed, so none of the values are in the markup yet.
    expect(markup).not.toContain("Apple M5 Max");
    expect(markup).not.toContain('aria-expanded="true"');
  });

  it("still renders the three summary bars alongside the toggle", () => {
    const markup = renderToStaticMarkup(
      <VitalsDetail
        context={emptyContext}
        accountUsage={null}
        host={detailedHost}
        now={0}
        timestampFormat="24-hour"
      />,
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
        timestampFormat="24-hour"
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

  it("draws one bar per core, labelled with its own utilization", () => {
    const markup = renderToStaticMarkup(<MachineDetailList sample={detailed} />);

    // The hover text moved into a Tooltip popup, which is portalled and only
    // mounts on hover — so the per-core value rides on the bar's accessible
    // name, which is where a screen reader could reach it anyway.
    expect(markup).toContain('aria-label="Core 0: 10%"');
    expect(markup).toContain('aria-label="Core 1: 90%"');
    expect(markup).toContain('aria-label="Core 2: 45%"');
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

describe("VitalsGauge window reset time", () => {
  const host = { sample, streaming: true, enabled: true, onToggle: () => {} };
  // Local-time constructor so the rendered clock is timezone-stable.
  const at = (h: number, m = 0) => new Date(2026, 7, 14, h, m, 0, 0);
  const now = at(12).getTime();

  it("shows when each window resets alongside the pace figures", () => {
    const accountUsage: AccountUsageView = {
      fiveHour: { utilization: 70, resetsAt: at(14, 20).toISOString() },
      sevenDay: { utilization: 30, resetsAt: null },
      extraUsage: null,
      fetchedAt: null,
      extraWindows: [],
      balances: [],
    };
    const markup = renderToStaticMarkup(
      <VitalsDetail
        context={emptyContext}
        accountUsage={accountUsage}
        host={host}
        now={now}
        timestampFormat="24-hour"
      />,
    );
    expect(markup).toContain("resets 14:20");
    // Pace is not replaced by the reset time — both are shown.
    expect(markup).toContain("% used");
    expect(markup).toContain("pace");
  });

  it("omits the reset text for a window with no reset clock", () => {
    const accountUsage: AccountUsageView = {
      fiveHour: null,
      sevenDay: { utilization: 30, resetsAt: null },
      extraUsage: null,
      fetchedAt: null,
      extraWindows: [],
      balances: [],
    };
    const markup = renderToStaticMarkup(
      <VitalsDetail
        context={emptyContext}
        accountUsage={accountUsage}
        host={host}
        now={now}
        timestampFormat="24-hour"
      />,
    );
    expect(markup).toContain("7-day");
    expect(markup).not.toContain("resets");
  });

  it("honours the 12-hour preference", () => {
    const accountUsage: AccountUsageView = {
      fiveHour: { utilization: 70, resetsAt: at(14, 20).toISOString() },
      sevenDay: null,
      extraUsage: null,
      fetchedAt: null,
      extraWindows: [],
      balances: [],
    };
    const markup = renderToStaticMarkup(
      <VitalsDetail
        context={emptyContext}
        accountUsage={accountUsage}
        host={host}
        now={now}
        timestampFormat="12-hour"
      />,
    );
    expect(markup).toMatch(/resets 2:20\s?PM/i);
    expect(markup).not.toContain("14:20");
  });

  it("keeps the footer a flex row so the reset text is pushed to the far edge", () => {
    // Guards the review finding: `justify-between` is silently inert on a
    // non-flex container, which would drop the reset text inline instead and
    // re-create the wrapping the predecessor panel was fixed for.
    const accountUsage: AccountUsageView = {
      fiveHour: { utilization: 70, resetsAt: at(14, 20).toISOString() },
      sevenDay: null,
      extraUsage: null,
      fetchedAt: null,
      extraWindows: [],
      balances: [],
    };
    const markup = renderToStaticMarkup(
      <VitalsDetail
        context={emptyContext}
        accountUsage={accountUsage}
        host={host}
        now={now}
        timestampFormat="24-hour"
      />,
    );
    const footer = markup.slice(markup.indexOf("% used") - 400, markup.indexOf("% used"));
    expect(footer).toContain("justify-between");
    expect(footer).toContain("flex");
    // flex-wrap is what keeps the worst-case width (dated reset + 12-hour clock,
    // ~265px against ~256px usable) falling to a second line rather than
    // overflowing the popover.
    expect(footer).toContain("flex-wrap");
    expect(markup).toContain("whitespace-nowrap");
  });

  it("shows a reset time for provider windows that have no pace at all", () => {
    // extraWindows carry windowMs: null, so they render no pace — the reset
    // time is the only timing signal they can show.
    const accountUsage: AccountUsageView = {
      fiveHour: null,
      sevenDay: null,
      extraUsage: null,
      fetchedAt: null,
      extraWindows: [
        {
          label: "weekly",
          utilization: 42,
          resetsAt: at(14, 20).toISOString(),
          windowMs: null,
        },
      ],
      balances: [],
    };
    const markup = renderToStaticMarkup(
      <VitalsDetail
        context={emptyContext}
        accountUsage={accountUsage}
        host={host}
        now={now}
        timestampFormat="24-hour"
      />,
    );
    expect(markup).toContain("weekly");
    expect(markup).toContain("resets 14:20");
  });
});

describe("VitalsGauge context model name", () => {
  const host = { sample, streaming: true, enabled: true, onToggle: () => {} };

  function render(options: { modelDisplayName?: string | null; maxTokens?: number | null }) {
    const context: ContextWindowSnapshot = {
      ...emptyContext,
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    };
    return renderToStaticMarkup(
      <VitalsDetail
        context={context}
        accountUsage={null}
        host={host}
        now={0}
        timestampFormat="24-hour"
        modelDisplayName={options.modelDisplayName ?? null}
      />,
    );
  }

  it("names the model the context window belongs to", () => {
    const markup = render({ modelDisplayName: "Opus 5" });
    expect(markup).toContain("Opus 5");
    expect(markup).toContain("200k window");
  });

  it("still names the model when the provider reports no window size", () => {
    // The case the model name matters MOST in, and the one a naive `hasMax`
    // gate silently drops: no window size to show, so the header would be empty.
    const markup = render({ modelDisplayName: "Opus 5", maxTokens: null });
    expect(markup).toContain("Opus 5");
    expect(markup).not.toContain("window");
  });

  it("degrades to the window size alone when the model is unknown", () => {
    const markup = render({ modelDisplayName: null });
    expect(markup).toContain("200k window");
    // No dangling separator when only one half is present.
    expect(markup).not.toContain("· 200k window");
  });

  it("shows neither half when there is no model and no window size", () => {
    const markup = render({ modelDisplayName: null, maxTokens: null });
    expect(markup).not.toContain("window");
    expect(markup).toContain("Context");
  });
});
