import { useEffect, useReducer, useRef, useState } from "react";
import { GaugeIcon } from "lucide-react";
import type { ResourceQueueItem } from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import { useResourceQueue } from "../../hooks/useResourceQueue";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import {
  resourceAccent,
  rowProgress,
  splitReason,
  type RowProgress,
} from "./sidebarResourceQueue.logic";

const PRIORITY_BADGE: Record<string, string> = {
  interactive: "bg-rose-400/15 text-rose-300",
  normal: "bg-sky-400/15 text-sky-300",
  background: "bg-zinc-400/15 text-zinc-300",
};
const FALLBACK_BADGE = "bg-muted text-muted-foreground";

function humanizeSec(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
function elapsedSince(sinceMs: number): string {
  return humanizeSec((Date.now() - sinceMs) / 1000);
}
function clockOf(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function Tag({ label, className }: { label: string; className: string }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1 py-px text-[9.5px] font-semibold uppercase tracking-wide",
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
    <span
      title={kind === "run" ? "running (holding a lease)" : "waiting (queued)"}
      className={cn(
        "min-w-[15px] rounded-full px-1 py-px text-center text-[10px] tabular-nums",
        zero
          ? "bg-accent font-medium text-muted-foreground"
          : kind === "run"
            ? "bg-emerald-500 font-semibold text-emerald-950"
            : "bg-amber-500 font-semibold text-amber-950",
      )}
    >
      {n}
    </span>
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
      <span className="inline-flex items-center gap-1 align-middle" title="queued — not started">
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
        <span className="text-[10px] text-muted-foreground">queued</span>
      </span>
    );
  }
  if (progress.pct == null) return null;
  const pct = progress.pct;
  const r = 5;
  const circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - pct / 100);
  return (
    <span
      className="inline-flex items-center gap-1 align-middle"
      title={`${pct}% of estimated time`}
    >
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
      <span className="text-[10px] tabular-nums text-muted-foreground">{pct}%</span>
    </span>
  );
}

/** One running/waiting job. Click the row to toggle its full detail line open or closed. */
function QueueRow({
  item,
  expanded,
  onToggle,
}: {
  item: ResourceQueueItem;
  expanded: boolean;
  onToggle: () => void;
}) {
  const now = Date.now();
  const { name, description } = splitReason(item.reason);
  const progress = rowProgress(item, now);
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
              "mr-1.5 inline-flex items-center rounded px-1 py-px align-middle text-[9px] font-semibold uppercase tracking-wide",
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
          <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground [overflow-wrap:anywhere]">
            {description}
          </div>
        ) : null}
        {/* line 3 — labels: priority badge, then project + elapsed */}
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          <Tag label={item.priority} className={PRIORITY_BADGE[item.priority] ?? FALLBACK_BADGE} />
          <span className="opacity-40">·</span>
          <span className="truncate">{item.project || "—"}</span>
          <span className="opacity-40">·</span>
          <span className="tabular-nums">
            {item.state === "running" ? "running" : "waiting"} {elapsedSince(item.sinceMs)}
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
            "overflow-hidden text-[10.5px] tabular-nums text-muted-foreground/70 transition-all duration-150",
            expanded ? "mt-1 max-h-16 opacity-100" : "max-h-0 opacity-0",
          )}
        >
          pid {item.pid ?? "—"} · {where} · {item.state === "running" ? "started" : "enqueued"}{" "}
          {clockOf(item.sinceMs)} · eta {item.etaSec != null ? humanizeSec(item.etaSec) : "—"}
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

/**
 * Sidebar quick-glance for the local resource broker (`resctl`). Renders as one control in the
 * sidebar footer row: a gauge icon plus two badges — running (green) and waiting (yellow) — and,
 * on hover or click, a popover with the live queue drawn above the row. Polls at 60s in the
 * background and 5s while the popover is open. The advisory RAM pool is intentionally omitted
 * (it is tracked but never reserved).
 */
