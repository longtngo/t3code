import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture, type ThreadFixtureOverrides } from "../test-fixtures";
import { threadQueueEntryKey } from "../threadQueueRules";
import {
  isSidebarThreadActive,
  isSidebarThreadWoke,
  resolveSidebarV2TopStatus,
  sidebarSectionCounts,
} from "./Sidebar.logic";

const WOKE_AT = "2026-03-09T12:00:00.000Z";
const READ = "2026-03-09T11:00:00.000Z";
const completedRun = {
  runId: "turn-1" as never,
  status: "completed" as const,
  assistantMessageId: null,
  requestedAt: "2026-03-09T10:00:00.000Z",
  startedAt: "2026-03-09T10:00:00.000Z",
  completedAt: "2026-03-09T10:05:00.000Z",
};

describe("isSidebarThreadWoke", () => {
  const woke = (lastVisitedAt: string | undefined, settledOverride: "settled" | null = null) =>
    isSidebarThreadWoke({ lastVisitedAt, wokeAt: WOKE_AT, settledOverride });

  it("is woke until a visit at or after the wake", () => {
    expect(woke(undefined)).toBe(true);
    expect(woke("2026-03-09T11:59:59.000Z")).toBe(true);
    expect(woke(WOKE_AT)).toBe(false);
    expect(woke("2026-03-09T12:00:01.000Z")).toBe(false);
  });

  it("treats an unparseable visit as never visited", () => {
    expect(woke("not a date")).toBe(true);
  });

  it("is never woke without a parseable wake, or once settled", () => {
    expect(
      isSidebarThreadWoke({ lastVisitedAt: undefined, wokeAt: null, settledOverride: null }),
    ).toBe(false);
    expect(
      isSidebarThreadWoke({ lastVisitedAt: undefined, wokeAt: "garbage", settledOverride: null }),
    ).toBe(false);
    expect(woke(undefined, "settled")).toBe(false);
  });
});

describe("resolveSidebarV2TopStatus", () => {
  it("shows woke over done, and each status over both", () => {
    const top = (status: Parameters<typeof resolveSidebarV2TopStatus>[0]["status"]) =>
      resolveSidebarV2TopStatus({ status, isUnread: true, isWoke: true });
    expect(top("ready")).toBe("woke");
    expect(top("failed")).toBe("failed");
    expect(top("limited")).toBe("limited");
    expect(resolveSidebarV2TopStatus({ status: "ready", isUnread: true, isWoke: false })).toBe(
      "done",
    );
    expect(resolveSidebarV2TopStatus({ status: "ready", isUnread: false, isWoke: false })).toBe(
      null,
    );
  });
});

describe("isSidebarThreadActive", () => {
  const runtime = (status: "running" | "idle" | "failed" | "completed", usageLimit = false) => ({
    status,
    activeRunId: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: "Codex",
    lastError: status === "failed" ? "boom" : null,
    ...(usageLimit ? { lastErrorClass: "usage_limit" as const } : {}),
    updatedAt: "2026-03-09T10:00:00.000Z",
  });
  const active = (
    overrides: ThreadFixtureOverrides,
    visit: { lastVisitedAt?: string; wokeAt?: string } = {},
  ) =>
    isSidebarThreadActive(
      makeThreadFixture({ runtime: null, latestRun: completedRun, ...overrides }),
      {
        lastVisitedAt: visit.lastVisitedAt ?? READ,
        wokeAt: visit.wokeAt ?? null,
      },
    );

  it("counts every labelled status as active", () => {
    expect(active({ runtime: runtime("running") })).toBe(true);
    expect(active({ runtime: runtime("idle") })).toBe(true);
    expect(active({ runtime: runtime("failed") })).toBe(true);
    expect(active({ runtime: runtime("failed", true) })).toBe(true);
    expect(active({ hasPendingApprovals: true })).toBe(true);
    expect(active({ hasPendingUserInput: true })).toBe(true);
  });

  it("counts an unread completion and an unvisited wake as active", () => {
    expect(active({}, { lastVisitedAt: "2026-03-09T10:01:00.000Z" })).toBe(true);
    expect(active({}, { wokeAt: WOKE_AT })).toBe(true);
  });

  it("counts a read, unwoken, finished thread as idle", () => {
    expect(active({})).toBe(false);
    expect(active({ runtime: runtime("completed") })).toBe(false);
    expect(active({ latestRun: null }, { wokeAt: WOKE_AT, lastVisitedAt: WOKE_AT })).toBe(false);
    expect(active({ settledOverride: "settled" }, { wokeAt: WOKE_AT })).toBe(false);
  });

  it("keeps a settled thread that is still working active", () => {
    expect(active({ settledOverride: "settled", runtime: runtime("running") })).toBe(true);
  });
});

