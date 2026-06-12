import { ArrowDownIcon, ArrowUpIcon, LoaderIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "~/lib/utils";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import {
  METER_EXTRA_SLOT,
  METER_PACE_SLOT,
  METER_VALUE_SLOT,
  type Pace,
  USAGE_WINDOW_MS,
  type UsageLevel,
  type UsageSnapshot,
  computePace,
  formatCredits,
  formatCreditsShort,
  formatResetTime,
  usageLevel,
} from "~/lib/usage";
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

interface WindowPaces {
  readonly fiveHour: Pace | null;
  readonly sevenDay: Pace | null;
}

/** Derive pace for the time-windowed segments. Extra (monthly) credits have no pace. */
function deriveWindowPaces(usage: UsageSnapshot, now: number): WindowPaces {
  return {
    fiveHour: usage.fiveHour
      ? computePace(usage.fiveHour.utilization, usage.fiveHour.resetsAt, USAGE_WINDOW_MS.fiveHour, now)
      : null,
    sevenDay: usage.sevenDay
      ? computePace(usage.sevenDay.utilization, usage.sevenDay.resetsAt, USAGE_WINDOW_MS.sevenDay, now)
      : null,
  };
}

interface Segment {
  readonly key: "5h" | "7d" | "extra";
  readonly label: string;
  readonly pct: number;
  readonly level: UsageLevel;
  /** Compact inline value shown beside the bar (desktop). */
  readonly inlineValue: string;
  /** Pace vs elapsed time, or null when it can't be placed in the window. */
  readonly pace: Pace | null;
}

function buildSegments(usage: UsageSnapshot, paces: WindowPaces): Segment[] {
  const segments: Segment[] = [];
  if (usage.fiveHour) {
    const pct = usage.fiveHour.utilization;
    segments.push({
      key: "5h",
      label: "5h",
      pct,
      level: usageLevel(pct),
      inlineValue: `${Math.round(pct)}%`,
      pace: paces.fiveHour,
    });
  }
  if (usage.sevenDay) {
    const pct = usage.sevenDay.utilization;
    segments.push({
      key: "7d",
      label: "7d",
      pct,
      level: usageLevel(pct),
      inlineValue: `${Math.round(pct)}%`,
      pace: paces.sevenDay,
    });
  }
  if (usage.extra?.isEnabled) {
    const pct = usage.extra.utilization;
    segments.push({
      key: "extra",
      label: "extra",
      pct,
      level: usageLevel(pct),
      inlineValue: `${formatCreditsShort(usage.extra.usedCredits)}/${formatCreditsShort(usage.extra.monthlyLimit)}`,
      pace: null,
    });
  }
  return segments;
}

function UsageBar(props: {
  pct: number;
  level: UsageLevel;
  /** Position (0–100) of the on-pace marker; omitted when pace is unknown. */
  tickPct?: number | null;
  className?: string;
}) {
  const width = Math.max(0, Math.min(100, props.pct));
  return (
    <span className={cn("relative inline-block h-1", props.className)} aria-hidden="true">
      <span className="block h-full overflow-hidden rounded-full bg-muted">
        <span
          className={cn("block h-full rounded-full", LEVEL_BG[props.level])}
          style={{ width: `${width}%` }}
        />
      </span>
      {props.tickPct != null ? (
        <span
          className="absolute -top-0.5 -bottom-0.5 w-px rounded-full bg-foreground/80"
          style={{ left: `${Math.max(0, Math.min(100, props.tickPct))}%` }}
          title="on-pace position"
        />
      ) : null}
    </span>
  );
}

/**
 * Pace readout: an up arrow + magnitude when burning faster than the elapsed
 * time allows (red), a down arrow when under it (green), or "on pace" within
 * the dead-zone. `compact` (mobile) drops the "%" and hides the on-pace case.
 */
function PaceLabel(props: { pace: Pace; compact?: boolean }) {
  if (props.pace.state === "onPace") {
    return props.compact ? null : <span className="text-muted-foreground/70">on pace</span>;
  }
  const ahead = props.pace.state === "ahead";
  const Icon = ahead ? ArrowUpIcon : ArrowDownIcon;
  const mag = Math.round(Math.abs(props.pace.delta));
  return (
    <span
      className={cn(
        "inline-flex items-center gap-px font-medium tabular-nums",
        ahead ? "text-red-500" : "text-green-500",
      )}
      title={ahead ? `${mag}% ahead of pace` : `${mag}% under pace`}
    >
      <Icon className="h-2.5 w-2.5" aria-hidden="true" />
      {mag}
      {props.compact ? "" : "%"}
    </span>
  );
}

function PopoverRow(props: {
  label: string;
  value: string;
  pct: number;
  level: UsageLevel;
  detail?: string | null;
  pace?: Pace | null;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-6 text-xs">
        <span className="text-muted-foreground">{props.label}</span>
        <span className="flex items-center gap-2">
          {props.pace ? <PaceLabel pace={props.pace} /> : null}
          <span className={cn("font-medium tabular-nums", LEVEL_TEXT[props.level])}>
            {props.value}
          </span>
        </span>
      </div>
      {props.detail ? (
        <div className="text-[11px] text-muted-foreground">{props.detail}</div>
      ) : null}
      <UsageBar
        pct={props.pct}
        level={props.level}
        tickPct={props.pace?.elapsedPct ?? null}
        className="w-full"
      />
    </div>
  );
}

/**
 * Account usage readout for the branch toolbar: compact bars on desktop, pills
 * on mobile, with full detail (reset times + dollar credits) in a hover popover.
 * Colors follow the statusline severity thresholds.
 */
export function UsageMeter(props: {
  usage: UsageSnapshot | null;
  contextWindow?: ContextWindowSnapshot | null;
  onRefresh?: () => void | Promise<void>;
}) {
  const { usage, onRefresh } = props;
  const contextWindow = props.contextWindow ?? null;
  const paces = usage
    ? deriveWindowPaces(usage, Date.now())
    : { fiveHour: null, sevenDay: null };
  const segments = usage ? buildSegments(usage, paces) : [];

  // Context window is shown as the leading data point. It is not a time-windowed
  // account limit, so it has no pace marker; color follows the same fill severity.
  const ctxPct = contextWindow?.usedPercentage ?? null;
  const ctxLevel = ctxPct != null ? usageLevel(ctxPct) : "green";
  const ctxInline =
    ctxPct != null
      ? `${Math.round(ctxPct)}%`
      : formatContextWindowTokens(contextWindow?.usedTokens ?? null);
  const ctxValue =
    ctxPct != null
      ? `${Math.round(ctxPct)}% · ${formatContextWindowTokens(contextWindow?.usedTokens ?? null)} / ${formatContextWindowTokens(contextWindow?.maxTokens ?? null)}`
      : `${formatContextWindowTokens(contextWindow?.usedTokens ?? null)} tokens`;

  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = async () => {
    if (refreshing || !onRefresh) return;
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  if (segments.length === 0 && !contextWindow) {
    return null;
  }

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <button
            type="button"
            className="group flex min-w-0 items-center rounded-md px-1 transition-opacity hover:opacity-85"
            aria-label="Account usage"
          >
            {/* Desktop: bars + value */}
            <span className="hidden items-center gap-3 text-[11px] text-muted-foreground sm:flex">
              {contextWindow ? (
                <span className="flex items-center gap-1.5">
                  <span className="text-muted-foreground/70">ctx</span>
                  {ctxPct != null ? <UsageBar pct={ctxPct} level={ctxLevel} className="w-8" /> : null}
                  <span className={cn(METER_VALUE_SLOT, LEVEL_TEXT[ctxLevel])}>{ctxInline}</span>
                </span>
              ) : null}
              {contextWindow && segments.length > 0 ? (
                <span className="h-3 w-px bg-border" aria-hidden="true" />
              ) : null}
              {segments.map((segment) => (
                <span key={segment.key} className="flex items-center gap-1.5">
                  <span className="text-muted-foreground/70">{segment.label}</span>
                  <UsageBar
                    pct={segment.pct}
                    level={segment.level}
                    tickPct={segment.pace?.elapsedPct ?? null}
                    className="w-8"
                  />
                  <span
                    className={cn(
                      segment.key === "extra" ? METER_EXTRA_SLOT : METER_VALUE_SLOT,
                      LEVEL_TEXT[segment.level],
                    )}
                  >
                    {segment.inlineValue}
                  </span>
                  {segment.key === "extra" ? null : (
                    <span className={METER_PACE_SLOT}>
                      {segment.pace ? <PaceLabel pace={segment.pace} /> : null}
                    </span>
                  )}
                </span>
              ))}
            </span>
            {/* Mobile: pills */}
            <span className="flex items-center gap-1.5 text-[11px] sm:hidden">
              {contextWindow ? (
                <span className="flex items-center gap-1 rounded-full bg-blue-500/10 px-2 py-0.5 text-muted-foreground">
                  <span className="text-muted-foreground/70">ctx</span>
                  <span
                    className={cn(
                      "inline-block min-w-[1.85rem] text-right font-medium tabular-nums",
                      LEVEL_TEXT[ctxLevel],
                    )}
                  >
                    {ctxInline}
                  </span>
                </span>
              ) : null}
              {segments.map((segment) => (
                <span
                  key={segment.key}
                  className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-muted-foreground"
                >
                  <span className="text-muted-foreground/70">
                    {segment.key === "extra" ? "$" : segment.label}
                  </span>
                  <span
                    className={cn(
                      "inline-block min-w-[1.85rem] text-right font-medium tabular-nums",
                      LEVEL_TEXT[segment.level],
                    )}
                  >
                    {Math.round(segment.pct)}%
                  </span>
                  {segment.key === "extra" ? null : (
                    <span className="inline-flex min-w-[1.85rem] items-center justify-end">
                      {segment.pace ? <PaceLabel pace={segment.pace} compact /> : null}
                    </span>
                  )}
                </span>
              ))}
            </span>
          </button>
        }
      />
      <PopoverPopup tooltipStyle side="top" align="center" className="w-56 max-w-none px-3 py-2.5">
        <div className="space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              Usage limits
            </div>
            {onRefresh ? (
              <button
                type="button"
                onClick={handleRefresh}
                disabled={refreshing}
                aria-label="Refresh usage now"
                title="Refresh usage now"
                className="-mr-1 flex items-center rounded-md p-0.5 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
              >
                {refreshing ? (
                  <LoaderIcon className="size-3 animate-spin" />
                ) : (
                  <RefreshCwIcon className="size-3" />
                )}
              </button>
            ) : null}
          </div>
          {contextWindow ? (
            <PopoverRow
              label="Context window"
              value={ctxValue}
              pct={ctxPct ?? 0}
              level={ctxLevel}
              detail={contextWindow.compactsAutomatically ? "Automatically compacts when needed" : null}
            />
          ) : null}
          {usage?.fiveHour ? (
            <PopoverRow
              label="5-hour"
              value={`${Math.round(usage.fiveHour.utilization)}%`}
              pct={usage.fiveHour.utilization}
              level={usageLevel(usage.fiveHour.utilization)}
              pace={paces.fiveHour}
              detail={
                formatResetTime(usage.fiveHour.resetsAt, "time")
                  ? `resets ${formatResetTime(usage.fiveHour.resetsAt, "time")}`
                  : null
              }
            />
          ) : null}
          {usage?.sevenDay ? (
            <PopoverRow
              label="7-day"
              value={`${Math.round(usage.sevenDay.utilization)}%`}
              pct={usage.sevenDay.utilization}
              level={usageLevel(usage.sevenDay.utilization)}
              pace={paces.sevenDay}
              detail={
                formatResetTime(usage.sevenDay.resetsAt, "datetime")
                  ? `resets ${formatResetTime(usage.sevenDay.resetsAt, "datetime")}`
                  : null
              }
            />
          ) : null}
          {usage?.extra?.isEnabled ? (
            <PopoverRow
              label="Extra usage"
              value={`${formatCredits(usage.extra.usedCredits)} / ${formatCredits(usage.extra.monthlyLimit)}`}
              pct={usage.extra.utilization}
              level={usageLevel(usage.extra.utilization)}
              detail={`${Math.round(usage.extra.utilization)}% of monthly limit${
                usage.extra.currency ? ` · ${usage.extra.currency}` : ""
              }`}
            />
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
