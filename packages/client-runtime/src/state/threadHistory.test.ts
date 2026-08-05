import { MessageId, ThreadId, TurnId, type OrchestrationThreadHistoryPageResult } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  EMPTY_THREAD_HISTORY_BACKFILL_STATE,
  mergeOlderHistoryPages,
  resolveThreadHistory,
  type ThreadHistoryBackfillState,
} from "./threadHistory.ts";

const THREAD_ID = ThreadId.make("thread-1");

const cursor = (turn: string, count: number) => ({
  requestedAt: "2026-04-01T00:00:00.000Z",
  turnId: turn,
  checkpointTurnCount: count,
});

const message = (id: string, createdAt: string) => ({
  id: MessageId.make(id),
  threadId: THREAD_ID,
  turnId: TurnId.make("turn-1"),
  role: "user" as const,
  text: id,
  attachments: [],
  createdAt,
  updatedAt: createdAt,
  streaming: false,
});

const page = (
  overrides: Partial<OrchestrationThreadHistoryPageResult> = {},
): OrchestrationThreadHistoryPageResult => ({
  messages: [],
  activities: [],
  proposedPlans: [],
  checkpoints: [],
  hasMoreHistory: false,
  ...overrides,
});

describe("mergeOlderHistoryPages", () => {
  it("returns the first page as-is", () => {
    const first = page({ messages: [message("m1", "2026-04-01T00:00:00.000Z")] });

    expect(mergeOlderHistoryPages(null, first)).toBe(first);
  });

  it("accumulates rows across pages", () => {
    const first = page({ messages: [message("m1", "2026-04-01T00:00:00.000Z")] });
    const second = page({
      messages: [message("m2", "2026-03-31T00:00:00.000Z")],
      oldestLoaded: cursor("turn-2", 2),
      hasMoreHistory: true,
    });

    const merged = mergeOlderHistoryPages(first, second);

    expect(merged.messages.map((row) => row.id)).toEqual(["m1", "m2"]);
    expect(merged.hasMoreHistory).toBe(true);
    expect(merged.oldestLoaded).toEqual(cursor("turn-2", 2));
  });

  it("does not double-insert a page that arrives twice", () => {
    // A retry or a resubscribe can re-issue the same cursor; the same rows coming
    // back must not duplicate every message in the transcript.
    const first = page({ messages: [message("m1", "2026-04-01T00:00:00.000Z")] });

    const merged = mergeOlderHistoryPages(first, first);

    expect(merged.messages.map((row) => row.id)).toEqual(["m1"]);
  });

  it("carries the newest page's end-of-history verdict", () => {
    const first = page({ hasMoreHistory: true });
    const second = page({ hasMoreHistory: false });

    expect(mergeOlderHistoryPages(first, second).hasMoreHistory).toBe(false);
  });
});

describe("resolveThreadHistory", () => {
  it("uses the snapshot window before any page is fetched", () => {
    const resolved = resolveThreadHistory(
      { oldestLoaded: cursor("turn-10", 10), hasMoreHistory: true },
      EMPTY_THREAD_HISTORY_BACKFILL_STATE,
    );

    expect(resolved.cursor).toEqual(cursor("turn-10", 10));
    expect(resolved.canLoadOlder).toBe(true);
  });

  it("prefers the backfill cursor once a page has been fetched", () => {
    const backfill: ThreadHistoryBackfillState = {
      ...EMPTY_THREAD_HISTORY_BACKFILL_STATE,
      oldestLoaded: cursor("turn-5", 5),
      hasMore: true,
    };

    const resolved = resolveThreadHistory(
      { oldestLoaded: cursor("turn-10", 10), hasMoreHistory: true },
      backfill,
    );

    // Paging from the snapshot cursor again would re-fetch a page already held.
    expect(resolved.cursor).toEqual(cursor("turn-5", 5));
  });

  it("stops offering to load once the backfill reached the beginning", () => {
    const backfill: ThreadHistoryBackfillState = {
      ...EMPTY_THREAD_HISTORY_BACKFILL_STATE,
      oldestLoaded: cursor("turn-0", 0),
      hasMore: false,
    };

    const resolved = resolveThreadHistory(
      { oldestLoaded: cursor("turn-10", 10), hasMoreHistory: true },
      backfill,
    );

    expect(resolved.canLoadOlder).toBe(false);
  });

  it("does not offer to load when there is no cursor to page from", () => {
    // `hasMoreHistory` without a cursor cannot produce a request; offering the
    // control would give the reader a button that does nothing.
    const resolved = resolveThreadHistory(
      { oldestLoaded: undefined, hasMoreHistory: true },
      EMPTY_THREAD_HISTORY_BACKFILL_STATE,
    );

    expect(resolved.cursor).toBe(null);
    expect(resolved.canLoadOlder).toBe(false);
  });

  it("reports an unwindowed thread as fully loaded", () => {
    const resolved = resolveThreadHistory(
      { oldestLoaded: undefined, hasMoreHistory: false },
      EMPTY_THREAD_HISTORY_BACKFILL_STATE,
    );

    expect(resolved.canLoadOlder).toBe(false);
    expect(resolved.error).toBe(null);
  });

  it("surfaces the backfill's loading and error state", () => {
    const resolved = resolveThreadHistory(
      { oldestLoaded: cursor("turn-10", 10), hasMoreHistory: true },
      { ...EMPTY_THREAD_HISTORY_BACKFILL_STATE, isLoading: true, error: "Network unreachable" },
    );

    expect(resolved.isLoading).toBe(true);
    expect(resolved.error).toBe("Network unreachable");
  });
});
