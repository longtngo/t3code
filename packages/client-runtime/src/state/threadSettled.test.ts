import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canSettle,
  changeRequestAutoSettles,
  effectiveSettled,
  hasQueuedTurnStart,
  waitingUserMessageIds,
  hasWaitingUserMessage,
  threadLastActivityAt,
  type ChangeRequestStateLike,
} from "./threadSettled.ts";

const NOW = "2026-04-10T00:00:00.000Z";
const FRESH = "2026-04-09T00:00:00.000Z";
const STALE = "2026-04-06T23:59:59.999Z";

describe("changeRequestAutoSettles", () => {
  it.each([
    ["open", true, false],
    ["merged", true, true],
    ["merged", false, false],
    ["closed", false, true],
    [null, false, false],
  ] as const)("state=%s autoSettleOnMerge=%s returns %s", (state, autoSettleOnMerge, expected) => {
    expect(changeRequestAutoSettles(state === null ? null : { state }, { autoSettleOnMerge })).toBe(
      expected,
    );
  });

  const THREAD_CREATED_AT = "2026-04-01T00:00:00.000Z";
  const idleThread = {
    createdAt: THREAD_CREATED_AT,
    latestUserMessageAt: null,
    latestTurn: null,
  };

  it("ignores a terminal change request last touched before the thread existed", () => {
    for (const state of ["merged", "closed"] as const) {
      expect(
        changeRequestAutoSettles(
          { state, updatedAt: "2026-03-31T23:59:59.999Z" },
          { thread: idleThread },
        ),
      ).toBe(false);
    }
  });

  it("settles on a terminal change request touched at or after the thread's latest event", () => {
    for (const updatedAt of [THREAD_CREATED_AT, "2026-04-02T00:00:00.000Z"]) {
      expect(changeRequestAutoSettles({ state: "merged", updatedAt }, { thread: idleThread })).toBe(
        true,
      );
    }
  });

  it("never re-settles a thread revived after the merge", () => {
    // Settling on a merge happens once: a user message newer than the PR's
    // last activity means the conversation outlived the PR.
    const revived = {
      createdAt: THREAD_CREATED_AT,
      latestUserMessageAt: "2026-04-05T00:00:00.000Z",
      latestTurn: null,
    };
    expect(
      changeRequestAutoSettles(
        { state: "merged", updatedAt: "2026-04-03T00:00:00.000Z" },
        { thread: revived },
      ),
    ).toBe(false);
    // A merge landing after the revival still settles.
    expect(
      changeRequestAutoSettles(
        { state: "merged", updatedAt: "2026-04-06T00:00:00.000Z" },
        { thread: revived },
      ),
    ).toBe(true);
  });

  it("still settles when the merge lands during an in-flight turn", () => {
    // Anchor is user-initiated activity only: the agent finishing a turn
    // after the merge must not block the settle the merge earned.
    const midTurnMerge = {
      createdAt: THREAD_CREATED_AT,
      latestUserMessageAt: "2026-04-02T00:00:00.000Z",
      latestTurn: {
        turnId: TurnId.make("turn-mid"),
        state: "completed" as const,
        requestedAt: "2026-04-02T00:00:00.000Z",
        startedAt: "2026-04-02T00:00:05.000Z",
        completedAt: "2026-04-02T00:20:00.000Z",
        assistantMessageId: null,
      },
    };
    expect(
      changeRequestAutoSettles(
        { state: "merged", updatedAt: "2026-04-02T00:10:00.000Z" },
        { thread: midTurnMerge },
      ),
    ).toBe(true);
  });

  it("falls back to settling when either timestamp is missing or malformed", () => {
    expect(changeRequestAutoSettles({ state: "merged" }, { thread: idleThread })).toBe(true);
    expect(
      changeRequestAutoSettles({ state: "merged", updatedAt: null }, { thread: idleThread }),
    ).toBe(true);
    expect(
      changeRequestAutoSettles({ state: "merged", updatedAt: "2026-03-01T00:00:00.000Z" }, {}),
    ).toBe(true);
    expect(
      changeRequestAutoSettles(
        { state: "merged", updatedAt: "not-a-date" },
        { thread: idleThread },
      ),
    ).toBe(true);
  });
});

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

