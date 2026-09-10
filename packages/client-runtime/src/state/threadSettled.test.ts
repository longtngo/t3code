import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  hasQueuedTurnStart,
  waitingUserMessageIds,
  hasWaitingUserMessage,
} from "./threadSettled.ts";

const NOW = "2026-04-10T00:00:00.000Z";
const FRESH = "2026-04-09T00:00:00.000Z";
const STALE = "2026-04-06T23:59:59.999Z";

/**
 * Upstream #8600 moved thread settling to the server and deleted this whole file.
 * The fork keeps it because its OTHER subjects survive that move: the queued-turn-start
 * grace window, and the fork-only held-message labelling (`hasWaitingUserMessage` /
 * `waitingUserMessageIds`) that backs the composer's waiting strip. The four describe
 * blocks covering the now-server-side computation are deliberately gone with it.
 */

function makeShell(input: {
  readonly settledOverride?: "settled" | "active" | null;
  readonly activityAt: string | null;
  readonly sessionStatus?: "starting" | "running";
  readonly pending?: "approval" | "user-input";
}): OrchestrationThreadShell {
  const threadId = ThreadId.make("thread-1");
  return {
    id: threadId,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn:
      input.activityAt === null
        ? null
        : {
            turnId: TurnId.make("turn-1"),
            state: "completed",
            requestedAt: input.activityAt,
            startedAt: null,
            completedAt: null,
            assistantMessageId: null,
          },
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: input.settledOverride ?? null,
    settledAt: input.settledOverride === "settled" ? NOW : null,
    session:
      input.sessionStatus === undefined
        ? null
        : {
            threadId,
            status: input.sessionStatus,
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: NOW,
          },
    latestUserMessageAt: null,
    hasPendingApprovals: input.pending === "approval",
    hasPendingUserInput: input.pending === "user-input",
    hasActionableProposedPlan: false,
    hasPendingBackgroundTask: false,
  };
}

describe("hasQueuedTurnStart", () => {
  const QUEUED_AT = "2026-04-09T12:00:00.000Z";
  // Within the adoption grace window of the queued message.
  const JUST_AFTER = { now: "2026-04-09T12:00:30.000Z" };

  it("flags a user message no turn has picked up, within the grace window", () => {
    const noTurn = { latestUserMessageAt: QUEUED_AT, latestTurn: null, session: null };
    expect(hasQueuedTurnStart(noTurn, JUST_AFTER)).toBe(true);

    const staleTurn = {
      ...makeShell({ activityAt: FRESH }),
      latestUserMessageAt: QUEUED_AT,
    };
    expect(hasQueuedTurnStart(staleTurn, JUST_AFTER)).toBe(true);
  });

  it("expires after the grace window: an unadopted message is a failed start, not queued work", () => {
    const noTurn = { latestUserMessageAt: QUEUED_AT, latestTurn: null, session: null };
    expect(hasQueuedTurnStart(noTurn, { now: "2026-04-09T12:03:00.000Z" })).toBe(false);
    // Historical shells (e.g. from servers that never carried latestTurn)
    // must never read as queued.
    expect(hasQueuedTurnStart(noTurn, { now: NOW })).toBe(false);
  });

  it("clears once a turn adopts the message or the start fails", () => {
    const adopted = {
      ...makeShell({ activityAt: QUEUED_AT }),
      latestUserMessageAt: QUEUED_AT,
    };
    expect(hasQueuedTurnStart(adopted, JUST_AFTER)).toBe(false);

    const failed = makeShell({ activityAt: FRESH });
    const failedShell = {
      ...failed,
      latestUserMessageAt: QUEUED_AT,
      session: {
        threadId: failed.id,
        status: "error" as const,
        providerName: "codex",
        runtimeMode: "full-access" as const,
        activeTurnId: null,
        lastError: "boom",
        updatedAt: NOW,
      },
    };
    expect(hasQueuedTurnStart(failedShell, JUST_AFTER)).toBe(false);
  });

  it("is quiet without user messages", () => {
    expect(hasQueuedTurnStart(makeShell({ activityAt: FRESH }), JUST_AFTER)).toBe(false);
  });

  it("bounds the grace window in both directions: a future-stamped message is skew, not queued work", () => {
    // Message timestamps originate on other devices; a clock an hour ahead
    // must not hold the queued state for the whole skew.
    const skewed = {
      latestUserMessageAt: "2026-04-09T13:00:00.000Z",
      latestTurn: null,
      session: null,
    };
    expect(hasQueuedTurnStart(skewed, { now: "2026-04-09T12:00:00.000Z" })).toBe(false);
    // A small negative age (within the grace window) still reads as queued.
    const slightlyAhead = {
      latestUserMessageAt: "2026-04-09T12:00:30.000Z",
      latestTurn: null,
      session: null,
    };
    expect(hasQueuedTurnStart(slightlyAhead, { now: "2026-04-09T12:00:00.000Z" })).toBe(true);
  });
});

