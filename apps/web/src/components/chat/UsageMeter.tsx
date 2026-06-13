import { ArrowDownIcon, ArrowUpIcon, LoaderIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "~/lib/utils";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import {
  METER_EXTRA_SLOT,
  METER_PACE_SLOT,
  METER_VALUE_SLOT,
  type Pace,
  type UsageLevel,
  type UsageSegment,
  type UsageSnapshot,
  deriveSegmentPace,
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

interface SegmentView {
  readonly segment: UsageSegment;
  readonly level: UsageLevel;
  readonly pace: Pace | null;
}

function buildSegmentViews(usage: UsageSnapshot, now: number): SegmentView[] {
  return usage.segments.map((segment) => ({
    segment,
    level: usageLevel(segment.utilization),
    pace: deriveSegmentPace(segment, now),
  }));
}

function UsageBar(props: {
  pct: number;
  level: UsageLevel;
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

function segmentPopoverDetail(
  segment: UsageSegment,
  source: UsageSnapshot["source"],
): string | null {
  if (segment.popoverDetail) return segment.popoverDetail;
  if (!segment.resetDetailStyle) return null;
  const formatted = formatResetTime(segment.resetsAt, segment.resetDetailStyle);
  if (!formatted) return null;
  return source === "cursor" ? `billing cycle resets ${formatted}` : `resets ${formatted}`;
}

export function UsageMeter(props: {
  usage: UsageSnapshot | null;
  contextWindow?: ContextWindowSnapshot | null;
  onRefresh?: () => void | Promise<void>;
}) {
  const { usage, onRefresh } = props;
  const contextWindow = props.contextWindow ?? null;
  const segmentViews = usage ? buildSegmentViews(usage, Date.now()) : [];

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

  if (segmentViews.length === 0 && !contextWindow) {
    return null;
  }

  const popoverTitle =
    usage?.source === "cursor"
      ? "Cursor usage"
      : usage?.source === "codex"
        ? "Codex usage"
        : "Usage limits";

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
            <span className="hidden items-center gap-3 text-[11px] text-muted-foreground sm:flex">
              {contextWindow ? (
                <span className="flex items-center gap-1.5">
                  <span className="text-muted-foreground/70">ctx</span>
                  {ctxPct != null ? (
                    <UsageBar pct={ctxPct} level={ctxLevel} className="w-8" />
                  ) : null}
                  <span className={cn(METER_VALUE_SLOT, LEVEL_TEXT[ctxLevel])}>{ctxInline}</span>
                </span>
              ) : null}
              {contextWindow && segmentViews.length > 0 ? (
                <span className="h-3 w-px bg-border" aria-hidden="true" />
              ) : null}
              {segmentViews.map(({ segment, level, pace }) => (
                <span key={segment.key} className="flex items-center gap-1.5">
                  <span className="text-muted-foreground/70">{segment.label}</span>
                  <UsageBar
                    pct={segment.utilization}
                    level={level}
                    tickPct={pace?.elapsedPct ?? null}
                    className="w-8"
                  />
                  <span
                    className={cn(
                      segment.isCurrency ? METER_EXTRA_SLOT : METER_VALUE_SLOT,
                      LEVEL_TEXT[level],
                    )}
                  >
                    {segment.inlineValue}
                  </span>
                  {segment.showPace ? (
                    <span className={METER_PACE_SLOT}>
                      {pace ? <PaceLabel pace={pace} /> : null}
                    </span>
                  ) : null}
                </span>
              ))}
            </span>
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
              {segmentViews.map(({ segment, level, pace }) => (
                <span
                  key={segment.key}
                  className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-muted-foreground"
                >
                  <span className="text-muted-foreground/70">
                    {segment.isCurrency ? "$" : segment.label}
                  </span>
                  <span
                    className={cn(
                      "inline-block min-w-[1.85rem] text-right font-medium tabular-nums",
                      LEVEL_TEXT[level],
                    )}
                  >
                    {segment.isCurrency
                      ? segment.inlineValue
                      : `${Math.round(segment.utilization)}%`}
                  </span>
                  {segment.showPace ? (
                    <span className="inline-flex min-w-[1.85rem] items-center justify-end">
                      {pace ? <PaceLabel pace={pace} compact /> : null}
                    </span>
                  ) : null}
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
              {popoverTitle}
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
              detail={
                contextWindow.compactsAutomatically ? "Automatically compacts when needed" : null
              }
            />
          ) : null}
          {segmentViews.map(({ segment, level, pace }) => (
            <PopoverRow
              key={segment.key}
              label={segment.popoverLabel}
              value={segment.popoverValue}
              pct={segment.utilization}
              level={level}
              pace={pace}
              detail={segmentPopoverDetail(segment, usage?.source ?? "claude")}
            />
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
