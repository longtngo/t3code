import { describe, expect, it } from "vite-plus/test";

import { foldBackgroundTasks, type BackgroundTaskActivityRow } from "./BackgroundTasks.ts";

const SINCE = "2026-09-12T09:00:00.000Z";
const at = (time: string) => `2026-09-12T${time}:00.000Z`;
const started = (taskId: string, time: string, extra: Record<string, unknown> = {}) => ({
  kind: "task.started",
  createdAt: at(time),
  payload: { taskId, taskType: "local_bash", agentKind: "background", ...extra },
});
const ended = (kind: string, taskId: string, time: string, extra: Record<string, unknown>) => ({
  kind,
  createdAt: at(time),
  payload: { taskId, ...extra },
});

describe("foldBackgroundTasks", () => {
  it("takes status from the last terminal row, whatever order the start arrived in", () => {
    const rows: BackgroundTaskActivityRow[] = [
      ended("task.updated", "late-start", "09:20", { status: "completed" }),
      started("late-start", "09:10", { title: "Build" }),
      started("cancelled", "09:30"),
      ended("task.updated", "cancelled", "09:35", { status: "cancelled" }),
      started("metadata-only", "09:40"),
      ended("task.updated", "metadata-only", "09:45", { title: "Renamed" }),
    ];
    const tasks = foldBackgroundTasks(rows, new Set(["metadata-only"]), SINCE);
    expect(tasks.map((task) => [task.taskId, task.status])).toEqual([
      ["metadata-only", "running"],
      ["cancelled", "stopped"],
      ["late-start", "completed"],
    ]);
  });

  it("keeps the first start of a task and falls back from title to detail to type", () => {
    const tasks = foldBackgroundTasks(
      [
        started("a", "09:10", { title: "  ", detail: "From detail" }),
        started("a", "09:50", { title: "Second start" }),
        started("b", "09:20", { taskType: "monitor" }),
      ],
      new Set(["a", "b"]),
      SINCE,
    );
    expect(tasks.map((task) => [task.title, task.startedAt])).toEqual([
      ["From detail", at("09:10")],
      ["monitor", at("09:20")],
    ]);
  });

  it("orders finished tasks newest end first, and a stopped orphan by its start", () => {
    const tasks = foldBackgroundTasks(
      [
        started("early-end", "09:10"),
        started("orphan", "09:30"),
        ended("task.completed", "early-end", "09:20", {}),
        started("late-end", "09:15"),
        ended("task.completed", "late-end", "09:50", { status: "failed" }),
      ],
      new Set(),
      SINCE,
    );
    expect(tasks.map((task) => [task.taskId, task.status])).toEqual([
      ["late-end", "failed"],
      ["orphan", "stopped"],
      ["early-end", "completed"],
    ]);
  });
});
