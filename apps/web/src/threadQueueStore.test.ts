import {
  EnvironmentId,
  THREAD_QUEUE_FAILURE_MESSAGE_MAX_LENGTH,
  THREAD_QUEUE_FAILURE_TITLE_MAX_LENGTH,
  THREAD_QUEUE_PRIOR_ID_MAX_LENGTH,
  ThreadId,
  type ThreadQueueDocument,
  ThreadQueueSetInput,
  type ThreadQueueSetResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  claimAndSendQueueEntry,
  nextThreadQueueAction,
  QUEUE_CLAIM_ABANDON_MS,
} from "./components/threadQueue.logic";
import { DraftId } from "./composerDraftStore";
import { SLOW_RPC_ACK_THRESHOLD_MS } from "./rpc/requestLatencyState";
import {
  applyQueueAction,
  threadQueueEntryKey,
  type ThreadQueueData,
  type ThreadQueueEntry,
  type ThreadQueuePrior,
} from "./threadQueueRules";
import {
  queueDeviceId,
  removeSentThreadFromQueue,
  THREAD_QUEUE_STORAGE_KEY,
  useThreadQueueStore,
  type ThreadQueueConnection,
  type ThreadQueueWriter,
} from "./threadQueueStore";

// The unit project runs under node: give the store a browser storage before it loads.
const localStorage = vi.hoisted(() => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    clear: () => data.clear(),
  };
  Object.assign(globalThis, { window: { localStorage: storage } });
  return storage;
});

const env = EnvironmentId.make("env-1");
const a = { environmentId: env, threadId: ThreadId.make("thread-A"), draftId: null };
const b = {
  environmentId: env,
  threadId: ThreadId.make("thread-B"),
  draftId: DraftId.make("draft-B"),
};
const c = { environmentId: env, threadId: ThreadId.make("thread-C"), draftId: null };
const resolveWith =
  (prior: Partial<ThreadQueuePrior> = {}) =>
  (entry: ThreadQueueEntry) => ({
    entry,
    prior: { userMessageAt: null, turnId: null, sessionUpdatedAt: null, ...prior },
  });
const keys = () => useThreadQueueStore.getState().entries.map(threadQueueEntryKey);

const primary = EnvironmentId.make("env-primary");
const LOCAL: ThreadQueueConnection = {
  primaryId: null,
  noPrimary: true,
  configSource: null,
  capability: false,
  connected: false,
  canWrite: true,
};
const SERVER: ThreadQueueConnection = {
  primaryId: primary,
  noPrimary: false,
  configSource: "live",
  capability: true,
  connected: true,
  canWrite: true,
};
const store = () => useThreadQueueStore.getState();
const emptyDocument = (bootId: string, revision = 0): ThreadQueueDocument => ({
  bootId,
  revision,
  entries: [],
  paused: false,
  inFlight: null,
  lastFailure: null,
});
const queued = (entry: typeof a | typeof b | typeof c) => ({
  ...entry,
  addedAt: 1,
  ownerId: "d",
  label: null,
});
/** Echoes every write back as accepted. */
const acceptAll = () =>
  vi.fn(async (input: ThreadQueueSetInput): Promise<ThreadQueueSetResult> => ({
    ok: true,
    document: { ...emptyDocument("boot-1", input.expectedRevision + 1), ...input.state },
    serverTime: Date.now(),
  }));
/** A server that holds one document and accepts a write only at its current revision. */
function fakeServer(initial: ThreadQueueDocument) {
  const server = {
    document: initial,
    write: vi.fn(async (input: ThreadQueueSetInput): Promise<ThreadQueueSetResult> => {
      const ok =
        input.bootId === server.document.bootId &&
        input.expectedRevision === server.document.revision;
      if (ok) {
        server.document = {
          ...server.document,
          ...input.state,
          revision: server.document.revision + 1,
        };
      }
      return { ok, document: server.document, serverTime: Date.now() };
    }),
  };
  return server;
}

async function enterLocal() {
  store().setConnection(LOCAL);
  await useThreadQueueStore.persist.rehydrate();
}

