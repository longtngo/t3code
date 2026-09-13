import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import type { QueuedSendSnapshot } from "../lib/threadSend/queuedSend";
import {
  threadQueueEntryKey,
  useThreadQueueStore,
  type ThreadQueueEntry,
  type ThreadQueueInFlight,
} from "../threadQueueStore";
import {
  claimAndSendQueueHead,
  nextThreadQueueAction,
  QUEUE_CLAIM_ABANDON_MS,
  QUEUE_SENT_LANDING_CAP_MS,
} from "./threadQueue.logic";

const env = EnvironmentId.make("env-1");
const NOW = Date.parse("2026-09-13T12:00:00.000Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function shell(
  id: string,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  return {
    environmentId: env,
    id: ThreadId.make(id),
    projectId: "project-1",
    title: id,
    archivedAt: null,
    settledOverride: null,
    pinnedAt: null,
    session: null,
    latestTurn: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...overrides,
  } as EnvironmentThreadShell;
}

const running = {
  threadId: ThreadId.make("x"),
  status: "running" as const,
  providerName: "codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeMode: "full-access" as const,
  activeTurnId: "turn-1" as never,
  lastError: null,
  updatedAt: iso(-1_000),
};

const entry = (id: string): ThreadQueueEntry => ({
  environmentId: env,
  threadId: ThreadId.make(id),
  draftId: null,
  addedAt: 0,
});

const allCapabilities = () => ({ threadSettlement: true, threadSnooze: true });

function decide(
  threads: EnvironmentThreadShell[],
  overrides: Partial<Parameters<typeof nextThreadQueueAction>[0]> = {},
) {
  return nextThreadQueueAction({
    entries: [entry("queued-1"), entry("queued-2")],
    paused: false,
    inFlight: null,
    threads,
    capabilitiesFor: allCapabilities,
    nowMs: NOW,
    ...overrides,
  }).kind;
}

describe("nextThreadQueueAction", () => {
  it("claims when every Active and Pinned thread is done", () => {
    expect(
      decide([
        shell("ready"),
        shell("failed", { session: { ...running, status: "error" } }),
        shell("asking", { hasPendingUserInput: true, session: running }),
      ]),
    ).toBe("claim");
  });

  it("waits on a working Active thread, a working Pinned thread, or a monitoring one", () => {
    expect(decide([shell("ready"), shell("busy", { session: running })])).toBe("wait");
    expect(decide([shell("pinned", { pinnedAt: iso(-5), session: running })])).toBe("wait");
    expect(decide([shell("watching", { backgroundLiveness: "monitoring" })])).toBe("wait");
  });

  it("ignores busy threads that are snoozed, settled, archived, or themselves queued", () => {
    expect(
      decide([
        shell("snoozed", { snoozedUntil: iso(60_000), snoozedAt: iso(-5), session: running }),
        shell("settled", { settledOverride: "settled", session: running }),
        shell("archived", { archivedAt: iso(-5), session: running }),
        shell("queued-2", { session: running }),
      ]),
    ).toBe("claim");
  });

  it("a queued head still running its own turn waits; a busy later entry does not block", () => {
    expect(decide([shell("queued-1", { session: running })])).toBe("wait");
    expect(decide([shell("queued-2", { session: running })])).toBe("claim");
  });

  it("waits on a thread whose message was accepted but not yet picked up", () => {
    expect(
      decide([shell("accepted", { latestUserMessageAt: iso(-2_000), latestTurn: null })]),
    ).toBe("wait");
  });

  it("does nothing while paused or empty", () => {
    expect(decide([shell("ready")], { paused: true })).toBe("wait");
    expect(decide([shell("ready")], { entries: [] })).toBe("wait");
  });

  describe("a claimed send", () => {
    const claim = (overrides: Partial<ThreadQueueInFlight> = {}): ThreadQueueInFlight => ({
      entry: entry("sent"),
      claimId: "claim-1",
      claimedAt: NOW - 1_000,
      priorUserMessageAt: iso(-3_600_000),
      sentAt: NOW - 500,
      ...overrides,
    });

    it("holds the next entry until the sent message lands on the thread", () => {
      const before = shell("sent", { latestUserMessageAt: iso(-3_600_000) });
      expect(decide([before], { inFlight: claim() })).toBe("wait");
      const landed = shell("sent", { latestUserMessageAt: iso(-100) });
      expect(decide([landed], { inFlight: claim() })).toBe("clear-in-flight");
    });

    it("a draft's thread appearing counts as landed", () => {
      const inFlight = claim({ priorUserMessageAt: null });
      expect(decide([], { inFlight })).toBe("wait");
      expect(decide([shell("sent", { latestUserMessageAt: iso(-100) })], { inFlight })).toBe(
        "clear-in-flight",
      );
    });

    it("gives up waiting after the caps", () => {
      const stuck = shell("sent", { latestUserMessageAt: iso(-3_600_000) });
      expect(
        decide([stuck], { inFlight: claim({ sentAt: NOW - QUEUE_SENT_LANDING_CAP_MS - 1 }) }),
      ).toBe("clear-in-flight");
      expect(
        decide([stuck], {
          inFlight: claim({ sentAt: null, claimedAt: NOW - QUEUE_CLAIM_ABANDON_MS + 1 }),
        }),
      ).toBe("wait");
      expect(
        decide([stuck], {
          inFlight: claim({ sentAt: null, claimedAt: NOW - QUEUE_CLAIM_ABANDON_MS - 1 }),
        }),
      ).toBe("clear-in-flight");
    });
  });

  it("two queued entries send one at a time across a turn", () => {
    // A sent, message landed, session not yet running: A is still busy.
    const accepted = shell("A", { latestUserMessageAt: iso(-1_000) });
    expect(decide([accepted], { entries: [entry("B")] })).toBe("wait");
    const working = shell("A", { latestUserMessageAt: iso(-1_000), session: running });
    expect(decide([working], { entries: [entry("B")] })).toBe("wait");
    const done = shell("A", {
      latestUserMessageAt: iso(-60_000),
      latestTurn: {
        turnId: "turn-1" as never,
        state: "completed",
        requestedAt: iso(-60_000),
        startedAt: iso(-59_000),
        completedAt: iso(-1_000),
        assistantMessageId: null,
      },
      session: { ...running, status: "ready", activeTurnId: null },
    });
    expect(decide([done], { entries: [entry("B")] })).toBe("claim");
  });
});

