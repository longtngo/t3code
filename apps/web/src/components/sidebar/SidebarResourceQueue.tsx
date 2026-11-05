import { Fragment, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { ChevronRightIcon, GaugeIcon } from "lucide-react";
import * as Schema from "effect/Schema";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentConnectionSummary } from "@t3tools/client-runtime/state/presentation";
import type { ResourceQueueItem, ResourceQueueSnapshot } from "@t3tools/contracts";
import type { HostMetricsSample } from "../../lib/hostMetrics";

import { cn } from "../../lib/utils";
import { fullnessArc, SEVERITY_TEXT } from "../../lib/vitals";
import { type HostMetricsState, useHostMetrics } from "../../hooks/useHostMetrics";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useNowSecond } from "../../hooks/useNowSecond";
import { useResourceQueues } from "../../hooks/useResourceQueues";
import {
  useEnvironmentConnectionSummaries,
  usePrimaryEnvironmentId,
} from "../../state/environments";
import { connectionPhaseDotClassName } from "../ConnectionStatusDot";
import { SIDEBAR_FOOTER_CONTROL_CLASS, sidebarFooterBadgeClass } from "./sidebarFooterBadge";
import { SidebarMenuItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { MachineDetails, MachineUsage } from "./MachineUsage";
import {
  diskSummary,
  isDiskStale,
  type FoldPart,
  foldOpen,
  type QueueView,
  resourceAccent,
  rowProgress,
  setFold,
  splitReason,
  type RowProgress,
} from "./sidebarResourceQueue.logic";

/**
 * Links the trigger to the panel it expands. A disclosure, not a dialog: it opens on hover and
 * closes on a mouse-leave timer, so the focus trap and restore `role="dialog"` promises would
 * be wrong.
 */
const RESOURCE_QUEUE_PANEL_ID = "sidebar-resource-queue-panel";

const PRIORITY_BADGE: Record<string, string> = {
  interactive: "bg-rose-400/15 text-rose-300",
  normal: "bg-sky-400/15 text-sky-300",
  background: "bg-zinc-400/15 text-zinc-300",
};
const FALLBACK_BADGE = "bg-muted text-muted-foreground";
/** `priority` is broker text: only an own key of the table names a badge, never `constructor`. */
const priorityBadge = (priority: string) =>
  Object.hasOwn(PRIORITY_BADGE, priority) ? PRIORITY_BADGE[priority]! : FALLBACK_BADGE;

function humanizeSec(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
/** `humanizeSec` clamps at 0, so a job stamped after a frozen (disconnected) clock reads 0s. */
function elapsedSince(sinceMs: number, nowMs: number): string {
  return humanizeSec((nowMs - sinceMs) / 1000);
}
function clockOf(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function Tag({ label, className }: { label: string; className: string }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1 py-px text-3xs font-semibold uppercase tracking-wide",
        className,
      )}
    >
      {label}
    </span>
  );
}

/**
 * Sized for the footer row, which is a ~240px strip shared with four other
 * controls — every pixel here is one the row does not have to wrap over.
 */
function CountBadge({ n, kind }: { n: number; kind: "run" | "wait" }) {
  const zero = n === 0;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            // The number alone is the visible content; the accessible name has to
            // say which count it is, since the tooltip text is only on hover. A
            // generic span cannot carry a name, so it is an image of its count.
            role="img"
            aria-label={`${String(n)} ${kind === "run" ? "running (holding a lease)" : "waiting (queued)"}`}
            className={sidebarFooterBadgeClass(
              zero ? "idle" : kind === "run" ? "active" : "pending",
            )}
          />
        }
      >
        {n}
      </TooltipTrigger>
      <TooltipPopup>
        {kind === "run" ? "running (holding a lease)" : "waiting (queued)"}
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * Small inline progress indicator sitting between the resource label and the name. Running jobs
 * with a known estimate show a filled ring + "%"; running jobs without one show nothing (there
 * is no estimate to draw); queued jobs show a dashed placeholder since they haven't started.
 */
