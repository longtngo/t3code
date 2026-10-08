import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  EnvironmentId,
  PROVIDER_DISPLAY_NAMES,
  THREAD_QUEUE_MAX_ENTRIES,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { queuedSendTitle, type QueuedSendSnapshot } from "../lib/threadSend/queuedSend";
import { type ThreadQueueEntry, type ThreadQueueInFlight } from "../threadQueueRules";
import { removeSentThreadFromQueue, useThreadQueueStore } from "../threadQueueStore";
import {
  addToQueue,
  explainQueueAdd,
  QUEUE_FULL_MESSAGE,
  QUEUE_READ_ONLY_MESSAGE,
  QUEUE_SENDING_MESSAGE,
} from "../threadQueueAdd";
import { runSidebarEnqueueDrop } from "./Sidebar.logic";
import {
  claimAndSendQueueEntry,
  nextThreadQueueAction,
  QUEUE_BRANCH_READ_TIMEOUT_MS,
  QUEUE_CLAIM_ABANDON_MS,
  isQueueBusy,
  listQueueSlotInstances,
  queueEntriesToPrune,
  queueSlotTotal,
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
    runtime: null,
    latestRun: null,
    pendingBackgroundTasks: [],
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...overrides,
  } as EnvironmentThreadShell;
}

const running = {
  status: "running" as const,
  activeRunId: "turn-1" as never,
  providerName: "codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  lastError: null,
  updatedAt: iso(-1_000),
};
/** Post-settlement background work: v2 parks the runtime at "idle" (the V1 "monitoring"). */
const monitoring = { ...running, status: "idle" as const, activeRunId: null };

const entry = (id: string, ownerId = "device-a"): ThreadQueueEntry => ({
  environmentId: env,
  threadId: ThreadId.make(id),
  draftId: null,
  addedAt: 0,
  ownerId,
  label: id,
});

type DecideInput = Parameters<typeof nextThreadQueueAction>[0];

const base = (): DecideInput => ({
  entries: [entry("queued-1"), entry("queued-2")],
  paused: false,
  inFlight: null,
  threads: [],
  nowMs: NOW,
  slots: 1,
  perProvider: false,
  providerSlots: {},
  visibleInstanceIds: [],
  targetInstanceOf: () => null,
  ownerId: null,
  leaving: new Set(),
});

function decide(threads: EnvironmentThreadShell[], overrides: Partial<DecideInput> = {}) {
  return nextThreadQueueAction({ ...base(), threads, ...overrides }).kind;
}

const a = ProviderInstanceId.make("claudeAgent");
const b = ProviderInstanceId.make("claudeAgent_personalsub");
const sel = (instanceId: string) => ({ instanceId, model: "m" }) as never;
const on = (instanceId: string, overrides: Partial<EnvironmentThreadShell> = {}) =>
  shell(`busy-${instanceId}-${Math.random()}`, {
    modelSelection: sel(instanceId),
    runtime: { ...running, providerInstanceId: ProviderInstanceId.make(instanceId) },
    ...overrides,
  });

