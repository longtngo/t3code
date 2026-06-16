/**
 * Pure derivation for the task sidebar's "background processes" (terminal
 * sessions) and "agents/subagents" (task-stream) sections, plus the shared
 * status ordering and 6h auto-clear filter.
 *
 * All inputs come from data the web client already holds — the active thread's
 * `activities` (task.* lifecycle, including terminal `task.updated` patches)
 * and `useKnownTerminalSessions` — so derivation is client-side with no extra
 * RPC. Activity payloads are `Schema.Unknown`, so every field is narrowed
 * defensively.
 *
 * @module sidebarSections
 */
import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import type { KnownTerminalSession } from "@t3tools/client-runtime";

export const AUTO_CLEAR_TTL_HOURS = 6;

export type SidebarItemStatus = "running" | "completed" | "failed";

/** Statuses that represent finished work (eligible for auto-clear / sink-to-bottom). */
export function isTerminalSidebarStatus(status: SidebarItemStatus): boolean {
  return status === "completed" || status === "failed";
}

interface AgentLogEntry {
  /** Stable key from the source activity id. */
  readonly id: string;
  readonly at: string;
  readonly text: string;
  readonly lastToolName?: string;
}

export interface AgentSidebarItem {
  readonly kind: "agent";
  readonly id: string;
  readonly label: string;
  readonly status: SidebarItemStatus;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly finalSummary?: string;
  readonly outputFile?: string;
  readonly log: ReadonlyArray<AgentLogEntry>;
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

export type SidebarItem = AgentSidebarItem | BackgroundSidebarItem;

/** Aggregate activity counts for the tasks-panel toggle indicator. */
export interface TaskActivitySummary {
  /** Running plan steps + running agents + running background processes. */
  readonly activeCount: number;
  /** All tracked plan steps + agents + background processes. */
  readonly totalCount: number;
  /** Whether any tracked item is currently running (drives the spinner). */
  readonly hasActive: boolean;
}

/**
 * Combine the three activity sources backing the tasks panel — TodoWrite plan
 * steps, agents/subagents, and background processes (terminals) — into a single
 * active/total summary for the permanent toggle above the composer.
 *
 * Pass the *visible* agent/background lists (post dismissal + auto-clear) so the
 * badge matches what the panel renders. An item is "active" when its status is
 * `running`; plan-step activity is supplied pre-counted since plan steps use a
 * different status vocabulary (`inProgress`).
 */
export function summarizeTaskActivity(input: {
  readonly planStepsActive: number;
  readonly planStepsTotal: number;
  readonly agents: ReadonlyArray<Pick<AgentSidebarItem, "status">>;
  readonly background: ReadonlyArray<Pick<BackgroundSidebarItem, "status">>;
}): TaskActivitySummary {
  const agentsActive = input.agents.filter((item) => item.status === "running").length;
  const backgroundActive = input.background.filter((item) => item.status === "running").length;
  const activeCount = input.planStepsActive + agentsActive + backgroundActive;
  const totalCount = input.planStepsTotal + input.agents.length + input.background.length;
  return { activeCount, totalCount, hasActive: activeCount > 0 };
}

/** Dismissal key for a TodoWrite plan step in the task sidebar. */
export function planStepDismissKey(step: string): string {
  return `plan:${step}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

interface MutableAgentItem {
  id: string;
  label: string;
  status: SidebarItemStatus;
  startedAt: string | null;
  completedAt: string | null;
  finalSummary?: string;
  outputFile?: string;
  log: AgentLogEntry[];
}

/** Map wire task status to a sidebar terminal status, or null when still active. */
function taskTerminalSidebarStatus(raw: string | null): SidebarItemStatus | null {
  if (!raw) return null;
  if (raw === "failed") return "failed";
  // completed / stopped / killed are all finished work (killed ≈ parent stop).
  if (raw === "completed" || raw === "stopped" || raw === "killed") return "completed";
  return null;
}

function ensureAgentItem(map: Map<string, MutableAgentItem>, taskId: string): MutableAgentItem {
  const existing = map.get(taskId);
  if (existing) return existing;
  const created: MutableAgentItem = {
    id: taskId,
    label: "Agent task",
    status: "running",
    startedAt: null,
    completedAt: null,
    log: [],
  };
  map.set(taskId, created);
  return created;
}

/**
 * Fold the thread's `task.*` activities into agent/subagent items, one per
 * taskId, preserving first-seen order. Agents are Claude-only today (only the
 * Claude adapter emits task.* events).
 */
export function deriveAgentItems(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): AgentSidebarItem[] {
  const byId = new Map<string, MutableAgentItem>();

  for (const activity of activities) {
    if (!activity.kind.startsWith("task.")) continue;
    const payload = asRecord(activity.payload);
    const taskId = asTrimmedString(payload?.taskId);
    if (!taskId) continue;
    const item = ensureAgentItem(byId, taskId);

    if (activity.kind === "task.started") {
      item.status = item.status === "running" ? "running" : item.status;
      item.startedAt = item.startedAt ?? activity.createdAt;
      const label = asTrimmedString(payload?.detail) ?? asTrimmedString(activity.summary);
      if (label) item.label = label;
      continue;
    }

    if (activity.kind === "task.progress") {
      const text = asTrimmedString(payload?.summary) ?? asTrimmedString(payload?.detail);
      const lastToolName = asTrimmedString(payload?.lastToolName);
      if (text || lastToolName) {
        item.log.push({
          id: activity.id,
          at: activity.createdAt,
          text: text ?? "",
          ...(lastToolName ? { lastToolName } : {}),
        });
      }
      continue;
    }

    if (activity.kind === "task.completed" || activity.kind === "task.updated") {
      // task.completed is the primary completion signal; task.updated is a
      // secondary terminal patch when task_notification never arrives.
      if (!payload) continue;
      const terminalStatus =
        activity.kind === "task.completed"
          ? (taskTerminalSidebarStatus(asTrimmedString(payload.status)) ?? "completed")
          : taskTerminalSidebarStatus(asTrimmedString(payload.status));
      if (!terminalStatus) continue;
      item.status = terminalStatus;
      item.completedAt = activity.createdAt;
      const finalSummary = asTrimmedString(payload.detail) ?? asTrimmedString(payload.summary);
      if (finalSummary) item.finalSummary = finalSummary;
      const outputFile = asTrimmedString(payload.outputFile);
      if (outputFile) item.outputFile = outputFile;
    }
  }

  return [...byId.values()].map((item) => ({
    kind: "agent" as const,
    id: item.id,
    label: item.label,
    status: item.status,
    startedAt: item.startedAt,
    completedAt: item.completedAt,
    ...(item.finalSummary ? { finalSummary: item.finalSummary } : {}),
    ...(item.outputFile ? { outputFile: item.outputFile } : {}),
    log: item.log,
  }));
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
