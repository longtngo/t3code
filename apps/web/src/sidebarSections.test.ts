import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import type { KnownTerminalSession } from "@t3tools/client-runtime";

import {
  deriveAgentItems,
  deriveBackgroundItems,
  isAutoCleared,
  sortSidebarItems,
  visibleSidebarItems,
  type SidebarItem,
} from "./sidebarSections";

function activity(partial: {
  id: string;
  kind: string;
  createdAt: string;
  payload: unknown;
  summary?: string;
}): OrchestrationThreadActivity {
  return {
    tone: "info",
    summary: partial.summary ?? partial.kind,
    turnId: null,
    ...partial,
  } as unknown as OrchestrationThreadActivity;
}

function terminal(
  terminalId: string,
  state: Partial<KnownTerminalSession["state"]> & Pick<KnownTerminalSession["state"], "status">,
): KnownTerminalSession {
  return {
    target: { environmentId: "env-1" as never, threadId: "thread-1" as never, terminalId },
    state: {
      summary: null,
      buffer: "",
      error: null,
      hasRunningSubprocess: false,
      updatedAt: null,
      version: 1,
      ...state,
    },
  };
}

describe("deriveAgentItems", () => {
  it("folds task.* activities into one item per taskId with a progress log", () => {
    const items = deriveAgentItems([
      activity({
        id: "a1",
        kind: "task.started",
        createdAt: "2026-06-13T00:00:00.000Z",
        payload: { taskId: "t1", detail: "Explore auth code" },
      }),
      activity({
        id: "a2",
        kind: "task.progress",
        createdAt: "2026-06-13T00:00:05.000Z",
        payload: { taskId: "t1", summary: "Reading login.ts", lastToolName: "Read" },
      }),
      activity({
        id: "a3",
        kind: "task.completed",
        createdAt: "2026-06-13T00:00:10.000Z",
        payload: { taskId: "t1", status: "completed", detail: "Found 3 entrypoints", outputFile: "/tmp/out.md" },
      }),
    ]);

    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item).toMatchObject({
      kind: "agent",
      id: "t1",
      label: "Explore auth code",
      status: "completed",
      startedAt: "2026-06-13T00:00:00.000Z",
      completedAt: "2026-06-13T00:00:10.000Z",
      finalSummary: "Found 3 entrypoints",
      outputFile: "/tmp/out.md",
    });
    expect(item.log).toEqual([
      { id: "a2", at: "2026-06-13T00:00:05.000Z", text: "Reading login.ts", lastToolName: "Read" },
    ]);
  });

  it("maps completion status: failed→failed, stopped→completed, running stays running", () => {
    const items = deriveAgentItems([
      activity({ id: "s1", kind: "task.started", createdAt: "t0", payload: { taskId: "run" } }),
      activity({ id: "f1", kind: "task.started", createdAt: "t0", payload: { taskId: "fail" } }),
      activity({ id: "f2", kind: "task.completed", createdAt: "t1", payload: { taskId: "fail", status: "failed" } }),
      activity({ id: "p1", kind: "task.started", createdAt: "t0", payload: { taskId: "stop" } }),
      activity({ id: "p2", kind: "task.completed", createdAt: "t1", payload: { taskId: "stop", status: "stopped" } }),
    ]);
    const byId = new Map(items.map((i) => [i.id, i]));
    expect(byId.get("run")?.status).toBe("running");
    expect(byId.get("fail")?.status).toBe("failed");
    expect(byId.get("stop")?.status).toBe("completed");
  });

  it("ignores non-task activities and activities without a taskId", () => {
    const items = deriveAgentItems([
      activity({ id: "x1", kind: "tool.completed", createdAt: "t0", payload: { taskId: "t1" } }),
      activity({ id: "x2", kind: "task.started", createdAt: "t0", payload: {} }),
    ]);
    expect(items).toHaveLength(0);
  });
});