describe("nextThreadQueueAction", () => {
  it("claims when fewer threads are busy than the slots (idle, failed, or waiting on input)", () => {
    expect(
      decide([
        shell("ready"),
        shell("failed", { runtime: { ...running, status: "failed" } }),
        shell("asking", { hasPendingUserInput: true, runtime: running }),
      ]),
    ).toBe("claim");
  });

  it("waits when a working or monitoring thread fills the only slot", () => {
    expect(decide([shell("ready"), shell("busy", { runtime: running })])).toBe("wait");
    expect(decide([shell("pinned", { pinnedAt: iso(-5), runtime: running })])).toBe("wait");
    expect(decide([shell("watching", { runtime: monitoring })])).toBe("wait");
  });

  it("counts every non-archived busy thread, whatever its section", () => {
    expect(
      decide([
        shell("snoozed", { snoozedUntil: iso(60_000), snoozedAt: iso(-5), runtime: running }),
      ]),
    ).toBe("wait");
    expect(decide([shell("settled", { settledOverride: "settled", runtime: monitoring })])).toBe(
      "wait",
    );
    expect(decide([shell("archived", { archivedAt: iso(-5), runtime: running })])).toBe("claim");
  });

  it("sends while busy < slots, skipping busy entries", () => {
    const busyQueued = shell("queued-1", { runtime: running });
    expect(decide([busyQueued])).toBe("wait"); // slots 1, one busy
    expect(nextThreadQueueAction({ ...base(), threads: [busyQueued], slots: 2 })).toEqual({
      kind: "claim",
      key: "env-1:queued-2",
    });
    expect(decide([busyQueued, shell("other", { runtime: running })], { slots: 2 })).toBe("wait");
    expect(
      decide([shell("x", { runtime: running }), shell("y", { runtime: running })], { slots: 1 }),
    ).toBe("wait"); // slots below busy
  });

  it("claims the first sendable entry in queue order", () => {
    expect(nextThreadQueueAction({ ...base(), slots: 2 })).toEqual({
      kind: "claim",
      key: "env-1:queued-1",
    });
  });

  it("skips an entry leaving the Queue, and waits when every entry is", () => {
    expect(nextThreadQueueAction({ ...base(), leaving: new Set(["env-1:queued-1"]) })).toEqual({
      kind: "claim",
      key: "env-1:queued-2",
    });
    expect(decide([], { leaving: new Set(["env-1:queued-1", "env-1:queued-2"]) })).toBe("wait");
  });

  it("slots 0 holds the queue in both modes, even for an entry that would refuse", () => {
    expect(decide([], { slots: 0 })).toBe("wait");
    expect(
      decide([], { perProvider: true, visibleInstanceIds: [a], providerSlots: { [a]: 0 } }),
    ).toBe("wait");
    expect(decide([], { perProvider: true, visibleInstanceIds: [] })).toBe("wait");
  });

  it("per provider: an entry waits only for its own instance", () => {
    const targets: Record<string, string> = { "queued-1": a, "queued-2": b };
    const targetInstanceOf = (e: ThreadQueueEntry) => targets[e.threadId] ?? null;
    const input = {
      perProvider: true,
      visibleInstanceIds: [a, b],
      providerSlots: { [a]: 1, [b]: 2 },
      targetInstanceOf,
    };
    expect(nextThreadQueueAction({ ...base(), threads: [on(a)], ...input })).toEqual({
      kind: "claim",
      key: "env-1:queued-2",
    });
    expect(decide([on(a), on(b), on(b)], input)).toBe("wait");
    expect(decide([on(b), on(b)], { ...input, providerSlots: { [b]: 2 } })).toBe("claim"); // a defaults to 1
  });

  it("per provider: a refusing entry (no target) waits when nothing is free", () => {
    const input = {
      perProvider: true,
      visibleInstanceIds: [a],
      providerSlots: { [a]: 1 },
      targetInstanceOf: () => null,
    };
    expect(decide([on(a)], input)).toBe("wait");
    expect(decide([], input)).toBe("claim");
  });

  it("per provider: an instance no longer listed has no slots", () => {
    expect(
      decide([], {
        entries: [entry("q")],
        perProvider: true,
        visibleInstanceIds: [a],
        providerSlots: { [b]: 3 },
        targetInstanceOf: () => b,
      }),
    ).toBe("wait");
  });

  it("per provider: an instance id that names an Object.prototype member defaults to 1", () => {
    expect(
      decide([], {
        entries: [entry("q")],
        perProvider: true,
        visibleInstanceIds: ["constructor"],
        providerSlots: {},
        targetInstanceOf: () => "constructor",
      }),
    ).toBe("claim");
  });

  it("counts a just-switched thread on its new instance while its session starts", () => {
    const switched = shell("switched", {
      modelSelection: sel(b),
      latestUserMessageAt: iso(-500),
      runtime: { ...running, status: "starting", providerInstanceId: a },
    });
    const input = {
      perProvider: true,
      visibleInstanceIds: [a, b],
      providerSlots: { [a]: 1, [b]: 1 },
      targetInstanceOf: () => b,
    };
    expect(decide([switched], input)).toBe("wait");
    const idleOld = shell("switched", {
      modelSelection: sel(b),
      latestUserMessageAt: iso(-500),
      latestRun: null,
      runtime: { ...running, status: "completed", activeRunId: null, providerInstanceId: a },
    });
    expect(decide([idleOld], input)).toBe("wait");
  });

  it("waits on a thread whose message was accepted but not yet picked up", () => {
    expect(decide([shell("accepted", { latestUserMessageAt: iso(-2_000), latestRun: null })])).toBe(
      "wait",
    );
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
      priorTurnId: null,
      priorSessionUpdatedAt: null,
      sentAt: NOW - 500,
      ...overrides,
    });

    it("holds the next entry until the sent message lands on the thread", () => {
      const before = shell("sent", { latestUserMessageAt: iso(-3_600_000) });
      expect(decide([before], { inFlight: claim() })).toBe("wait");
      const landed = shell("sent", { latestUserMessageAt: iso(-100), runtime: running });
      expect(decide([landed], { inFlight: claim() })).toBe("clear-in-flight");
    });

    it("a landed but idle send with the same turn holds the claim; a failed start releases it", () => {
      // Completed after the message landed (clock skew), so the thread reads idle.
      const prior = {
        runId: "turn-1" as never,
        status: "completed" as const,
        requestedAt: iso(-9_000),
        startedAt: iso(-8_000),
        completedAt: iso(-50),
        assistantMessageId: null,
      };
      const inFlight = claim({ priorTurnId: "turn-1" as never });
      const idleSession = { ...running, status: "completed" as const, activeRunId: null };
      const idle = shell("sent", {
        latestUserMessageAt: iso(-100),
        latestRun: prior,
        runtime: idleSession,
      });
      expect(isQueueBusy(idle, iso(0))).toBe(false);
      expect(decide([idle], { inFlight })).toBe("wait");
      const failed = shell("sent", {
        latestUserMessageAt: iso(-100),
        latestRun: prior,
        runtime: { ...running, status: "failed", activeRunId: null, updatedAt: iso(-50) },
      });
      expect(decide([failed], { inFlight })).toBe("clear-in-flight");
      const nextTurn = shell("sent", {
        latestUserMessageAt: iso(-100),
        latestRun: { ...prior, runId: "turn-2" as never },
        runtime: idleSession,
      });
      expect(decide([nextTurn], { inFlight })).toBe("clear-in-flight");
    });

    it("a draft's thread appearing counts as landed", () => {
      const inFlight = claim({ priorUserMessageAt: null });
      expect(decide([], { inFlight })).toBe("wait");
      expect(
        decide([shell("sent", { latestUserMessageAt: iso(-100), runtime: running })], {
          inFlight,
        }),
      ).toBe("clear-in-flight");
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
      // An unstarted claim goes back to the queue; a landing clear is unconditional.
      expect(
        nextThreadQueueAction({
          ...base(),
          threads: [stuck],
          inFlight: claim({ sentAt: null, claimedAt: NOW - QUEUE_CLAIM_ABANDON_MS - 1 }),
        }),
      ).toEqual({ kind: "release-claim", claimId: "claim-1" });
      expect(
        nextThreadQueueAction({
          ...base(),
          threads: [stuck],
          inFlight: claim({ sentAt: NOW - QUEUE_SENT_LANDING_CAP_MS - 1 }),
        }),
      ).toEqual({ kind: "clear-in-flight", claimId: "claim-1" });
    });

    it("ages a started send from its sending mark, not from its claim", () => {
      const stuck = shell("sent", { latestUserMessageAt: iso(-3_600_000) });
      // The claim retried a lost reply for most of the cap; its send started a minute ago.
      const startedAt = (ago: number) =>
        claim({ sentAt: null, claimedAt: NOW - 2 * QUEUE_CLAIM_ABANDON_MS, sendingAt: NOW - ago });
      expect(decide([stuck], { inFlight: startedAt(60_000) })).toBe("wait");
      expect(decide([stuck], { inFlight: startedAt(QUEUE_CLAIM_ABANDON_MS - 1) })).toBe("wait");
      expect(
        nextThreadQueueAction({
          ...base(),
          threads: [stuck],
          inFlight: startedAt(QUEUE_CLAIM_ABANDON_MS + 1),
        }),
      ).toEqual({ kind: "clear-in-flight", claimId: "claim-1", ifUnsent: true });
    });
  });

  it("counts a running thread on the instance its session runs on, not the one it is set to", () => {
    const opts = {
      perProvider: true,
      visibleInstanceIds: [a, b],
      providerSlots: { [a]: 1, [b]: 1 },
    };
    const moved = shell("moved", {
      modelSelection: sel(b),
      runtime: { ...running, providerInstanceId: a },
    });
    expect(decide([moved], { ...opts, entries: [entry("q")], targetInstanceOf: () => b })).toBe(
      "claim",
    );
    expect(decide([moved], { ...opts, entries: [entry("q")], targetInstanceOf: () => a })).toBe(
      "wait",
    );
  });

  it("never lets an over-full instance cancel another instance's free slot", () => {
    expect(
      decide([on(a), on(a)], {
        entries: [entry("q")],
        perProvider: true,
        visibleInstanceIds: [a, b],
        providerSlots: { [a]: 1, [b]: 1 },
        targetInstanceOf: () => b,
      }),
    ).toBe("claim");
  });

  it("a busy thread whose message and turn are unchanged has not landed the sent message", () => {
    const stale = shell("sent", {
      latestUserMessageAt: iso(-100),
      runtime: running,
    });
    expect(
      decide([stale], {
        inFlight: {
          entry: entry("sent"),
          claimId: "claim-1",
          claimedAt: NOW - 1_000,
          priorUserMessageAt: iso(-100),
          priorTurnId: null,
          priorSessionUpdatedAt: null,
          sentAt: NOW - 500,
        },
      }),
    ).toBe("wait");
  });

  it("two queued entries send one at a time across a turn", () => {
    // A sent, message landed, session not yet running: A is still busy.
    const accepted = shell("A", { latestUserMessageAt: iso(-1_000) });
    expect(decide([accepted], { entries: [entry("B")] })).toBe("wait");
    const working = shell("A", { latestUserMessageAt: iso(-1_000), runtime: running });
    expect(decide([working], { entries: [entry("B")] })).toBe("wait");
    const done = shell("A", {
      latestUserMessageAt: iso(-60_000),
      latestRun: {
        runId: "turn-1" as never,
        status: "completed",
        requestedAt: iso(-60_000),
        startedAt: iso(-59_000),
        completedAt: iso(-1_000),
        assistantMessageId: null,
      },
      runtime: { ...running, status: "completed", activeRunId: null },
    });
    expect(decide([done], { entries: [entry("B")] })).toBe("claim");
  });
});

