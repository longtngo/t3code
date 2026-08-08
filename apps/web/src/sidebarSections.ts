/**
 * Pure derivation for the Agents panel's "background processes" (terminal
 * sessions) section, plus the shared status ordering and 6h auto-clear filter.
 *
 * Input comes from data the web client already holds (`useKnownTerminalSessions`),
 * so derivation is client-side with no extra RPC. Agents themselves are no longer
 * derived here: they come from the server-backed subagent runtime model.
 *
 * @module sidebarSections
 */
import type { KnownTerminalSession } from "@t3tools/client-runtime/state/terminal";

export const AUTO_CLEAR_TTL_HOURS = 6;

export type SidebarItemStatus = "running" | "completed" | "failed";

/** Statuses that represent finished work (eligible for auto-clear / sink-to-bottom). */
export function isTerminalSidebarStatus(status: SidebarItemStatus): boolean {
  return status === "completed" || status === "failed";
}

export interface BackgroundSidebarItem {
  readonly kind: "background";
  readonly id: string;
  readonly label: string;
  readonly cwd?: string;
  readonly status: SidebarItemStatus;
  readonly exitCode: number | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly buffer: string;
}

export type SidebarItem = BackgroundSidebarItem;

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function backgroundStatus(
  status: KnownTerminalSession["state"]["status"],
  exitCode: number | null,
): SidebarItemStatus {
  switch (status) {
    case "starting":
    case "running":
      return "running";
    case "error":
      return "failed";
    case "exited":
      return exitCode !== null && exitCode !== 0 ? "failed" : "completed";
    case "closed":
      return "completed";
    default:
      return "running";
  }
}

/** Map per-thread terminal sessions to background-process items. */
export function deriveBackgroundItems(
  terminals: ReadonlyArray<KnownTerminalSession>,
): BackgroundSidebarItem[] {
  return terminals.map((terminal) => {
    const summary = terminal.state.summary;
    const exitCode = summary?.exitCode ?? null;
    const status = backgroundStatus(terminal.state.status, exitCode);
    // Terminals carry no exit timestamp; updatedAt is stable once a terminal
    // stops emitting, so it approximates "completed at" for terminal statuses.
    const completedAt = isTerminalSidebarStatus(status) ? terminal.state.updatedAt : null;
    return {
      kind: "background" as const,
      id: terminal.target.terminalId,
      label: asTrimmedString(summary?.label) ?? "Terminal",
      ...(summary?.cwd ? { cwd: summary.cwd } : {}),
      status,
      exitCode,
      // Terminals carry no start timestamp; active terminals tiebreak by id.
      startedAt: null,
      completedAt,
      buffer: terminal.state.buffer,
    };
  });
}

function parseTime(value: string | null): number {
  if (!value) return Number.NaN;
  return Date.parse(value);
}

/**
 * Total ordering: active items (running/pending) before terminal items
 * (completed/failed). Active sorted oldest-first by startedAt; terminal sorted
 * newest-first by completedAt. Missing/NaN timestamps sort last within their
 * group, with a stable id tiebreak.
 */
export function sortSidebarItems<T extends Pick<SidebarItem, "id" | "status" | "startedAt" | "completedAt">>(
  items: ReadonlyArray<T>,
): T[] {
  return [...items].sort((left, right) => {
    const leftTerminal = isTerminalSidebarStatus(left.status);
    const rightTerminal = isTerminalSidebarStatus(right.status);
    if (leftTerminal !== rightTerminal) return leftTerminal ? 1 : -1;

    if (!leftTerminal) {
      const byStarted = compareTimes(parseTime(left.startedAt), parseTime(right.startedAt), "asc");
      return byStarted !== 0 ? byStarted : left.id.localeCompare(right.id);
    }
    const byCompleted = compareTimes(parseTime(left.completedAt), parseTime(right.completedAt), "desc");
    return byCompleted !== 0 ? byCompleted : left.id.localeCompare(right.id);
  });
}

function compareTimes(left: number, right: number, direction: "asc" | "desc"): number {
  const leftNaN = Number.isNaN(left);
  const rightNaN = Number.isNaN(right);
  if (leftNaN && rightNaN) return 0;
  if (leftNaN) return 1; // missing sorts last
  if (rightNaN) return -1;
  if (left === right) return 0;
  const ascending = left < right ? -1 : 1;
  return direction === "asc" ? ascending : -ascending;
}

/**
 * Whether a finished item should be auto-cleared from the sidebar because it
 * completed more than `ttlHours` ago. Active items are never auto-cleared.
 */
export function isAutoCleared(
  item: Pick<SidebarItem, "status" | "completedAt">,
  nowMs: number,
  ttlHours: number = AUTO_CLEAR_TTL_HOURS,
): boolean {
  if (!isTerminalSidebarStatus(item.status)) return false;
  const completedAt = parseTime(item.completedAt);
  if (Number.isNaN(completedAt)) return false;
  return nowMs - completedAt > ttlHours * 60 * 60 * 1000;
}

/**
 * Apply dismissal + auto-clear, then order completed-to-bottom. `dismissedIds`
 * holds item ids the user manually removed.
 */
export function visibleSidebarItems<T extends SidebarItem>(
  items: ReadonlyArray<T>,
  dismissedIds: ReadonlySet<string>,
  nowMs: number,
  ttlHours: number = AUTO_CLEAR_TTL_HOURS,
): T[] {
  const filtered = items.filter(
    (item) => !dismissedIds.has(item.id) && !isAutoCleared(item, nowMs, ttlHours),
  );
  return sortSidebarItems(filtered);
}
