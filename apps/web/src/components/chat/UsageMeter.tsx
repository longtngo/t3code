import { cn } from "~/lib/utils";
import {
  type UsageLevel,
  type UsageSnapshot,
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

interface Segment {
  readonly key: "5h" | "7d" | "extra";
  readonly label: string;
  readonly pct: number;
  readonly level: UsageLevel;
  /** Compact inline value shown beside the bar (desktop). */
  readonly inlineValue: string;
}

function buildSegments(usage: UsageSnapshot): Segment[] {
  const segments: Segment[] = [];
  if (usage.fiveHour) {
    const pct = usage.fiveHour.utilization;
    segments.push({
      key: "5h",
      label: "5h",
      pct,
      level: usageLevel(pct),
      inlineValue: `${Math.round(pct)}%`,
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
    });
  }
  return segments;
}

function UsageBar(props: { pct: number; level: UsageLevel; className?: string }) {
  const width = Math.max(0, Math.min(100, props.pct));
  return (
    <span
      className={cn("inline-block h-1 overflow-hidden rounded-full bg-muted", props.className)}
      aria-hidden="true"
    >
      <span
        className={cn("block h-full rounded-full", LEVEL_BG[props.level])}
        style={{ width: `${width}%` }}
      />
    </span>
  );
}

function PopoverRow(props: {
  label: string;
  value: string;
  pct: number;
  level: UsageLevel;
  detail?: string | null;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-6 text-xs">
        <span className="text-muted-foreground">{props.label}</span>
        <span className={cn("font-medium tabular-nums", LEVEL_TEXT[props.level])}>
          {props.value}
        </span>
      </div>
      {props.detail ? (
        <div className="text-[11px] text-muted-foreground">{props.detail}</div>
      ) : null}
      <UsageBar pct={props.pct} level={props.level} className="w-full" />
    </div>
  );
}

/**
 * Account usage readout for the branch toolbar: compact bars on desktop, pills
 * on mobile, with full detail (reset times + dollar credits) in a hover popover.
 * Colors follow the statusline severity thresholds.
 */
export function UsageMeter(props: { usage: UsageSnapshot }) {
  const { usage } = props;
  const segments = buildSegments(usage);
  if (segments.length === 0) {
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
              {segments.map((segment) => (
                <span key={segment.key} className="flex items-center gap-1.5">
                  <span className="text-muted-foreground/70">{segment.label}</span>
                  <UsageBar pct={segment.pct} level={segment.level} className="w-8" />
                  <span className={cn("tabular-nums", LEVEL_TEXT[segment.level])}>
                    {segment.inlineValue}
                  </span>
                </span>
              ))}
            </span>
            {/* Mobile: pills */}
            <span className="flex items-center gap-1.5 text-[11px] sm:hidden">
              {segments.map((segment) => (
                <span
                  key={segment.key}
                  className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-muted-foreground"
                >
                  <span className="text-muted-foreground/70">
                    {segment.key === "extra" ? "$" : segment.label}
                  </span>
                  <span className={cn("font-medium tabular-nums", LEVEL_TEXT[segment.level])}>
                    {Math.round(segment.pct)}%
                  </span>
                </span>
              ))}
            </span>
          </button>
        }
      />
      <PopoverPopup tooltipStyle side="top" align="center" className="w-56 max-w-none px-3 py-2.5">
        <div className="space-y-2.5">
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            Usage limits
          </div>
          {usage.fiveHour ? (
            <PopoverRow
              label="5-hour"
              value={`${Math.round(usage.fiveHour.utilization)}%`}
              pct={usage.fiveHour.utilization}
              level={usageLevel(usage.fiveHour.utilization)}
              detail={
                formatResetTime(usage.fiveHour.resetsAt, "time")
                  ? `resets ${formatResetTime(usage.fiveHour.resetsAt, "time")}`
                  : null
              }
            />
          ) : null}
          {usage.sevenDay ? (
            <PopoverRow
              label="7-day"
              value={`${Math.round(usage.sevenDay.utilization)}%`}
              pct={usage.sevenDay.utilization}
              level={usageLevel(usage.sevenDay.utilization)}
              detail={
                formatResetTime(usage.sevenDay.resetsAt, "datetime")
                  ? `resets ${formatResetTime(usage.sevenDay.resetsAt, "datetime")}`
                  : null
              }
            />
          ) : null}
          {usage.extra?.isEnabled ? (
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
