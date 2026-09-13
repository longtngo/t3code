import type { OrchestrationBackgroundTask, OrchestrationThreadActivity } from "@t3tools/contracts";
import { EventId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  backgroundTaskDetail,
  backgroundTasksPanelState,
  backgroundTasksRefreshKey,
} from "./BackgroundTasksPanel.logic";

const activity = (id: string, kind: string, payload: unknown): OrchestrationThreadActivity => ({
  id: EventId.make(id),
  tone: "info",
  kind,
  summary: "Task",
  payload,
  turnId: null,
  createdAt: "2026-09-13T10:00:00.000Z",
});

const task = (overrides: Partial<OrchestrationBackgroundTask>): OrchestrationBackgroundTask => ({
  taskId: "t1",
  title: "Run tests",
  taskType: "local_bash",
  status: "running",
  startedAt: "2026-09-13T10:00:00.000Z",
  endedAt: null,
  summary: null,
  ...overrides,
});

describe("backgroundTasksRefreshKey", () => {
  const shellStart = activity("bg-start", "task.started", { agentKind: "background" });
  const agentEnd = activity("agent-end", "task.completed", { agentKind: "agent" });
  const toolRow = activity("tool", "tool.completed", { agentKind: "background" });

  it("moves with the newest background lifecycle row, not agent or tool rows", () => {
    const base = backgroundTasksRefreshKey([shellStart], 1, "turn-1");
    expect(backgroundTasksRefreshKey([shellStart, agentEnd, toolRow], 1, "turn-1")).toBe(base);
    const shellEnd = activity("bg-end", "task.completed", { agentKind: "background" });
    expect(backgroundTasksRefreshKey([shellStart, shellEnd], 1, "turn-1")).not.toBe(base);
  });

  it("moves when the live count or the latest turn changes without a new row", () => {
    const base = backgroundTasksRefreshKey([shellStart], 1, "turn-1");
    expect(backgroundTasksRefreshKey([shellStart], 0, "turn-1")).not.toBe(base);
    expect(backgroundTasksRefreshKey([shellStart], 1, "turn-0")).not.toBe(base);
  });
});

describe("backgroundTaskDetail", () => {
  const now = Date.parse("2026-09-13T10:12:00.000Z");

  it("names the kind, the start, and how long a finished task ran", () => {
    expect(backgroundTaskDetail(task({}), now)).toBe("Shell · started 12m ago");
    expect(
      backgroundTaskDetail(
        task({ status: "failed", taskType: "monitor", endedAt: "2026-09-13T10:03:12.000Z" }),
        now,
      ),
    ).toBe("Monitor · started 12m ago · ran 3m 12s");
    expect(backgroundTaskDetail(task({ status: "stopped" }), now)).toBe(
      "Shell · started 12m ago · ended without a result",
    );
  });
});

describe("backgroundTasksPanelState", () => {
  it("keeps a landed list on screen while a refetch runs or fails", () => {
    const tasks = [task({})];
    expect(backgroundTasksPanelState(tasks, "pending")).toEqual({ kind: "list", failed: false });
    expect(backgroundTasksPanelState(tasks, "error")).toEqual({ kind: "list", failed: true });
    expect(backgroundTasksPanelState([], "ready")).toEqual({ kind: "empty" });
  });

  it("never reports an empty thread when there is no list to show", () => {
    expect(backgroundTasksPanelState(null, "unsupported")).toEqual({
      kind: "unavailable",
      canRetry: false,
    });
    expect(backgroundTasksPanelState(null, "error")).toEqual({
      kind: "unavailable",
      canRetry: true,
    });
    expect(backgroundTasksPanelState(null, "pending")).toEqual({ kind: "loading" });
  });
});
