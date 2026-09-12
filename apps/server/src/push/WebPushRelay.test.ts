import { describe, expect, it } from "vite-plus/test";

import { isInterimBackgroundLiveness, type NotificationCategorySettings } from "@t3tools/contracts";

import {
  buildPushPayload,
  classifyThreadNotifyEdges,
  filterEdgesByCategory,
  isAllowedPushEndpoint,
  type ThreadNotifyState,
} from "./WebPushRelay.ts";

const running: ThreadNotifyState = { latestTurnState: "running", hasPendingUserInput: false };
const completed: ThreadNotifyState = { latestTurnState: "completed", hasPendingUserInput: false };
const errored: ThreadNotifyState = { latestTurnState: "error", hasPendingUserInput: false };
const interrupted: ThreadNotifyState = {
  latestTurnState: "interrupted",
  hasPendingUserInput: false,
};
const runningAsking: ThreadNotifyState = { latestTurnState: "running", hasPendingUserInput: true };

describe("classifyThreadNotifyEdges — finished edge", () => {
  it("first sight (no previous) never fires — initialize baseline only", () => {
    expect(classifyThreadNotifyEdges(null, completed)).toEqual([]);
    expect(classifyThreadNotifyEdges(null, runningAsking)).toEqual([]);
    expect(classifyThreadNotifyEdges(null, running)).toEqual([]);
  });

  it("fires on running -> completed/error/interrupted", () => {
    expect(classifyThreadNotifyEdges(running, completed)).toEqual([
      { kind: "finished", outcome: "completed" },
    ]);
    expect(classifyThreadNotifyEdges(running, errored)).toEqual([
      { kind: "finished", outcome: "error" },
    ]);
    expect(classifyThreadNotifyEdges(running, interrupted)).toEqual([
      { kind: "finished", outcome: "interrupted" },
    ]);
  });

  it("does not re-fire once already terminal", () => {
    expect(classifyThreadNotifyEdges(completed, completed)).toEqual([]);
    expect(classifyThreadNotifyEdges(completed, errored)).toEqual([]);
  });

  it("does not fire while still running or on start (-> running)", () => {
    expect(classifyThreadNotifyEdges(running, running)).toEqual([]);
    expect(classifyThreadNotifyEdges(completed, running)).toEqual([]);
  });
});

describe("classifyThreadNotifyEdges — asking edge", () => {
  it("fires only on hasPendingUserInput false -> true", () => {
    expect(classifyThreadNotifyEdges(running, runningAsking)).toEqual([{ kind: "asking" }]);
  });

  it("does not re-fire while still pending", () => {
    expect(classifyThreadNotifyEdges(runningAsking, runningAsking)).toEqual([]);
  });

  it("does not fire when the question is resolved (true -> false)", () => {
    expect(classifyThreadNotifyEdges(runningAsking, running)).toEqual([]);
  });
});

describe("classifyThreadNotifyEdges — combined", () => {
  it("can emit both edges when a turn goes terminal AND input becomes pending", () => {
    const prev: ThreadNotifyState = { latestTurnState: "running", hasPendingUserInput: false };
    const next: ThreadNotifyState = { latestTurnState: "completed", hasPendingUserInput: true };
    expect(classifyThreadNotifyEdges(prev, next)).toEqual([
      { kind: "finished", outcome: "completed" },
      { kind: "asking" },
    ]);
  });

  it("treats a null latestTurnState as non-terminal", () => {
    const prev: ThreadNotifyState = { latestTurnState: null, hasPendingUserInput: false };
    const next: ThreadNotifyState = { latestTurnState: null, hasPendingUserInput: false };
    expect(classifyThreadNotifyEdges(prev, next)).toEqual([]);
  });
});

describe("isAllowedPushEndpoint", () => {
  it("allows real public push-service HTTPS endpoints", () => {
    expect(isAllowedPushEndpoint("https://fcm.googleapis.com/fcm/send/abc123")).toBe(true);
    expect(isAllowedPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/xyz")).toBe(
      true,
    );
    expect(isAllowedPushEndpoint("https://web.push.apple.com/abc")).toBe(true);
  });

  it("rejects non-HTTPS", () => {
    expect(isAllowedPushEndpoint("http://fcm.googleapis.com/x")).toBe(false);
    expect(isAllowedPushEndpoint("ftp://fcm.googleapis.com/x")).toBe(false);
  });

  it("rejects loopback / private / link-local IP hosts (SSRF)", () => {
    expect(isAllowedPushEndpoint("https://127.0.0.1/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://10.0.0.5/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://192.168.1.1/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://172.16.0.1/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://169.254.169.254/latest/meta-data")).toBe(false);
    expect(isAllowedPushEndpoint("https://[::1]/x")).toBe(false);
  });

  it("rejects localhost, .local, and single-label internal hosts", () => {
    expect(isAllowedPushEndpoint("https://localhost/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://printer.local/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://intranet/x")).toBe(false);
  });

  it("rejects garbage", () => {
    expect(isAllowedPushEndpoint("not a url")).toBe(false);
    expect(isAllowedPushEndpoint("")).toBe(false);
  });
});