describe("ownership", () => {
  it("never claims another device's entry; its own entry behind it is claimed", () => {
    const entries = [entry("foreign", "device-b"), entry("mine", "device-a")];
    expect(nextThreadQueueAction({ ...base(), entries, ownerId: "device-a" })).toEqual({
      kind: "claim",
      key: "env-1:mine",
    });
    expect(
      nextThreadQueueAction({
        ...base(),
        entries: [entry("foreign", "device-b")],
        ownerId: "device-a",
      }).kind,
    ).toBe("wait");
    // Local mode: every entry is this device's.
    expect(nextThreadQueueAction({ ...base(), entries, ownerId: null })).toEqual({
      kind: "claim",
      key: "env-1:foreign",
    });
  });
});

describe("queueEntriesToPrune", () => {
  const draft = (id: string, draftId: string, ownerId: string): ThreadQueueEntry => ({
    ...entry(id, ownerId),
    draftId: draftId as ThreadQueueEntry["draftId"],
  });
  it("prunes an archived thread whoever queued it", () => {
    const archived = shell("gone", { archivedAt: iso(-1) });
    expect(
      queueEntriesToPrune({
        entries: [entry("gone", "device-b")],
        threads: [archived],
        draftSessions: {},
        ownerId: "device-a",
      }),
    ).toEqual(["env-1:gone"]);
  });
  it("never prunes a foreign draft or a thread this device cannot see", () => {
    expect(
      queueEntriesToPrune({
        entries: [draft("d", "draft-1", "device-b"), entry("unseen", "device-b")],
        threads: [],
        draftSessions: {},
        ownerId: "device-a",
      }),
    ).toEqual([]);
  });
  it("prunes its own entry whose thread and draft are both gone", () => {
    expect(
      queueEntriesToPrune({
        entries: [draft("d", "draft-1", "device-a"), draft("kept", "draft-2", "device-a")],
        threads: [],
        draftSessions: { "draft-2": {} },
        ownerId: "device-a",
      }),
    ).toEqual(["env-1:d"]);
  });
  it("in local mode every entry is this device's", () => {
    expect(
      queueEntriesToPrune({
        entries: [entry("unseen", "device-b")],
        threads: [],
        draftSessions: {},
        ownerId: null,
      }),
    ).toEqual(["env-1:unseen"]);
  });
});