function RowProgressBadge({ progress }: { progress: RowProgress }) {
  if (progress.state === "waiting") {
    return (
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex items-center gap-1 align-middle" />}>
          <svg width="14" height="14" viewBox="0 0 14 14" className="shrink-0">
            <circle
              cx="7"
              cy="7"
              r="5"
              fill="none"
              strokeWidth="2"
              strokeDasharray="2 2"
              className="stroke-muted-foreground/40"
            />
          </svg>
          <span className="text-3xs text-muted-foreground">queued</span>
        </TooltipTrigger>
        <TooltipPopup>queued, not started</TooltipPopup>
      </Tooltip>
    );
  }
  if (progress.pct == null) return null;
  const pct = progress.pct;
  const r = 5;
  const circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - pct / 100);
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex items-center gap-1 align-middle" />}>
        <svg width="14" height="14" viewBox="0 0 14 14" className="shrink-0 -rotate-90">
          <circle
            cx="7"
            cy="7"
            r={r}
            fill="none"
            strokeWidth="2"
            className="stroke-muted-foreground/25"
          />
          <circle
            cx="7"
            cy="7"
            r={r}
            fill="none"
            strokeWidth="2"
            strokeLinecap="round"
            className="stroke-primary"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
          />
        </svg>
        <span className="text-3xs tabular-nums text-muted-foreground">{pct}%</span>
      </TooltipTrigger>
      <TooltipPopup>{pct}% of estimated time</TooltipPopup>
    </Tooltip>
  );
}

/**
 * One running/waiting job. Click the row to toggle its full detail line open or closed.
 * `nowMs` is the section's clock: live while connected, frozen at receipt otherwise.
 */
function QueueRow({
  item,
  nowMs,
  expanded,
  onToggle,
}: {
  item: ResourceQueueItem;
  nowMs: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { name, description } = splitReason(item.reason);
  const progress = rowProgress(item, nowMs);
  const where =
    item.state === "waiting" ? `#${item.pos ?? "?"} in ${item.resource} queue` : "holding lease";
  return (
    <div
      className="flex cursor-pointer gap-2 rounded-md px-1.5 py-1.5 hover:bg-accent"
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onToggle();
        }
      }}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
    >
      <div className="min-w-0 flex-1">
        {/* line 1 — resource label + progress inline, then the wrapping name */}
        <div className="text-xs leading-snug text-foreground [overflow-wrap:anywhere]">
          <span
            className={cn(
              "mr-1.5 inline-flex items-center rounded px-1 py-px align-middle text-3xs font-semibold uppercase tracking-wide",
              resourceAccent(item.resource).badge,
            )}
          >
            {item.resource}
          </span>
          <RowProgressBadge progress={progress} />
          <span className="ml-1.5">{name || "(no description)"}</span>
        </div>
        {/* line 2 — optional description mined from the reason */}
        {description ? (
          <div className="mt-0.5 text-2xs leading-snug text-muted-foreground [overflow-wrap:anywhere]">
            {description}
          </div>
        ) : null}
        {/* line 3 — labels: priority badge, then project + elapsed */}
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-2xs text-muted-foreground">
          <Tag label={item.priority} className={priorityBadge(item.priority)} />
          <span className="opacity-40">·</span>
          <span className="truncate">{item.project || "-"}</span>
          <span className="opacity-40">·</span>
          <span className="tabular-nums">
            {item.state === "running" ? "running" : "waiting"} {elapsedSince(item.sinceMs, nowMs)}
          </span>
          {item.amount > 1 ? (
            <>
              <span className="opacity-40">·</span>
              <span className="tabular-nums">×{item.amount}</span>
            </>
          ) : null}
        </div>
        {/* line 4 — full details, toggled open by a click (no longer hover-only) */}
        <div
          className={cn(
            "overflow-hidden text-3xs tabular-nums text-muted-foreground/70 transition-all duration-150",
            expanded ? "mt-1 max-h-16 opacity-100" : "max-h-0 opacity-0",
          )}
        >
          pid {item.pid ?? "-"} · {where} · {item.state === "running" ? "started" : "enqueued"}{" "}
          {clockOf(item.sinceMs)} · eta {item.etaSec != null ? humanizeSec(item.etaSec) : "-"}
        </div>
      </div>
      <svg
        className={cn(
          "mt-0.5 size-3.5 shrink-0 text-muted-foreground/60 transition-transform",
          expanded ? "rotate-90" : "",
        )}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      >
        <path d="m9 6 6 6-6 6" />
      </svg>
    </div>
  );
}