describe("hasWaitingUserMessage", () => {
  const TURN_AT = "2026-04-09T12:00:00.000Z";
  const SENT_MID_TURN = "2026-04-09T12:00:30.000Z";
  const ACTIVE_TURN = TurnId.make("turn-1");

  /**
   * A thread whose turn is genuinely running, with a user message sent after
   * that turn started — the shape a provider produces while holding a message
   * behind the turn in flight.
   */
  function midTurnShell(overrides?: {
    readonly activeTurnId?: TurnId | null;
    readonly status?: "starting" | "running";
    readonly completedAt?: string | null;
    readonly providerName?: string | null;
    readonly latestTurnId?: TurnId;
    readonly latestUserMessageAt?: string | null;
  }) {
    const base = makeShell({ activityAt: TURN_AT, sessionStatus: overrides?.status ?? "running" });
    return {
      ...base,
      latestUserMessageAt:
        overrides?.latestUserMessageAt === undefined
          ? SENT_MID_TURN
          : overrides.latestUserMessageAt,
      latestTurn:
        base.latestTurn === null
          ? null
          : {
              ...base.latestTurn,
              turnId: overrides?.latestTurnId ?? ACTIVE_TURN,
              state: "running" as const,
              startedAt: TURN_AT,
              completedAt: overrides?.completedAt ?? null,
            },
      session:
        base.session === null
          ? null
          : {
              ...base.session,
              providerName:
                overrides?.providerName === undefined ? "claudeAgent" : overrides.providerName,
              activeTurnId:
                overrides?.activeTurnId === undefined ? ACTIVE_TURN : overrides.activeTurnId,
            },
    };
  }

  it("flags a message held while a turn is running", () => {
    expect(hasWaitingUserMessage(midTurnShell())).toBe(true);
  });

  it("flags it while the session is still starting", () => {
    expect(hasWaitingUserMessage(midTurnShell({ status: "starting" }))).toBe(true);
  });

  it("does not expire — a held message outlives any grace window", () => {
    // Bounded by the turn ending, not by a clock: measured holds reach a p90
    // of 36 minutes, far past QUEUED_TURN_START_GRACE_MS, and are still waiting.
    const longHeld = midTurnShell({ latestUserMessageAt: "2026-04-09T12:00:01.000Z" });
    expect(hasWaitingUserMessage(longHeld)).toBe(true);
  });

  it("clears once no turn is active", () => {
    expect(hasWaitingUserMessage(midTurnShell({ activeTurnId: null }))).toBe(false);
  });

  it("clears once the running turn reports a completion", () => {
    // Separate from the active-turn gate above, which would short-circuit and
    // leave this comparison untested.
    const completed = midTurnShell({ completedAt: "2026-04-09T12:05:00.000Z" });
    expect(hasWaitingUserMessage(completed)).toBe(false);
  });

  it("refuses when latestTurn is not the turn that is actually running", () => {
    // thread.turn-diff-completed for the PREVIOUS turn rewrites latestTurnId
    // unconditionally and asynchronously, regressing it to an older completed
    // turn. Without this gate the message being worked on reads as waiting.
    const regressed = midTurnShell({ latestTurnId: TurnId.make("turn-0") });
    expect(hasWaitingUserMessage(regressed)).toBe(false);
  });

  it.each(["cursor", "grok", "opencode"])(
    "refuses on %s, which reuses the running turn and never announces a new one",
    (providerName) => {
      expect(hasWaitingUserMessage(midTurnShell({ providerName }))).toBe(false);
    },
  );

  it.each(["claudeAgent", "codex"])(
    "flags on %s, which opens a turn of its own",
    (providerName) => {
      expect(hasWaitingUserMessage(midTurnShell({ providerName }))).toBe(true);
    },
  );

  it("refuses when the provider is unknown", () => {
    expect(hasWaitingUserMessage(midTurnShell({ providerName: null }))).toBe(false);
  });

  it("does not flag an ordinary send on a thread with no session", () => {
    const idle = { ...makeShell({ activityAt: TURN_AT }), latestUserMessageAt: SENT_MID_TURN };
    expect(hasWaitingUserMessage(idle)).toBe(false);
  });

  it("does not flag the message that started the running turn", () => {
    expect(hasWaitingUserMessage(midTurnShell({ latestUserMessageAt: TURN_AT }))).toBe(false);
  });

  it("ignores a thread with no user message", () => {
    expect(hasWaitingUserMessage(midTurnShell({ latestUserMessageAt: null }))).toBe(false);
  });

  it("ignores an unparseable message timestamp", () => {
    expect(hasWaitingUserMessage(midTurnShell({ latestUserMessageAt: "not-a-date" }))).toBe(false);
  });
});