describe("threadLastActivityAt", () => {
  it("returns the latest real user or turn activity and ignores thread/session updates", () => {
    const shell = makeShell({ activityAt: null, sessionStatus: "running" });
    const withActivity: OrchestrationThreadShell = {
      ...shell,
      latestUserMessageAt: "2026-04-04T00:00:00.000Z",
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        state: "completed",
        requestedAt: "2026-04-03T00:00:00.000Z",
        startedAt: "2026-04-05T00:00:00.000Z",
        completedAt: "2026-04-06T00:00:00.000Z",
        assistantMessageId: null,
      },
    };

    expect(threadLastActivityAt(withActivity)).toBe("2026-04-06T00:00:00.000Z");
    expect(threadLastActivityAt(shell)).toBeNull();
  });
});

describe("effectiveSettled", () => {
  const overrideCases = [null, "settled", "active"] as const;
  const changeRequestStates = [undefined, "open", "merged"] as const;
  const inactivityCases = [
    ["fresh", FRESH],
    ["stale", STALE],
    ["no-activity", null],
  ] as const;
  const runningCases = [false, true] as const;
  const pendingCases = [undefined, "approval", "user-input"] as const;
  const truthTable = overrideCases.flatMap((settledOverride) =>
    changeRequestStates.flatMap((changeRequestState) =>
      inactivityCases.flatMap(([inactivity, activityAt]) =>
        runningCases.flatMap((running) =>
          pendingCases.map((pending) => ({
            settledOverride,
            changeRequestState,
            inactivity,
            activityAt,
            running,
            pending,
            // Settled iff nothing blocks (pending work / live session) AND
            // the override says settled, or (with no override) a merged PR
            // or staleness auto-settles. The "active" pin suppresses both
            // auto signals, and an open PR suppresses the inactivity path:
            // a thread with a PR out for review is never done, however quiet.
            expected:
              pending === undefined &&
              !running &&
              (settledOverride === "settled" ||
                (settledOverride === null &&
                  (changeRequestState === "merged" ||
                    (changeRequestState !== "open" && inactivity === "stale")))),
          })),
        ),
      ),
    ),
  );

  it.each(truthTable)(
    "override=$settledOverride pr=$changeRequestState inactivity=$inactivity running=$running pending=$pending",
    ({ settledOverride, changeRequestState, activityAt, running, pending, expected }) => {
      const shell = makeShell({
        settledOverride,
        activityAt,
        ...(running ? { sessionStatus: "running" as const } : {}),
        ...(pending === undefined ? {} : { pending }),
      });
      const changeRequestOptions =
        changeRequestState === undefined
          ? {}
          : { changeRequest: { state: changeRequestState as ChangeRequestStateLike } };

      expect(
        effectiveSettled(shell, {
          now: NOW,
          autoSettleAfterDays: 3,
          ...changeRequestOptions,
        }),
      ).toBe(expected);
    },
  );

  it("treats closed change requests like merged ones", () => {
    const shell = makeShell({ activityAt: null });
    expect(
      effectiveSettled(shell, {
        now: NOW,
        autoSettleAfterDays: null,
        changeRequest: { state: "closed" },
      }),
    ).toBe(true);
  });

  it("settles immediately when a change request merges or closes", () => {
    const recentlyActive = makeShell({ activityAt: "2026-04-09T23:59:59.999Z" });
    for (const changeRequestState of ["merged", "closed"] as const) {
      expect(
        effectiveSettled(recentlyActive, {
          now: NOW,
          autoSettleAfterDays: null,
          changeRequest: { state: changeRequestState },
        }),
      ).toBe(true);
    }
  });

  it("ignores a change request that merged before the thread's latest event", () => {
    // A new thread started at a worktree root inherits the branch's old
    // merged PR, and a revived thread outlives its merge; neither settles
    // the live conversation.
    const fresh = makeShell({ activityAt: FRESH });
    for (const state of ["merged", "closed"] as const) {
      expect(
        effectiveSettled(fresh, {
          now: NOW,
          autoSettleAfterDays: null,
          changeRequest: { state, updatedAt: "2026-03-20T00:00:00.000Z" },
        }),
      ).toBe(false);
    }
    // A merge during the thread's life still settles it.
    expect(
      effectiveSettled(fresh, {
        now: NOW,
        autoSettleAfterDays: null,
        changeRequest: { state: "merged", updatedAt: "2026-04-09T00:00:00.000Z" },
      }),
    ).toBe(true);
  });

  it("can keep a merged change request active", () => {
    const recentlyActive = makeShell({ activityAt: "2026-04-09T23:59:59.999Z" });
    expect(
      effectiveSettled(recentlyActive, {
        now: NOW,
        autoSettleAfterDays: null,
        autoSettleOnMerge: false,
        changeRequest: { state: "merged" },
      }),
    ).toBe(false);

    expect(
      effectiveSettled(recentlyActive, {
        now: NOW,
        autoSettleAfterDays: null,
        autoSettleOnMerge: false,
        changeRequest: { state: "closed" },
      }),
    ).toBe(true);
  });

  it("never auto-settles a stale thread with an open change request", () => {
    const stale = makeShell({ activityAt: STALE });
    expect(
      effectiveSettled(stale, {
        now: NOW,
        autoSettleAfterDays: 3,
        changeRequest: { state: "open" },
      }),
    ).toBe(false);
    // An explicit user settle still wins: open PR only blocks the auto path.
    const settled = makeShell({ settledOverride: "settled", activityAt: STALE });
    expect(
      effectiveSettled(settled, {
        now: NOW,
        autoSettleAfterDays: 3,
        changeRequest: { state: "open" },
      }),
    ).toBe(true);
  });

  it("keeps an explicitly un-settled merged-PR thread active", () => {
    const shell = makeShell({
      settledOverride: "active",
      activityAt: "2026-04-09T23:59:59.999Z",
    });
    expect(
      effectiveSettled(shell, {
        now: NOW,
        autoSettleAfterDays: null,
        changeRequest: { state: "merged" },
      }),
    ).toBe(false);
  });

  it("never settles a starting session, even with a settled override", () => {
    const shell = makeShell({
      settledOverride: "settled",
      activityAt: STALE,
      sessionStatus: "starting",
    });
    expect(
      effectiveSettled(shell, {
        now: NOW,
        autoSettleAfterDays: 3,
        changeRequest: { state: "merged" },
      }),
    ).toBe(false);
  });

  it("keeps a new turn active from queued through starting and running", () => {
    const requestedAt = "2026-04-09T12:00:00.000Z";
    const transitionNow = "2026-04-09T12:00:30.000Z";
    const base = makeShell({
      settledOverride: null,
      activityAt: STALE,
    });
    const queued: OrchestrationThreadShell = {
      ...base,
      latestUserMessageAt: requestedAt,
      latestTurn: null,
      session: null,
    };
    const starting: OrchestrationThreadShell = {
      ...queued,
      session: {
        threadId: queued.id,
        status: "starting",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        updatedAt: requestedAt,
      },
    };
    const running: OrchestrationThreadShell = {
      ...starting,
      session: {
        ...starting.session!,
        status: "running",
        activeTurnId: TurnId.make("turn-new"),
      },
    };

    for (const shell of [queued, starting, running]) {
      expect(
        effectiveSettled(shell, {
          now: transitionNow,
          autoSettleAfterDays: 3,
          changeRequest: { state: "merged" },
        }),
      ).toBe(false);
    }
  });

  it("uses a strict inactivity boundary and honors a null threshold", () => {
    const boundary = makeShell({
      activityAt: "2026-04-07T00:00:00.000Z",
    });
    const stale = makeShell({ activityAt: STALE });

    expect(effectiveSettled(boundary, { now: NOW, autoSettleAfterDays: 3 })).toBe(false);
    expect(effectiveSettled(stale, { now: NOW, autoSettleAfterDays: null })).toBe(false);
  });
});

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