beforeEach(async () => {
  localStorage.clear();
  store().setWriter(null);
  await enterLocal();
  useThreadQueueStore.setState({ entries: [], paused: false, inFlight: null, lastFailure: null });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("threadQueueStore", () => {
  it("appends in add order, ignores a second add, and moves on drop", () => {
    const store = useThreadQueueStore.getState();
    store.enqueue(a);
    store.enqueue(b);
    store.enqueue(c);
    store.enqueue(a);
    expect(keys()).toEqual(["env-1:thread-A", "env-1:thread-B", "env-1:thread-C"]);

    store.enqueue(c, 0);
    expect(keys()).toEqual(["env-1:thread-C", "env-1:thread-A", "env-1:thread-B"]);
    store.remove("env-1:thread-A");
    expect(keys()).toEqual(["env-1:thread-C", "env-1:thread-B"]);
  });

  it("a claim takes the head out of the queue and blocks a second claim until cleared", () => {
    const store = useThreadQueueStore.getState();
    store.enqueue(a);
    store.enqueue(b);
    const claim = store.claimEntry({
      key: "env-1:thread-A",
      claimId: "one",
      now: 1,
      resolve: resolveWith({ userMessageAt: "t0" }),
    });
    expect(claim?.entry.threadId).toBe("thread-A");
    expect(claim?.priorUserMessageAt).toBe("t0");
    expect(keys()).toEqual(["env-1:thread-B"]);
    expect(
      store.claimEntry({
        key: "env-1:thread-B",
        claimId: "two",
        now: 2,
        resolve: resolveWith(),
      }),
    ).toBeNull();

    store.clearInFlight("someone-else");
    expect(useThreadQueueStore.getState().inFlight?.claimId).toBe("one");
    store.clearInFlight("one");
    expect(
      store.claimEntry({
        key: "env-1:thread-B",
        claimId: "two",
        now: 3,
        resolve: resolveWith(),
      })?.entry.threadId,
    ).toBe("thread-B");
  });

  it("a hand-sent thread leaves the queue, matched by thread or by its draft", () => {
    const store = useThreadQueueStore.getState();
    store.enqueue(a);
    store.enqueue(b);
    store.enqueue(c);
    removeSentThreadFromQueue("env-1:thread-A", null);
    // The draft moved machine after joining: its key no longer matches, its draft id does.
    removeSentThreadFromQueue("env-2:thread-B", DraftId.make("draft-B"));
    expect(keys()).toEqual(["env-1:thread-C"]);
  });

  it("a hand send takes over a claim whose send has not started, matched by thread or draft", () => {
    const store = useThreadQueueStore.getState();
    store.enqueue(a);
    store.enqueue(b);
    store.claimEntry({ key: "env-1:thread-A", claimId: "one", now: 1, resolve: resolveWith() });
    expect(useThreadQueueStore.getState().inFlight?.claimId).toBe("one");
    removeSentThreadFromQueue("env-1:thread-A", null);
    expect(useThreadQueueStore.getState().inFlight).toMatchObject({
      claimId: "one",
      sentAt: expect.any(Number),
      handSent: true,
    });
    store.clearInFlight("one");
    store.claimEntry({ key: "env-1:thread-B", claimId: "two", now: 2, resolve: resolveWith() });
    expect(useThreadQueueStore.getState().inFlight?.claimId).toBe("two");
    // The draft moved machine after it was claimed: only its draft id still matches.
    removeSentThreadFromQueue("env-2:thread-moved", DraftId.make("draft-B"));
    expect(useThreadQueueStore.getState().inFlight).toMatchObject({
      claimId: "two",
      handSent: true,
    });
  });

  it("a hand send leaves a claim alone once its send has started or landed", () => {
    const store = useThreadQueueStore.getState();
    store.enqueue(a);
    store.enqueue(c);
    store.claimEntry({ key: "env-1:thread-A", claimId: "one", now: 1, resolve: resolveWith() });
    store.markSending("one", 2);
    removeSentThreadFromQueue("env-1:thread-A", null);
    expect(useThreadQueueStore.getState().inFlight).toMatchObject({ claimId: "one", sentAt: null });
    store.clearInFlight("one");
    // A claim an older tab wrote: sent, with no sending mark.
    store.claimEntry({ key: "env-1:thread-C", claimId: "two", now: 3, resolve: resolveWith() });
    store.markSent("two", 4);
    removeSentThreadFromQueue("env-1:thread-C", null);
    expect(useThreadQueueStore.getState().inFlight).toMatchObject({ claimId: "two", sentAt: 4 });
  });

  it("a failed hand send frees the slot its taken-over claim held, and nothing else", () => {
    const store = useThreadQueueStore.getState();
    store.enqueue(a);
    store.enqueue(c);
    store.claimEntry({ key: "env-1:thread-A", claimId: "one", now: 1, resolve: resolveWith() });
    removeSentThreadFromQueue("env-1:thread-A", null)();
    expect(useThreadQueueStore.getState().inFlight).toBeNull();

    // Nothing was taken over: releasing leaves another thread's claim alone.
    store.claimEntry({ key: "env-1:thread-C", claimId: "two", now: 2, resolve: resolveWith() });
    removeSentThreadFromQueue("env-1:thread-A", null)();
    expect(useThreadQueueStore.getState().inFlight?.claimId).toBe("two");

    // A late release from an earlier hand send leaves a later hand send's claim alone.
    store.clearInFlight("two");
    store.enqueue(a);
    store.claimEntry({ key: "env-1:thread-A", claimId: "three", now: 3, resolve: resolveWith() });
    const earlier = removeSentThreadFromQueue("env-1:thread-A", null);
    earlier();
    store.enqueue(a);
    store.claimEntry({ key: "env-1:thread-A", claimId: "four", now: 4, resolve: resolveWith() });
    removeSentThreadFromQueue("env-1:thread-A", null);
    earlier();
    expect(useThreadQueueStore.getState().inFlight).toMatchObject({
      claimId: "four",
      handSent: true,
    });
    store.clearInFlight("four");
    store.enqueue(c);
    store.claimEntry({ key: "env-1:thread-C", claimId: "two", now: 2, resolve: resolveWith() });

    // A stale tab took over a claim whose send then went out: the queue's send keeps it.
    const release = removeSentThreadFromQueue("env-1:thread-C", null);
    store.markSent("two", 5);
    expect(useThreadQueueStore.getState().inFlight?.sentAt).toBe(5);
    expect(useThreadQueueStore.getState().inFlight).not.toHaveProperty("handSent");
    release();
    expect(useThreadQueueStore.getState().inFlight?.claimId).toBe("two");
  });

  it("a failed send pauses the queue with the reason, and resuming clears it", () => {
    const store = useThreadQueueStore.getState();
    store.enqueue(a);
    store.enqueue(b);
    store.claimEntry({
      key: "env-1:thread-A",
      claimId: "one",
      now: 1,
      resolve: resolveWith(),
    });
    store.fail("one", { threadKey: "env-1:thread-A", title: "A", message: "boom" });
    let state = useThreadQueueStore.getState();
    expect(state.paused).toBe(true);
    expect(state.inFlight).toBeNull();
    expect(state.lastFailure?.message).toBe("boom");
    expect(keys()).toEqual(["env-1:thread-B"]);

    store.setPaused(false);
    state = useThreadQueueStore.getState();
    expect(state.paused).toBe(false);
    expect(state.lastFailure).toBeNull();
  });

  it("adding a thread whose claimed draft has not been sent yet does not queue it twice", () => {
    store().enqueue(a);
    store().claimEntry({ key: "env-1:thread-A", claimId: "one", now: 1, resolve: resolveWith() });
    store().enqueue(a);
    expect(keys()).toEqual([]);
    // Once sent, the composer holds a new message: adding queues that one.
    store().markSent("one", 2);
    store().enqueue(a);
    expect(keys()).toEqual(["env-1:thread-A"]);
  });

  it("claims the named entry wherever it sits, once", () => {
    const store = useThreadQueueStore.getState();
    store.enqueue(a);
    store.enqueue(b);
    store.enqueue(c);
    const claim = store.claimEntry({
      key: "env-1:thread-B",
      claimId: "one",
      now: 1,
      resolve: resolveWith({ userMessageAt: "t0", turnId: "turn-9", sessionUpdatedAt: "s9" }),
    });
    expect(claim).toMatchObject({
      entry: { threadId: "thread-B" },
      priorTurnId: "turn-9",
      priorSessionUpdatedAt: "s9",
    });
    expect(keys()).toEqual(["env-1:thread-A", "env-1:thread-C"]);
    expect(
      store.claimEntry({
        key: "env-1:thread-A",
        claimId: "two",
        now: 2,
        resolve: resolveWith(),
      }),
    ).toBeNull();
    store.clearInFlight("one");
    expect(
      store.claimEntry({
        key: "env-1:missing",
        claimId: "three",
        now: 3,
        resolve: resolveWith(),
      }),
    ).toBeNull();
  });
});

describe("queue modes", () => {
  // Pending accepts no user change and never writes.
  it("pending shows the mirror read-only and accepts no user change", () => {
    const write = vi.fn();
    store().setWriter({ write, reportFailure: vi.fn() });
    store().setConnection({ ...SERVER, connected: false });
    expect(store().mode).toBe("pending");
    expect(store().readOnly).toBe(true);
    store().enqueue(a);
    store().setPaused(true);
    store().remove("env-1:thread-A");
    expect(store().entries).toEqual([]);
    expect(store().paused).toBe(false);
    expect(write).not.toHaveBeenCalled();

    // A session without operate scope sees the live queue but cannot change it either.
    store().setConnection({ ...SERVER, canWrite: false });
    store().receiveDocument({ ...emptyDocument("boot-1"), entries: [queued(a)] }, Date.now());
    expect(store()).toMatchObject({ mode: "server", readOnly: true });
    store().enqueue(b);
    store().remove("env-1:thread-A");
    expect(store().entries).toHaveLength(1);
    expect(
      store().claimEntry({ key: "env-1:thread-A", claimId: "x", now: 1, resolve: resolveWith() }),
    ).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });

  it("never calls the queue RPCs on a cached config or a server without the capability", () => {
    const write = vi.fn();
    store().setWriter({ write, reportFailure: vi.fn() });
    store().setConnection({ ...SERVER, configSource: "cache" });
    store().receiveDocument(emptyDocument("boot-1"), Date.now());
    expect(store().mode).toBe("pending");
    store().setConnection({ ...SERVER, capability: false });
    expect(store().mode).toBe("local");
    store().setConnection({ ...SERVER, primaryId: null, configSource: null });
    expect(store().mode).toBe("pending");
    expect(write).not.toHaveBeenCalled();
  });

  // The v1 key still holds threads sent by hand while the server's queue ran.
  it("loads a v1 queue paused once after this device ran in server mode, and as it was otherwise", async () => {
    store().enqueue(a);
    await enterLocal();
    expect(store()).toMatchObject({ paused: false, entries: [expect.objectContaining(a)] });

    store().setWriter({ write: acceptAll(), reportFailure: vi.fn() });
    store().setConnection(SERVER);
    store().receiveDocument(emptyDocument("boot-1"), Date.now());
    expect(store().mode).toBe("server");
    await enterLocal();
    expect(store()).toMatchObject({ paused: true, entries: [expect.objectContaining(a)] });
    expect(JSON.parse(localStorage.getItem(THREAD_QUEUE_STORAGE_KEY)!).state.paused).toBe(true);

    // Once: a resume sticks across the next load.
    store().setPaused(false);
    await useThreadQueueStore.persist.rehydrate();
    expect(store().paused).toBe(false);
  });

  it("counts the v1 entries left behind on the first server run only, without writing v1", () => {
    store().enqueue(a);
    store().enqueue(c);
    const v1 = localStorage.getItem(THREAD_QUEUE_STORAGE_KEY);
    store().setWriter({ write: acceptAll(), reportFailure: vi.fn() });
    store().setConnection(SERVER);
    store().receiveDocument(emptyDocument("boot-1"), Date.now());
    expect(store().localEntriesLeftBehind).toBe(2);
    useThreadQueueStore.setState({ localEntriesLeftBehind: 0 });
    store().setConnection({ ...SERVER, connected: false });
    store().setConnection(SERVER);
    store().receiveDocument(emptyDocument("boot-1", 1), Date.now());
    expect(store().mode).toBe("server");
    expect(store().localEntriesLeftBehind).toBe(0);
    expect(localStorage.getItem(THREAD_QUEUE_STORAGE_KEY)).toBe(v1);
  });

  it("counts the v1 entries left behind once per page load when storage refuses the seen-server key", async () => {
    store().enqueue(a);
    store().enqueue(c);
    const setItem = localStorage.setItem;
    const refusing = vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
      if (key === "t3code:thread-queue-seen-server:v1") throw new Error("QuotaExceededError");
      setItem(key, value);
    });
    try {
      vi.resetModules();
      const fresh = (await import("./threadQueueStore")).useThreadQueueStore;
      fresh.getState().setWriter({ write: acceptAll(), reportFailure: vi.fn() });
      const counts: number[] = [];
      for (let revision = 0; revision < 3; revision++) {
        fresh.getState().setConnection({ ...SERVER, connected: false });
        fresh.getState().setConnection(SERVER);
        fresh.getState().receiveDocument(emptyDocument("boot-1", revision), Date.now());
        expect(fresh.getState().mode).toBe("server");
        counts.push(fresh.getState().localEntriesLeftBehind);
        fresh.setState({ localEntriesLeftBehind: 0 });
      }
      expect(counts).toEqual([2, 0, 0]);
    } finally {
      refusing.mockRestore();
    }
  });

  it("server mode never writes the v1 key", async () => {
    store().enqueue(a);
    const v1 = localStorage.getItem(THREAD_QUEUE_STORAGE_KEY);
    expect(v1).toContain("thread-A");
    store().setWriter({ write: acceptAll(), reportFailure: vi.fn() });
    store().setConnection(SERVER);
    store().receiveDocument(emptyDocument("boot-1"), Date.now());
    expect(store().mode).toBe("server");
    store().enqueue(b);
    store().setPaused(true);
    await vi.waitFor(() => expect(store().pending).toEqual([]));
    store().setConnection({ ...SERVER, connected: false });
    expect(localStorage.getItem(THREAD_QUEUE_STORAGE_KEY)).toBe(v1);
  });

  // What a hand send or a send's outcome changes while pending is held, then applied
  // when the queue opens.
  it("holds a hand-sent removal while pending and applies it when server mode starts", async () => {
    const write = acceptAll();
    store().setWriter({ write, reportFailure: vi.fn() });
    const sending = {
      entry: queued(b),
      claimId: "claim-B",
      claimedAt: 1,
      priorUserMessageAt: null,
      priorTurnId: null,
      priorSessionUpdatedAt: null,
      sentAt: null,
      sendingAt: 2,
    };
    const document = { ...emptyDocument("boot-1", 3), entries: [queued(a)], inFlight: sending };
    store().setConnection(SERVER);
    store().receiveDocument(document, Date.now());
    store().setConnection({ ...SERVER, connected: false });
    removeSentThreadFromQueue("env-1:thread-A", null);
    // The queue's own send of B settles while the primary is away.
    store().markSent("claim-B", 7);
    expect(write).not.toHaveBeenCalled();
    expect(store().held).toHaveLength(2);
    expect(store().entries).toEqual([]); // shown applied, even while held
    expect(store().inFlight?.sentAt).toBe(7);

    store().setConnection(SERVER);
    store().receiveDocument(document, Date.now());
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    expect(write.mock.calls[0]![0]).toMatchObject({ expectedRevision: 3, state: { entries: [] } });
    expect(write.mock.calls[1]![0]).toMatchObject({
      expectedRevision: 4,
      state: { inFlight: { claimId: "claim-B", sentAt: 7 } },
    });
    expect(store().held).toEqual([]);

    // A failure is held too: dropped, the server's queue would stay unpaused behind a stale claim.
    const failure = { threadKey: "env-1:thread-B", title: "B", message: "boom" };
    store().setConnection({ ...SERVER, connected: false });
    store().fail("claim-B", failure);
    expect(store()).toMatchObject({ paused: true, inFlight: null, lastFailure: failure });
    store().setConnection(SERVER);
    store().receiveDocument(store().server!, Date.now());
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(3));
    expect(write.mock.calls[2]![0]).toMatchObject({
      expectedRevision: 5,
      state: { inFlight: null, paused: true, lastFailure: failure },
    });
  });

  it("local mode keeps today's cross-tab claim check", async () => {
    vi.useFakeTimers();
    store().enqueue(a);
    store().claimEntry({ key: "env-1:thread-A", claimId: "mine", now: 1, resolve: resolveWith() });
    // Another tab's claim lands in storage during the settle.
    const raw = JSON.parse(localStorage.getItem(THREAD_QUEUE_STORAGE_KEY)!);
    raw.state.inFlight.claimId = "other-tab";
    localStorage.setItem(THREAD_QUEUE_STORAGE_KEY, JSON.stringify(raw));
    const confirmed = store().confirmClaim("mine");
    await vi.advanceTimersByTimeAsync(300);
    expect(await confirmed).toBe(false);
  });

  it("stamps the owner and a clamped label on enqueue; v1 entries from before ownership are this device's", async () => {
    store().enqueue({ ...a, label: `${"x".repeat(100)}\nmore` });
    const device = queueDeviceId();
    expect(store().entries[0]).toMatchObject({ label: "x".repeat(80), ownerId: device });
    localStorage.setItem(
      THREAD_QUEUE_STORAGE_KEY,
      JSON.stringify({
        state: {
          entries: [{ ...c, addedAt: 1 }],
          paused: false,
          inFlight: null,
          lastFailure: null,
        },
        version: 1,
      }),
    );
    await useThreadQueueStore.persist.rehydrate();
    expect(store().entries).toEqual([{ ...c, addedAt: 1, ownerId: device, label: null }]);
  });

  // Ruling 8: a take-over from another tab can land between the claim and the send.
  it("a send starts only once the server holds its sending mark, never over a take-over", async () => {
    const server = fakeServer({ ...emptyDocument("boot-1"), entries: [queued(a), queued(c)] });
    store().setWriter({ write: server.write, reportFailure: vi.fn() });
    store().setConnection(SERVER);
    store().receiveDocument(server.document, Date.now());

    store().claimEntry({ key: "env-1:thread-A", claimId: "one", now: 1, resolve: resolveWith() });
    expect(await store().confirmClaim("one")).toBe(true);
    expect(await store().markSending("one", 2)).toBe(true);
    expect(server.document.inFlight).toMatchObject({ claimId: "one", sendingAt: 2 });
    store().clearInFlight("one");
    await vi.waitFor(() => expect(store().pending).toEqual([]));

    store().claimEntry({ key: "env-1:thread-C", claimId: "two", now: 3, resolve: resolveWith() });
    expect(await store().confirmClaim("two")).toBe(true);
    // Another tab of this device sent C by hand; its take-over reached the server first.
    server.document = {
      ...server.document,
      revision: server.document.revision + 1,
      inFlight: { ...server.document.inFlight!, sentAt: 4, handSent: true },
    };
    expect(await store().markSending("two", 5)).toBe(false);
    expect(server.document.inFlight).not.toHaveProperty("sendingAt");
    expect(store().inFlight).toMatchObject({ claimId: "two", handSent: true });
  });

  // Ruling 3: the release frees only a claim its own removal took over; a held removal's is a no-op.
  it("a failed hand send releases its taken-over claim on the server, but not one held while pending", async () => {
    const server = fakeServer({ ...emptyDocument("boot-1"), entries: [queued(a), queued(c)] });
    store().setWriter({ write: server.write, reportFailure: vi.fn() });
    store().setConnection(SERVER);
    store().receiveDocument(server.document, Date.now());

    store().claimEntry({ key: "env-1:thread-A", claimId: "one", now: 1, resolve: resolveWith() });
    await store().confirmClaim("one");
    const release = removeSentThreadFromQueue("env-1:thread-A", null);
    await vi.waitFor(() =>
      expect(server.document.inFlight).toMatchObject({ claimId: "one", handSent: true }),
    );
    release();
    await vi.waitFor(() => expect(server.document.inFlight).toBeNull());

    store().claimEntry({ key: "env-1:thread-C", claimId: "two", now: 2, resolve: resolveWith() });
    await store().confirmClaim("two");
    store().setConnection({ ...SERVER, connected: false });
    const held = removeSentThreadFromQueue("env-1:thread-C", null);
    held();
    expect(store().held).toHaveLength(1);
    store().setConnection(SERVER);
    store().receiveDocument(server.document, Date.now());
    await vi.waitFor(() =>
      expect(server.document.inFlight).toMatchObject({ claimId: "two", handSent: true }),
    );
    await idle();
  });

  // A claim's waiter gives up when server mode ends, so its write must not follow.
  it("a claim still queued when the primary disconnects is never written after the reconnect", async () => {
    const server = fakeServer({ ...emptyDocument("boot-1"), entries: [queued(a)] });
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const write = vi.fn(async (input: ThreadQueueSetInput) => {
      await gate;
      return server.write(input);
    });
    store().setWriter({ write, reportFailure: vi.fn() });
    store().setConnection(SERVER);
    store().receiveDocument(server.document, Date.now());

    // In flight, holding the claim behind it. Not a pause: a paused queue refuses the claim anyway.
    store().enqueue(c);
    store().claimEntry({ key: "env-1:thread-A", claimId: "one", now: 1, resolve: resolveWith() });
    const confirmed = store().confirmClaim("one");
    store().setConnection({ ...SERVER, connected: false });
    expect(await confirmed).toBe(false);
    open();
    await vi.waitFor(() => expect(server.document.entries).toHaveLength(2));

    store().setConnection(SERVER);
    store().receiveDocument(server.document, Date.now());
    await vi.waitFor(() => expect(store().pending).toEqual([]));
    expect(write).toHaveBeenCalledTimes(1);
    expect(server.document.inFlight).toBeNull();
    expect(server.document.entries.map(threadQueueEntryKey)).toEqual([
      threadQueueEntryKey(a),
      threadQueueEntryKey(c),
    ]);
  });

  // Held changes belong to the queue they were made against.
  it("held changes never reach another primary's queue, and a held failure never pauses the local one", async () => {
    const failure = { threadKey: "env-1:thread-C", title: "C", message: "boom" };
    store().setConnection(SERVER);
    store().receiveDocument({ ...emptyDocument("boot-1"), entries: [queued(a)] }, Date.now());
    store().setConnection({ ...SERVER, connected: false });
    removeSentThreadFromQueue("env-1:thread-A", null);
    expect(store().held).toHaveLength(1);
    store().setConnection({ ...SERVER, primaryId: EnvironmentId.make("env-other") });
    expect(store().held).toEqual([]);

    // The same primary turns out to lack the capability: the queue is this device's after all.
    await enterLocal();
    store().enqueue(a);
    store().enqueue(c);
    store().setConnection({ ...SERVER, connected: false });
    removeSentThreadFromQueue("env-1:thread-A", null);
    store().fail("claim-C", failure);
    expect(store().held).toHaveLength(2);
    store().setConnection({ ...SERVER, capability: false });
    expect(store().mode).toBe("local");
    await useThreadQueueStore.persist.rehydrate();
    expect(keys()).toEqual(["env-1:thread-C"]);
    expect(store()).toMatchObject({ held: [], paused: false, lastFailure: null });
  });

  // While pending, the last document seen from this primary is shown, and only its.
  it("pending shows the last document mirrored for this primary, read-only", () => {
    store().setConnection(SERVER);
    store().receiveDocument({ ...emptyDocument("boot-1", 4), entries: [queued(a)] }, Date.now());
    const other = EnvironmentId.make("env-other");
    store().setConnection({ ...SERVER, primaryId: other, connected: false });
    expect(store()).toMatchObject({ mode: "pending", entries: [] });
    store().setConnection({ ...SERVER, connected: false });
    expect(store()).toMatchObject({ mode: "pending", readOnly: true, entries: [queued(a)] });
  });
});

