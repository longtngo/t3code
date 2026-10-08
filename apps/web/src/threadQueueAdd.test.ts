import { EnvironmentId, THREAD_QUEUE_MAX_ENTRIES, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { toastManager } from "./components/ui/toast";
import { QUEUE_FULL_MESSAGE, runThreadQueueMenuAction } from "./threadQueueAdd";
import { useThreadQueueStore } from "./threadQueueStore";

const shell = vi.hoisted(() => ({ snoozedUntil: null as string | null }));
vi.mock("./state/entities", async (original) => ({
  ...(await original<typeof import("./state/entities")>()),
  readThreadShell: () => shell,
}));

const thread = {
  environmentId: EnvironmentId.make("env"),
  id: ThreadId.make("thread"),
  title: "Thread",
};
const queuedThreadIds = () =>
  useThreadQueueStore.getState().entries.map((candidate) => candidate.threadId);

beforeEach(() => {
  shell.snoozedUntil = null;
  useThreadQueueStore.setState({ mode: "local", readOnly: false, entries: [] });
});
afterEach(() => {
  useThreadQueueStore.setState({ entries: [] });
  vi.restoreAllMocks();
});

describe("the thread menu's Add to queue", () => {
  it("on a snoozed thread is Wake & queue: it wakes once the Queue took it", async () => {
    shell.snoozedUntil = "2999-01-01T00:00:00.000Z";
    let queuedAtWake: string[] = [];
    const wake = vi.fn(async () => {
      queuedAtWake = queuedThreadIds();
    });
    await runThreadQueueMenuAction("queue", thread, wake);
    expect(wake).toHaveBeenCalledOnce();
    expect(queuedAtWake).toEqual(["thread"]);
  });

  it("resolves only once the wake finished", async () => {
    shell.snoozedUntil = "2999-01-01T00:00:00.000Z";
    let finishWake: () => void = () => {};
    const added = runThreadQueueMenuAction(
      "queue",
      thread,
      () => new Promise<void>((resolve) => (finishWake = resolve)),
    );
    let done = false;
    void added.then(() => (done = true));
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(done).toBe(false);
    finishWake();
    await added;
    expect(done).toBe(true);
  });

  it("wakes nothing when the Queue refused it, and says why", async () => {
    shell.snoozedUntil = "2999-01-01T00:00:00.000Z";
    useThreadQueueStore.setState({
      entries: Array.from({ length: THREAD_QUEUE_MAX_ENTRIES }, (_, index) => ({
        environmentId: thread.environmentId,
        threadId: ThreadId.make(`other-${index}`),
        draftId: null,
        addedAt: index,
        ownerId: "device",
        label: null,
      })),
    });
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    const wake = vi.fn(async () => {});
    await runThreadQueueMenuAction("queue", thread, wake);
    expect(wake).not.toHaveBeenCalled();
    expect(add.mock.calls.map(([toast]) => toast.title)).toEqual([QUEUE_FULL_MESSAGE]);
  });

  it("wakes nothing for an awake thread, or one whose snooze has passed", async () => {
    const wake = vi.fn(async () => {});
    await runThreadQueueMenuAction("queue", thread, wake);
    useThreadQueueStore.setState({ entries: [] });
    shell.snoozedUntil = "2000-01-01T00:00:00.000Z";
    await runThreadQueueMenuAction("queue", thread, wake);
    expect(queuedThreadIds()).toEqual(["thread"]);
    expect(wake).not.toHaveBeenCalled();
  });

  it("Remove from queue only unqueues", async () => {
    shell.snoozedUntil = "2999-01-01T00:00:00.000Z";
    const wake = vi.fn(async () => {});
    await runThreadQueueMenuAction("queue", thread, async () => {});
    await runThreadQueueMenuAction("unqueue", thread, wake);
    expect(queuedThreadIds()).toEqual([]);
    expect(wake).not.toHaveBeenCalled();
  });
});
