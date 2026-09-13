/**
 * Folds a thread's `task.*` activity rows into the Background panel's rows.
 *
 * A row is a top-level background task: `agentKind: "background"`, not launched from inside a
 * subagent, and not plan-mode bookkeeping. That is the same population the liveness registry
 * counts as watch loops, so the panel and the "Monitoring" status agree.
 *
 * Status comes from the task's last terminal row. Without one, only the in-memory registry can
 * say it is still running; persisted rows cannot tell a live shell from one whose session died,
 * so such a task reads `stopped`.
 *
 * @module BackgroundTasks
 */
import { INERT_TASK_TYPES, type OrchestrationBackgroundTask } from "@t3tools/contracts";

export interface BackgroundTaskActivityRow {
  readonly kind: string;
  readonly payload: unknown;
  readonly createdAt: string;
}

const TITLE_LIMIT = 200;
const SUMMARY_LIMIT = 300;

const STATUS_BY_TERMINAL: Readonly<Record<string, OrchestrationBackgroundTask["status"]>> = {
  completed: "completed",
  failed: "failed",
  stopped: "stopped",
  cancelled: "stopped",
  interrupted: "stopped",
};

function text(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`;
}

function payloadOf(row: BackgroundTaskActivityRow): Record<string, unknown> | null {
  return typeof row.payload === "object" && row.payload !== null
    ? (row.payload as Record<string, unknown>)
    : null;
}

/**
 * `rows` must be in activity order (oldest first). Keeps tasks started at or after `sinceIso`
 * plus every task in `liveTaskIds`; running first (oldest start first), then the rest newest
 * first.
 */
export function foldBackgroundTasks(
  rows: ReadonlyArray<BackgroundTaskActivityRow>,
  liveTaskIds: ReadonlySet<string>,
  sinceIso: string,
): ReadonlyArray<OrchestrationBackgroundTask> {
  const started = new Map<string, { title: string; taskType: string | null; startedAt: string }>();
  const terminal = new Map<
    string,
    { status: OrchestrationBackgroundTask["status"]; endedAt: string; summary: string | null }
  >();

  for (const row of rows) {
    const payload = payloadOf(row);
    const taskId = payload ? text(payload.taskId, Number.MAX_SAFE_INTEGER) : null;
    if (!payload || !taskId) continue;

    if (row.kind === "task.started") {
      const taskType = text(payload.taskType, 100);
      const ownedByAgent = text(payload.agentId, Number.MAX_SAFE_INTEGER) !== null;
      if (payload.agentKind !== "background" || ownedByAgent) continue;
      if (taskType !== null && INERT_TASK_TYPES.has(taskType)) continue;
      if (started.has(taskId)) continue;
      started.set(taskId, {
        title:
          text(payload.title, TITLE_LIMIT) ??
          text(payload.detail, TITLE_LIMIT) ??
          taskType ??
          "Background task",
        taskType,
        startedAt: row.createdAt,
      });
      continue;
    }

    if (row.kind !== "task.completed" && row.kind !== "task.updated") continue;
    const rawStatus = typeof payload.status === "string" ? payload.status : undefined;
    // A status-free task.updated is a metadata change; a status-free task.completed still ends it.
    const status =
      rawStatus === undefined
        ? row.kind === "task.completed"
          ? "completed"
          : undefined
        : STATUS_BY_TERMINAL[rawStatus];
    if (status === undefined) continue;
    terminal.set(taskId, {
      status,
      endedAt: row.createdAt,
      summary: text(payload.summary, SUMMARY_LIMIT) ?? text(payload.detail, SUMMARY_LIMIT),
    });
  }

  const tasks: Array<OrchestrationBackgroundTask> = [];
  for (const [taskId, start] of started) {
    const end = terminal.get(taskId);
    const status = end?.status ?? (liveTaskIds.has(taskId) ? "running" : "stopped");
    if (status !== "running" && start.startedAt < sinceIso) continue;
    tasks.push({
      taskId,
      title: start.title,
      taskType: start.taskType,
      status,
      startedAt: start.startedAt,
      endedAt: end?.endedAt ?? null,
      summary: end?.summary ?? null,
    });
  }

  return tasks.sort((left, right) => {
    const leftRunning = left.status === "running";
    if (leftRunning !== (right.status === "running")) return leftRunning ? -1 : 1;
    if (leftRunning) return left.startedAt.localeCompare(right.startedAt);
    return (right.endedAt ?? right.startedAt).localeCompare(left.endedAt ?? left.startedAt);
  });
}