const FOLDS_KEY = "t3code:resource-queue-folds";
const FoldsSchema = Schema.Record(Schema.String, Schema.Boolean);
const NO_FOLDS: Record<string, boolean> = {};
/**
 * `live` = a host sample arrived within this window (2x the server's slowest 5 s cadence):
 * a sample 9 999 ms old is live, one exactly 10 000 ms old is not.
 */
const LIVE_WINDOW_MS = 10_000;
const NOT_SUPPORTED = "Not available on this server";
const REQUEST_FAILED = "Request failed";

/** Header text for each connection phase; `connected` shows none. */
function phaseText(phase: EnvironmentConnectionPhase): string | null {
  switch (phase) {
    case "connected":
      return null;
    case "available":
      return "Not connected";
    case "offline":
      return "Offline";
    case "connecting":
      return "Connecting";
    case "reconnecting":
      return "Reconnecting";
    case "error":
      return "Connection failed";
    case "unsupported":
      return "Client not supported";
  }
}

/** Non-ram jobs and pools: the advisory RAM pool is tracked but never reserved. */
function reservable(snapshot: ResourceQueueSnapshot | null) {
  const running = (snapshot?.running ?? []).filter((item) => item.resource !== "ram");
  const waiting = (snapshot?.waiting ?? []).filter((item) => item.resource !== "ram");
  const resources = (snapshot?.resources ?? []).filter((r) => r.name !== "ram");
  return { running, waiting, resources };
}

/**
 * The reservations part's one-line state: why there is nothing to list, or the counts. Shown
 * folded, and in place of the job list when there is no list to show.
 */
function reservationState(queue: QueueView): string {
  if (queue.status === "unsupported") return NOT_SUPPORTED;
  const snapshot = queue.data;
  if (snapshot == null) {
    return queue.status === "failed" ? (queue.message ?? REQUEST_FAILED) : "Connecting…";
  }
  if (!snapshot.available) {
    return `Resource broker unavailable: ${snapshot.unavailableReason ?? "unknown"}`;
  }
  const { running, waiting } = reservable(snapshot);
  return `${running.length} running · ${waiting.length} waiting`;
}

/** Folded reservations: the state, plus the error of a failed refresh that kept its last data. */
function reservationSummary(queue: QueueView): string {
  const state = reservationState(queue);
  return queue.status === "failed" && queue.data != null
    ? `${state} · ${queue.message ?? REQUEST_FAILED}`
    : state;
}

/**
 * What one machine shows, decided once so the footer's collapse/expand control agrees with the
 * sections. An unsupported env has no list, so it has no badges and is never "busy".
 */
function machineFacts(
  environment: EnvironmentConnectionSummary,
  queue: QueueView,
  isPrimary: boolean,
  folds: Record<string, boolean>,
) {
  const snapshot = queue.data;
  const hasBody = environment.connectionState === "connected" || snapshot != null;
  const showList = snapshot != null && snapshot.available && queue.status !== "unsupported";
  const { running, waiting } = reservable(snapshot);
  const hasJobs = showList && running.length + waiting.length > 0;
  const machineOpen =
    hasBody && foldOpen(folds, environment.environmentId, "machine", { isPrimary, hasJobs });
  const noBroker = snapshot != null && !snapshot.available && queue.status !== "unsupported";
  // The trigger totals count every env with data, listed or not (an unsupported env's last jobs).
  return {
    hasBody,
    showList,
    hasJobs,
    machineOpen,
    noBroker,
    running: running.length,
    waiting: waiting.length,
  };
}

type MachineFacts = ReturnType<typeof machineFacts>;

/** The usage part's text when there is no sample to draw. */
function usageState(host: HostMetricsState, connected: boolean): string {
  if (host.status === "unsupported") return NOT_SUPPORTED;
  if (host.status === "failed") return `Usage unavailable: ${host.message ?? "unknown"}`;
  return connected ? "Waiting for usage…" : "Usage unavailable";
}

function QuickStat({
  label,
  pct,
  stale,
}: {
  label: string;
  pct: number | null | undefined;
  stale?: boolean | undefined;
}) {
  const { pct: reading, level } = fullnessArc(pct ?? null);
  return (
    <span className={cn(stale && "opacity-50")} data-stale={stale ? "" : undefined}>
      {label}{" "}
      <b className={cn("font-semibold", level ? SEVERITY_TEXT[level] : "text-muted-foreground/50")}>
        {reading ?? "-"}
      </b>
    </span>
  );
}

