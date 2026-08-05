import { useEffect, useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { cn } from "~/lib/utils";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import { formatBytes, type HostMetricsSample } from "~/lib/hostMetrics";
import { ChevronRightIcon } from "lucide-react";
import { useHostMetrics, useHostMetricsEnabled } from "~/hooks/useHostMetrics";
import {
  type AccountUsageView,
  type UsageBalanceView,
  type Severity,
  type UsageWindowView,
  clampPct,
  computeWindowPace,
  fullnessArc,
  readingPct,
  windowArc,
  type VitalsGaugeArc,
  FIVE_HOUR_MS,
  GAUGE_MIRROR_TRANSFORM,
  GAUGE_RINGS,
  GAUGE_STROKE_WIDTH,
  GAUGE_VIEWBOX,
  paceDiffLabel,
  rightHalfArc,
  SEVEN_DAY_MS,
  SEVERITY_BG,
  SEVERITY_STROKE,
  SEVERITY_TEXT,
  VITALS_TRACK_STROKE,
  vitalsLevel,
  windowSeverity,
  type WindowPace,
} from "~/lib/vitals";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

// ---------------------------------------------------------------------------
// Icon — three rings cut by a straight vertical seam
// ---------------------------------------------------------------------------

/** One right-side half-ring (track + optional severity-colored fill). */
function HalfArc(props: { r: number; arc: VitalsGaugeArc; mirror?: boolean }) {
  const { trackD, fillD } = rightHalfArc(props.r, props.arc.pct);
  // The severity travels on the arc rather than being re-derived from `pct`
  // here: a usage window is coloured by pace, not fullness, and deriving it at
  // draw time is exactly how this glyph drifted from the detail panel.
  const fillStroke = props.arc.level === null ? undefined : SEVERITY_STROKE[props.arc.level];
  const paths = (
    <>
      <path
        d={trackD}
        stroke={VITALS_TRACK_STROKE}
        strokeWidth={GAUGE_STROKE_WIDTH}
        strokeLinecap="round"
        fill="none"
      />
      {fillD && fillStroke ? (
        <path
          d={fillD}
          stroke={fillStroke}
          strokeWidth={GAUGE_STROKE_WIDTH}
          strokeLinecap="round"
          fill="none"
        />
      ) : null}
    </>
  );
  return props.mirror ? <g transform={GAUGE_MIRROR_TRANSFORM}>{paths}</g> : paths;
}

export interface VitalsGaugeInputs {
  /** Context fullness, or a null arc when there is no snapshot yet. */
  readonly context: VitalsGaugeArc;
  /** Rolling windows: swept by usage, coloured by pace (see {@link windowArc}). */
  readonly fiveHour: VitalsGaugeArc;
  readonly sevenDay: VitalsGaugeArc;
  readonly cpu: VitalsGaugeArc;
  readonly gpu: VitalsGaugeArc;
  readonly mem: VitalsGaugeArc;
}

/**
 * The split-ring glyph. Left arcs are limits (context / 5h / 7d), right arcs are
 * resources (CPU / GPU / memory); the halves never touch. Arc sweep is fullness,
 * color is severity.
 */
export function VitalsGaugeIcon(props: { inputs: VitalsGaugeInputs; size?: number }) {
  const { context, fiveHour, sevenDay, cpu, gpu, mem } = props.inputs;
  const size = props.size ?? 20;
  return (
    <svg
      viewBox={`0 0 ${GAUGE_VIEWBOX} ${GAUGE_VIEWBOX}`}
      width={size}
      height={size}
      fill="none"
      aria-hidden="true"
      className="transform-gpu"
    >
      <HalfArc r={GAUGE_RINGS.outer} arc={context} mirror />
      <HalfArc r={GAUGE_RINGS.outer} arc={cpu} />
      <HalfArc r={GAUGE_RINGS.middle} arc={fiveHour} mirror />
      <HalfArc r={GAUGE_RINGS.middle} arc={gpu} />
      <HalfArc r={GAUGE_RINGS.inner} arc={sevenDay} mirror />
      <HalfArc r={GAUGE_RINGS.inner} arc={mem} />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Detail popover
// ---------------------------------------------------------------------------

const CAP_CLASS = "text-[10.5px] font-semibold uppercase tracking-[0.13em] text-muted-foreground";
const BLOCK_CLASS = "border-t border-border px-4 py-3 first:border-t-0";
const TRACK_CLASS = "overflow-hidden rounded-full bg-muted";

function ContextBlock(props: {
  usage: ContextWindowSnapshot;
  providerDisplayName?: string | null | undefined;
}) {
  const { usage } = props;
  const pct = readingPct(usage.usedPercentage ?? 0);
  const level: Severity = vitalsLevel(pct);
  const hasMax = usage.maxTokens !== null;
  return (
    <div className={BLOCK_CLASS}>
      <div className="flex items-baseline justify-between gap-2">
        <span className={CAP_CLASS}>Context</span>
        {hasMax ? (
          <span className="font-mono text-[11px] text-muted-foreground/60">
            {formatContextWindowTokens(usage.maxTokens ?? null)} window
          </span>
        ) : null}
      </div>
      {hasMax ? (
        <>
          <div className="mt-1.5 flex items-end gap-2">
            <span
              className={cn("font-mono text-2xl font-semibold leading-none", SEVERITY_TEXT[level])}
            >
              {pct}%
            </span>
            <span className="font-mono text-xs text-muted-foreground">
              {formatContextWindowTokens(usage.usedTokens)} /{" "}
              {formatContextWindowTokens(usage.maxTokens ?? null)}
            </span>
          </div>
          <div className={cn("mt-2.5 h-1.5 w-full", TRACK_CLASS)}>
            <div
              className={cn("h-full rounded-full", SEVERITY_BG[level])}
              style={{ width: `${clampPct(pct)}%` }}
            />
          </div>
        </>
      ) : (
        <div className="mt-1.5 font-mono text-xs text-muted-foreground">
          {formatContextWindowTokens(usage.usedTokens)} tokens
        </div>
      )}
      {usage.compactsAutomatically ? (
        <div className="mt-2 text-pretty text-[11px] font-medium text-muted-foreground/70">
          {props.providerDisplayName ?? "It"} automatically compacts its context when needed.
        </div>
      ) : null}
    </div>
  );
}

function WindowRow(props: {
  label: string;
  window: UsageWindowView;
  windowMs: number | null;
  now: number;
}) {
  const pace: WindowPace = computeWindowPace(props.window, props.windowMs, props.now);
  const level = windowSeverity(pace);
  return (
    <div className="border-t border-dashed border-border py-2.5 first:border-t-0">
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-semibold">{props.label}</span>
        {pace.diff !== null ? (
          <span className={cn("ml-auto font-mono text-[13px] font-bold", SEVERITY_TEXT[level])}>
            {paceDiffLabel(pace.diff)}
          </span>
        ) : null}
      </div>
      <div className={cn("relative my-2 h-2 rounded-full bg-muted")}>
        <div
          className={cn("absolute inset-y-0 left-0 rounded-full", SEVERITY_BG[level])}
          style={{ width: `${clampPct(pace.usage)}%` }}
        />
        {pace.projection !== null ? (
          <span
            className="absolute -top-[3px] -bottom-[3px] w-0.5 -translate-x-1/2 rounded-sm bg-foreground"
            style={{ left: `${clampPct(pace.projection)}%` }}
            aria-hidden="true"
          />
        ) : null}
      </div>
      <div className="font-mono text-[11px] text-muted-foreground/70">
        <span className="font-semibold text-muted-foreground">{pace.usage}% used</span>
        {pace.projection !== null ? ` · pace ${pace.projection}%` : null}
      </div>
    </div>
  );
}

function LimitsBlock(props: { usage: AccountUsageView; now: number }) {
  const { usage, now } = props;
  return (
    <div className={BLOCK_CLASS}>
      <div className="flex items-baseline justify-between gap-2">
        <span className={CAP_CLASS}>Usage limits</span>
        <span className="font-mono text-[11px] text-muted-foreground/60">pace</span>
      </div>
      <div className="mt-1">
        {usage.fiveHour ? (
          <WindowRow label="5-hour" window={usage.fiveHour} windowMs={FIVE_HOUR_MS} now={now} />
        ) : null}
        {usage.sevenDay ? (
          <WindowRow label="7-day" window={usage.sevenDay} windowMs={SEVEN_DAY_MS} now={now} />
        ) : null}
        {usage.extraWindows.map((window) => (
          <WindowRow
            key={window.label}
            label={window.label}
            window={window}
            windowMs={window.windowMs}
            now={now}
          />
        ))}
        {usage.balances.map((balance) => (
          <BalanceRow key={balance.label} balance={balance} />
        ))}
      </div>
    </div>
  );
}

/**
 * A balance, not a window. No pace bar: these have no reset time, so there is
 * no elapsed fraction to be ahead or behind, and a pace treatment would imply
 * a deadline that does not exist. Coloured by absolute utilization when the
 * balance has a ceiling, and left neutral when it does not.
 */
function BalanceRow(props: { balance: UsageBalanceView }) {
  const { balance } = props;
  const level = balance.utilization === null ? null : vitalsLevel(clampPct(balance.utilization));
  return (
    <div className="flex items-center gap-3 py-1">
      <span className="min-w-0 flex-1 truncate text-xs text-foreground">{balance.label}</span>
      <span
        className={cn(
          "font-mono text-[11px] tabular-nums",
          level === null ? "text-muted-foreground" : SEVERITY_TEXT[level],
        )}
      >
        {balance.detail}
      </span>
    </div>
  );
}

function MetricRow(props: { label: string; pct: number | null }) {
  const known = props.pct !== null && Number.isFinite(props.pct);
  // Bucket the rounded reading, not the raw one: this row displays
  // `Math.round(pct)`, so colouring from the unrounded value would let it show
  // "50%" in yellow — the same split that made the glyph and the context block
  // disagree.
  const reading = known ? readingPct(props.pct as number) : null;
  const level = reading === null ? null : vitalsLevel(reading);
  return (
    <div className="flex items-center gap-3 py-1">
      <span className="w-9 text-xs font-semibold text-foreground">{props.label}</span>
      <span className={cn("h-1.5 flex-1", TRACK_CLASS)}>
        {level ? (
          <span
            className={cn("block h-full rounded-full", SEVERITY_BG[level])}
            style={{ width: `${reading ?? 0}%` }}
          />
        ) : null}
      </span>
      <span
        className={cn(
          "w-10 text-right font-mono text-sm font-semibold",
          level ? SEVERITY_TEXT[level] : "text-muted-foreground/50",
        )}
      >
        {reading === null ? "—" : `${reading}%`}
      </span>
    </div>
  );
}

function MachineBlock(props: {
  sample: HostMetricsSample | null;
  streaming: boolean;
  enabled: boolean;
  onToggle: (next: boolean) => void;
}) {
  const { sample, streaming, enabled, onToggle } = props;
  return (
    <div className={BLOCK_CLASS}>
      <div className="flex items-center justify-between gap-2">
        <span className={CAP_CLASS}>Machine</span>
        <button
          type="button"
          onClick={() => onToggle(!enabled)}
          aria-label={enabled ? "Pause host metrics" : "Resume host metrics"}
          title={enabled ? "Live — click to pause" : "Paused — click to resume"}
          className="flex items-center gap-1 rounded-md p-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              enabled && streaming ? "animate-pulse bg-green-500" : "bg-muted-foreground/40",
            )}
          />
          {enabled ? "live" : "paused"}
        </button>
      </div>
      {!enabled ? (
        <div className="mt-1.5 text-xs text-muted-foreground">Metrics paused.</div>
      ) : sample === null ? (
        <div className="mt-1.5 text-xs text-muted-foreground">Connecting to host…</div>
      ) : (
        <div className="mt-1">
          <MetricRow label="CPU" pct={sample.cpu.pct} />
          <MetricRow label="GPU" pct={sample.gpu?.pct ?? null} />
          <MetricRow label="MEM" pct={sample.mem.pct} />
          <MachineDetails sample={sample} />
        </div>
      )}
    </div>
  );
}

/**
 * The detail the three summary bars leave out — per-core load, load average,
 * GPU name and VRAM, and memory in bytes.
 *
 * Collapsed by default: the three bars answer "is the machine busy", which is
 * what the gauge is for, and this answers "busy with what", which is a question
 * you ask second. Every value here already arrives on each sample, so opening
 * it costs no extra traffic.
 *
 * The per-core display is a bar per core, not a sparkline: a sample carries
 * instantaneous per-core utilization and no history, and drawing a line through
 * points we never kept would invent a trend.
 */
function MachineDetails(props: { sample: HostMetricsSample }) {
  const [open, setOpen] = useState(false);
  const { sample } = props;

  return (
    <div className="mt-1 border-t border-border/40 pt-1">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex w-full items-center gap-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRightIcon className={cn("size-3 transition-transform", open && "rotate-90")} />
        details
      </button>
      {open ? <MachineDetailList sample={sample} /> : null}
    </div>
  );
}

/** Split out from the disclosure so its contents are renderable in a test. */
export function MachineDetailList(props: { sample: HostMetricsSample }) {
  const { sample } = props;
  const loadAvg = sample.cpu.loadAvg.filter((value) => Number.isFinite(value));
  return (
    <dl className="mt-1 space-y-1 text-[11px]">
      {sample.cpu.perCore.length > 0 ? (
        <div>
          <dt className="text-muted-foreground">
            Cores{sample.host ? ` (${String(sample.host.cores)})` : ""}
          </dt>
          <dd className="mt-0.5 flex items-end gap-px" aria-label="Per-core utilization">
            {sample.cpu.perCore.map((corePct, index) => (
              <span
                // Cores have no identity beyond their position, and the
                // list is fixed for the life of the host.
                key={index}
                title={`Core ${String(index)}: ${String(Math.round(corePct))}%`}
                className={cn("w-1 rounded-t-[1px]", SEVERITY_BG[vitalsLevel(clampPct(corePct))])}
                style={{ height: `${String(Math.max(2, clampPct(corePct) * 0.16))}px` }}
              />
            ))}
          </dd>
        </div>
      ) : null}
      {loadAvg.length > 0 ? (
        <DetailRow label="Load" value={loadAvg.map((value) => value.toFixed(2)).join("  ")} />
      ) : null}
      <DetailRow
        label="Memory"
        value={`${formatBytes(sample.mem.usedBytes)} of ${formatBytes(sample.mem.totalBytes)}`}
      />
      {sample.gpu?.name ? <DetailRow label="GPU" value={sample.gpu.name} /> : null}
      {sample.gpu?.vramUsedBytes !== undefined ? (
        <DetailRow label="VRAM" value={formatBytes(sample.gpu.vramUsedBytes)} />
      ) : null}
      {sample.host ? (
        <DetailRow label="Host" value={`${sample.host.platform} ${sample.host.arch}`} />
      ) : null}
    </dl>
  );
}

function DetailRow(props: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{props.label}</dt>
      <dd className="min-w-0 truncate font-mono tabular-nums text-foreground/90">{props.value}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Assembled gauge (presentational) + connected wrapper
// ---------------------------------------------------------------------------

function describeInputs(inputs: VitalsGaugeInputs): string {
  const parts: string[] = [];
  const push = (label: string, arc: VitalsGaugeArc) => {
    if (arc.pct !== null) parts.push(`${label} ${Math.round(arc.pct)}%`);
  };
  push("context", inputs.context);
  push("5-hour", inputs.fiveHour);
  push("7-day", inputs.sevenDay);
  push("CPU", inputs.cpu);
  push("GPU", inputs.gpu);
  push("memory", inputs.mem);
  return parts.length ? `Vitals — ${parts.join(", ")}` : "Vitals";
}

interface VitalsHost {
  readonly sample: HostMetricsSample | null;
  readonly streaming: boolean;
  readonly enabled: boolean;
  readonly onToggle: (next: boolean) => void;
}

/** The popover body: context / usage-limits / machine blocks. */
export function VitalsDetail(props: {
  context: ContextWindowSnapshot | null;
  accountUsage: AccountUsageView | null;
  host: VitalsHost;
  now: number;
  providerDisplayName?: string | null | undefined;
}) {
  const { context, accountUsage, host, now } = props;
  const hasWindows = Boolean(
    accountUsage?.fiveHour ||
    accountUsage?.sevenDay ||
    accountUsage?.extraWindows.length ||
    accountUsage?.balances.length,
  );
  return (
    <div className="flex flex-col">
      {context ? (
        <ContextBlock usage={context} providerDisplayName={props.providerDisplayName} />
      ) : null}
      {hasWindows && accountUsage ? <LimitsBlock usage={accountUsage} now={now} /> : null}
      <MachineBlock
        sample={host.sample}
        streaming={host.streaming}
        enabled={host.enabled}
        onToggle={host.onToggle}
      />
    </div>
  );
}

export function VitalsGauge(props: {
  context: ContextWindowSnapshot | null;
  accountUsage: AccountUsageView | null;
  host: VitalsHost;
  providerDisplayName?: string | null | undefined;
}) {
  const { context, accountUsage, host } = props;
  const [open, setOpen] = useState(false);
  // The pace clock has to run even while the detail is closed: the icon colours
  // its two window arcs by pace, and pace is a function of how much of the
  // window's clock has elapsed. Leaving it frozen would let the glyph keep
  // showing a severity the panel no longer agrees with.
  const now = useNow(30_000, true);
  const inputs: VitalsGaugeInputs = {
    context: fullnessArc(context?.usedPercentage ?? null),
    fiveHour: windowArc(accountUsage?.fiveHour, FIVE_HOUR_MS, now),
    sevenDay: windowArc(accountUsage?.sevenDay, SEVEN_DAY_MS, now),
    cpu: fullnessArc(host.sample?.cpu.pct ?? null),
    gpu: fullnessArc(host.sample?.gpu?.pct ?? null),
    mem: fullnessArc(host.sample?.mem.pct ?? null),
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <button
            type="button"
            className={cn(
              // size-8 matches the composer's send button, so the two controls
              // in the footer share one hit-target size.
              "inline-flex size-8 cursor-pointer items-center justify-center rounded-full border border-transparent text-muted-foreground outline-none transition-colors",
              "hover:bg-accent data-[pressed]:bg-accent",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
            )}
            aria-label={describeInputs(inputs)}
          >
            <span className="flex size-6 items-center justify-center">
              <VitalsGaugeIcon inputs={inputs} size={24} />
            </span>
          </button>
        }
      />
      <PopoverPopup
        tooltipStyle
        side="top"
        align="end"
        viewportClassName="p-0"
        className="w-72 max-w-none text-left whitespace-normal"
      >
        <VitalsDetail
          context={context}
          accountUsage={accountUsage}
          host={host}
          now={now}
          providerDisplayName={props.providerDisplayName}
        />
      </PopoverPopup>
    </Popover>
  );
}

/**
 * Ticking wall-clock (ms) so pace projections advance. Only runs while `active`
 * (the detail popover is open); refreshes immediately on activation.
 */
function useNow(intervalMs: number, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, active]);
  return now;
}

/**
 * Connects {@link VitalsGauge} to the live host-metrics stream and the persisted
 * enable/pause toggle. Context and account usage are derived upstream (from the
 * thread activity log) and passed in.
 */
export function VitalsGaugeConnected(props: {
  environmentId: EnvironmentId;
  context: ContextWindowSnapshot | null;
  accountUsage: AccountUsageView | null;
  providerDisplayName?: string | null | undefined;
}) {
  const [enabled, setEnabled] = useHostMetricsEnabled();
  const { sample, streaming } = useHostMetrics(props.environmentId, enabled);
  return (
    <VitalsGauge
      context={props.context}
      accountUsage={props.accountUsage}
      host={{ sample, streaming, enabled, onToggle: setEnabled }}
      providerDisplayName={props.providerDisplayName}
    />
  );
}