describe("waitingUserMessageIds", () => {
  const TURN_AT = "2026-04-09T12:00:00.000Z";
  const ACTIVE_TURN = TurnId.make("turn-1");

  /** A thread whose turn-1 is genuinely running, as while it holds messages. */
  function runningShell(overrides?: { readonly providerName?: string | null }) {
    const base = makeShell({ activityAt: TURN_AT, sessionStatus: "running" });
    return {
      ...base,
      latestUserMessageAt: TURN_AT,
      latestTurn: base.latestTurn === null ? null : { ...base.latestTurn, turnId: ACTIVE_TURN },
      session:
        base.session === null
          ? null
          : {
              ...base.session,
              activeTurnId: ACTIVE_TURN,
              // makeShell defaults to "Codex"; the live projection only ever
              // stores lowercase provider names (claudeAgent/codex/cursor).
              providerName: overrides?.providerName ?? "claudeAgent",
            },
    } as unknown as Parameters<typeof waitingUserMessageIds>[0];
  }

  const message = (id: string, role: string, createdAt: string) => ({ id, role, createdAt });

  it("labels every message held behind the running turn, not only the newest", () => {
    const ids = waitingUserMessageIds(runningShell(), [
      message("m1", "user", TURN_AT),
      message("m2", "user", "2026-04-09T12:00:30.000Z"),
      message("m3", "user", "2026-04-09T12:01:00.000Z"),
    ]);
    expect([...ids].sort()).toEqual(["m2", "m3"]);
  });

  it("excludes the message that started the turn", () => {
    const ids = waitingUserMessageIds(runningShell(), [message("m1", "user", TURN_AT)]);
    expect(ids.size).toBe(0);
  });

  it("ignores assistant messages sent during the turn", () => {
    const ids = waitingUserMessageIds(runningShell(), [
      message("a1", "assistant", "2026-04-09T12:00:30.000Z"),
      message("m2", "user", "2026-04-09T12:00:30.000Z"),
    ]);
    expect([...ids]).toEqual(["m2"]);
  });

  it("labels nothing on a provider that reuses the running turn", () => {
    const ids = waitingUserMessageIds(runningShell({ providerName: "cursor" }), [
      message("m2", "user", "2026-04-09T12:00:30.000Z"),
    ]);
    expect(ids.size).toBe(0);
  });

  it("labels nothing when no turn is in flight", () => {
    const base = makeShell({ activityAt: TURN_AT, sessionStatus: "running" });
    const idle = {
      ...base,
      session: base.session === null ? null : { ...base.session, activeTurnId: null },
    } as unknown as Parameters<typeof waitingUserMessageIds>[0];
    expect(
      waitingUserMessageIds(idle, [message("m2", "user", "2026-04-09T12:00:30.000Z")]).size,
    ).toBe(0);
  });

  it("skips a message with an unparseable timestamp", () => {
    const ids = waitingUserMessageIds(runningShell(), [
      message("bad", "user", "not-a-date"),
      message("m2", "user", "2026-04-09T12:00:30.000Z"),
    ]);
    expect([...ids]).toEqual(["m2"]);
  });
});