it("a full storage does not stop this device from getting an id", async () => {
  const setItem = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
    throw new Error("QuotaExceededError");
  });
  try {
    vi.resetModules();
    const fresh = await import("./threadQueueStore");
    expect(fresh.queueDeviceId()).toEqual(expect.any(String));
  } finally {
    setItem.mockRestore();
  }
});

/**
 * The server's compare-and-set, as `ThreadQueueService.set` does it; claim times are stamped as
 * `stampClaimTimes` stamps them (keep the two alike).
 */
function casServer(bootId: string, revision = 0) {
  let document: ThreadQueueDocument = emptyDocument(bootId, revision);
  let now = 1_000_000;
  const writes: ThreadQueueSetInput[] = [];
  return {
    get document() {
      return document;
    },
    set now(value: number) {
      now = value;
    },
    get now() {
      return now;
    },
    writes,
    restart(nextBoot: string) {
      document = { ...document, bootId: nextBoot };
    },
    /** Another writer's change, landing first. */
    replace(state: Partial<ThreadQueueDocument>) {
      document = { ...document, ...state, revision: document.revision + 1 };
    },
    apply(input: ThreadQueueSetInput): ThreadQueueSetResult {
      writes.push(input);
      if (input.bootId !== document.bootId || input.expectedRevision !== document.revision) {
        return { ok: false, document, serverTime: now };
      }
      const next = input.state.inFlight;
      let inFlight: ThreadQueueDocument["inFlight"] = null;
      if (next !== null) {
        const { sendingAt, ...claim } = next;
        const first = document.inFlight?.claimId === next.claimId ? document.inFlight : null;
        const sending = first?.sendingAt ?? (sendingAt === undefined ? undefined : now);
        inFlight = {
          ...claim,
          claimedAt: first?.claimedAt ?? now,
          sentAt: first?.sentAt ?? (next.sentAt === null ? null : now),
          ...(sending !== undefined && { sendingAt: sending }),
        };
      }
      document = {
        bootId: document.bootId,
        revision: document.revision + 1,
        ...input.state,
        inFlight,
      };
      return { ok: true, document, serverTime: now };
    },
  };
}
type CasServer = ReturnType<typeof casServer>;
function enterServer(server: CasServer, overrides: Partial<ThreadQueueWriter> = {}) {
  const reportFailure = vi.fn();
  store().setWriter({ write: async (input) => server.apply(input), reportFailure, ...overrides });
  store().setConnection(SERVER);
  store().receiveDocument(server.document, server.now);
  return { reportFailure };
}
/** A writer whose next reply is lost after the server applied the write. */
function losingWriter(server: CasServer) {
  const writer = {
    loseNext: false,
    write: async (input: ThreadQueueSetInput) => {
      const reply = server.apply(input);
      if (writer.loseNext) {
        writer.loseNext = false;
        throw new Error("socket closed");
      }
      return reply;
    },
  };
  return writer;
}
const idle = () => vi.waitFor(() => expect(store().pending).toEqual([]));
const claimA = (claimId = "mine") =>
  store().claimEntry({
    key: "env-1:thread-A",
    claimId,
    now: store().serverNow(),
    resolve: resolveWith(),
  });