describe("claimAndSendQueueEntry", () => {
  beforeEach(async () => {
    useThreadQueueStore.getState().setConnection({
      primaryId: null,
      noPrimary: true,
      configSource: null,
      capability: false,
      connected: false,
      canWrite: true,
    });
    await useThreadQueueStore.persist.rehydrate();
    useThreadQueueStore.setState({ entries: [], paused: false, inFlight: null, lastFailure: null });
    const store = useThreadQueueStore.getState();
    store.enqueue(entry("A"));
    store.enqueue(entry("B"));
  });

  function deps(overrides: Partial<Parameters<typeof claimAndSendQueueEntry>[0]> = {}) {
    const snapshots: Array<{ entry: ThreadQueueEntry; branch: string | null }> = [];
    const failures: string[] = [];
    const failureTitles: string[] = [];
    const empties: string[] = [];
    const titles: string[] = [];
    return {
      snapshots,
      failures,
      failureTitles,
      empties,
      titles,
      deps: {
        key: "env-1:A",
        claimId: "claim-1",
        readGitBranch: async (value: ThreadQueueEntry) => `branch-of-${value.threadId}`,
        resolveEntry: (value: ThreadQueueEntry) => value,
        prior: () => ({ userMessageAt: null, turnId: null, sessionUpdatedAt: null }),
        now: () => 1_000,
        confirm: async () => true,
        readSnapshot: (value: ThreadQueueEntry, branch: string | null) => {
          snapshots.push({ entry: value, branch });
          return { shell: null, draft: null } as unknown as QueuedSendSnapshot;
        },
        send: async () => ({ kind: "sent" }) as const,
        // The coordinator's rule once the snapshot is read; a stand-in name before that.
        title: (value: ThreadQueueEntry, snapshot: QueuedSendSnapshot | null) =>
          snapshot === null ? `Title of ${value.threadId}` : queuedSendTitle(snapshot),
        reportFailure: (_entry: ThreadQueueEntry, title: string, message: string) => {
          failures.push(message);
          failureTitles.push(title);
        },
        reportEmpty: (value: ThreadQueueEntry, title: string) => {
          empties.push(`${value.environmentId}:${value.threadId}`);
          titles.push(title);
        },
        ...overrides,
      },
    };
  }

  it("sends the named entry with its own checkout branch", async () => {
    const run = deps({
      key: "env-1:B",
      prior: () => ({ userMessageAt: null, turnId: null, sessionUpdatedAt: "session-at-claim" }),
    });
    await claimAndSendQueueEntry(run.deps);
    expect(run.snapshots).toMatchObject([{ entry: { threadId: "B" }, branch: "branch-of-B" }]);
    const state = useThreadQueueStore.getState();
    expect(state.entries.map((value) => value.threadId)).toEqual(["A"]);
    expect(state.inFlight?.sentAt).toEqual(expect.any(Number));
    expect(state.inFlight?.priorSessionUpdatedAt).toBe("session-at-claim");
  });

  it("reads the claimed entry's branch after the claim", async () => {
    const reads: Array<{ environmentId: string; queued: boolean }> = [];
    const run = deps({
      key: "env-1:B",
      resolveEntry: (value) => ({ ...value, environmentId: EnvironmentId.make("env-2") }),
      readGitBranch: async (value) => {
        reads.push({
          environmentId: value.environmentId,
          queued: useThreadQueueStore
            .getState()
            .entries.some((queued) => queued.threadId === value.threadId),
        });
        return `branch-of-${value.threadId}`;
      },
    });
    await claimAndSendQueueEntry(run.deps);
    expect(reads).toEqual([{ environmentId: "env-2", queued: false }]);
    expect(run.snapshots).toMatchObject([{ entry: { threadId: "B" }, branch: "branch-of-B" }]);
  });

  it("a failed branch read sends with no branch", async () => {
    const run = deps({
      readGitBranch: async () => {
        throw new Error("status unavailable");
      },
    });
    await claimAndSendQueueEntry(run.deps);
    expect(run.snapshots).toMatchObject([{ entry: { threadId: "A" }, branch: null }]);
    expect(useThreadQueueStore.getState().inFlight?.sentAt).toEqual(expect.any(Number));
  });

  it("a branch read that never returns sends with no branch after the read limit", async () => {
    vi.useFakeTimers();
    try {
      const run = deps({ readGitBranch: () => new Promise<string | null>(() => {}) });
      const sending = claimAndSendQueueEntry(run.deps);
      await vi.advanceTimersByTimeAsync(QUEUE_BRANCH_READ_TIMEOUT_MS - 1);
      expect(run.snapshots).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await sending;
      expect(run.snapshots).toMatchObject([{ entry: { threadId: "A" }, branch: null }]);
      expect(useThreadQueueStore.getState().inFlight?.sentAt).toEqual(expect.any(Number));
    } finally {
      vi.useRealTimers();
    }
  });

  it("an entry gone before its claim sends nothing", async () => {
    const run = deps({ key: "env-1:gone" });
    await claimAndSendQueueEntry(run.deps);
    expect(run.snapshots).toEqual([]);
    expect(useThreadQueueStore.getState().inFlight).toBeNull();
  });

  it("a claim the queue does not confirm sends nothing", async () => {
    const run = deps({ confirm: async () => false });
    await claimAndSendQueueEntry(run.deps);
    expect(run.snapshots).toEqual([]);
  });

  it("a confirmed claim the store shows as another tab's sends nothing", async () => {
    const stolen = deps({
      confirm: async () => {
        useThreadQueueStore.setState((state) => ({
          inFlight: state.inFlight && { ...state.inFlight, claimId: "other-tab" },
        }));
        return true;
      },
    });
    await claimAndSendQueueEntry(stolen.deps);
    expect(stolen.snapshots).toEqual([]);
    expect(useThreadQueueStore.getState().inFlight?.claimId).toBe("other-tab");
  });

  it("a hand send while the claim is confirmed: no branch read, nothing sent, nothing said", async () => {
    let reads = 0;
    const run = deps({
      confirm: async () => {
        removeSentThreadFromQueue("env-1:A", null);
        return true;
      },
      readGitBranch: async () => {
        reads += 1;
        return null;
      },
    });
    await claimAndSendQueueEntry(run.deps);
    expect({ reads, snapshots: run.snapshots, failures: run.failures }).toEqual({
      reads: 0,
      snapshots: [],
      failures: [],
    });
  });

  // The claim refuses a paused queue, but a pause can land while the claim settles or the
  // branch is read: the send must not start, and the entry goes back where it was.
  it.each([
    ["while the claim settles", "confirm"],
    ["during the branch read", "readGitBranch"],
  ] as const)("a pause %s sends nothing and puts the entry back", async (_name, step) => {
    const pause = () => useThreadQueueStore.getState().setPaused(true);
    const run = deps(
      step === "confirm"
        ? {
            confirm: async () => {
              pause();
              return true;
            },
          }
        : {
            readGitBranch: async () => {
              pause();
              return null;
            },
          },
    );
    expect(await claimAndSendQueueEntry(run.deps)).toBe(false);
    expect({ snapshots: run.snapshots, failures: run.failures }).toEqual({
      snapshots: [],
      failures: [],
    });
    const state = useThreadQueueStore.getState();
    expect(state).toMatchObject({ paused: true, inFlight: null, lastFailure: null });
    expect(state.entries.map((value) => value.threadId)).toEqual(["A", "B"]);
  });

  it("a pause after a hand send took the claim over leaves the hand send's slot held", async () => {
    const run = deps({
      readGitBranch: async () => {
        removeSentThreadFromQueue("env-1:A", null);
        useThreadQueueStore.getState().setPaused(true);
        return null;
      },
    });
    expect(await claimAndSendQueueEntry(run.deps)).toBe(false);
    const state = useThreadQueueStore.getState();
    expect(state.inFlight).toMatchObject({ claimId: "claim-1", handSent: true });
    expect(state.entries.map((value) => value.threadId)).toEqual(["B"]);
  });

  it("stamps the claim, the sending mark and the sent mark with the injected clock", async () => {
    const run = deps({ now: () => 42_000 });
    await claimAndSendQueueEntry(run.deps);
    expect(useThreadQueueStore.getState().inFlight).toMatchObject({
      claimedAt: 42_000,
      sendingAt: 42_000,
      sentAt: 42_000,
    });
  });

  it("sends the entry as the confirmed claim holds it", async () => {
    const run = deps({
      confirm: async () => {
        // The adopted claim names where the entry lives now.
        useThreadQueueStore.setState((state) => ({
          inFlight: state.inFlight && {
            ...state.inFlight,
            entry: { ...state.inFlight.entry, environmentId: EnvironmentId.make("env-2") },
          },
        }));
        return true;
      },
    });
    await claimAndSendQueueEntry(run.deps);
    expect(run.snapshots).toMatchObject([{ entry: { environmentId: "env-2", threadId: "A" } }]);
  });

  it("a sending mark the queue refuses sends nothing and leaves the claim to its owner", async () => {
    const { markSending } = useThreadQueueStore.getState();
    useThreadQueueStore.setState({ markSending: async () => false });
    let sends = 0;
    try {
      const run = deps({
        send: async () => {
          sends += 1;
          return { kind: "sent" };
        },
      });
      await claimAndSendQueueEntry(run.deps);
      expect({ sends, failures: run.failures, empties: run.empties }).toEqual({
        sends: 0,
        failures: [],
        empties: [],
      });
      // Not cleared: the take-over (or the abandon cap) owns the slot.
      expect(useThreadQueueStore.getState()).toMatchObject({
        paused: false,
        inFlight: { claimId: "claim-1", sentAt: null },
      });
    } finally {
      useThreadQueueStore.setState({ markSending });
    }
  });

  it("a hand send while the queued send is going out keeps the claim, even if it fails", async () => {
    const run = deps({
      send: async () => {
        // The hand send fails: its release must not free the queue's own send.
        removeSentThreadFromQueue("env-1:A", null)();
        return { kind: "sent" };
      },
    });
    await claimAndSendQueueEntry(run.deps);
    expect(useThreadQueueStore.getState().inFlight).toMatchObject({ claimId: "claim-1" });
    expect(useThreadQueueStore.getState().inFlight?.sentAt).toEqual(expect.any(Number));
  });

  it("names an empty draft by its prose, not by a context link's raw text", async () => {
    const draft = (prompt: string) =>
      deps({
        readSnapshot: () => ({ shell: null, draft: { prompt } }) as unknown as QueuedSendSnapshot,
        send: async () => ({ kind: "empty" }),
      });
    const linkOnly = draft("[Terminal 1 lines 1-2](t3-context://v1/terminal/ctx-1)");
    await claimAndSendQueueEntry(linkOnly.deps);
    const withProse = draft("[Terminal 1 lines 1-2](t3-context://v1/terminal/ctx-1) check this");
    useThreadQueueStore
      .getState()
      .enqueue({ environmentId: env, threadId: ThreadId.make("A"), draftId: null });
    await claimAndSendQueueEntry(withProse.deps);
    const long = draft("x".repeat(80));
    useThreadQueueStore
      .getState()
      .enqueue({ environmentId: env, threadId: ThreadId.make("A"), draftId: null });
    await claimAndSendQueueEntry(long.deps);
    const quoted = draft(
      "[Assistant quote](t3-citation://v1/a/b/c?text=quoted+words&start=0&end=12&prefix=&suffix=) fix it",
    );
    useThreadQueueStore
      .getState()
      .enqueue({ environmentId: env, threadId: ThreadId.make("A"), draftId: null });
    await claimAndSendQueueEntry(quoted.deps);
    // The composer's rule: citations read as their words, 50 characters, then an ellipsis.
    expect([...linkOnly.titles, ...withProse.titles, ...long.titles, ...quoted.titles]).toEqual([
      "New thread",
      "check this",
      `${"x".repeat(50)}...`,
      "quoted words fix it",
    ]);
    const named = deps({
      readSnapshot: () =>
        ({ shell: { title: "Thread A" }, draft: { prompt: "" } }) as unknown as QueuedSendSnapshot,
      send: async () => ({ kind: "empty" }),
    });
    useThreadQueueStore
      .getState()
      .enqueue({ environmentId: env, threadId: ThreadId.make("A"), draftId: null });
    await claimAndSendQueueEntry(named.deps);
    expect(named.titles).toEqual(["Thread A"]);
  });

  it("a throw once the claim is held pauses the queue and reports it", async () => {
    const run = deps({
      readSnapshot: () => {
        throw new Error("snapshot broke");
      },
    });
    await claimAndSendQueueEntry(run.deps);
    expect(useThreadQueueStore.getState()).toMatchObject({
      paused: true,
      inFlight: null,
      lastFailure: { threadKey: "env-1:A", message: "snapshot broke" },
    });
    expect(run.failures).toEqual(["snapshot broke"]);
  });

  it("a refused draft with only an image is named by it, as the composer does", async () => {
    const run = deps({
      readSnapshot: () =>
        ({
          shell: null,
          draft: { prompt: "", images: [{ name: "shot.png" }] },
        }) as unknown as QueuedSendSnapshot,
      send: async () => ({ kind: "refused", reason: "The message has attachments." }),
    });
    await claimAndSendQueueEntry(run.deps);
    expect(run.failureTitles).toEqual(["Image: shot.png"]);
  });

  it("a title that throws as well still pauses the queue, says why, and frees the claim", async () => {
    const titleBroke = (_entry: ThreadQueueEntry, snapshot: QueuedSendSnapshot | null) => {
      if (snapshot === null) throw new Error("title broke");
      return "unused";
    };
    const cases = {
      settle: { confirm: async () => Promise.reject(new Error("settle broke")) },
      snapshot: {
        readSnapshot: () => {
          throw new Error("settle broke");
        },
      },
    };
    for (const [name, overrides] of Object.entries(cases)) {
      useThreadQueueStore.setState({
        entries: [entry("A")],
        paused: false,
        inFlight: null,
        lastFailure: null,
      });
      const run = deps({ ...overrides, title: titleBroke });
      const outcome = await claimAndSendQueueEntry(run.deps).then(
        () => "settled",
        (error: Error) => `threw: ${error.message}`,
      );
      const state = useThreadQueueStore.getState();
      expect({
        name,
        outcome,
        failureTitles: run.failureTitles,
        paused: state.paused,
        inFlight: state.inFlight,
        lastFailure: state.lastFailure,
      }).toEqual({
        name,
        outcome: "settled",
        failureTitles: ["New thread"],
        paused: true,
        inFlight: null,
        lastFailure: { threadKey: "env-1:A", title: "New thread", message: "settle broke" },
      });
    }
  });

  it("a failure before the snapshot names the thread by its own title", async () => {
    const run = deps({
      confirm: async () => {
        throw new Error("settle broke");
      },
    });
    await claimAndSendQueueEntry(run.deps);
    expect(run.failureTitles).toEqual(["Title of A"]);
    expect(useThreadQueueStore.getState().lastFailure).toMatchObject({
      title: "Title of A",
      message: "settle broke",
    });
  });

  it("a send that fails after its claim was cleared still pauses and says so", async () => {
    const lose = () => {
      // The abandon cap cleared the claim and another entry was claimed while the send was out.
      const queue = useThreadQueueStore.getState();
      queue.clearInFlight("claim-1");
      queue.claimEntry({
        key: "env-1:B",
        claimId: "next",
        now: 1,
        resolve: (entry) => ({
          entry,
          prior: { userMessageAt: null, turnId: null, sessionUpdatedAt: null },
        }),
      });
    };
    const failed = deps({
      send: async () => {
        lose();
        return { kind: "failed", message: "server gone" };
      },
    });
    await claimAndSendQueueEntry(failed.deps);
    expect(failed.failures).toEqual(["server gone"]);
    expect(useThreadQueueStore.getState()).toMatchObject({
      paused: true,
      lastFailure: { message: "server gone" },
      inFlight: { claimId: "next" },
    });

    useThreadQueueStore.setState({
      entries: [entry("A")],
      paused: false,
      inFlight: null,
      lastFailure: null,
    });
    const thrown = deps({
      send: async () => {
        lose();
        throw new Error("socket closed");
      },
    });
    await claimAndSendQueueEntry(thrown.deps);
    expect(thrown.failures).toEqual(["socket closed"]);
    expect(useThreadQueueStore.getState()).toMatchObject({
      paused: true,
      lastFailure: { message: "socket closed" },
    });
  });

  it("a refused storage write still tells the user why the send failed", async () => {
    const { fail } = useThreadQueueStore.getState();
    useThreadQueueStore.setState({
      fail: () => {
        throw new Error("QuotaExceededError");
      },
    });
    try {
      const run = deps({ send: async () => ({ kind: "failed", message: "server gone" }) });
      await expect(claimAndSendQueueEntry(run.deps)).rejects.toThrow("QuotaExceededError");
      expect(run.failures).toEqual(["server gone"]);
    } finally {
      useThreadQueueStore.setState({ fail });
    }
  });

  it("a refused storage write still says an empty draft left the queue", async () => {
    const { clearInFlight } = useThreadQueueStore.getState();
    useThreadQueueStore.setState({
      clearInFlight: () => {
        throw new Error("QuotaExceededError");
      },
    });
    try {
      const run = deps({ send: async () => ({ kind: "empty" }) });
      await expect(claimAndSendQueueEntry(run.deps)).rejects.toThrow("QuotaExceededError");
      expect(run.empties).toEqual(["env-1:A"]);
    } finally {
      useThreadQueueStore.setState({ clearInFlight });
    }
  });

  it("a notice that throws still records the outcome in the store", async () => {
    const boom = () => {
      throw new Error("toast broke");
    };
    const failed = deps({
      send: async () => ({ kind: "failed", message: "server gone" }),
      reportFailure: boom,
    });
    await expect(claimAndSendQueueEntry(failed.deps)).rejects.toThrow("toast broke");
    expect(useThreadQueueStore.getState()).toMatchObject({ paused: true, inFlight: null });

    useThreadQueueStore.setState({
      entries: [entry("A")],
      paused: false,
      inFlight: null,
      lastFailure: null,
    });
    const empty = deps({ send: async () => ({ kind: "empty" }), reportEmpty: boom });
    await expect(claimAndSendQueueEntry(empty.deps)).rejects.toThrow("toast broke");
    expect(useThreadQueueStore.getState()).toMatchObject({ paused: false, inFlight: null });
  });

  it("a throw before the send starts says nothing once the claim is not ours to send", async () => {
    const cases = {
      cleared: () => useThreadQueueStore.getState().clearInFlight("claim-1"),
      "taken over by a hand send": () => removeSentThreadFromQueue("env-1:A", null),
    };
    for (const [name, lose] of Object.entries(cases)) {
      useThreadQueueStore.setState({
        entries: [entry("A")],
        paused: false,
        inFlight: null,
        lastFailure: null,
      });
      const run = deps({
        confirm: async () => {
          lose();
          throw new Error("rehydrate broke");
        },
      });
      await claimAndSendQueueEntry(run.deps);
      expect({
        name,
        failures: run.failures,
        paused: useThreadQueueStore.getState().paused,
      }).toEqual({
        name,
        failures: [],
        paused: false,
      });
    }
  });

  it("a throw after another tab took the claim leaves that tab's claim alone", async () => {
    const run = deps({
      confirm: async () => {
        useThreadQueueStore.setState((state) => ({
          inFlight: state.inFlight && { ...state.inFlight, claimId: "other-tab" },
        }));
        throw new Error("rehydrate broke");
      },
    });
    await claimAndSendQueueEntry(run.deps);
    expect(useThreadQueueStore.getState()).toMatchObject({
      paused: false,
      inFlight: { claimId: "other-tab" },
    });
    expect(run.failures).toEqual([]);
  });

  it("an empty draft leaves for Active with a notice and does not pause the queue", async () => {
    const run = deps({ send: async () => ({ kind: "empty" }) });
    await claimAndSendQueueEntry(run.deps);
    expect(useThreadQueueStore.getState()).toMatchObject({
      paused: false,
      inFlight: null,
      lastFailure: null,
    });
    expect(run.empties).toEqual(["env-1:A"]);
    expect(run.failures).toEqual([]);
  });

  it("a hand send during the branch read takes the claim over: nothing sent, nothing said", async () => {
    let sends = 0;
    const run = deps({
      readGitBranch: async () => {
        removeSentThreadFromQueue("env-1:A", null);
        return null;
      },
      send: async () => {
        sends += 1;
        return { kind: "empty" };
      },
    });
    await claimAndSendQueueEntry(run.deps);
    expect(sends).toBe(0);
    expect(run.empties).toEqual([]);
    expect(useThreadQueueStore.getState()).toMatchObject({
      paused: false,
      inFlight: { claimId: "claim-1", handSent: true, sentAt: expect.any(Number) },
    });
  });

  it("a refused or throwing send pauses the queue and reports why", async () => {
    const refused = deps({ send: async () => ({ kind: "refused", reason: "needs you" }) });
    await claimAndSendQueueEntry(refused.deps);
    expect(useThreadQueueStore.getState()).toMatchObject({
      paused: true,
      inFlight: null,
      lastFailure: { threadKey: "env-1:A", message: "needs you" },
    });
    expect(refused.failures).toEqual(["needs you"]);

    useThreadQueueStore.getState().setPaused(false);
    const throwing = deps({
      key: "env-1:B",
      claimId: "claim-2",
      send: async () => {
        throw new Error("boom");
      },
    });
    await claimAndSendQueueEntry(throwing.deps);
    expect(useThreadQueueStore.getState().lastFailure?.message).toBe("boom");
    expect(useThreadQueueStore.getState().inFlight).toBeNull();
  });
});

