import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  EnvironmentId,
  PROVIDER_DISPLAY_NAMES,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { QueuedSendSnapshot } from "../lib/threadSend/queuedSend";
import {
  useThreadQueueStore,
  type ThreadQueueEntry,
  type ThreadQueueInFlight,
} from "../threadQueueStore";
import {
  claimAndSendQueueEntry,
  nextThreadQueueAction,
  QUEUE_BRANCH_READ_TIMEOUT_MS,
  QUEUE_CLAIM_ABANDON_MS,
  isQueueBusy,
  listQueueSlotInstances,
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

const entry = (id: string): ThreadQueueEntry => ({
  environmentId: env,
  threadId: ThreadId.make(id),
  draftId: null,
  addedAt: 0,
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
      expect(
        decide([stuck], {
          inFlight: claim({ sentAt: null, claimedAt: NOW - QUEUE_CLAIM_ABANDON_MS - 1 }),
        }),
      ).toBe("clear-in-flight");
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

describe("claimAndSendQueueEntry", () => {
  beforeEach(() => {
    useThreadQueueStore.setState({ entries: [], paused: false, inFlight: null, lastFailure: null });
    const store = useThreadQueueStore.getState();
    store.enqueue(entry("A"));
    store.enqueue(entry("B"));
  });

  function deps(overrides: Partial<Parameters<typeof claimAndSendQueueEntry>[0]> = {}) {
    const snapshots: Array<{ entry: ThreadQueueEntry; branch: string | null }> = [];
    const failures: string[] = [];
    return {
      snapshots,
      failures,
      deps: {
        key: "env-1:A",
        claimId: "claim-1",
        readGitBranch: async (value: ThreadQueueEntry) => `branch-of-${value.threadId}`,
        resolveEntry: (value: ThreadQueueEntry) => value,
        prior: () => ({ userMessageAt: null, turnId: null, sessionUpdatedAt: null }),
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

  it("sends the named entry with its own checkout branch", async () => {
    const run = deps({
      key: "env-1:B",
      prior: () => ({ userMessageAt: null, turnId: null, sessionUpdatedAt: "session-at-claim" }),
    });
    await claimAndSendQueueEntry(run.deps);
    expect(run.snapshots).toMatchObject([{ entry: { threadId: "B" }, branch: "branch-of-B" }]);
    const state = useThreadQueueStore.getState();
    expect(state.entries.map((value) => value.threadId)).toEqual(["A"]);
    expect(state.inFlight?.sentAt).not.toBeNull();
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
    expect(useThreadQueueStore.getState().inFlight?.sentAt).not.toBeNull();
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
      expect(useThreadQueueStore.getState().inFlight?.sentAt).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a claim taken over by another tab during the settle sends nothing", async () => {
    const run = deps({
      settle: async () => {
        useThreadQueueStore.setState((state) => ({
          inFlight: state.inFlight && { ...state.inFlight, claimId: "other-tab" },
        }));
      },
    });
    await claimAndSendQueueEntry(run.deps);
    expect(run.snapshots).toEqual([]);
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
