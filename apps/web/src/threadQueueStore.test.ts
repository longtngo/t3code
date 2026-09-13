import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { DraftId } from "./composerDraftStore";
import {
  removeSentThreadFromQueue,
  threadQueueEntryKey,
  useThreadQueueStore,
} from "./threadQueueStore";

const env = EnvironmentId.make("env-1");
const a = { environmentId: env, threadId: ThreadId.make("thread-A"), draftId: null };
const b = {
  environmentId: env,
  threadId: ThreadId.make("thread-B"),
  draftId: DraftId.make("draft-B"),
};
const c = { environmentId: env, threadId: ThreadId.make("thread-C"), draftId: null };
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
    const claim = store.claimHead({
      claimId: "one",
      now: 1,
      resolve: (entry) => ({ entry, priorUserMessageAt: "t0" }),
    });
    expect(claim?.entry.threadId).toBe("thread-A");
    expect(claim?.priorUserMessageAt).toBe("t0");
    expect(keys()).toEqual(["env-1:thread-B"]);
    expect(
      store.claimHead({
        claimId: "two",
        now: 2,
        resolve: (entry) => ({ entry, priorUserMessageAt: null }),
      }),
    ).toBeNull();

    store.clearInFlight("someone-else");
    expect(useThreadQueueStore.getState().inFlight?.claimId).toBe("one");
    store.clearInFlight("one");
    expect(
      store.claimHead({
        claimId: "two",
        now: 3,
        resolve: (entry) => ({ entry, priorUserMessageAt: null }),
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

  it("a failed send pauses the queue with the reason, and resuming clears it", () => {
    const store = useThreadQueueStore.getState();
    store.enqueue(a);
    store.enqueue(b);
    store.claimHead({
      claimId: "one",
      now: 1,
      resolve: (entry) => ({ entry, priorUserMessageAt: null }),
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
});