describe("claimAndSendQueueHead", () => {
  beforeEach(() => {
    useThreadQueueStore.setState({ entries: [], paused: false, inFlight: null, lastFailure: null });
    const store = useThreadQueueStore.getState();
    store.enqueue(entry("A"));
    store.enqueue(entry("B"));
  });

  // The watched branch always follows whatever is at the head right now, as the
  // coordinator's render does once the claim removes the old head.
  const liveHeadBranch = () => {
    const head = useThreadQueueStore.getState().entries[0];
    return head ? { key: threadQueueEntryKey(head), branch: `branch-of-${head.threadId}` } : null;
  };

  function deps(overrides: Partial<Parameters<typeof claimAndSendQueueHead>[0]> = {}) {
    const snapshots: Array<{ entry: ThreadQueueEntry; branch: string | null }> = [];
    const failures: string[] = [];
    return {
      snapshots,
      failures,
      deps: {
        claimId: "claim-1",
        headGitBranch: liveHeadBranch,
        resolveEntry: (value: ThreadQueueEntry) => value,
        priorUserMessageAt: () => null,
        settle: async () => {},
        readSnapshot: (value: ThreadQueueEntry, branch: string | null) => {
          snapshots.push({ entry: value, branch });
          return { shell: null, draft: null } as unknown as QueuedSendSnapshot;
        },
        send: async () => ({ kind: "sent" }) as const,
        reportFailure: (_entry: ThreadQueueEntry, _title: string, message: string) => {
          failures.push(message);
        },
        ...overrides,
      },
    };
  }

  it("sends the claimed head with the branch watched for it, not for the next entry", async () => {
    const run = deps();
    await claimAndSendQueueHead(run.deps);
    expect(run.snapshots).toMatchObject([{ entry: { threadId: "A" }, branch: "branch-of-A" }]);
    const state = useThreadQueueStore.getState();
    expect(state.entries.map((value) => value.threadId)).toEqual(["B"]);
    expect(state.inFlight?.sentAt).not.toBeNull();
  });

  it("a claim taken over by another tab during the settle sends nothing", async () => {
    const run = deps({
      settle: async () => {
        useThreadQueueStore.setState((state) => ({
          inFlight: state.inFlight && { ...state.inFlight, claimId: "other-tab" },
        }));
      },
    });
    await claimAndSendQueueHead(run.deps);
    expect(run.snapshots).toEqual([]);
  });

  it("a refused or throwing send pauses the queue and reports why", async () => {
    const refused = deps({ send: async () => ({ kind: "refused", reason: "needs you" }) });
    await claimAndSendQueueHead(refused.deps);
    expect(useThreadQueueStore.getState()).toMatchObject({
      paused: true,
      inFlight: null,
      lastFailure: { threadKey: "env-1:A", message: "needs you" },
    });
    expect(refused.failures).toEqual(["needs you"]);

    useThreadQueueStore.getState().setPaused(false);
    const throwing = deps({
      claimId: "claim-2",
      send: async () => {
        throw new Error("boom");
      },
    });
    await claimAndSendQueueHead(throwing.deps);
    expect(useThreadQueueStore.getState().lastFailure?.message).toBe("boom");
    expect(useThreadQueueStore.getState().inFlight).toBeNull();
  });
});