/**
 * Severity-coloured usage numbers. Folded usage line: cpu · gpu · mem · disk; collapsed machine
 * row: cpu mem disk. Disk is the fullest mount.
 */
function UsageStats({ sample, withGpu }: { sample: HostMetricsSample | null; withGpu: boolean }) {
  type Stat = readonly [string, number | null | undefined, boolean?];
  const disk = fullestDisk(sample);
  const gpu: ReadonlyArray<Stat> = withGpu ? [["gpu", sample?.gpu?.pct]] : [];
  const stats: ReadonlyArray<Stat> = [
    ["cpu", sample?.cpu.pct],
    ...gpu,
    ["mem", sample?.mem.pct],
    ["disk", disk.pct, disk.stale],
  ];
  return stats.map(([label, pct, stale], index) => (
    <Fragment key={label}>
      {withGpu && index > 0 ? <span className="opacity-40"> · </span> : null}
      <QuickStat label={label} pct={pct} stale={stale} />
    </Fragment>
  ));
}

/** The collapsed machine row's quick stats as spoken text: "cpu 12, mem 40, disk 55 stale". */
function quickStatsText(sample: HostMetricsSample | null): string {
  const read = (pct: number | null | undefined) => String(fullnessArc(pct ?? null).pct ?? "-");
  const disk = fullestDisk(sample);
  return `cpu ${read(sample?.cpu.pct)}, mem ${read(sample?.mem.pct)}, disk ${read(disk.pct)}${disk.stale ? " stale" : ""}`;
}

/** The fullest mount's reading and whether it is older than its sample. */
function fullestDisk(sample: HostMetricsSample | null): {
  pct: number | undefined;
  stale: boolean;
} {
  const disk = diskSummary(sample?.disks);
  return { pct: disk?.pct, stale: sample != null && disk != null && isDiskStale(sample.ts, disk) };
}

function FoldChevron({ open }: { open: boolean }) {
  return (
    <ChevronRightIcon className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
  );
}

/** A part's foldable sub-header; folded, it carries the part's one-line summary. */
function PartHeader({
  part,
  open,
  controls,
  summary,
  onToggle,
}: {
  part: "usage" | "reservations";
  open: boolean;
  /** Id of the region this header opens; referenced only while that region is rendered. */
  controls: string;
  summary: ReactNode;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      data-fold={part}
      aria-expanded={open}
      aria-controls={open ? controls : undefined}
      onClick={onToggle}
      className="flex w-full items-center gap-1 py-0.5 text-3xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
    >
      <FoldChevron open={open} />
      {part}
      {open ? null : (
        <span className="ml-auto truncate font-normal normal-case tracking-normal tabular-nums">
          {summary}
        </span>
      )}
    </button>
  );
}

/**
 * One environment: a header (status, label, `local`, live dot, phase, badges) and, while the
 * machine is open, its usage and reservations parts. A disconnected env keeps its last data,
 * dimmed, with elapsed frozen at the moment that data arrived.
 */
