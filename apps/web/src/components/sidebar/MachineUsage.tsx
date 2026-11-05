import { useState } from "react";
import { ChevronRightIcon } from "lucide-react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { formatBytes, type HostMetricsSample } from "~/lib/hostMetrics";
import {
  clampPct,
  fullnessArc,
  SEVERITY_BG,
  SEVERITY_TEXT,
  TRACK_CLASS,
  vitalsLevel,
} from "~/lib/vitals";
import { cn } from "~/lib/utils";
import { isDiskStale } from "./sidebarResourceQueue.logic";

/** CPU, GPU, MEM and one row per disk for a host sample; severity colours come from vitalsLevel. */
export function MachineUsage(props: { sample: HostMetricsSample }) {
  const { sample } = props;
  return (
    <div>
      <MetricRow label="CPU" pct={sample.cpu.pct} />
      <MetricRow label="GPU" pct={sample.gpu?.pct ?? null} />
      <MetricRow label="MEM" pct={sample.mem.pct} />
      {(sample.disks ?? []).map((disk, index) => (
        <MetricRow
          // oxlint-disable-next-line react/no-array-index-key -- Labels drop control characters server-side, so two mounts can share one; position disambiguates them.
          key={`${index}:${disk.mount}`}
          label={`DISK ${disk.mount}`}
          fullLabel={disk.mount}
          pct={disk.pct}
          stale={isDiskStale(sample.ts, disk)}
        />
      ))}
    </div>
  );
}

function MetricRow(props: {
  label: string;
  pct: number | null;
  /** Full text for a label that may truncate, revealed on hover (the text itself is whole). */
  fullLabel?: string;
  /** A reading older than its sample: dimmed and titled so it is not read as live. */
  stale?: boolean;
}) {
  const { pct: reading, level } = fullnessArc(props.pct);
  return (
    <div
      className={cn("flex items-center gap-3 py-1", props.stale && "opacity-50")}
      // oxlint-disable-next-line t3code/no-native-title-tooltip -- Spec requires title="stale" on the row; it marks state, it is not a hover tooltip.
      title={props.stale ? "stale" : undefined}
    >
      <span
        className="w-16 truncate text-xs font-semibold text-foreground"
        // oxlint-disable-next-line t3code/no-native-title-tooltip -- Reveals a truncated mount path; same native reveal as the stale marker above.
        title={props.fullLabel}
      >
        {props.label}
      </span>
      <span className={cn("h-1.5 flex-1", TRACK_CLASS)}>
        {level ? (
          <span
            className={cn("block h-full rounded-full", SEVERITY_BG[level])}
            style={{ width: `${reading}%` }}
          />
        ) : null}
      </span>
      <span
        className={cn(
          "w-10 text-right font-mono text-sm font-semibold",
          level ? SEVERITY_TEXT[level] : "text-muted-foreground/50",
        )}
      >
        {reading === null ? "-" : `${reading}%`}
      </span>
    </div>
  );
}

/**
 * Per-core load, load average, GPU and memory detail, collapsed by default. Every value
 * already arrives on each sample, so opening it costs no traffic. Bars, not a sparkline:
 * a sample has no per-core history, so a line would invent a trend.
 */
export function MachineDetails(props: { sample: HostMetricsSample }) {
  const [open, setOpen] = useState(false);
  const { sample } = props;

  return (
    <div className="mt-1 border-t border-border/40 pt-1">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex w-full items-center gap-1 text-3xs text-muted-foreground transition-colors hover:text-foreground"
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
    <dl className="mt-1 space-y-1 text-2xs">
      {sample.cpu.perCore.length > 0 ? (
        <div>
          <dt className="text-muted-foreground">
            Cores{sample.host ? ` (${String(sample.host.cores)})` : ""}
          </dt>
          <dd className="mt-0.5 flex items-end gap-px" aria-label="Per-core utilization">
            {sample.cpu.perCore.map((corePct, index) => (
              <Tooltip
                // oxlint-disable-next-line react/no-array-index-key -- Cores have no identity beyond their position, and the list is fixed for the life of the host.
                key={index}
              >
                <TooltipTrigger
                  render={
                    <span
                      role="img"
                      aria-label={`Core ${String(index)}: ${String(Math.round(corePct))}%`}
                      className={cn(
                        "w-1 rounded-t-xs",
                        SEVERITY_BG[vitalsLevel(clampPct(corePct))],
                      )}
                      style={{ height: `${String(Math.max(2, clampPct(corePct) * 0.16))}px` }}
                    />
                  }
                />
                <TooltipPopup>
                  Core {String(index)}: {String(Math.round(corePct))}%
                </TooltipPopup>
              </Tooltip>
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
