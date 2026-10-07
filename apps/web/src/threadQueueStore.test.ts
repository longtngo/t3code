import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { DraftId } from "./composerDraftStore";
import {
  removeSentThreadFromQueue,
  threadQueueEntryKey,
  useThreadQueueStore,
  type ThreadQueueEntry,
  type ThreadQueuePrior,
} from "./threadQueueStore";

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

describe("threadQueueStore", () => {
  beforeEach(() => {
    useThreadQueueStore.setState({ entries: [], paused: false, inFlight: null, lastFailure: null });
  });

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