describe("addToQueue", () => {
  it("says the queue is full instead of adding past the cap, and still takes a queued thread", async () => {
    useThreadQueueStore.getState().setConnection({
      primaryId: null,
      noPrimary: true,
      configSource: null,
      capability: false,
      connected: false,
      canWrite: true,
    });
    await useThreadQueueStore.persist.rehydrate();
    const full = Array.from({ length: THREAD_QUEUE_MAX_ENTRIES }, (_, i) => ({
      environmentId: env,
      threadId: ThreadId.make(`T${i}`),
      draftId: null,
      addedAt: 1,
      ownerId: "d",
      label: null,
    }));
    useThreadQueueStore.setState({ entries: full });
    const fresh = { environmentId: env, threadId: ThreadId.make("new"), draftId: null };
    expect(addToQueue(fresh)).toBe("full");
    expect(addToQueue(full[0]!)).toBe("added");
    expect(useThreadQueueStore.getState().entries).toHaveLength(THREAD_QUEUE_MAX_ENTRIES);
    useThreadQueueStore.setState({ entries: full.slice(1) });
    expect(addToQueue(fresh)).toBe("added");
    expect(useThreadQueueStore.getState().entries.at(-1)?.threadId).toBe("new");
  });

  it("says a thread the queue is about to send is already sending, and adds it once sent", async () => {
    useThreadQueueStore.getState().setConnection({
      primaryId: null,
      noPrimary: true,
      configSource: null,
      capability: false,
      connected: false,
      canWrite: true,
    });
    await useThreadQueueStore.persist.rehydrate();
    const thread = { environmentId: env, threadId: ThreadId.make("A"), draftId: null };
    useThreadQueueStore.setState({ entries: [], paused: false, inFlight: null });
    expect(addToQueue(thread)).toBe("added");
    const claim = useThreadQueueStore.getState().claimEntry({
      key: `${env}:A`,
      claimId: "c1",
      now: 1,
      resolve: (entry) => ({
        entry,
        prior: { userMessageAt: null, turnId: null, sessionUpdatedAt: null },
      }),
    });
    expect(claim?.claimId).toBe("c1");
    expect(addToQueue(thread)).toBe("sending");
    expect(useThreadQueueStore.getState().entries).toEqual([]);
    // Only the thread being sent: another one still gets in.
    const other = { environmentId: env, threadId: ThreadId.make("B"), draftId: null };
    expect(addToQueue(other)).toBe("added");
    useThreadQueueStore.getState().remove(`${env}:B`);
    useThreadQueueStore.getState().markSent("c1", 2);
    expect(addToQueue(thread)).toBe("added");
    expect(useThreadQueueStore.getState().entries.map((entry) => entry.threadId)).toEqual(["A"]);
  });

  it("refuses a thread that is both queued and being sent", async () => {
    useThreadQueueStore.getState().setConnection({
      primaryId: null,
      noPrimary: true,
      configSource: null,
      capability: false,
      connected: false,
      canWrite: true,
    });
    await useThreadQueueStore.persist.rehydrate();
    const thread = { environmentId: env, threadId: ThreadId.make("A"), draftId: null };
    const queued = { ...thread, addedAt: 1, ownerId: "d", label: null };
    useThreadQueueStore.setState({
      entries: [queued],
      paused: false,
      inFlight: {
        entry: queued,
        claimId: "c1",
        claimedAt: 1,
        priorUserMessageAt: null,
        priorTurnId: null,
        priorSessionUpdatedAt: null,
        sentAt: null,
      },
    });
    expect(addToQueue(thread)).toBe("sending");
  });

  it("refuses an add while the queue is read-only", () => {
    useThreadQueueStore.setState({ entries: [], inFlight: null, readOnly: true });
    try {
      const thread = { environmentId: env, threadId: ThreadId.make("A"), draftId: null };
      expect(addToQueue(thread)).toBe("read-only");
      expect(useThreadQueueStore.getState().entries).toEqual([]);
    } finally {
      useThreadQueueStore.setState({ readOnly: false });
    }
  });
});