describe("sidebarSectionCounts", () => {
  const NOW = "2026-03-09T13:00:00.000Z";
  const running = {
    status: "running" as const,
    activeRunId: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: "Codex",
    lastError: null,
    updatedAt: "2026-03-09T10:00:00.000Z",
  };
  // The fixture's server shell carries no `lastVisitedAt`, so the local visit map decides.
  const thread = (id: string, overrides: ThreadFixtureOverrides = {}) =>
    makeThreadFixture({
      id: ThreadId.make(id),
      runtime: null,
      latestRun: completedRun,
      ...overrides,
    });
  const key = (t: ReturnType<typeof thread>) =>
    threadQueueEntryKey({ environmentId: t.environmentId, threadId: t.id });
  const empty = { working: [], snoozed: [], settled: [], custom: new Map(), queued: [] };

  it("reads visits from the local visit map", () => {
    const woke = thread("woke", { snoozedUntil: "2026-03-09T12:00:00.000Z" });
    const done = thread("done");
    const counts = (visits: Record<string, string>) =>
      sidebarSectionCounts({ ...empty, snoozed: [woke], settled: [done] }, visits, NOW);

    expect(counts({ [key(woke)]: "2026-03-09T12:30:00.000Z", [key(done)]: READ })).toMatchObject({
      snoozed: "0/1",
      settled: "0/1",
    });
    expect(
      counts({ [key(woke)]: "2026-03-09T11:30:00.000Z", [key(done)]: "2026-03-09T10:01:00.000Z" }),
    ).toMatchObject({ snoozed: "1/1", settled: "1/1" });
  });

  it("lets a server-tracked visit outrank a later local one", () => {
    const done = thread("done", { lastVisitedAt: "2026-03-09T10:01:00.000Z" });
    const counts = sidebarSectionCounts({ ...empty, settled: [done] }, { [key(done)]: READ }, NOW);

    expect(counts.settled).toBe("1/1");
  });

  it("totals each section over every row it holds", () => {
    const idle = (id: string) => thread(id);
    const busy = (id: string) => thread(id, { runtime: running });
    const visits = Object.fromEntries(
      ["w1", "w2", "w3", "s1", "s2", "d1", "d2", "d3", "d4", "c1", "c2"].map((id) => [
        key(idle(id)),
        READ,
      ]),
    );
    const counts = sidebarSectionCounts(
      {
        working: [busy("w1"), busy("w2"), idle("w3")],
        snoozed: [idle("s1"), idle("s2")],
        settled: [busy("d1"), idle("d2"), idle("d3"), idle("d4")],
        custom: new Map([
          ["a", [busy("c1"), idle("c2")]],
          ["b", []],
        ]),
        queued: [],
      },
      visits,
      NOW,
    );

    expect(counts.working).toBe("2/3");
    expect(counts.snoozed).toBe("0/2");
    expect(counts.settled).toBe("1/4");
    expect([...counts.custom]).toEqual([
      ["a", "1/2"],
      ["b", "0/0"],
    ]);
  });

  it("marks only active queued threads, by their queue entry key", () => {
    const busy = thread("busy", { runtime: running });
    const idle = thread("idle");
    const counts = sidebarSectionCounts(
      { ...empty, queued: [busy, idle] },
      { [key(busy)]: READ, [key(idle)]: READ },
      NOW,
    );

    expect([...counts.activeQueuedKeys]).toEqual([key(busy)]);
  });
});
