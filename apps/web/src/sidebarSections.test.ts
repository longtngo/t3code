import { describe, expect, it } from "vite-plus/test";
import type { KnownTerminalSession } from "@t3tools/client-runtime/state/terminal";

import {
  deriveBackgroundItems,
  isAutoCleared,
  sortSidebarItems,
  visibleSidebarItems,
  type SidebarItem,
} from "./sidebarSections";

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
      {
        kind: "background",
        id: "done-old",
        label: "",
        status: "completed",
        startedAt: null,
        completedAt: "2026-06-13T00:00:01.000Z",
        exitCode: 0,
        buffer: "",
      },
      {
        kind: "background",
        id: "running",
        label: "",
        status: "running",
        startedAt: "2026-06-13T00:00:00.000Z",
        completedAt: null,
        exitCode: null,
        buffer: "",
      },
      {
        kind: "background",
        id: "done-new",
        label: "",
        status: "failed",
        startedAt: null,
        completedAt: "2026-06-13T00:00:09.000Z",
        exitCode: 1,
        buffer: "",
      },
    ];
    expect(sortSidebarItems(items).map((i) => i.id)).toEqual(["running", "done-new", "done-old"]);
  });

  it("is stable with missing timestamps (tiebreak by id)", () => {
    const items: SidebarItem[] = [
      {
        kind: "background",
        id: "b",
        label: "",
        status: "running",
        startedAt: null,
        completedAt: null,
        exitCode: null,
        buffer: "",
      },
      {
        kind: "background",
        id: "a",
        label: "",
        status: "running",
        startedAt: null,
        completedAt: null,
        exitCode: null,
        buffer: "",
      },
    ];
    expect(sortSidebarItems(items).map((i) => i.id)).toEqual(["a", "b"]);
  });
});

describe("isAutoCleared / visibleSidebarItems", () => {
  const now = Date.parse("2026-06-13T12:00:00.000Z");

  it("auto-clears a completed item older than the TTL but not a recent one", () => {
    expect(
      isAutoCleared({ status: "completed", completedAt: "2026-06-13T05:00:00.000Z" }, now, 6),
    ).toBe(true);
    expect(
      isAutoCleared({ status: "completed", completedAt: "2026-06-13T11:00:00.000Z" }, now, 6),
    ).toBe(false);
    expect(isAutoCleared({ status: "running", completedAt: null }, now, 6)).toBe(false);
  });

  it("hides dismissed and auto-cleared items, keeps the rest sorted", () => {
    const items: SidebarItem[] = [
      {
        kind: "background",
        id: "keep",
        label: "",
        status: "running",
        startedAt: "2026-06-13T11:59:00.000Z",
        completedAt: null,
        exitCode: null,
        buffer: "",
      },
      {
        kind: "background",
        id: "dismissed",
        label: "",
        status: "completed",
        startedAt: null,
        completedAt: "2026-06-13T11:59:00.000Z",
        exitCode: 0,
        buffer: "",
      },
      {
        kind: "background",
        id: "old",
        label: "",
        status: "completed",
        startedAt: null,
        completedAt: "2026-06-13T01:00:00.000Z",
        exitCode: 0,
        buffer: "",
      },
    ];
    const visible = visibleSidebarItems(items, new Set(["dismissed"]), now, 6);
    expect(visible.map((i) => i.id)).toEqual(["keep"]);
  });
});

function makeSummary(overrides: {
  exitCode: number | null;
}): KnownTerminalSession["state"]["summary"] {
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