describe("buildPushPayload", () => {
  it("finished/completed → 'Task finished'", () => {
    const payload = JSON.parse(
      buildPushPayload({
        edge: { kind: "finished", outcome: "completed" },
        title: "My thread",
        url: "/env/thread",
        threadId: "thread-1",
      }),
    );
    expect(payload).toEqual({
      title: "My thread",
      body: "Task finished",
      tag: "thread-1",
      url: "/env/thread",
      kind: "finished",
    });
  });

  it("finished/error and finished/interrupted use distinct bodies", () => {
    const err = JSON.parse(
      buildPushPayload({
        edge: { kind: "finished", outcome: "error" },
        title: "t",
        url: "/u",
        threadId: "id",
      }),
    );
    const intr = JSON.parse(
      buildPushPayload({
        edge: { kind: "finished", outcome: "interrupted" },
        title: "t",
        url: "/u",
        threadId: "id",
      }),
    );
    expect(err.body).toBe("Task stopped with an error");
    expect(intr.body).toBe("Task was interrupted");
  });

  it("asking → 'Waiting for your input'", () => {
    const payload = JSON.parse(
      buildPushPayload({ edge: { kind: "asking" }, title: "t", url: "/u", threadId: "id" }),
    );
    expect(payload.body).toBe("Waiting for your input");
    expect(payload.tag).toBe("id");
    expect(payload.kind).toBe("asking");
  });
});

describe("filterEdgesByCategory", () => {
  const allOn: NotificationCategorySettings = {
    finished: true,
    finishedBackground: true,
    needsInput: true,
    failed: true,
  };
  const finishedEdge = { kind: "finished", outcome: "completed" } as const;
  const interruptedEdge = { kind: "finished", outcome: "interrupted" } as const;
  const failedEdge = { kind: "finished", outcome: "error" } as const;
  const askingEdge = { kind: "asking" } as const;
  const everyEdge = [finishedEdge, interruptedEdge, failedEdge, askingEdge];

  it("passes everything through when no category is disabled", () => {
    expect(filterEdgesByCategory(everyEdge, allOn, null)).toEqual(everyEdge);
    expect(filterEdgesByCategory(everyEdge, allOn, "working")).toEqual(everyEdge);
  });

  it("drops nothing at all when there is nothing to drop", () => {
    expect(filterEdgesByCategory([], allOn, null)).toEqual([]);
  });

  it("treats an interrupted turn as finished, not as its own category", () => {
    const noFinished = { ...allOn, finished: false };
    expect(filterEdgesByCategory([finishedEdge, interruptedEdge], noFinished, null)).toEqual([]);
  });

  it("routes a finish to finishedBackground only while other work is still running", () => {
    const noInterim = { ...allOn, finishedBackground: false };
    const noFinished = { ...allOn, finished: false };

    // Background work still alive: this is an interim finish.
    expect(filterEdgesByCategory([finishedEdge], noInterim, "working")).toEqual([]);
    expect(filterEdgesByCategory([finishedEdge], noFinished, "working")).toEqual([finishedEdge]);

    // Nothing left running: this is the real completion and must survive
    // silencing the interim ones. This is the whole point of the split.
    expect(filterEdgesByCategory([finishedEdge], noInterim, null)).toEqual([finishedEdge]);
    expect(filterEdgesByCategory([finishedEdge], noFinished, null)).toEqual([]);
  });

  it("counts background shells as work still running", () => {
    // Subagents offloaded to another CLI run as background shells, which read
    // as "monitoring". Their settles are interim like an agent task's.
    const noInterim = { ...allOn, finishedBackground: false };
    expect(filterEdgesByCategory([finishedEdge], noInterim, "monitoring")).toEqual([]);
    expect(filterEdgesByCategory([finishedEdge], allOn, "monitoring")).toEqual([finishedEdge]);
  });

  it("keeps a failure in its own category even while background work runs", () => {
    // A failure is the alert people keep when they silence everything else;
    // reclassifying it as interim would hide it behind the noisy switch.
    const noInterim = { ...allOn, finishedBackground: false };
    expect(filterEdgesByCategory([failedEdge], noInterim, "working")).toEqual([failedEdge]);
    expect(filterEdgesByCategory([failedEdge], { ...allOn, failed: false }, "working")).toEqual([]);
  });

  it("gates an input request on needsInput regardless of background work", () => {
    const noInput = { ...allOn, needsInput: false };
    expect(filterEdgesByCategory([askingEdge], noInput, null)).toEqual([]);
    expect(filterEdgesByCategory([askingEdge], noInput, "working")).toEqual([]);
    expect(filterEdgesByCategory([askingEdge], allOn, "working")).toEqual([askingEdge]);
  });

  it("drops every edge when the user turns everything off", () => {
    const allOff: NotificationCategorySettings = {
      finished: false,
      finishedBackground: false,
      needsInput: false,
      failed: false,
    };
    expect(filterEdgesByCategory(everyEdge, allOff, null)).toEqual([]);
    expect(filterEdgesByCategory(everyEdge, allOff, "working")).toEqual([]);
  });
});

describe("isInterimBackgroundLiveness", () => {
  it("treats live agent work as interim", () => {
    expect(isInterimBackgroundLiveness("working")).toBe(true);
  });

  it("treats background shells and watch loops as interim", () => {
    expect(isInterimBackgroundLiveness("monitoring")).toBe(true);
  });

  it("reads an absent liveness as nothing running, so the alert still fires", () => {
    // The liveness map is in-memory, so it is empty after a restart. Failing
    // toward "notify" is the safe direction.
    expect(isInterimBackgroundLiveness(null)).toBe(false);
    expect(isInterimBackgroundLiveness(undefined)).toBe(false);
  });
});