describe("canSettle", () => {
  it("blocks every state effectiveSettled refuses to classify as settled", () => {
    expect(canSettle(makeShell({ activityAt: FRESH }), { now: NOW })).toBe(true);
    expect(
      canSettle(makeShell({ activityAt: FRESH, sessionStatus: "starting" }), { now: NOW }),
    ).toBe(false);
    expect(
      canSettle(makeShell({ activityAt: FRESH, sessionStatus: "running" }), { now: NOW }),
    ).toBe(false);
    expect(canSettle(makeShell({ activityAt: FRESH, pending: "approval" }), { now: NOW })).toBe(
      false,
    );
    expect(canSettle(makeShell({ activityAt: FRESH, pending: "user-input" }), { now: NOW })).toBe(
      false,
    );
  });

  it("blocks settling a queued turn start, only within the grace window", () => {
    const queued = {
      ...makeShell({ activityAt: FRESH }),
      latestUserMessageAt: "2026-04-09T12:00:00.000Z",
    };
    const justAfter = "2026-04-09T12:00:30.000Z";
    expect(canSettle(queued, { now: justAfter })).toBe(false);
    // effectiveSettled must agree: queued work never auto-settles either,
    // even with a merged PR.
    expect(
      effectiveSettled(queued, {
        now: justAfter,
        autoSettleAfterDays: 3,
        changeRequest: { state: "merged" },
      }),
    ).toBe(false);
    // Past the window the message is a failed/stale start: settleable again.
    expect(canSettle(queued, { now: NOW })).toBe(true);
  });

  it("lets a server-accepted settle overrule the clock-derived queued blocker", () => {
    // The settle action ran with wall-clock `now` (past the grace window);
    // the list partition re-evaluates with a minute-floored `now` that is
    // still INSIDE the window. settledAt >= message time proves the server
    // already adjudicated this exact message, so the row must not snap back
    // to active until the coarser clock catches up.
    const messageAt = "2026-04-09T12:00:00.000Z";
    const flooredNow = "2026-04-09T12:01:00.000Z";
    const base = makeShell({ settledOverride: "settled", activityAt: null });
    const settledAfterMessage = {
      ...base,
      latestUserMessageAt: messageAt,
      settledAt: "2026-04-09T12:02:10.000Z",
    };
    expect(hasQueuedTurnStart(settledAfterMessage, { now: flooredNow })).toBe(true);
    expect(effectiveSettled(settledAfterMessage, { now: flooredNow, autoSettleAfterDays: 3 })).toBe(
      true,
    );

    // A message NEWER than settledAt is genuinely new work: still blocked
    // until the server's auto-unsettle lands.
    const messageAfterSettle = {
      ...base,
      latestUserMessageAt: "2026-04-09T12:03:00.000Z",
      settledAt: "2026-04-09T12:02:10.000Z",
    };
    expect(
      effectiveSettled(messageAfterSettle, {
        now: "2026-04-09T12:03:30.000Z",
        autoSettleAfterDays: 3,
      }),
    ).toBe(false);
  });

  it("agrees with effectiveSettled's blockers for explicitly settled shells", () => {
    // Anything canSettle rejects must render as active even when the user
    // settled it earlier.
    const blocked = makeShell({
      settledOverride: "settled",
      activityAt: FRESH,
      pending: "user-input",
    });
    expect(canSettle(blocked, { now: NOW })).toBe(false);
    expect(effectiveSettled(blocked, { now: NOW, autoSettleAfterDays: 3 })).toBe(false);
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