export function SidebarResourceQueue() {
  const environmentId = usePrimaryEnvironmentId();
  const [pinned, setPinned] = useState(false);
  const [hovering, setHovering] = useState(false);
  const open = pinned || hovering;
  const { snapshot } = useResourceQueue(environmentId, open);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const wrapRef = useRef<HTMLLIElement | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [, tick] = useReducer((n: number) => n + 1, 0);

  // Re-render every second while open so the "elapsed" durations tick live between polls.
  useEffect(() => {
    if (!open) return;
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [open]);

  // Close on outside click / Escape while open.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        setPinned(false);
        setHovering(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPinned(false);
        setHovering(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (environmentId == null) return null;

  // Drop the advisory RAM/memory pool from every surface — it is tracked but not reservable,
  // so it has no place in this "what's holding/queued for a resource" view.
  const running = (snapshot?.running ?? []).filter((item) => item.resource !== "ram");
  const waiting = (snapshot?.waiting ?? []).filter((item) => item.resource !== "ram");
  const resources = (snapshot?.resources ?? []).filter((r) => r.name !== "ram");
  const rows = [...running, ...waiting];

  // Hover opens; the popover lives inside the wrapper, so moving into it keeps it open. A
  // short close delay bridges the small gap above the trigger. Click pins it open.
  const onEnter = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setHovering(true);
  };
  const onLeave = () => {
    closeTimer.current = setTimeout(() => setHovering(false), 160);
  };
  const togglePin = () => {
    setPinned((prev) => {
      if (prev) setHovering(false);
      return !prev;
    });
  };
  const toggleExpand = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    /*
     * `static` opts out of `SidebarMenuItem`'s baked-in `relative` so the
     * popover below anchors to the footer row's wrapper rather than to this
     * ~70px trigger — footer-width on every sidebar size, no width arithmetic.
     *
     * No Tooltip on this one, unlike its neighbours in the row: hovering it
     * already opens the panel, which names itself and says strictly more than a
     * tooltip could. The `aria-label` carries the name for screen readers.
     */
    <SidebarMenuItem
      ref={wrapRef}
      className="static shrink-0"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <SidebarMenuButton
        size="sm"
        className="h-8 w-auto gap-1 px-1.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
        onClick={togglePin}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Resource Queue"
      >
        <GaugeIcon className="size-3.5" />
        {snapshot?.maintenance ? (
          <span
            title="broker in maintenance (draining)"
            className="rounded-full bg-red-500 px-1 py-px text-[9px] font-semibold text-white"
          >
            maint
          </span>
        ) : null}
        <CountBadge n={running.length} kind="run" />
        <CountBadge n={waiting.length} kind="wait" />
      </SidebarMenuButton>

      {open ? (
        <div
          role="dialog"
          aria-label="Resource queue"
          className="absolute right-0 bottom-full left-0 z-50 mb-2 rounded-lg border bg-popover p-2 text-popover-foreground shadow-lg"
        >
          <div className="flex items-center justify-between px-0.5 pb-2">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Resource queue
            </span>
            <span className="flex items-center gap-2">
              {snapshot?.maintenance ? (
                <span className="rounded-full bg-red-500 px-1.5 py-px text-[10px] font-semibold text-white">
                  maintenance
                </span>
              ) : null}
              <span className="text-[10px] text-muted-foreground/60">refresh 5s</span>
            </span>
          </div>

          {resources.length > 0 ? (
            /* The pool set grows and gets renamed by the broker (the cpu split, one pool per
               configured device), so the strip wraps to as many rows as the sidebar needs
               rather than assuming a fixed count fits on one line. */
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(84px,100%),1fr))] gap-x-2 gap-y-1.5 px-0.5 pb-2">
              {resources.map((r) => {
                const pct =
                  r.capacity > 0 ? Math.min(100, Math.round((r.inUse / r.capacity) * 100)) : 0;
                return (
                  <div key={r.name} className="min-w-0">
                    <div className="mb-0.5 flex items-baseline justify-between gap-1 text-[10px] text-muted-foreground">
                      <span className="truncate uppercase" title={r.name}>
                        {r.name}
                      </span>
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

          <div className="h-px bg-border" />

          <div className="mt-1.5 max-h-[262px] overflow-y-auto pr-0.5">
            {snapshot == null ? (
              <div className="px-2 py-4 text-center text-xs text-muted-foreground/60">
                Connecting…
              </div>
            ) : !snapshot.available ? (
              <div className="px-2 py-4 text-center text-xs text-muted-foreground/60">
                Resource broker not running.
              </div>
            ) : rows.length === 0 ? (
              <div className="px-2 py-4 text-center text-xs text-muted-foreground/60">
                Nothing running or queued — all resources free.
              </div>
            ) : (
              rows.map((item) => {
                const key = `${item.state}:${item.resource}:${item.pid ?? "?"}:${item.pos ?? 0}`;
                return (
                  <QueueRow
                    key={key}
                    item={item}
                    expanded={expanded.has(key)}
                    onToggle={() => toggleExpand(key)}
                  />
                );
              })
            )}
          </div>

          <div className="mt-1.5 border-t pt-1.5 text-[10px] text-muted-foreground/60">
            {running.length} running · {waiting.length} waiting
          </div>
        </div>
      ) : null}
    </SidebarMenuItem>
  );
}
