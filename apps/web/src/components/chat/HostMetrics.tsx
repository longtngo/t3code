import type { ReactNode } from "react";
import { cn } from "~/lib/utils";
import { type HostMetricsSample, formatBytes } from "~/lib/hostMetrics";
import { type UsageLevel, usageLevel } from "~/lib/usage";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

const LEVEL_TEXT: Record<UsageLevel, string> = {
  green: "text-green-500",
  yellow: "text-yellow-500",
  orange: "text-orange-400",
  red: "text-red-500",
};

const LEVEL_BG: Record<UsageLevel, string> = {
  green: "bg-green-500",
  yellow: "bg-yellow-500",
  orange: "bg-orange-400",
  red: "bg-red-500",
};

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/** Horizontal fill bar matching the account UsageMeter's bar (no pace marker). */
function MetricBar(props: { pct: number; className?: string }) {
  const level = usageLevel(props.pct);
  return (
    <span className={cn("relative inline-block h-1", props.className)} aria-hidden="true">
      <span className="block h-full overflow-hidden rounded-full bg-muted">
        <span
          className={cn("block h-full rounded-full", LEVEL_BG[level])}
          style={{ width: `${clampPercent(props.pct)}%` }}
        />
      </span>
    </span>
  );
}

/** Desktop compact segment: label + bar + value. Renders a dash until first sample. */
function MetricSegment(props: { label: string; pct: number | null }) {
  if (props.pct == null) {
    return (
      <span className="flex items-center gap-1.5">
        <span className="text-muted-foreground/70">{props.label}</span>
        <span className="tabular-nums text-muted-foreground/50">—</span>
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-muted-foreground/70">{props.label}</span>
      <MetricBar pct={props.pct} className="w-8" />
      <span className={cn("tabular-nums", LEVEL_TEXT[usageLevel(props.pct)])}>
        {Math.round(props.pct)}%
      </span>
    </span>
  );
}

/** Mobile compact pill mirroring the UsageMeter pill style. */
function MetricPill(props: { label: string; pct: number | null }) {
  return (
    <span className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
      <span className="text-muted-foreground/70">{props.label}</span>
      <span
        className={cn(
          "font-medium tabular-nums",
          props.pct == null ? "text-muted-foreground/50" : LEVEL_TEXT[usageLevel(props.pct)],
        )}
      >
        {props.pct == null ? "—" : `${Math.round(props.pct)}%`}
      </span>
    </span>
  );
}

function DetailRow(props: {
  label: string;
  value: string;
  pct: number;
  detail?: string | null;
  children?: ReactNode;
}) {
  const level = usageLevel(props.pct);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-6 text-xs">
        <span className="text-muted-foreground">{props.label}</span>
        <span className={cn("font-medium tabular-nums", LEVEL_TEXT[level])}>{props.value}</span>
      </div>
      {props.detail ? (
        <div className="text-[11px] text-muted-foreground">{props.detail}</div>
      ) : null}
      <MetricBar pct={props.pct} className="w-full" />
      {props.children}
    </div>
  );
}