describe("explainQueueAdd", () => {
  it.each([
    ["added", true, []],
    ["full", false, [QUEUE_FULL_MESSAGE]],
    ["sending", false, [QUEUE_SENDING_MESSAGE]],
    ["read-only", false, [QUEUE_READ_ONLY_MESSAGE]],
  ] as const)("%s: added %s, says %j", (result, added, said) => {
    const titles: string[] = [];
    expect(explainQueueAdd(result, (title) => titles.push(title))).toBe(added);
    expect(titles).toEqual(said);
  });

  // Snooze -> Queue wakes only a thread the Queue took.
  it.each(["full", "sending", "read-only"] as const)(
    "Wake & queue wakes nothing when the add is %s",
    async (result) => {
      const wake = vi.fn(async () => {});
      await runSidebarEnqueueDrop({
        liveSection: "snoozed",
        checkOperate: () => true,
        enqueue: () => explainQueueAdd(result, () => {}),
        wake,
      });
      expect(wake).not.toHaveBeenCalled();
    },
  );
});

describe("listQueueSlotInstances", () => {
  const provider = (instanceId: string, driver: string, displayName?: string): ServerProvider => ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    ...(displayName ? { displayName } : {}),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  });
  const settings = {
    providerInstances: {
      claudeAgent: { driver: "claudeAgent", displayName: "UniSub", enabled: true },
      claudeAgent_personalsub: {
        driver: "claudeAgent",
        displayName: "PersonalSub",
        enabled: true,
      },
      codex: { driver: "codex", enabled: false },
    },
    providers: {},
  } as unknown as Pick<ServerSettings, "providerInstances" | "providers">;

  it("lists visible instances, labelled and deduped across sources", () => {
    const providers = [
      provider("claudeAgent", "claudeAgent", "UniSub"),
      provider("claudeAgent_personalsub", "claudeAgent", "PersonalSub"),
      provider("codex", "codex"),
    ];
    const claude = PROVIDER_DISPLAY_NAMES[ProviderDriverKind.make("claudeAgent")];
    expect(
      listQueueSlotInstances([
        { providers, settings },
        { providers: [providers[0]!], settings },
      ]),
    ).toEqual([
      { instanceId: "claudeAgent", label: `${claude} \u00b7 UniSub` },
      { instanceId: "claudeAgent_personalsub", label: `${claude} \u00b7 PersonalSub` },
    ]);
  });

  it("labels a driver without a display name the way its instance name reads", () => {
    const providers = [provider("myDriver", "myDriver")];
    const custom = {
      providerInstances: { myDriver: { driver: "myDriver", enabled: true } },
      providers: {},
    } as unknown as typeof settings;
    expect(listQueueSlotInstances([{ providers, settings: custom }])).toEqual([
      { instanceId: "myDriver", label: "My Driver" },
    ]);
  });
});

describe("queueSlotTotal", () => {
  it("returns the global slots when per-provider is off", () => {
    expect(queueSlotTotal(3, false, { a: 9 }, ["a"])).toBe(3);
  });

  it("sums per-instance slots over the visible ids, defaulting to 1", () => {
    expect(queueSlotTotal(1, true, { a: 2, b: 3, hidden: 7 }, ["a", "b", "c"])).toBe(6);
    expect(queueSlotTotal(1, true, {}, [])).toBe(0);
  });

  it("does not read Object.prototype members as slot counts", () => {
    expect(queueSlotTotal(1, true, {}, ["constructor"])).toBe(1);
  });
});