describe("server mode", () => {
  it("on one boot never adopts a lower or equal revision; another boot is always adopted", () => {
    const server = casServer("boot-1", 2);
    enterServer(server);
    store().receiveDocument(emptyDocument("boot-1", 1), server.now);
    expect(store().server?.revision).toBe(2);
    store().receiveDocument({ ...emptyDocument("boot-1", 2), paused: true }, server.now);
    expect(store().server?.paused).toBe(false);
    store().receiveDocument(emptyDocument("boot-2", 0), server.now);
    expect(store().server).toMatchObject({ bootId: "boot-2", revision: 0 });
  });

  // A write in flight across a restart is refused once and re-run.
  it("converges after a server restart in one retry", async () => {
    const server = casServer("boot-1", 3);
    enterServer(server);
    server.restart("boot-2");
    store().enqueue(a);
    await idle();
    expect(server.writes.map((w) => w.bootId)).toEqual(["boot-1", "boot-2"]);
    expect(server.document.entries.map((e) => e.threadId)).toEqual(["thread-A"]);
    expect(store().entries.map((e) => e.threadId)).toEqual(["thread-A"]);
  });

  // Another writer's claim lands first; ours becomes a no-op.
  it("a claim another writer beat is not won", async () => {
    const server = casServer("boot-1");
    enterServer(server);
    store().enqueue(a);
    await idle();
    const theirs = { ...server.document.entries[0]! };
    server.replace({
      entries: [],
      inFlight: {
        entry: theirs,
        claimId: "other-tab",
        claimedAt: 1,
        priorUserMessageAt: null,
        priorTurnId: null,
        priorSessionUpdatedAt: null,
        sentAt: null,
      },
    });
    expect(claimA()).not.toBeNull();
    expect(await store().confirmClaim("mine")).toBe(false);
    expect(store().server?.inFlight?.claimId).toBe("other-tab");
  });

  // The server applied the claim but its reply was lost; re-sending the document the
  // claim was written on gets a reply that settles it.
  it("a claim whose reply was lost is won, and sent once", async () => {
    const server = casServer("boot-1");
    const writer = losingWriter(server);
    enterServer(server, { write: writer.write });
    store().enqueue(a);
    await idle();
    writer.loseNext = true;
    claimA();
    expect(await store().confirmClaim("mine")).toBe(true);
    // The re-send carries the document the claim was written on, so the server refuses it.
    expect(
      server.writes.slice(1).map((w) => [w.expectedRevision, w.state.inFlight?.claimId]),
    ).toEqual([
      [1, "mine"],
      [1, undefined],
    ]);
    expect(await store().markSending("mine", 2)).toBe(true);
    expect(server.writes.filter((w) => w.state.inFlight?.claimId === "mine")).toHaveLength(2);
    expect(server.document).toMatchObject({ entries: [], inFlight: { claimId: "mine" } });
    expect(claimA("again")).toBeNull();
  });

  it("a claim that never reached the server is lost, and the entry stays queued", async () => {
    const server = casServer("boot-1");
    let failNext = false;
    enterServer(server, {
      write: async (input) => {
        if (failNext) {
          failNext = false;
          throw new Error("socket closed");
        }
        return server.apply(input);
      },
    });
    store().enqueue(a);
    await idle();
    failNext = true;
    claimA();
    expect(await store().confirmClaim("mine")).toBe(false);
    expect(store()).toMatchObject({ inFlight: null, entries: [expect.objectContaining(a)] });
  });

  // Ruling 8: a lost sending-mark reply does not strand the claim.
  it("a sending mark whose reply was lost still lets the send go", async () => {
    const server = casServer("boot-1");
    const writer = losingWriter(server);
    enterServer(server, { write: writer.write });
    store().enqueue(a);
    await idle();
    claimA();
    expect(await store().confirmClaim("mine")).toBe(true);
    writer.loseNext = true;
    expect(await store().markSending("mine", 2)).toBe(true);
    expect(server.document.inFlight).toMatchObject({ claimId: "mine", sendingAt: server.now });
  });

  it("re-sends with backoff while the request fails, and stops when a document or a disconnect settles it", async () => {
    vi.useFakeTimers();
    const server = casServer("boot-1", 0);
    server.replace({ entries: [{ ...queued(a), ownerId: "device-a" }] });
    let down = false;
    let lose = false;
    let attempts = 0;
    enterServer(server, {
      write: async (input) => {
        attempts += 1;
        if (down) throw new Error("socket closed");
        const reply = server.apply(input);
        if (lose) {
          lose = false;
          down = true;
          throw new Error("socket closed");
        }
        return reply;
      },
    });
    const writes = () => server.writes.length;

    // The claim lands, its reply is lost, and the next two re-sends fail: 1 s, then 2 s apart.
    lose = true;
    claimA("one");
    let settled: boolean | undefined;
    void store()
      .confirmClaim("one")
      .then((won) => (settled = won));
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(3);
    down = false;
    await vi.advanceTimersByTimeAsync(1_999);
    expect(attempts).toBe(3);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(4);
    expect(settled).toBe(true);
    expect(writes()).toBe(2);

    // A document showing the claim settles it between re-sends.
    store().clearInFlight("one");
    await vi.advanceTimersByTimeAsync(0);
    store().enqueue(c);
    await vi.advanceTimersByTimeAsync(0);
    lose = true;
    store().claimEntry({ key: "env-1:thread-C", claimId: "two", now: 1, resolve: resolveWith() });
    settled = undefined;
    void store()
      .confirmClaim("two")
      .then((won) => (settled = won));
    await vi.advanceTimersByTimeAsync(0);
    const before = writes();
    store().receiveDocument(server.document, server.now);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(writes()).toBe(before);

    // Leaving server mode ends the wait as unconfirmed.
    down = false;
    store().clearInFlight("two");
    store().enqueue(a);
    await vi.advanceTimersByTimeAsync(0);
    lose = true;
    claimA("three");
    settled = undefined;
    void store()
      .confirmClaim("three")
      .then((won) => (settled = won));
    await vi.advanceTimersByTimeAsync(0);
    const stopped = writes();
    store().setConnection({ ...SERVER, connected: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(writes()).toBe(stopped);
  });

  it("a lost-reply re-send stops once the session may no longer write the queue", async () => {
    vi.useFakeTimers();
    const server = casServer("boot-1");
    let attempts = 0;
    let lose = false;
    enterServer(server, {
      write: async (input) => {
        attempts += 1;
        if (lose) throw new Error("socket closed");
        return server.apply(input);
      },
    });
    store().enqueue(a);
    await vi.advanceTimersByTimeAsync(0);
    lose = true;
    claimA();
    let settled: boolean | undefined;
    void store()
      .confirmClaim("mine")
      .then((won) => (settled = won));
    await vi.advanceTimersByTimeAsync(0);
    const before = attempts;
    store().setConnection({ ...SERVER, canWrite: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(store()).toMatchObject({ mode: "server", readOnly: true });
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempts).toBe(before);
  });

  // A lost markSent reply leaves the server's stamp, and re-running it writes nothing.
  it("server owns sentAt; a markSent re-run after a lost reply is a no-op", async () => {
    const server = casServer("boot-1");
    const writer = losingWriter(server);
    enterServer(server, { write: writer.write });
    store().enqueue(a);
    await idle();
    store().claimEntry({ key: "env-1:thread-A", claimId: "mine", now: 1, resolve: resolveWith() });
    expect(await store().confirmClaim("mine")).toBe(true);
    server.now = 1_005_000;
    writer.loseNext = true;
    store().markSent("mine", 42);
    await idle();
    store().receiveDocument(server.document, server.now);
    expect(store().server?.inFlight?.sentAt).toBe(1_005_000);
    const writes = server.writes.length;
    store().markSent("mine", 43);
    await idle();
    expect(server.writes.length).toBe(writes);
  });

  // Every time the queue uses is the server's clock.
  it("measures time on the server's clock, from the latest message", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000_000);
    const server = casServer("boot-1");
    server.now = 10_000_000 - 600_000; // this device runs 10 minutes ahead
    enterServer(server);
    expect(store().serverNow()).toBe(10_000_000 - 600_000);
  });

  it("a failed write drops the change, toasting for a user change only", async () => {
    const server = casServer("boot-1");
    server.replace({ entries: [{ ...a, addedAt: 1, ownerId: "device-b", label: "A" }] });
    const write = vi.fn(async () => {
      throw new Error("disk full");
    });
    const { reportFailure } = enterServer(server, { write });
    // A coordinator write that fails: dropped silently.
    store().prune(["env-1:thread-A"]);
    await idle();
    expect(write).toHaveBeenCalledTimes(1);
    expect(reportFailure).not.toHaveBeenCalled();
    expect(store().entries.map((e) => e.threadId)).toEqual(["thread-A"]);
    // A user's write that fails: dropped, one toast.
    store().enqueue(b);
    await idle();
    expect(write).toHaveBeenCalledTimes(2);
    expect(reportFailure).toHaveBeenCalledTimes(1);
    expect(store().entries.map((e) => e.threadId)).toEqual(["thread-A"]);
  });

  it("a read-only session (no operate scope) changes nothing and the coordinator gets no claim", () => {
    const server = casServer("boot-1");
    enterServer(server);
    store().setConnection({ ...SERVER, canWrite: false });
    expect(store().readOnly).toBe(true);
    store().enqueue(a);
    expect(store().pending).toEqual([]);
    expect(
      store().claimEntry({ key: "env-1:thread-A", claimId: "x", now: 1, resolve: resolveWith() }),
    ).toBeNull();
  });

  it("a primary change drops the old server's document and unconfirmed changes", () => {
    const server = casServer("boot-1");
    enterServer(server);
    // No writer: the change stays unconfirmed (a writer that never settles would wedge the
    // module's single write chain for every later test).
    store().setWriter(null);
    store().enqueue(a);
    expect(store().pending).toHaveLength(1);
    store().setConnection({ ...SERVER, primaryId: EnvironmentId.make("env-other") });
    expect(store().server).toBeNull();
    expect(store().pending).toEqual([]);
    expect(store().mode).toBe("pending");
  });

  /** A writer that lets another device's write land, and reach this tab, before its first write. */
  function beatenOnce(server: CasServer, other: Partial<ThreadQueueDocument>) {
    let beaten = false;
    return async (input: ThreadQueueSetInput) => {
      if (!beaten) {
        beaten = true;
        server.replace(other);
        store().receiveDocument(server.document, server.now);
      }
      return server.apply(input);
    };
  }

  // The refusal's document is already the adopted one, yet it is newer than the write's base.
  it("a change refused because another device's write arrived first is re-run, not dropped", async () => {
    const server = casServer("boot-1");
    enterServer(server, {
      write: beatenOnce(server, { entries: [{ ...queued(b), ownerId: "device-b" }] }),
    });
    store().enqueue(c);
    await idle();
    expect(server.document.entries.map((e) => e.threadId)).toEqual(["thread-B", "thread-C"]);
  });

  // A drag decided before another device's claim landed must not re-add the claimed row as ours.
  it("a reorder refused behind another device's claim of the row does not bring it back", async () => {
    const server = casServer("boot-1");
    const ownedA = { ...queued(a), ownerId: "device-b" };
    const ownedC = { ...queued(c), ownerId: "device-b" };
    server.replace({ entries: [ownedA, ownedC] });
    const claimOfA = {
      entry: ownedA,
      claimId: "device-b-claim",
      claimedAt: 1,
      priorUserMessageAt: null,
      priorTurnId: null,
      priorSessionUpdatedAt: null,
      sentAt: null,
    };
    enterServer(server, { write: beatenOnce(server, { entries: [ownedC], inFlight: claimOfA }) });
    store().enqueue(a, 1);
    await idle();
    expect(server.document.inFlight).toMatchObject({ claimId: "device-b-claim" });
    expect(server.document.entries).toEqual([ownedC]);
  });

  // The abandon was decided on an unsent claim; the owner's mark-sent landed first.
  it("an abandon refused behind the owner's mark-sent keeps the sent claim", async () => {
    const server = casServer("boot-1");
    const unsent = {
      entry: { ...queued(a), ownerId: "device-b" },
      claimId: "device-b-claim",
      claimedAt: 1,
      priorUserMessageAt: null,
      priorTurnId: null,
      priorSessionUpdatedAt: null,
      sentAt: null,
    };
    server.replace({ inFlight: unsent });
    enterServer(server, {
      write: beatenOnce(server, { inFlight: { ...unsent, sentAt: 5 } }),
    });
    store().clearInFlight("device-b-claim", true);
    await idle();
    expect(server.document.inFlight).toMatchObject({ claimId: "device-b-claim", sentAt: 5 });
  });

  // The resume was decided on a queue with no failure; another device's send failed first.
  it("a resume refused behind another device's failure keeps that failure showing", async () => {
    const server = casServer("boot-1");
    server.replace({ paused: true });
    const failure = { title: "B", message: "boom", threadKey: "env-1:thread-B" };
    enterServer(server, { write: beatenOnce(server, { lastFailure: failure }) });
    store().setPaused(false);
    await idle();
    expect(server.document).toMatchObject({ paused: true, lastFailure: failure });
    expect(store().lastFailure).toEqual(failure);
  });

  // The add was decided before another device claimed the same thread.
  it("an add refused behind another device's claim of that thread does not queue it again", async () => {
    const server = casServer("boot-1");
    const claimOfA = {
      entry: { ...queued(a), ownerId: "device-b" },
      claimId: "device-b-claim",
      claimedAt: 1,
      priorUserMessageAt: null,
      priorTurnId: null,
      priorSessionUpdatedAt: null,
      sentAt: null,
    };
    enterServer(server, { write: beatenOnce(server, { inFlight: claimOfA }) });
    store().enqueue(a);
    await idle();
    expect(server.document.entries).toEqual([]);
    expect(server.document.inFlight?.claimId).toBe("device-b-claim");
  });

  // A refusal carrying no newer document cannot converge: re-sending would loop forever.
  it("a change refused at the same revision is dropped, not re-sent", async () => {
    const server = casServer("boot-1");
    let calls = 0;
    enterServer(server, {
      write: async () => {
        calls += 1;
        // Ends a resend loop fast: a throw drops the change.
        if (calls > 3) throw new Error("re-sent in a loop");
        return { ok: false, document: server.document, serverTime: server.now };
      },
    });
    store().enqueue(a);
    await idle();
    expect(calls).toBe(1);
    expect(server.document.entries).toEqual([]);
  });

  it("a sending mark refused behind an unrelated write still lands and lets the send go", async () => {
    const server = casServer("boot-1");
    let beat: ((input: ThreadQueueSetInput) => Promise<ThreadQueueSetResult>) | null = null;
    enterServer(server, {
      write: async (input) => (beat === null ? server.apply(input) : beat(input)),
    });
    store().enqueue(a);
    await idle();
    claimA();
    expect(await store().confirmClaim("mine")).toBe(true);
    beat = beatenOnce(server, { paused: true });
    expect(await store().markSending("mine", 2)).toBe(true);
    expect(server.document.inFlight).toMatchObject({ claimId: "mine", sendingAt: server.now });
  });

  it("keeps one held hand-sent removal per thread while pending", () => {
    store().setConnection({ ...SERVER, connected: false });
    expect(store().mode).toBe("pending");
    for (let i = 0; i < 300; i++) {
      store().removeSent(`env-1:thread-${i % 3}`, null);
    }
    store().removeSent("env-1:thread-0", DraftId.make("draft-0"));
    expect(store().held).toHaveLength(4);
  });

  it("a reorder hands the sidebar a new entries list once", async () => {
    const server = casServer("boot-1");
    enterServer(server);
    store().enqueue(a);
    store().enqueue(b);
    await idle();
    const identities = new Set([store().entries]);
    const unsubscribe = useThreadQueueStore.subscribe((state) => identities.add(state.entries));
    store().enqueue(b, 0);
    await idle();
    unsubscribe();
    expect(keys()).toEqual(["env-1:thread-B", "env-1:thread-A"]);
    expect(identities.size).toBe(2);
  });

  // The server refuses an over-long failure, so the client never composes one.
  it("bounds a failure's title and message before writing it", async () => {
    const server = casServer("boot-1");
    enterServer(server);
    store().enqueue(a);
    await idle();
    claimA();
    expect(await store().confirmClaim("mine")).toBe(true);
    store().fail("mine", {
      threadKey: "env-1:thread-A",
      title: "t".repeat(10_000),
      message: "m".repeat(10_000),
    });
    await idle();
    expect(server.document.lastFailure?.title).toHaveLength(THREAD_QUEUE_FAILURE_TITLE_MAX_LENGTH);
    expect(server.document.lastFailure?.message).toHaveLength(
      THREAD_QUEUE_FAILURE_MESSAGE_MAX_LENGTH,
    );
  });
});

// A connected server that never answers a write must not hold the chain, the claims waiting on
// it, or the coordinator. The write may still have landed, so it is given up like a failed
// request and never re-run: a re-run could undo another device's later change.
describe("a write that gets no reply", () => {
  const BOUND = SLOW_RPC_ACK_THRESHOLD_MS;
  const never = () => new Promise<ThreadQueueSetResult>(() => {});
  const threadIds = (entries: ReadonlyArray<{ threadId: string }>) =>
    entries.map((e) => e.threadId);
  /** The first write is applied by the server, but its reply never comes. */
  function landsButNoReply(server: CasServer) {
    let first = true;
    return async (input: ThreadQueueSetInput) => {
      const reply = server.apply(input);
      if (!first) return reply;
      first = false;
      return never();
    };
  }

  it("is given up after the bound and reported, and the change queued behind it still goes", async () => {
    vi.useFakeTimers();
    const server = casServer("boot-1");
    let hangNext = true;
    let calls = 0;
    const { reportFailure } = enterServer(server, {
      write: async (input) => {
        calls += 1;
        if (hangNext) {
          hangNext = false;
          return never();
        }
        return server.apply(input);
      },
    });
    store().enqueue(a);
    store().enqueue(c);
    await vi.advanceTimersByTimeAsync(BOUND - 1);
    expect(calls).toBe(1);
    expect(store().pending).toHaveLength(2);
    expect(reportFailure).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(store().pending).toEqual([]);
    expect(calls).toBe(2);
    expect(reportFailure).toHaveBeenCalledTimes(1);
    expect(threadIds(server.document.entries)).toEqual(["thread-C"]);
    expect(threadIds(store().entries)).toEqual(["thread-C"]);
  });

  // A slow server, not a dead one: the given-up write is applied before or after the bound.
  // Either way it is never sent again, and the server ends with what actually landed.
  it.each([
    ["before", 0, ["thread-A", "thread-C"]],
    ["after", BOUND + 5_000, ["thread-C"]],
  ])("a slow write applied %s the bound is not sent again", async (_when, applyAfterMs, landed) => {
    vi.useFakeTimers();
    const server = casServer("boot-1");
    let slowNext = true;
    enterServer(server, {
      write: (input) => {
        if (!slowNext) return Promise.resolve(server.apply(input));
        slowNext = false;
        const applied = applyAfterMs === 0 ? server.apply(input) : null;
        return new Promise((resolve) => {
          setTimeout(() => resolve(applied ?? server.apply(input)), BOUND + 5_000);
        });
      },
    });
    store().enqueue(a);
    store().enqueue(c);
    await vi.advanceTimersByTimeAsync(BOUND + 5_000);
    expect(store().pending).toEqual([]);
    expect(server.writes.filter((w) => threadIds(w.state.entries)[0] === "thread-A")).toHaveLength(
      applyAfterMs === 0 ? 2 : 1,
    );
    expect(threadIds(server.document.entries)).toEqual(landed);
    store().receiveDocument(server.document, server.now);
    expect(threadIds(store().entries)).toEqual(landed);
  });

  // The measured slowest comparable server write is 2.2 s; one minute is far past any bound the
  // queue should wait. A bound of 1 ms or 1 h fails one of the two.
  it("a write answered in 2.2 s is sent once; one with no reply is given up within a minute", async () => {
    vi.useFakeTimers();
    const server = casServer("boot-1");
    let replyMs: number | null = 2_200;
    const { reportFailure } = enterServer(server, {
      write: (input) => {
        if (replyMs === null) return never();
        const reply = server.apply(input);
        return new Promise((resolve) => setTimeout(() => resolve(reply), replyMs!));
      },
    });
    store().enqueue(a);
    await vi.advanceTimersByTimeAsync(2_200);
    expect(server.writes).toHaveLength(1);
    expect(store().pending).toEqual([]);
    expect(reportFailure).not.toHaveBeenCalled();

    replyMs = null;
    store().enqueue(c);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store().pending).toEqual([]);
    expect(reportFailure).toHaveBeenCalledTimes(1);
  });

  it("leaves no timer behind when a write fails or is answered", async () => {
    vi.useFakeTimers();
    const server = casServer("boot-1");
    let fail = true;
    enterServer(server, {
      write: async (input) => {
        if (fail) throw new Error("socket closed");
        return server.apply(input);
      },
    });
    store().enqueue(a);
    await vi.advanceTimersByTimeAsync(0);
    expect(store().pending).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    fail = false;
    store().enqueue(c);
    await vi.advanceTimersByTimeAsync(0);
    expect(threadIds(server.document.entries)).toEqual(["thread-C"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a claim whose write never reached the server gives up after the bound", async () => {
    vi.useFakeTimers();
    const server = casServer("boot-1");
    let hangNext = false;
    enterServer(server, {
      write: async (input) => {
        if (hangNext) {
          hangNext = false;
          return never();
        }
        return server.apply(input);
      },
    });
    store().enqueue(a);
    await vi.advanceTimersByTimeAsync(0);
    hangNext = true;
    claimA();
    let settled: boolean | undefined;
    void store()
      .confirmClaim("mine")
      .then((won) => (settled = won));
    await vi.advanceTimersByTimeAsync(BOUND - 1);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(false);
    expect(server.document).toMatchObject({
      inFlight: null,
      entries: [expect.objectContaining(a)],
    });
    expect(store()).toMatchObject({ inFlight: null, entries: [expect.objectContaining(a)] });
  });

  it("a claim that landed without a reply is won after the bound, and sent once", async () => {
    vi.useFakeTimers();
    const server = casServer("boot-1");
    let write = (input: ThreadQueueSetInput) => Promise.resolve(server.apply(input));
    enterServer(server, { write: (input) => write(input) });
    store().enqueue(a);
    await vi.advanceTimersByTimeAsync(0);
    write = landsButNoReply(server);
    claimA();
    let settled: boolean | undefined;
    void store()
      .confirmClaim("mine")
      .then((won) => (settled = won));
    await vi.advanceTimersByTimeAsync(BOUND);
    expect(settled).toBe(true);
    expect(server.writes.filter((w) => w.state.inFlight?.claimId === "mine")).toHaveLength(1);
    expect(server.document).toMatchObject({ entries: [], inFlight: { claimId: "mine" } });
  });

  // The claim landed but its reply was lost; the re-send that would settle it then hangs.
  it("a lost-reply re-send that gets no reply is sent again", async () => {
    vi.useFakeTimers();
    const server = casServer("boot-1");
    let mode: "ok" | "lose" | "hang" = "ok";
    let calls = 0;
    enterServer(server, {
      write: async (input) => {
        calls += 1;
        if (mode === "hang") {
          mode = "ok";
          return never();
        }
        const reply = server.apply(input);
        if (mode === "lose") {
          mode = "hang";
          throw new Error("socket closed");
        }
        return reply;
      },
    });
    store().enqueue(a);
    await vi.advanceTimersByTimeAsync(0);
    mode = "lose";
    claimA();
    let settled: boolean | undefined;
    void store()
      .confirmClaim("mine")
      .then((won) => (settled = won));
    await vi.advanceTimersByTimeAsync(0);
    const afterLoss = calls;
    await vi.advanceTimersByTimeAsync(BOUND);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(afterLoss + 1);
    expect(settled).toBe(true);
  });

  it("against a server that never answers, each change is given up once and nothing is re-sent", async () => {
    vi.useFakeTimers();
    const server = casServer("boot-1");
    let calls = 0;
    const { reportFailure } = enterServer(server, {
      write: async () => {
        calls += 1;
        return never();
      },
    });
    store().enqueue(a);
    store().enqueue(c);
    await vi.advanceTimersByTimeAsync(2 * BOUND);
    expect(calls).toBe(2);
    expect(store().pending).toEqual([]);
    expect(reportFailure).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4 * BOUND);
    expect(calls).toBe(2);
  });

  // A write landed but its reply never came; another device changed the queue before the bound.
  // The given-up write must not be applied again over that change.
  it.each([
    ["the live document arrives", true],
    ["no document arrives", false],
  ])("a thread another device sent and cleared is not queued again (%s)", async (_n, deliver) => {
    vi.useFakeTimers();
    const server = casServer("boot-1");
    enterServer(server, { write: landsButNoReply(server) });
    store().enqueue(a);
    await vi.advanceTimersByTimeAsync(0);
    expect(threadIds(server.document.entries)).toEqual(["thread-A"]);
    if (deliver) store().receiveDocument(server.document, server.now);
    // Another device claims A, sends it, and clears the claim.
    server.replace({ entries: [] });
    server.replace({ inFlight: null });
    if (deliver) store().receiveDocument(server.document, server.now);
    await vi.advanceTimersByTimeAsync(BOUND + 10);
    expect(threadIds(server.document.entries)).toEqual([]);
  });

  it("a thread the phone removes at 10 s is not queued again", async () => {
    vi.useFakeTimers();
    const server = casServer("boot-1");
    enterServer(server, { write: landsButNoReply(server) });
    store().enqueue(a);
    await vi.advanceTimersByTimeAsync(10_000);
    server.replace({ entries: [] });
    await vi.advanceTimersByTimeAsync(BOUND);
    expect(server.writes.map((w) => w.expectedRevision)).toEqual([0]);
    expect(threadIds(server.document.entries)).toEqual([]);
  });

  it("another device's resume at 10 s is not paused again", async () => {
    vi.useFakeTimers();
    const server = casServer("boot-1");
    enterServer(server, { write: landsButNoReply(server) });
    store().setPaused(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(server.document.paused).toBe(true);
    server.replace({ paused: false });
    await vi.advanceTimersByTimeAsync(BOUND);
    expect(server.document.paused).toBe(false);
  });
});

// Ids the server derives from other ids grow past a few hundred characters: an MCP thread id
// carries an encoded client request id, and a run id encodes the thread id again.
describe("server-derived ids", () => {
  const mcpThreadId = (request: string) =>
    [
      "thread",
      "mcp",
      "0b5c8a3e-6a7a-4c3e-9f2f-0a1b2c3d4e5f",
      encodeURIComponent(request),
      "0",
    ].join(":");
  const runIdOf = (threadId: string) =>
    ["run", "thread", encodeURIComponent(threadId), "ordinal", "1"].join(":");

  /** Encodes each write as the RPC client does before sending it, which dies on a bad payload. */
  function encodingServer() {
    const server = fakeServer(emptyDocument("boot-1"));
    const failures: unknown[] = [];
    const encode = Schema.encodeUnknownSync(ThreadQueueSetInput);
    store().setWriter({
      write: async (input) => {
        encode(input);
        return server.write(input);
      },
      reportFailure: (error) => failures.push(error),
    });
    store().setConnection(SERVER);
    store().receiveDocument(server.document, Date.now());
    return { server, failures };
  }

  it("queues an MCP thread whose id passes 210 characters", async () => {
    const { server, failures } = encodingServer();
    const threadId = ThreadId.make(mcpThreadId("x".repeat(200)));
    expect(threadId.length).toBeGreaterThan(210);
    store().enqueue({ environmentId: env, threadId, draftId: null });
    await vi.waitFor(() => expect(store().pending).toEqual([]));
    expect(server.document.entries.map((entry) => entry.threadId)).toEqual([threadId]);
    expect(failures).toEqual([]);
  });

  it("claims and sends a thread whose run id passes 200 characters", async () => {
    const { server, failures } = encodingServer();
    const threadId = ThreadId.make(mcpThreadId("r".repeat(130)));
    const runId = runIdOf(threadId);
    expect(runId.length).toBeGreaterThan(200);
    const entry = { environmentId: env, threadId, draftId: null };
    store().enqueue(entry);
    await vi.waitFor(() => expect(server.document.entries).toHaveLength(1));

    store().claimEntry({
      key: threadQueueEntryKey(entry),
      claimId: "long",
      now: 1,
      resolve: resolveWith({ turnId: runId }),
    });
    expect(await store().confirmClaim("long")).toBe(true);
    expect(await store().markSending("long", 2)).toBe(true);
    expect(server.document.inFlight).toMatchObject({ claimId: "long", priorTurnId: runId });
    expect(failures).toEqual([]);
  });
});

// A claim whose prior ids outgrow the wire bound fails to encode before it is sent. Nothing
// distinguishes the next attempt, so the entry would sit at the head and block the queue.
describe("a claim that cannot be saved", () => {
  it("leaves the queue, is reported once with its entry, and the next entry is claimed", async () => {
    const server = fakeServer(emptyDocument("boot-1"));
    const encode = Schema.encodeUnknownSync(ThreadQueueSetInput);
    const reportFailure = vi.fn();
    store().setWriter({
      write: async (input) => {
        encode(input);
        return server.write(input);
      },
      reportFailure,
    });
    store().setConnection(SERVER);
    store().receiveDocument(server.document, Date.now());
    store().enqueue(a);
    store().enqueue(c);
    await vi.waitFor(() => expect(server.document.entries).toHaveLength(2));

    const tooLong = "x".repeat(THREAD_QUEUE_PRIOR_ID_MAX_LENGTH + 1);
    store().claimEntry({
      key: threadQueueEntryKey(a),
      claimId: "big",
      now: 1,
      resolve: resolveWith({ turnId: tooLong }),
    });
    expect(await store().confirmClaim("big")).toBe(false);
    await vi.waitFor(() => expect(store().pending).toEqual([]));
    expect(server.document.entries.map(threadQueueEntryKey)).toEqual([threadQueueEntryKey(c)]);
    expect(server.document.inFlight).toBeNull();
    expect(reportFailure).toHaveBeenCalledTimes(1);
    expect(Schema.isSchemaError(reportFailure.mock.calls[0]![0])).toBe(true);
    expect(reportFailure.mock.calls[0]![1]).toMatchObject({ threadId: a.threadId });

    store().claimEntry({
      key: threadQueueEntryKey(c),
      claimId: "next",
      now: 2,
      resolve: resolveWith(),
    });
    expect(await store().confirmClaim("next")).toBe(true);
    expect(reportFailure).toHaveBeenCalledTimes(1);
  });
});

/** A queued send whose branch read runs `duringBranch`; records what it sent. */
function queuedSend(
  key: string,
  claimId: string,
  duringBranch: () => void,
  overrides: Partial<Parameters<typeof claimAndSendQueueEntry>[0]> = {},
) {
  const sent: string[] = [];
  const deps: Parameters<typeof claimAndSendQueueEntry>[0] = {
    key,
    claimId,
    readGitBranch: async () => {
      duringBranch();
      return null;
    },
    resolveEntry: (entry) => entry,
    prior: () => ({ userMessageAt: null, turnId: null, sessionUpdatedAt: null }),
    now: () => store().serverNow(),
    confirm: async () => true,
    readSnapshot: (entry) => {
      sent.push(threadQueueEntryKey(entry));
      return { shell: null, draft: null } as never;
    },
    send: async () => ({ kind: "sent" }),
    title: () => "New thread",
    reportFailure: vi.fn(),
    reportEmpty: vi.fn(),
    ...overrides,
  };
  return { sent, deps };
}

describe("a queued send racing other tabs and devices", () => {
  // Tab A sleeps in the branch read past the abandon cap; tab B releases the claim in storage,
  // which puts the entry back at the front. A resumes before its storage event arrives.
  it("local: a claim another tab released while this tab slept is not sent by this tab", async () => {
    for (const entry of [a, b, c]) store().enqueue(entry);
    let tabB: ThreadQueueData | null = null;
    const run = queuedSend("env-1:thread-A", "tab-a", () => {
      const raw = JSON.parse(localStorage.getItem(THREAD_QUEUE_STORAGE_KEY)!);
      const decision = nextThreadQueueAction({
        entries: raw.state.entries,
        paused: raw.state.paused,
        inFlight: raw.state.inFlight,
        threads: [],
        nowMs: raw.state.inFlight.claimedAt + QUEUE_CLAIM_ABANDON_MS + 1,
        slots: 3,
        perProvider: false,
        providerSlots: {},
        visibleInstanceIds: [],
        targetInstanceOf: () => null,
        ownerId: null,
        leaving: new Set(),
      });
      expect(decision).toEqual({ kind: "release-claim", claimId: "tab-a" });
      tabB = applyQueueAction(raw.state, decision as { kind: "release-claim"; claimId: string });
      localStorage.setItem(THREAD_QUEUE_STORAGE_KEY, JSON.stringify({ ...raw, state: tabB }));
    });
    expect(await claimAndSendQueueEntry(run.deps)).toBe(false);
    expect(run.sent).toEqual([]);
    // Tab B, seeing the entry back and the slot free, is now its only sender.
    expect(tabB!.entries.map(threadQueueEntryKey)).toEqual([
      "env-1:thread-A",
      "env-1:thread-B",
      "env-1:thread-C",
    ]);
    expect(store().inFlight).toBeNull();
    expect(keys()).toEqual(["env-1:thread-A", "env-1:thread-B", "env-1:thread-C"]);
  });

  // The pause check reads the queue as this tab shows it: its own click counts before the
  // server confirms it.
  it("server: this tab's own pause, not yet confirmed, stops the send and requeues the entry", async () => {
    const server = casServer("boot-1");
    for (const entry of [a, b, c])
      server.replace({ entries: [...server.document.entries, queued(entry)] });
    let hold: Promise<void> | null = null;
    let open!: () => void;
    enterServer(server, {
      write: async (input) => {
        if (input.state.paused && hold === null) {
          hold = new Promise((resolve) => (open = resolve));
        }
        if (input.state.paused) await hold;
        return server.apply(input);
      },
    });
    const run = queuedSend(
      "env-1:thread-A",
      "mine",
      () => {
        store().setPaused(true);
        expect(store().server?.paused).toBe(false);
        // The pause lands right after this send decides: under a wrong decision the mark waits
        // behind it and the send starts at once, rather than after the write timeout.
        setTimeout(() => open(), 0);
      },
      // The claim and its confirmation go through `settle` for real.
      { confirm: (claimId) => store().confirmClaim(claimId) },
    );
    expect(await claimAndSendQueueEntry(run.deps)).toBe(false);
    expect(run.sent).toEqual([]);
    open();
    await idle();
    expect({
      paused: server.document.paused,
      inFlight: server.document.inFlight,
      keys: server.document.entries.map(threadQueueEntryKey),
    }).toEqual({
      paused: true,
      inFlight: null,
      keys: ["env-1:thread-A", "env-1:thread-B", "env-1:thread-C"],
    });
  });
});