function HostMetricsDetail(props: {
  sample: HostMetricsSample | null;
  onToggle: (next: boolean) => void;
}) {
  const { sample } = props;
  if (!sample) {
    return <div className="text-xs text-muted-foreground">Connecting to host…</div>;
  }
  const { cpu, mem, gpu, host } = sample;
  const gpuDetail = gpu
    ? [gpu.name, gpu.vramUsedBytes != null ? `${formatBytes(gpu.vramUsedBytes)} in use` : null]
        .filter(Boolean)
        .join(" · ") || null
    : null;
  return (
    <div className="space-y-2.5">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            Host metrics
          </div>
          {host ? (
            <div className="mt-0.5 text-[10px] text-muted-foreground/70">
              {host.platform} · {host.arch} · {host.cores} cores
            </div>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => props.onToggle(false)}
          aria-label="Pause host metrics"
          title="Live — click to pause"
          className="-mr-1 flex items-center gap-1 rounded-md p-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <span className="size-1.5 animate-pulse rounded-full bg-green-500" />
          live
        </button>
      </div>
      <DetailRow
        label="CPU"
        value={`${Math.round(cpu.pct)}%`}
        pct={cpu.pct}
        detail={
          cpu.loadAvg.length ? `load ${cpu.loadAvg.map((n) => n.toFixed(2)).join(" · ")}` : null
        }
      >
        {cpu.perCore.length ? (
          <div className="mt-1.5 flex flex-wrap gap-0.5">
            {cpu.perCore.map((core, index) => (
              <span
                // oxlint-disable-next-line react/no-array-index-key -- cores are positional and stable
                key={index}
                className="relative h-3 w-1 overflow-hidden rounded-sm bg-muted"
                title={`core ${index}: ${Math.round(core)}%`}
              >
                <span
                  className={cn(
                    "absolute inset-x-0 bottom-0 rounded-sm",
                    LEVEL_BG[usageLevel(core)],
                  )}
                  style={{ height: `${clampPercent(core)}%` }}
                />
              </span>
            ))}
          </div>
        ) : null}
      </DetailRow>
      {gpu ? (
        <DetailRow label="GPU" value={`${Math.round(gpu.pct)}%`} pct={gpu.pct} detail={gpuDetail} />
      ) : null}
      <DetailRow
        label="Memory"
        value={`${formatBytes(mem.usedBytes)} / ${formatBytes(mem.totalBytes)}`}
        pct={mem.pct}
        detail={`${Math.round(mem.pct)}% used`}
      />
    </div>
  );
}

/**
 * Live host CPU/GPU/memory readout for the branch toolbar: compact bars on
 * desktop, pills on mobile, with full detail in a hover popover — mirroring the
 * account UsageMeter. A live-dot button toggles the stream to save bandwidth;
 * when disabled it collapses to a single "metrics paused" affordance.
 */
export function HostMetrics(props: {
  sample: HostMetricsSample | null;
  streaming: boolean;
  enabled: boolean;
  onToggle: (next: boolean) => void;
}) {
  const { sample, enabled, onToggle } = props;

  if (!enabled) {
    return (
      <button
        type="button"
        onClick={() => onToggle(true)}
        aria-label="Enable host metrics"
        title="Host metrics paused — click to resume"
        className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground/60 transition-colors hover:text-muted-foreground"
      >
        <span className="size-1.5 rounded-full bg-muted-foreground/40" />
        <span className="hidden sm:inline">metrics paused</span>
      </button>
    );
  }

  const cpuPct = sample?.cpu.pct ?? null;
  const gpuPct = sample?.gpu?.pct ?? null;
  const memPct = sample?.mem.pct ?? null;
  const hasGpu = sample == null || sample.gpu != null;

  return (
    <div className="flex items-center gap-1">
      <Popover>
        <PopoverTrigger
          openOnHover
          delay={150}
          closeDelay={0}
          render={
            <button
              type="button"
              className="group flex min-w-0 items-center rounded-md px-1 transition-opacity hover:opacity-85"
              aria-label="Host metrics"
            >
              {/* Desktop: bars + value */}
              <span className="hidden items-center gap-3 text-[11px] text-muted-foreground sm:flex">
                <MetricSegment label="cpu" pct={cpuPct} />
                {hasGpu ? <MetricSegment label="gpu" pct={gpuPct} /> : null}
                <MetricSegment label="mem" pct={memPct} />
              </span>
              {/* Mobile: pills */}
              <span className="flex items-center gap-1.5 text-[11px] sm:hidden">
                <MetricPill label="cpu" pct={cpuPct} />
                {hasGpu ? <MetricPill label="gpu" pct={gpuPct} /> : null}
                <MetricPill label="mem" pct={memPct} />
              </span>
            </button>
          }
        />
        <PopoverPopup
          tooltipStyle
          side="top"
          align="center"
          className="w-60 max-w-none px-3 py-2.5"
        >
          <HostMetricsDetail sample={sample} onToggle={onToggle} />
        </PopoverPopup>
      </Popover>
      <button
        type="button"
        onClick={() => onToggle(false)}
        aria-label="Pause host metrics"
        title="Live — click to pause"
        className="flex items-center rounded-md p-1 text-muted-foreground/70 transition-colors hover:text-foreground"
      >
        <span
          className={cn(
            "size-1.5 rounded-full",
            props.streaming ? "animate-pulse bg-green-500" : "bg-muted-foreground/40",
          )}
        />
      </button>
    </div>
  );
}
