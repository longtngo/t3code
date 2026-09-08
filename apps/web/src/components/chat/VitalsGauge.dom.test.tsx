import { describe, expect, it, vi } from "vite-plus/test";

import type { ContextWindowSnapshot } from "~/lib/contextWindow";
import type { HostMetricsSample } from "~/lib/hostMetrics";
import type { AccountUsageView } from "~/lib/vitals";
import { FIVE_HOUR_MS, SEVERITY_STROKE, fullnessArc, vitalsLevel, windowArc } from "~/lib/vitals";
import { renderDom } from "../../testing/renderDom";
import {
  MachineDetailList,
  VitalsDetail,
  VitalsGauge,
  VitalsGaugeIcon,
  VITALS_GAUGE_TRIGGER_SIZE,
} from "./VitalsGauge";

type View = Awaited<ReturnType<typeof renderDom>>;

/** Every arc's stroke colour, which is where severity shows up in the glyph. */
function strokes(view: View): Array<string | null> {
  return view.findAll("path").map((path) => path.getAttribute("stroke"));
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

function renderCompactionNote(overrides: Partial<ContextWindowSnapshot>) {
  return renderDom(
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
  it("stays hidden when the provider resolved the window as auto", async () => {
    // "auto" is exactly the case where Claude Code refuses to compact, so the
    // sentence would be a lie. The inverted case below is what proves this
    // assertion can fail - an absence check that never renders the string for
    // some unrelated reason would pass either way.
    const view = await renderCompactionNote({ autoCompactSource: "auto" });
    expect(view.text()).not.toContain(COMPACT_SENTENCE);
  });

  it("shows once the provider resolved a real window", async () => {
    const view = await renderCompactionNote({ autoCompactSource: "settings" });
    expect(view.text()).toContain(COMPACT_SENTENCE);
  });

  it("shows for a provider that reports no source at all", async () => {
    const view = await renderCompactionNote({});
    expect(view.text()).toContain(COMPACT_SENTENCE);
  });

  it("stays hidden when the provider does not auto-compact", async () => {
    const view = await renderDom(
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
    );
    expect(view.text()).not.toContain(COMPACT_SENTENCE);
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

  it("renders a track for every ring half and a fill for each non-null metric", async () => {
    const view = await renderDom(
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
    expect(view.findAll("path")).toHaveLength(12);
  });

  it("omits the fill path for a null metric (track only)", async () => {
    const view = await renderDom(<VitalsGaugeIcon inputs={NO_ARCS} />);
    // 6 tracks, no fills.
    expect(view.findAll("path")).toHaveLength(6);
  });

  it("colours an under-pace window by pace, matching the detail row, not by fullness", async () => {
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

    const view = await renderDom(<VitalsGaugeIcon inputs={{ ...NO_ARCS, fiveHour: arc }} />);
    expect(strokes(view)).toContain(SEVERITY_STROKE.ok);
    expect(strokes(view)).not.toContain(SEVERITY_STROKE.warn);
  });

  it("buckets the rounded reading, so a fraction over a boundary is not yellow at 50%", async () => {
    // The reported split: context at 50.4 renders "50%" in the panel — which
    // rounds first and calls it green — while the glyph bucketed 50.4 and
    // painted it yellow. Both must now read the same number.
    const arc = fullnessArc(50.4);

    expect(arc).toEqual({ pct: 50, level: "ok" });
    expect(vitalsLevel(50.4)).toBe("warn"); // what the glyph used to use

    const view = await renderDom(<VitalsGaugeIcon inputs={{ ...NO_ARCS, context: arc }} />);
    expect(strokes(view)).toContain(SEVERITY_STROKE.ok);
    expect(strokes(view)).not.toContain(SEVERITY_STROKE.warn);
  });

  it("still crosses a boundary once the rounded reading crosses it", () => {
    // Guard against "fix" by clamping: 50.6 rounds to 51, which is genuinely
    // past the ≤50 green bucket and must stay yellow.
    expect(fullnessArc(50.6)).toEqual({ pct: 51, level: "warn" });
  });

  it("still colours a window by fullness when there is no pace projection", async () => {
    // No `resetsAt` => no projection => windowSeverity falls back to fullness,
    // so this path must keep behaving exactly as it did before.
    const arc = windowArc({ utilization: 74, resetsAt: null }, FIVE_HOUR_MS, Date.now());

    expect(arc).toEqual({ pct: 74, level: "warn" });

    const view = await renderDom(<VitalsGaugeIcon inputs={{ ...NO_ARCS, fiveHour: arc }} />);
    expect(strokes(view)).toContain(SEVERITY_STROKE.warn);
  });
});

describe("VitalsGauge detail", () => {
  const host = { sample, streaming: true, enabled: true, onToggle: () => {} };

  it("shows context tokens, both usage windows, and machine rows", async () => {
    const accountUsage: AccountUsageView = {
      fiveHour: { utilization: 70, resetsAt: new Date(FIVE_HOUR_MS / 2).toISOString() },
      sevenDay: { utilization: 30, resetsAt: null },
      extraUsage: null,
      fetchedAt: null,
      extraWindows: [],
      balances: [],
    };
    const view = await renderDom(
      <VitalsDetail
        context={emptyContext}
        accountUsage={accountUsage}
        host={host}
        now={0}
        timestampFormat="24-hour"
      />,
    );
    const text = view.text();
    expect(text).toContain("Context");
    expect(text).toContain("92k / 200k");
    expect(text).toContain("Usage limits");
    expect(text).toContain("5-hour");
    expect(text).toContain("7-day");
    // 5h: usage 70 vs 50% projection → +20 over pace.
    expect(text).toContain("+20% over pace");
    // 7d has no resetsAt → no projection → plain usage, no pace label.
    expect(text).toContain("30% used");
    expect(text).toContain("Machine");
    expect(text).toContain("CPU");
    expect(text).toContain("GPU");
    expect(text).toContain("MEM");
  });

  // On a phone or a second laptop these are the server's numbers, not the
  // reader's, and until now nothing on the panel said whose they were.
  it("names the environment the machine numbers come from", async () => {
    const view = await renderDom(
      <VitalsDetail
        context={null}
        accountUsage={null}
        host={host}
        now={0}
        timestampFormat="24-hour"
        machineName="studio-mini"
      />,
    );
    expect(view.text()).toContain("studio-mini");
  });

  it("renders nothing at all beside the caption when the environment has no name", async () => {
    const view = await renderDom(
      <VitalsDetail
        context={null}
        accountUsage={null}
        host={host}
        now={0}
        timestampFormat="24-hour"
      />,
    );
    const text = view.text();
    expect(text).toContain("CPU");
    // The caption runs straight into the live/paused toggle. Asserting only
    // `not.toContain("undefined")` was close to vacuous — React renders nothing
    // for an undefined child, so only an explicit String()/template coercion
    // could ever have tripped it. This pins the whole slot instead, so a
    // placeholder like "unknown" or a stray separator fails too.
    expect(text).toContain("Machinelive");
  });

  it("explains a missing context block when the session's provider never reports usage", async () => {
    // Silently omitting it is what got this popover reported as broken. Cursor
    // reports no token usage at all over ACP - a raw ACP client against
    // cursor-agent 2026.08.25 saw no `usage_update` and a prompt result with no
    // `usage` member - so the absence is permanent and worth naming.
    const view = await renderDom(
      <VitalsDetail
        context={null}
        accountUsage={null}
        host={host}
        now={0}
        timestampFormat="24-hour"
        sessionProvider="cursor"
      />,
    );
    expect(view.text()).toContain("Cursor does not report context usage.");
  });

  it("stays silent for a provider that does report usage but has no snapshot yet", async () => {
    // "No snapshot" and "provider never reports" are different states, and the
    // database holds started Claude threads with zero context activities. A
    // gate keyed on absence alone would tell those users something false.
    const view = await renderDom(
      <VitalsDetail
        context={null}
        accountUsage={null}
        host={host}
        now={0}
        timestampFormat="24-hour"
        sessionProvider="claudeAgent"
      />,
    );
    expect(view.text()).not.toContain("does not report context usage");
  });

  it("does not blame the picker's provider for a thread that ran on another one", async () => {
    // The gate is the SESSION's provider. Passing the model picker's selection
    // instead would put "Cursor does not report context usage" on a thread
    // that ran its whole life on Claude and merely has the picker parked
    // elsewhere - the picker moves without the thread following it.
    const view = await renderDom(
      <VitalsDetail
        context={emptyContext}
        accountUsage={null}
        host={host}
        now={0}
        timestampFormat="24-hour"
        sessionProvider="cursor"
      />,
    );
    expect(view.text()).not.toContain("does not report context usage");
    expect(view.text()).toContain("Context");
  });

  it("omits the usage-limits block when no windows are present", async () => {
    const view = await renderDom(
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
    expect(view.text()).not.toContain("Usage limits");
    expect(view.text()).toContain("Machine");
  });

  it("renders Codex and Cursor provider windows as extra limit rows", async () => {
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
    const view = await renderDom(
      <VitalsDetail
        context={emptyContext}
        accountUsage={accountUsage}
        host={host}
        now={0}
        timestampFormat="24-hour"
      />,
    );
    const text = view.text();
    expect(text).toContain("Usage limits");
    expect(text).toContain("Codex 5h");
    // Codex window has a duration + resetsAt → pace projection (60 vs 50%).
    expect(text).toContain("+10% over pace");
    expect(text).toContain("Cursor auto");
    // Cursor has no fixed window → utilization only, no pace label.
    expect(text).toContain("25% used");
  });

  it("shows a connecting state when host metrics are enabled but absent", async () => {
    const view = await renderDom(
      <VitalsDetail
        context={emptyContext}
        accountUsage={null}
        host={{ sample: null, streaming: false, enabled: true, onToggle: () => {} }}
        now={0}
        timestampFormat="24-hour"
      />,
    );
    expect(view.text()).toContain("Connecting to host");
  });

  it("shows a paused state when host metrics are disabled", async () => {
    const view = await renderDom(
      <VitalsDetail
        context={emptyContext}
        accountUsage={null}
        host={{ sample: null, streaming: false, enabled: false, onToggle: () => {} }}
        now={0}
        timestampFormat="24-hour"
      />,
    );
    expect(view.text()).toContain("Metrics paused");
  });

  // The live/paused control was only ever rendered, never pressed, so nothing proved it was
  // wired to `host.onToggle` — or that it asks for the opposite of the current state.
  it("asks its owner to pause host metrics while they are live", async () => {
    const onToggle = vi.fn();
    const view = await renderDom(
      <VitalsDetail
        context={emptyContext}
        accountUsage={null}
        host={{ sample, streaming: true, enabled: true, onToggle }}
        now={0}
        timestampFormat="24-hour"
      />,
    );

    await view.click(view.find('[aria-label="Pause host metrics"]'));

    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it("asks its owner to resume host metrics while they are paused", async () => {
    const onToggle = vi.fn();
    const view = await renderDom(
      <VitalsDetail
        context={emptyContext}
        accountUsage={null}
        host={{ sample: null, streaming: false, enabled: false, onToggle }}
        now={0}
        timestampFormat="24-hour"
      />,
    );

    await view.click(view.find('[aria-label="Resume host metrics"]'));

    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith(true);
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

  const REFRESH_LABEL = '[aria-label="Refresh usage from the provider"]';

  it("offers a refresh control on the limits block when one is wired", async () => {
    const view = await renderDom(
      <VitalsDetail
        context={emptyContext}
        accountUsage={usageWithLimits}
        host={{ sample: null, streaming: false, enabled: false, onToggle: () => {} }}
        now={0}
        timestampFormat="24-hour"
        refreshUsage={{ run: () => {}, pending: false }}
      />,
    );

    expect(view.find(REFRESH_LABEL)).not.toBeNull();
    expect(view.find(".animate-spin")).toBeNull();
  });

  it("refetches from the provider when the control is pressed", async () => {
    const run = vi.fn();
    const view = await renderDom(
      <VitalsDetail
        context={emptyContext}
        accountUsage={usageWithLimits}
        host={{ sample: null, streaming: false, enabled: false, onToggle: () => {} }}
        now={0}
        timestampFormat="24-hour"
        refreshUsage={{ run, pending: false }}
      />,
    );

    await view.click(view.find(REFRESH_LABEL));

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("spins and refuses a second press while the refresh is in flight", async () => {
    // The numbers arrive later as an activity, so the button is the only place
    // the request is visible at all. Without the disabled state a slow provider
    // reads as a dead control and invites repeat presses.
    const run = vi.fn();
    const view = await renderDom(
      <VitalsDetail
        context={emptyContext}
        accountUsage={usageWithLimits}
        host={{ sample: null, streaming: false, enabled: false, onToggle: () => {} }}
        now={0}
        timestampFormat="24-hour"
        refreshUsage={{ run, pending: true }}
      />,
    );

    expect(view.find(".animate-spin")).not.toBeNull();
    const button = view.find<HTMLButtonElement>(REFRESH_LABEL);
    expect(button?.disabled).toBe(true);
    // The refusal is what the disabled attribute is for, so press it and check.
    await view.click(button);
    expect(run).not.toHaveBeenCalled();
  });

  it("renders without the control when nothing is wired, so the detail stays pure", async () => {
    const view = await renderDom(
      <VitalsDetail
        context={emptyContext}
        accountUsage={usageWithLimits}
        host={{ sample: null, streaming: false, enabled: false, onToggle: () => {} }}
        now={0}
        timestampFormat="24-hour"
      />,
    );

    expect(view.text()).toContain("Usage limits");
    expect(view.find(REFRESH_LABEL)).toBeNull();
  });
});

describe("VitalsGauge trigger", () => {
  it("names every present metric in the button aria-label, including usage windows", async () => {
    const view = await renderDom(
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
    expect(view.find("button")?.getAttribute("aria-label")).toBe(
      "Vitals — context 46%, 5-hour 88%, 7-day 41%, CPU 22%, GPU 44%, memory 50%",
    );
  });

  it("draws the glyph at the full size of its button, with nothing insetting it", async () => {
    const view = await renderDom(
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
    const svg = view.find("svg");
    expect(svg?.getAttribute("width")).toBe("32");
    expect(svg?.getAttribute("height")).toBe("32");
    expect(view.find(".size-6")).toBeNull();
    // The border counts as inset too: `box-sizing: border-box` means a 1px
    // border shrinks the content box to 30px around a 32px glyph, and asserting
    // only on the wrapper would not see that come back.
    expect(view.find(".border-transparent")).toBeNull();
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

  const detailsToggle = (view: View) =>
    view.findAll("button").find((button) => button.textContent?.trim() === "details") ?? null;

  it("keeps the detail collapsed so the summary bars stay the answer", async () => {
    const view = await renderDom(
      <VitalsDetail
        context={emptyContext}
        accountUsage={null}
        host={detailedHost}
        now={0}
        timestampFormat="24-hour"
      />,
    );

    expect(view.text()).toContain("details");
    // Collapsed, so none of the values are rendered yet.
    expect(view.text()).not.toContain("Apple M5 Max");
    expect(view.find('[aria-expanded="true"]')).toBeNull();
  });

  // The collapsed state above is only half the disclosure. Static markup could never press
  // the toggle, so the way back in was untested and `MachineDetailList` was only ever
  // exercised directly, never through the control that mounts it.
  it("reveals the machine detail when the toggle is pressed", async () => {
    const view = await renderDom(
      <VitalsDetail
        context={emptyContext}
        accountUsage={null}
        host={detailedHost}
        now={0}
        timestampFormat="24-hour"
      />,
    );

    await view.click(detailsToggle(view));

    expect(view.find('[aria-expanded="true"]')).not.toBeNull();
    expect(view.text()).toContain("Apple M5 Max");
  });

  it("still renders the three summary bars alongside the toggle", async () => {
    const view = await renderDom(
      <VitalsDetail
        context={emptyContext}
        accountUsage={null}
        host={detailedHost}
        now={0}
        timestampFormat="24-hour"
      />,
    );

    expect(view.text()).toContain("CPU");
    expect(view.text()).toContain("GPU");
    expect(view.text()).toContain("MEM");
  });

  it("offers no detail toggle before a sample arrives", async () => {
    const view = await renderDom(
      <VitalsDetail
        context={emptyContext}
        accountUsage={null}
        host={{ sample: null, streaming: false, enabled: true, onToggle: () => {} }}
        now={0}
        timestampFormat="24-hour"
      />,
    );

    expect(view.text()).toContain("Connecting to host…");
    expect(view.text()).not.toContain("details");
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
    expect(view.find('[aria-label="Core 0: 10%"]')).not.toBeNull();
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

describe("VitalsGauge window reset time", () => {
  const host = { sample, streaming: true, enabled: true, onToggle: () => {} };
  // Local-time constructor so the rendered clock is timezone-stable.
  const at = (h: number, m = 0) => new Date(2026, 7, 14, h, m, 0, 0);
  const now = at(12).getTime();

  it("shows when each window resets alongside the pace figures", async () => {
    const accountUsage: AccountUsageView = {
      fiveHour: { utilization: 70, resetsAt: at(14, 20).toISOString() },
      sevenDay: { utilization: 30, resetsAt: null },
      extraUsage: null,
      fetchedAt: null,
      extraWindows: [],
      balances: [],
    };
    const view = await renderDom(
      <VitalsDetail
        context={emptyContext}
        accountUsage={accountUsage}
        host={host}
        now={now}
        timestampFormat="24-hour"
      />,
    );
    expect(view.text()).toContain("resets 14:20");
    // Pace is not replaced by the reset time — both are shown.
    expect(view.text()).toContain("% used");
    expect(view.text()).toContain("pace");
  });

  it("omits the reset text for a window with no reset clock", async () => {
    const accountUsage: AccountUsageView = {
      fiveHour: null,
      sevenDay: { utilization: 30, resetsAt: null },
      extraUsage: null,
      fetchedAt: null,
      extraWindows: [],
      balances: [],
    };
    const view = await renderDom(
      <VitalsDetail
        context={emptyContext}
        accountUsage={accountUsage}
        host={host}
        now={now}
        timestampFormat="24-hour"
      />,
    );
    expect(view.text()).toContain("7-day");
    expect(view.text()).not.toContain("resets");
  });

  it("honours the 12-hour preference", async () => {
    const accountUsage: AccountUsageView = {
      fiveHour: { utilization: 70, resetsAt: at(14, 20).toISOString() },
      sevenDay: null,
      extraUsage: null,
      fetchedAt: null,
      extraWindows: [],
      balances: [],
    };
    const view = await renderDom(
      <VitalsDetail
        context={emptyContext}
        accountUsage={accountUsage}
        host={host}
        now={now}
        timestampFormat="12-hour"
      />,
    );
    expect(view.text()).toMatch(/resets 2:20\s?PM/i);
    expect(view.text()).not.toContain("14:20");
  });

  it("keeps the footer a flex row so the reset text is pushed to the far edge", async () => {
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
    const view = await renderDom(
      <VitalsDetail
        context={emptyContext}
        accountUsage={accountUsage}
        host={host}
        now={now}
        timestampFormat="24-hour"
      />,
    );
    // The usage half and the reset half are siblings, so the row that has to be a flex
    // container is their shared parent — reachable directly instead of by slicing markup.
    const usage = view
      .findAll("span")
      .find(
        (span) =>
          span.classList.contains("whitespace-nowrap") && span.textContent?.includes("% used"),
      );
    expect(usage).toBeDefined();
    const footer = usage?.parentElement;
    expect(footer?.textContent).toContain("resets 14:20");
    expect(footer?.classList.contains("justify-between")).toBe(true);
    expect(footer?.classList.contains("flex")).toBe(true);
    // flex-wrap is what keeps the worst-case width (dated reset + 12-hour clock,
    // ~265px against ~256px usable) falling to a second line rather than
    // overflowing the popover.
    expect(footer?.classList.contains("flex-wrap")).toBe(true);
    expect(usage?.classList.contains("whitespace-nowrap")).toBe(true);
  });

  it("shows a reset time for provider windows that have no pace at all", async () => {
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
    const view = await renderDom(
      <VitalsDetail
        context={emptyContext}
        accountUsage={accountUsage}
        host={host}
        now={now}
        timestampFormat="24-hour"
      />,
    );
    expect(view.text()).toContain("weekly");
    expect(view.text()).toContain("resets 14:20");
  });
});

describe("VitalsGauge context model name", () => {
  const host = { sample, streaming: true, enabled: true, onToggle: () => {} };

  function render(options: { modelDisplayName?: string | null; maxTokens?: number | null }) {
    const context: ContextWindowSnapshot = {
      ...emptyContext,
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    };
    return renderDom(
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

  it("names the model the context window belongs to", async () => {
    const view = await render({ modelDisplayName: "Opus 5" });
    expect(view.text()).toContain("Opus 5");
    expect(view.text()).toContain("200k window");
  });

  it("still names the model when the provider reports no window size", async () => {
    // The case the model name matters MOST in, and the one a naive `hasMax`
    // gate silently drops: no window size to show, so the header would be empty.
    const view = await render({ modelDisplayName: "Opus 5", maxTokens: null });
    expect(view.text()).toContain("Opus 5");
    expect(view.text()).not.toContain("window");
  });

  it("degrades to the window size alone when the model is unknown", async () => {
    const view = await render({ modelDisplayName: null });
    expect(view.text()).toContain("200k window");
    // No dangling separator when only one half is present.
    expect(view.text()).not.toContain("· 200k window");
  });

  it("shows neither half when there is no model and no window size", async () => {
    const view = await render({ modelDisplayName: null, maxTokens: null });
    expect(view.text()).not.toContain("window");
    expect(view.text()).toContain("Context");
  });
});