function MachineSection({
  environment,
  isPrimary,
  queue,
  facts,
  folds,
  onFold,
}: {
  environment: EnvironmentConnectionSummary;
  isPrimary: boolean;
  queue: QueueView;
  facts: MachineFacts;
  folds: Record<string, boolean>;
  onFold: (part: FoldPart, open: boolean) => void;
}) {
  const { environmentId, connectionState } = environment;
  const connected = connectionState === "connected";
  // Sections exist only inside the open panel, so being mounted already means "open".
  const host = useHostMetrics(environmentId, connected);
  const now = useNowSecond();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const partId = useId();

  const snapshot = queue.data;
  const { running, waiting, resources } = reservable(snapshot);
  const rows = [...running, ...waiting];
  const { hasBody, showList, hasJobs, machineOpen, noBroker } = facts;
  const defaults = { isPrimary, hasJobs };
  const usageOpen = foldOpen(folds, environmentId, "usage", defaults);
  const reservationsOpen = foldOpen(folds, environmentId, "reservations", defaults);
  // `receivedAt` is 0 until a sample arrives, so no sample is never live.
  const live = now - host.receivedAt < LIVE_WINDOW_MS;
  const phase = phaseText(connectionState);
  // The header's name is spoken in place of its content, so it carries the badges' counts.
  const quickShown = hasBody && !machineOpen;
  // Collapsed, why there are no badges, shown where they go; open, the body says it in full.
  const reason = machineOpen
    ? null
    : noBroker
      ? "no broker"
      : queue.status === "unsupported"
        ? "not available"
        : queue.status === "failed" && snapshot == null
          ? "request failed"
          : null;
  const headerName = [
    environment.environmentLabel,
    ...(isPrimary ? ["local"] : []),
    phase ?? "connected",
    ...(live ? ["live"] : []),
    ...(quickShown ? [quickStatsText(host.sample)] : []),
    ...(reason ? [reason] : []),
    ...(showList ? [`${running.length} running`, `${waiting.length} waiting`] : []),
  ].join(", ");
  // A disconnected env's clock stops where its data stopped.
  const clockMs = connected ? now : queue.receivedAt;

  const toggleExpand = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div
      data-env={environmentId}
      className={cn("border-t py-1 first:border-t-0", !connected && "opacity-60")}
    >
      <button
        type="button"
        data-fold="machine"
        aria-label={headerName}
        aria-expanded={machineOpen}
        aria-controls={machineOpen ? `${partId}-machine` : undefined}
        // Not `disabled`: an offline machine's header stays reachable by Tab to be read.
        aria-disabled={hasBody ? undefined : true}
        onClick={() => {
          if (hasBody) onFold("machine", !machineOpen);
        }}
        className="flex w-full min-w-0 flex-col gap-0.5 rounded-md px-0.5 py-1 text-left text-xs hover:bg-accent aria-disabled:cursor-default aria-disabled:hover:bg-transparent"
      >
        <span data-header-row className="flex w-full min-w-0 items-center gap-1.5">
          <FoldChevron open={machineOpen} />
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              connectionPhaseDotClassName(connectionState),
            )}
          />
          <span className="min-w-0 truncate font-semibold text-foreground">
            {environment.environmentLabel}
          </span>
          {isPrimary ? (
            <span data-local className="shrink-0 text-3xs text-muted-foreground">
              local
            </span>
          ) : null}
          {live ? (
            <span
              data-live
              className="flex shrink-0 items-center gap-1 text-3xs text-muted-foreground"
            >
              <span className="size-1 rounded-full bg-success" />
              live
            </span>
          ) : null}
          {phase ? <span className="shrink-0 text-3xs text-muted-foreground">{phase}</span> : null}
          {reason ? (
            <span data-reason className="ml-auto shrink-0 text-3xs text-muted-foreground/60">
              {reason}
            </span>
          ) : null}
          {showList ? (
            <span className="ml-auto flex shrink-0 gap-1">
              <CountBadge n={running.length} kind="run" />
              <CountBadge n={waiting.length} kind="wait" />
            </span>
          ) : null}
        </span>
        {quickShown ? (
          <span
            data-quick
            className="flex gap-1.5 pl-7 text-3xs text-muted-foreground tabular-nums"
          >
            <UsageStats sample={host.sample} withGpu={false} />
          </span>
        ) : null}
      </button>

      {machineOpen ? (
        <div id={`${partId}-machine`} className="pl-4">
          <PartHeader
            part="usage"
            open={usageOpen}
            controls={`${partId}-usage`}
            summary={
              host.sample ? (
                <span data-usage-summary>
                  <UsageStats sample={host.sample} withGpu />
                </span>
              ) : (
                usageState(host, connected)
              )
            }
            onToggle={() => onFold("usage", !usageOpen)}
          />
          {usageOpen ? (
            <div id={`${partId}-usage`}>
              {host.sample ? (
                <div className="pb-1">
                  <MachineUsage sample={host.sample} />
                  <MachineDetails sample={host.sample} />
                </div>
              ) : (
                <div className="px-0.5 py-1 text-2xs text-muted-foreground/70">
                  {usageState(host, connected)}
                </div>
              )}
            </div>
          ) : null}

          <PartHeader
            part="reservations"
            open={reservationsOpen}
            controls={`${partId}-reservations`}
            summary={reservationSummary(queue)}
            onToggle={() => onFold("reservations", !reservationsOpen)}
          />
          {reservationsOpen ? (
            <div id={`${partId}-reservations`} className="pb-1">
              {queue.status === "failed" && snapshot != null ? (
                <div className="px-0.5 py-1 text-2xs text-destructive">{queue.message}</div>
              ) : null}
              {showList && resources.length > 0 ? (
                /* The pool set grows and gets renamed by the broker (the cpu split, one pool per
                   configured device), so the strip wraps to as many rows as the sidebar needs
                   rather than assuming a fixed count fits on one line. */
                <div className="grid grid-cols-[repeat(auto-fit,minmax(min(84px,100%),1fr))] gap-x-2 gap-y-1.5 px-0.5 py-1">
                  {resources.map((r) => {
                    const pct =
                      r.capacity > 0 ? Math.min(100, Math.round((r.inUse / r.capacity) * 100)) : 0;
                    return (
                      <div key={r.name} className="min-w-0">
                        <div className="mb-0.5 flex items-baseline justify-between gap-1 text-3xs text-muted-foreground">
                          <Tooltip>
                            <TooltipTrigger render={<span className="truncate uppercase" />}>
                              {r.name}
                            </TooltipTrigger>
                            <TooltipPopup>{r.name}</TooltipPopup>
                          </Tooltip>
                          <span className="shrink-0 tabular-nums">
                            <span className="font-semibold text-foreground">{r.inUse}</span>/
                            {r.capacity}
                          </span>
                        </div>
                        <div className="h-[3px] overflow-hidden rounded bg-accent">
                          <div
                            className={cn("h-full rounded", resourceAccent(r.name).bar)}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : null}
              {!showList ? (
                <div className="px-0.5 py-1 text-2xs text-muted-foreground/70">
                  {reservationState(queue)}
                </div>
              ) : rows.length === 0 ? (
                <div className="px-0.5 py-1 text-2xs text-muted-foreground/60">
                  Nothing running or queued. All resources free.
                </div>
              ) : (
                rows.map((item) => {
                  const key = `${item.state}:${item.resource}:${item.pid ?? "?"}:${item.pos ?? 0}:${item.sinceMs}`;
                  return (
                    <QueueRow
                      key={key}
                      item={item}
                      nowMs={clockMs}
                      expanded={expanded.has(key)}
                      onToggle={() => toggleExpand(key)}
                    />
                  );
                })
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Sidebar quick-glance for every enabled environment's resource broker (`resctl`) and host
 * usage: a gauge with running and waiting totals and a hover/click popover with one section per
 * machine. Queues poll at 60s, 5s while open; host usage streams only while open.
 */
export function SidebarResourceQueue({
  isOpen,
  onOpenChange,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const primaryId = usePrimaryEnvironmentId();
  const summaries = useEnvironmentConnectionSummaries();
  // `pinned` stays local because it records WHY the panel is open — a click rather than a hover —
  // which is the only thing that decides whether a mouse-leave should close it. Whether it is open
  // at all is the footer's call, since the sibling panel shares this positioning context.
  const [pinned, setPinned] = useState(false);
  const open = isOpen;
  const environments = [
    ...summaries.filter((s) => s.isEnabled && s.environmentId === primaryId),
    ...summaries.filter((s) => s.isEnabled && s.environmentId !== primaryId),
  ];
  const queues = useResourceQueues(
    environments.map((s) => ({
      environmentId: s.environmentId,
      connected: s.connectionState === "connected",
    })),
    open,
  );
  const [folds, setFolds] = useLocalStorage(FOLDS_KEY, NO_FOLDS, FoldsSchema);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Un-pin whenever the panel closes, including when the footer closed it because the sibling
  // opened. Left latched, the next hover-leave would refuse to close a panel nobody pinned.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- un-pins the panel whenever it closes, including when a sibling closed it
  useEffect(() => {
    if (!open) setPinned(false);
  }, [open]);

  // Drop any in-flight close timer on unmount so it cannot fire against a dead component.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the pending hover-close timer on unmount
  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );

  // Every catalog env, enabled or not, so a fold never prunes a disabled env's overrides.
  const knownIds = summaries.map((s) => s.environmentId);
  const facts = environments.map((s, index) =>
    machineFacts(s, queues[index]!, s.environmentId === primaryId, folds),
  );
  const totals = {
    running: facts.reduce((sum, f) => sum + f.running, 0),
    waiting: facts.reduce((sum, f) => sum + f.waiting, 0),
    maintenance: queues.some((view) => view.data?.maintenance === true),
  };
  const reachable = environments.filter((s) => s.connectionState === "connected").length;
  const anyOpen = facts.some((f) => f.machineOpen);
  // "collapse all" closes every machine; "expand busy" opens the ones with jobs. Both write
  // overrides, so the choice outlives the defaults that would otherwise reopen a busy machine.
  const anyBusy = facts.some((f) => f.hasJobs);
  const foldAll = () =>
    setFolds((current) =>
      environments.reduce((next, s, index) => {
        const f = facts[index]!;
        if (anyOpen) return setFold(next, s.environmentId, "machine", false, knownIds);
        return f.hasJobs ? setFold(next, s.environmentId, "machine", true, knownIds) : next;
      }, current),
    );

  // Hover opens; the popover lives inside the wrapper, so moving into it keeps it open. A
  // short close delay bridges the small gap above the trigger. Click pins it open.
  const onEnter = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    onOpenChange(true);
  };
  const onLeave = () => {
    // A pinned panel survives the pointer leaving; only a hover-opened one closes.
    // Read at the moment of leaving rather than when the timer fires: pinning
    // requires activating the trigger, and both paths that can do so cancel a
    // pending close first, so the value cannot go stale in between.
    if (pinned) return;
    closeTimer.current = setTimeout(() => onOpenChange(false), 160);
  };
  const togglePin = () => {
    // Keyboard activation reaches this without a preceding mouseenter, so a
    // close timer left over from an earlier mouseleave has to be cancelled here
    // too — otherwise pinning by keyboard is undone 160ms later.
    if (closeTimer.current) clearTimeout(closeTimer.current);
    const next = !pinned;
    setPinned(next);
    onOpenChange(next);
  };

  return (
    /*
     * `static` opts out of `SidebarMenuItem`'s `relative` so the popover anchors to the footer
     * row (footer-width everywhere). No Tooltip: hovering already opens the self-naming panel,
     * and `aria-label` names it for screen readers.
     */
    <SidebarMenuItem className="static shrink-0" onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <button
        type="button"
        className={SIDEBAR_FOOTER_CONTROL_CLASS}
        onClick={togglePin}
        aria-expanded={open}
        aria-controls={open ? RESOURCE_QUEUE_PANEL_ID : undefined}
        aria-label="Resource Queue"
      >
        <GaugeIcon className="size-3.5" />
        {totals.maintenance ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  role="img"
                  aria-label="broker in maintenance (draining)"
                  className="rounded-full bg-destructive px-1 py-px text-3xs font-semibold text-white"
                />
              }
            >
              maint
            </TooltipTrigger>
            <TooltipPopup>broker in maintenance (draining)</TooltipPopup>
          </Tooltip>
        ) : null}
        <CountBadge n={totals.running} kind="run" />
        <CountBadge n={totals.waiting} kind="wait" />
      </button>

      {open ? (
        <div
          id={RESOURCE_QUEUE_PANEL_ID}
          className="absolute right-0 bottom-full left-0 z-50 mb-2 rounded-lg border bg-popover p-2 text-popover-foreground shadow-lg"
        >
          <div className="flex items-center justify-between px-0.5 pb-1">
            <span className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
              Resource queue
            </span>
            <span className="flex items-center gap-2">
              {totals.maintenance ? (
                <span className="rounded-full bg-destructive px-1.5 py-px text-3xs font-semibold text-white">
                  maintenance
                </span>
              ) : null}
              <span className="text-3xs text-muted-foreground/60">refresh 5s</span>
            </span>
          </div>

          <div className="max-h-[70vh] overflow-y-auto pr-0.5">
            {environments.map((environment, index) => (
              <MachineSection
                key={environment.environmentId}
                environment={environment}
                isPrimary={environment.environmentId === primaryId}
                queue={queues[index]!}
                facts={facts[index]!}
                folds={folds}
                onFold={(part, next) =>
                  setFolds((current) =>
                    setFold(current, environment.environmentId, part, next, knownIds),
                  )
                }
              />
            ))}
          </div>

          <div className="mt-1.5 flex items-center justify-between gap-2 border-t pt-1.5 text-3xs text-muted-foreground/60">
            <span data-footer-counts>
              {totals.running} running · {totals.waiting} waiting · {reachable} of{" "}
              {environments.length} reachable
            </span>
            {anyOpen || anyBusy ? (
              <button
                type="button"
                data-fold-all
                onClick={foldAll}
                className="shrink-0 text-primary hover:underline"
              >
                {anyOpen ? "collapse all" : "expand busy"}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </SidebarMenuItem>
  );
}