describe("deriveBackgroundItems", () => {
  it("maps terminal status to sidebar status", () => {
    const items = deriveBackgroundItems([
      terminal("run", { status: "running" }),
      terminal("start", { status: "starting" }),
      terminal("ok", { status: "exited", summary: makeSummary({ exitCode: 0 }) }),
      terminal("bad", { status: "exited", summary: makeSummary({ exitCode: 1 }) }),
      terminal("err", { status: "error" }),
      terminal("closed", { status: "closed" }),
    ]);
    const byId = new Map(items.map((i) => [i.id, i.status]));
    expect(byId.get("run")).toBe("running");
    expect(byId.get("start")).toBe("running");
    expect(byId.get("ok")).toBe("completed");
    expect(byId.get("bad")).toBe("failed");
    expect(byId.get("err")).toBe("failed");
    expect(byId.get("closed")).toBe("completed");
  });

  it("falls back to a default label when summary is null", () => {
    const [item] = deriveBackgroundItems([terminal("t", { status: "running" })]);
    expect(item?.label).toBe("Terminal");
    expect(item?.buffer).toBe("");
  });
});

describe("sortSidebarItems", () => {
  it("puts active before terminal, and sinks completed to the bottom", () => {
    const items: SidebarItem[] = [
      { kind: "agent", id: "done-old", label: "", status: "completed", startedAt: null, completedAt: "2026-06-13T00:00:01.000Z", log: [] },
      { kind: "agent", id: "running", label: "", status: "running", startedAt: "2026-06-13T00:00:00.000Z", completedAt: null, log: [] },
      { kind: "agent", id: "done-new", label: "", status: "failed", startedAt: null, completedAt: "2026-06-13T00:00:09.000Z", log: [] },
    ];
    expect(sortSidebarItems(items).map((i) => i.id)).toEqual(["running", "done-new", "done-old"]);
  });

  it("is stable with missing timestamps (tiebreak by id)", () => {
    const items: SidebarItem[] = [
      { kind: "background", id: "b", label: "", status: "running", startedAt: null, completedAt: null, exitCode: null, buffer: "" },
      { kind: "background", id: "a", label: "", status: "running", startedAt: null, completedAt: null, exitCode: null, buffer: "" },
    ];
    expect(sortSidebarItems(items).map((i) => i.id)).toEqual(["a", "b"]);
  });
});

describe("isAutoCleared / visibleSidebarItems", () => {
  const now = Date.parse("2026-06-13T12:00:00.000Z");

  it("auto-clears a completed item older than the TTL but not a recent one", () => {
    expect(isAutoCleared({ status: "completed", completedAt: "2026-06-13T05:00:00.000Z" }, now, 6)).toBe(true);
    expect(isAutoCleared({ status: "completed", completedAt: "2026-06-13T11:00:00.000Z" }, now, 6)).toBe(false);
    expect(isAutoCleared({ status: "running", completedAt: null }, now, 6)).toBe(false);
  });

  it("hides dismissed and auto-cleared items, keeps the rest sorted", () => {
    const items: SidebarItem[] = [
      { kind: "agent", id: "keep", label: "", status: "running", startedAt: "2026-06-13T11:59:00.000Z", completedAt: null, log: [] },
      { kind: "agent", id: "dismissed", label: "", status: "completed", startedAt: null, completedAt: "2026-06-13T11:59:00.000Z", log: [] },
      { kind: "agent", id: "old", label: "", status: "completed", startedAt: null, completedAt: "2026-06-13T01:00:00.000Z", log: [] },
    ];
    const visible = visibleSidebarItems(items, new Set(["dismissed"]), now, 6);
    expect(visible.map((i) => i.id)).toEqual(["keep"]);
  });
});

function makeSummary(overrides: { exitCode: number | null }): KnownTerminalSession["state"]["summary"] {
  return {
    threadId: "thread-1",
    terminalId: "t",
    cwd: "/repo",
    worktreePath: null,
    status: "exited",
    pid: null,
    exitCode: overrides.exitCode,
    exitSignal: null,
    hasRunningSubprocess: false,
    label: "npm run build",
    updatedAt: "2026-06-13T00:00:00.000Z",
  };
}
