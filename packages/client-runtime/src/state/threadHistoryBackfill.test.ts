import { describe, expect, it } from "vite-plus/test";

import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import type {
  OrchestrationMessage,
  OrchestrationThread,
  OrchestrationThreadActivity,
  OrchestrationThreadHistoryPageResult,
} from "@t3tools/contracts";

import { prependThreadHistoryPage } from "./threadHistoryBackfill.ts";

const baseThread: OrchestrationThread = {
  id: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  title: "Test Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};

const message = (id: string, createdAt: string): OrchestrationMessage => ({
  id: MessageId.make(id),
  role: "assistant",
  text: id,
  turnId: TurnId.make(`turn-${id}`),
  streaming: false,
  createdAt,
  updatedAt: createdAt,
});

const activity = (id: string, sequence: number, createdAt: string): OrchestrationThreadActivity => ({
  id: EventId.make(id),
  tone: "info",
  kind: "note",
  summary: id,
  payload: {},
  turnId: null,
  sequence,
  createdAt,
});

const emptyPage: OrchestrationThreadHistoryPageResult = {
  messages: [],
  activities: [],
  proposedPlans: [],
  checkpoints: [],
  hasMoreHistory: false,
};

describe("prependThreadHistoryPage", () => {
  it("prepends older messages ahead of the windowed (newer) ones, sorted ascending", () => {
    const thread: OrchestrationThread = {
      ...baseThread,
      // The windowed snapshot holds the two most-recent messages.
      messages: [message("m3", "2026-04-01T03:00:00.000Z"), message("m4", "2026-04-01T04:00:00.000Z")],
    };
    const page: OrchestrationThreadHistoryPageResult = {
      ...emptyPage,
      // The older page holds the two earliest.
      messages: [message("m1", "2026-04-01T01:00:00.000Z"), message("m2", "2026-04-01T02:00:00.000Z")],
    };

    const merged = prependThreadHistoryPage(thread, page);

    expect(merged.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4"]);
  });

  it("dedupes an overlapping row by id, keeping the live (existing) copy", () => {
    const live = { ...message("m2", "2026-04-01T02:00:00.000Z"), text: "live-edit" };
    const thread: OrchestrationThread = { ...baseThread, messages: [live] };
    const page: OrchestrationThreadHistoryPageResult = {
      ...emptyPage,
      messages: [
        message("m1", "2026-04-01T01:00:00.000Z"),
        // Same id as the live copy but the stale historical text.
        { ...message("m2", "2026-04-01T02:00:00.000Z"), text: "stale" },
      ],
    };

    const merged = prependThreadHistoryPage(thread, page);

    expect(merged.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(merged.messages.find((m) => m.id === "m2")?.text).toBe("live-edit");
  });

  it("merges activities by sequence and leaves the thread head untouched", () => {
    const thread: OrchestrationThread = {
      ...baseThread,
      title: "Head stays",
      activities: [activity("a2", 2, "2026-04-01T02:00:00.000Z")],
    };
    const page: OrchestrationThreadHistoryPageResult = {
      ...emptyPage,
      activities: [activity("a1", 1, "2026-04-01T01:00:00.000Z")],
    };

    const merged = prependThreadHistoryPage(thread, page);

    expect(merged.activities.map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(merged.title).toBe("Head stays");
    // Returns a new object; the input thread is not mutated.
    expect(thread.activities.map((a) => a.id)).toEqual(["a2"]);
  });

  it("is a no-op on the collections for an empty final page", () => {
    const thread: OrchestrationThread = {
      ...baseThread,
      messages: [message("m1", "2026-04-01T01:00:00.000Z")],
    };
    const merged = prependThreadHistoryPage(thread, emptyPage);
    expect(merged.messages.map((m) => m.id)).toEqual(["m1"]);
  });
});
