import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, type Atom } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useThreadActions } from "./useThreadActions";
import { threadEnvironment } from "../state/threads";
import { toastManager } from "../components/ui/toast";
import { useThreadUndoNotice } from "./showThreadUndoNotice";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { primaryServerConfigAtom } from "../state/server";
import { useThreadQueueStore } from "../threadQueueStore";
import { useThreadQueueLeavingStore } from "../threadQueueLeaving";
import { nextThreadQueueAction } from "../components/threadQueue.logic";
import type { DraftId } from "../composerDraftStore";
import { QUEUE_SENDING_MESSAGE, SNOOZE_QUEUE_READ_ONLY_MESSAGE } from "../threadQueueAdd";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { SLOW_RPC_ACK_THRESHOLD_MS } from "../rpc/requestLatencyState";

const shellPresent = vi.hoisted(() => ({ value: true }));
/** The thread keys this client's shells read as archived; set by each test, like the shell stream. */
const archivedShells = vi.hoisted(() => ({
  atom: null as unknown as Atom.Writable<{ readonly keys: ReadonlySet<string> }>,
}));
const supportsSnooze = vi.hoisted(() => ({ value: true }));
const commands = vi.hoisted(() => ({
  pin: vi.fn(),
  unpin: vi.fn(),
  archive: vi.fn(),
  unarchive: vi.fn(),
  settle: vi.fn(),
  unsettle: vi.fn(),
  snooze: vi.fn(),
  unsnooze: vi.fn(),
  setSection: vi.fn(),
}));
const router = vi.hoisted(() => ({
  navigate: vi.fn(async () => {}),
  state: { matches: [{ params: {} as Record<string, string> }] },
}));
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../state/session", async (original) => ({
  ...(await original<typeof import("../state/session")>()),
  readEnvironmentScope: () => true,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useCallback: (callback: unknown) => callback,
  useMemo: (create: () => unknown) => create(),
  useRef: (value: unknown) => ({ current: value }),
}));
// Writable so a test can delete a section the way a peer would.
vi.mock("../state/server", async (original) => {
  const { Atom } = await import("effect/reactivity");
  return {
    ...(await original<typeof import("../state/server")>()),
    primaryServerConfigAtom: Atom.keepAlive(Atom.make<unknown>(null)),
  };
});
vi.mock("@tanstack/react-router", () => ({ useRouter: () => router }));
vi.mock("./useSettings", () => ({ useClientSettings: () => false }));
vi.mock("./useHandleNewThread", () => ({ useNewThreadHandler: () => vi.fn() }));
vi.mock("../composerDraftStore", () => ({ useComposerDraftStore: () => vi.fn() }));
vi.mock("../terminalUiStateStore", () => ({ useTerminalUiStateStore: () => vi.fn() }));
vi.mock("../uiStateStore", () => ({ useUiStateStore: () => vi.fn() }));
vi.mock("../lib/archivedThreadsState", () => ({ refreshArchivedThreadsForEnvironment: vi.fn() }));
const threadShell = vi.hoisted(() => ({
  title: "Thread",
  pinOrderKey: "a0",
  pinnedAt: null as string | null,
  snoozedUntil: null as string | null,
  sidebarSectionId: null as string | null,
  settledOverride: null,
  projectId: "project",
  environmentId: "undo-env",
  session: null,
}));
vi.mock("../state/entities", async (original) => {
  const actual = await original<typeof import("../state/entities")>();
  const { Atom } = await import("effect/reactivity");
  const { appAtomRegistry } = await import("../rpc/atomRegistry");
  const { waitForAtomValue } = await import("../state/waitForAtomValue");
  archivedShells.atom = Atom.keepAlive(
    Atom.make({ keys: new Set<string>() } as { readonly keys: ReadonlySet<string> }),
  );
  return {
    ...actual,
    // The real rule over a stand-in shell; the shells' state changes when each test says.
    waitForThreadUnarchived: (
      ref: { environmentId: string; threadId: string },
      timeoutMs: number,
    ) =>
      waitForAtomValue({
        registry: appAtomRegistry,
        atom: archivedShells.atom,
        predicate: (archived) =>
          actual.threadReadsUnarchived({
            archivedAt: archived.keys.has(`${ref.environmentId}:${ref.threadId}`)
              ? "2026-10-08T00:00:00.000Z"
              : null,
          }),
        timeoutMs,
      }),
    readEnvironmentSupportsPinning: () => true,
    readEnvironmentSupportsPinReorder: () => true,
    readEnvironmentSupportsSettlement: () => true,
    readEnvironmentSupportsSnooze: () => supportsSnooze.value,
    readEnvironmentSupportsSidebarSections: () => true,
    readThreadShell: () => (shellPresent.value ? threadShell : null),
  };
});
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => {
    switch (command) {
      case threadEnvironment.pin:
        return commands.pin;
      case threadEnvironment.unpin:
        return commands.unpin;
      case threadEnvironment.archive:
        return commands.archive;
      case threadEnvironment.unarchive:
        return commands.unarchive;
      case threadEnvironment.settle:
        return commands.settle;
      case threadEnvironment.unsettle:
        return commands.unsettle;
      case threadEnvironment.snooze:
        return commands.snooze;
      case threadEnvironment.unsnooze:
        return commands.unsnooze;
      case threadEnvironment.setSection:
        return commands.setSection;
      default:
        return vi.fn();
    }
  },
}));

const target = {
  environmentId: EnvironmentId.make("undo-env"),
  threadId: ThreadId.make("thread"),
};
function currentUndo() {
  const notice = useThreadUndoNotice.getState().notice;
  expect(notice).not.toBeNull();
  return notice!.undo;
}

beforeEach(() => {
  vi.useFakeTimers();
  for (const command of Object.values(commands)) {
    command.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  }
  router.navigate.mockClear();
  router.state.matches[0]!.params = {};
  threadShell.pinnedAt = null;
  threadShell.snoozedUntil = null;
  threadShell.sidebarSectionId = null;
  shellPresent.value = true;
  supportsSnooze.value = true;
});
/** Lets an un-awaited follow-up (the wake after a settle) finish. */
async function flushMicrotasks() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
afterEach(() => {
  vi.runAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("unpin Undo", () => {
  it("ignores an old notice across hook instances and still restores the latest unpin", async () => {
    const sidebar = useThreadActions();
    const header = useThreadActions();
    await sidebar.unpinThread(target);
    const staleUndo = currentUndo();
    await header.pinThread(target, { orderKey: "a1" });
    await header.unpinThread(target);
    const latestUndo = currentUndo();
    await staleUndo();
    expect(commands.pin).toHaveBeenCalledTimes(1);
    await latestUndo();
    expect(commands.pin).toHaveBeenCalledTimes(2);
    expect(commands.pin).toHaveBeenLastCalledWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, orderKey: "a0" },
    });
    await latestUndo();
    expect(commands.pin).toHaveBeenCalledTimes(2);
  });
});

describe("archive Undo", () => {
  it("unarchives and returns to the thread when archiving left it", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    router.state.matches[0]!.params = {
      environmentId: target.environmentId,
      threadId: target.threadId,
    };
    const actions = useThreadActions();
    await actions.archiveThread(target);
    expect(useThreadUndoNotice.getState().notice).toMatchObject({ action: "Archived", count: 1 });
    expect(add).not.toHaveBeenCalled();
    await currentUndo()();
    expect(commands.unarchive).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId },
    });
    expect(router.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/$environmentId/$threadId",
        params: { environmentId: target.environmentId, threadId: target.threadId },
      }),
    );
  });

  it("stays put when the archived thread was not open", async () => {
    const actions = useThreadActions();
    await actions.archiveThread(target);
    await currentUndo()();
    expect(commands.unarchive).toHaveBeenCalledOnce();
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it("shows no Undo when the archive failed", async () => {
    commands.archive.mockResolvedValue({ _tag: "Failure", cause: new Error("nope") });
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    await useThreadActions().archiveThread(target);
    expect(add).not.toHaveBeenCalled();
  });
});

describe("settle and snooze Undo", () => {
  it("un-settles from the notice and expires the Undo after a manual un-settle", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    const actions = useThreadActions();
    await actions.settleThread(target);
    expect(useThreadUndoNotice.getState().notice).toMatchObject({ action: "Settled", count: 1 });
    expect(add).not.toHaveBeenCalled();
    const undo = currentUndo();
    await actions.unsettleThread(target);
    await undo();
    expect(commands.unsettle).toHaveBeenCalledOnce();
  });

  it("re-pins and re-snoozes a thread that settling had cleared", async () => {
    const snoozedUntil = "2030-01-01T09:00:00.000Z";
    threadShell.pinnedAt = "2026-01-01T00:00:00.000Z";
    threadShell.snoozedUntil = snoozedUntil;
    const actions = useThreadActions();
    await actions.settleThread(target);
    await currentUndo()();
    expect(commands.unsettle).toHaveBeenCalledOnce();
    expect(commands.pin).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, orderKey: "a0" },
    });
    expect(commands.snooze).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, snoozedUntil },
    });
  });

  it("wakes a snoozed thread once it settled, as a drop from Snoozed to Settled does", async () => {
    threadShell.snoozedUntil = "2999-01-01T00:00:00.000Z";
    const order: string[] = [];
    commands.settle.mockImplementation(async () => {
      order.push("settle");
      return AsyncResult.success(undefined);
    });
    commands.unsnooze.mockImplementation(async () => {
      order.push("unsnooze");
      return AsyncResult.success(undefined);
    });
    const result = await useThreadActions().settleThread(target);
    expect(result._tag).toBe("Success");
    expect(order).toEqual(["settle", "unsnooze"]);
    expect(commands.unsnooze).toHaveBeenCalledWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, reason: "user" },
    });
    // The notice's Undo puts the snooze back.
    expect(useThreadUndoNotice.getState().notice).toMatchObject({ action: "Settled" });
  });

  it("leaves an awake thread's snooze alone, and wakes nothing when the settle failed", async () => {
    await useThreadActions().settleThread(target);
    // An expired snooze is not snoozed.
    threadShell.snoozedUntil = "2000-01-01T00:00:00.000Z";
    await useThreadActions().settleThread(target);
    threadShell.snoozedUntil = "2999-01-01T00:00:00.000Z";
    commands.settle.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("nope"))));
    await useThreadActions().settleThread(target);
    expect(commands.unsnooze).not.toHaveBeenCalled();
  });

  it("says when the wake after a settle failed, but not when it was interrupted", async () => {
    threadShell.snoozedUntil = "2999-01-01T00:00:00.000Z";
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    commands.unsnooze.mockResolvedValueOnce(AsyncResult.failure(Cause.interrupt()));
    expect((await useThreadActions().settleThread(target))._tag).toBe("Success");
    await flushMicrotasks();
    expect(add).not.toHaveBeenCalled();
    commands.unsnooze.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("nope"))));
    expect((await useThreadActions().settleThread(target))._tag).toBe("Success");
    await flushMicrotasks();
    expect(add.mock.calls.map(([toast]) => toast.title)).toEqual(["Failed to wake thread"]);
  });

  it("returns once the settle landed, without waiting for the wake, so navigation is not held", async () => {
    threadShell.snoozedUntil = "2999-01-01T00:00:00.000Z";
    let finishWake: (value: unknown) => void = () => {};
    commands.unsnooze.mockReturnValueOnce(new Promise((resolve) => (finishWake = resolve)));
    const settled = useThreadActions().settleThread(target);
    const winner = await Promise.race([
      settled.then(() => "settled"),
      flushMicrotasks().then(() => "still waiting"),
    ]);
    expect(winner).toBe("settled");
    expect(commands.unsnooze).toHaveBeenCalledOnce();
    finishWake(AsyncResult.success(undefined));
  });

  it("wakes through unsnoozeThread's checks: a server without snooze gets no wake", async () => {
    threadShell.snoozedUntil = "2999-01-01T00:00:00.000Z";
    supportsSnooze.value = false;
    vi.spyOn(toastManager, "add").mockReturnValue("toast");
    await useThreadActions().settleThread(target);
    await flushMicrotasks();
    expect(commands.settle).toHaveBeenCalledOnce();
    expect(commands.unsnooze).not.toHaveBeenCalled();
  });

  it("expires an older unpin Undo when the thread is settled", async () => {
    const actions = useThreadActions();
    await actions.unpinThread(target);
    const staleUnpinUndo = currentUndo();
    await actions.settleThread(target);
    await staleUnpinUndo();
    expect(commands.pin).not.toHaveBeenCalled();
  });

  it("wakes the thread from the snooze notice", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    const actions = useThreadActions();
    await actions.snoozeThread(target, new Date(Date.now() + 60_000).toISOString());
    expect(useThreadUndoNotice.getState().notice).toMatchObject({ action: "Snoozed", count: 1 });
    expect(add).not.toHaveBeenCalled();
    await currentUndo()();
    expect(commands.unsnooze).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, reason: "user" },
    });
  });
});

describe("Snooze on a queued thread", () => {
  const entry = {
    environmentId: target.environmentId,
    threadId: target.threadId,
    draftId: null,
    addedAt: 1,
    ownerId: "device",
    label: "Thread",
  };
  const other = { ...entry, threadId: ThreadId.make("other"), label: "Other" };
  const queuedThreadIds = () =>
    useThreadQueueStore.getState().entries.map((candidate) => candidate.threadId);
  const inHour = () => new Date(Date.now() + 3_600_000).toISOString();

  beforeEach(() => {
    useThreadQueueStore.setState({
      mode: "local",
      readOnly: false,
      entries: [entry, other],
      inFlight: null,
    });
  });
  afterEach(() => {
    useThreadQueueStore.setState({ entries: [], inFlight: null });
  });

  it("leaves the Queue once the snooze landed, as a drop from the Queue to Snooze does", async () => {
    let queuedAtSnooze: string[] = [];
    commands.snooze.mockImplementation(async () => {
      queuedAtSnooze = queuedThreadIds();
      return AsyncResult.success(undefined);
    });
    await useThreadActions().snoozeThread(target, inHour());
    expect(queuedAtSnooze).toEqual(["thread", "other"]);
    expect(queuedThreadIds()).toEqual(["other"]);
  });

  /** What the queue coordinator would claim now, with one free slot. */
  const coordinatorClaims = () => {
    const action = nextThreadQueueAction({
      entries: useThreadQueueStore.getState().entries,
      paused: false,
      inFlight: null,
      threads: [],
      nowMs: Date.now(),
      slots: 1,
      perProvider: false,
      providerSlots: {},
      visibleInstanceIds: [],
      targetInstanceOf: () => null,
      ownerId: null,
      leaving: useThreadQueueLeavingStore.getState().keys,
    });
    return action.kind === "claim" ? action.key : null;
  };

  it("is not sent while the snooze is in flight; the next entry is", async () => {
    let claimedAtSnooze: string | null = null;
    commands.snooze.mockImplementation(async () => {
      claimedAtSnooze = coordinatorClaims();
      return AsyncResult.success(undefined);
    });
    // The mark ends only once the thread already left the Queue: no gap between the two.
    const queuedAtRelease: string[][] = [];
    const unsubscribe = useThreadQueueLeavingStore.subscribe(({ keys }) => {
      if (keys.size === 0) queuedAtRelease.push(queuedThreadIds());
    });
    try {
      await useThreadActions().snoozeThread(target, inHour());
    } finally {
      unsubscribe();
    }
    expect(claimedAtSnooze).toBe("undo-env:other");
    expect(queuedAtRelease).toEqual([["other"]]);
  });

  it.each([
    ["refused", async () => AsyncResult.failure(Cause.fail(new Error("nope")))],
    ["interrupted", async () => AsyncResult.failure(Cause.interrupt())],
    [
      "thrown",
      async () => {
        throw new Error("socket closed");
      },
    ],
  ])("after a %s snooze it stays queued and sendable at once", async (_name, snooze) => {
    commands.snooze.mockImplementationOnce(snooze);
    await useThreadActions()
      .snoozeThread(target, inHour())
      .catch(() => {});
    expect(queuedThreadIds()).toEqual(["thread", "other"]);
    expect(coordinatorClaims()).toBe("undo-env:thread");
  });

  it("stays queued when the snooze failed or was interrupted", async () => {
    commands.snooze.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("nope"))));
    await useThreadActions().snoozeThread(target, inHour());
    commands.snooze.mockResolvedValueOnce(AsyncResult.failure(Cause.interrupt()));
    await useThreadActions().snoozeThread(target, inHour());
    expect(queuedThreadIds()).toEqual(["thread", "other"]);
  });

  it("Undo wakes it and puts it back at the end of the Queue, draft and label kept", async () => {
    useThreadQueueStore.setState({ entries: [{ ...entry, draftId: "draft-1" as DraftId }, other] });
    await useThreadActions().snoozeThread(target, inHour());
    await currentUndo()();
    expect(commands.unsnooze).toHaveBeenCalledOnce();
    expect(queuedThreadIds()).toEqual(["other", "thread"]);
    expect(useThreadQueueStore.getState().entries[1]).toMatchObject({
      label: "Thread",
      draftId: "draft-1",
    });
  });

  it("Undo does not queue again a thread a peer's queue already sent", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    await useThreadActions().snoozeThread(target, inHour());
    // A peer's coordinator claimed and sent it before our removal landed.
    useThreadQueueStore.setState({
      inFlight: { entry, claimId: "claim", claimedAt: 4, sentAt: 5 } as never,
    });
    await currentUndo()();
    expect(commands.unsnooze).toHaveBeenCalledOnce();
    expect(queuedThreadIds()).toEqual(["other"]);
    expect(add).not.toHaveBeenCalled();
  });

  it("Undo puts nothing in the Queue when the wake failed, or when it was not queued", async () => {
    vi.spyOn(toastManager, "add").mockReturnValue("toast");
    commands.unsnooze.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("nope"))));
    await useThreadActions().snoozeThread(target, inHour());
    await currentUndo()();
    expect(queuedThreadIds()).toEqual(["other"]);
    await useThreadActions().snoozeThread(target, inHour());
    await currentUndo()();
    expect(queuedThreadIds()).toEqual(["other"]);
  });

  it("Undo still re-queues when the only claim is an earlier send that was already there", async () => {
    // This thread was sent before and the user queued it again; that send has not landed yet.
    useThreadQueueStore.setState({
      inFlight: { entry, claimId: "earlier", claimedAt: 1, sentAt: 2 } as never,
    });
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    // Two callers snooze both queued threads; one Undo restores both.
    await Promise.all([
      useThreadActions().snoozeThread(target, inHour()),
      useThreadActions().snoozeThread({ ...target, threadId: other.threadId }, inHour()),
    ]);
    expect(queuedThreadIds()).toEqual([]);
    await currentUndo()();
    expect(commands.unsnooze).toHaveBeenCalledTimes(2);
    expect(queuedThreadIds().toSorted()).toEqual(["other", "thread"]);
    expect(add).not.toHaveBeenCalled();
  });

  it("Undo of a thread a peer is still sending says so rather than queueing it twice", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    await useThreadActions().snoozeThread(target, inHour());
    useThreadQueueStore.setState({
      inFlight: { entry, claimId: "claim", claimedAt: 4, sentAt: null } as never,
    });
    await currentUndo()();
    expect(queuedThreadIds()).toEqual(["other"]);
    expect(add.mock.calls.map(([toast]) => toast.title)).toEqual([QUEUE_SENDING_MESSAGE]);
  });

  it("refuses while the Queue is read-only: it could not leave, and its send would wake it", async () => {
    // A user's change to a read-only server queue is dropped.
    useThreadQueueStore.setState({ mode: "server", readOnly: true });
    const result = await useThreadActions().snoozeThread(target, inHour());
    expect(result._tag).toBe("Failure");
    expect(result._tag === "Failure" && (squashAtomCommandFailure(result) as Error).message).toBe(
      SNOOZE_QUEUE_READ_ONLY_MESSAGE,
    );
    expect(commands.snooze).not.toHaveBeenCalled();
    expect(useThreadUndoNotice.getState().notice?.action).not.toBe("Snoozed");
    expect(queuedThreadIds()).toEqual(["thread", "other"]);
    // A thread that is not queued snoozes as usual.
    useThreadQueueStore.setState({ entries: [other] });
    expect((await useThreadActions().snoozeThread(target, inHour()))._tag).toBe("Success");
  });

  it("an Undo whose re-queue throws still wakes it, and says the queue failed", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    await useThreadActions().snoozeThread(target, inHour());
    const { enqueue } = useThreadQueueStore.getState();
    useThreadQueueStore.setState({
      enqueue: () => {
        throw new Error("queue store gone");
      },
    });
    try {
      await currentUndo()();
    } finally {
      useThreadQueueStore.setState({ enqueue });
    }
    expect(commands.unsnooze).toHaveBeenCalledOnce();
    // The wake succeeded, so this is not "Failed to wake thread".
    expect(add.mock.calls.map(([toast]) => toast.title)).toEqual(["Failed to queue thread"]);
  });
});

describe("Move to section", () => {
  const sections = (ids: string[]) => ({
    environment: { capabilities: { sidebarSections: true } },
    settings: {
      sidebarSections: Object.fromEntries(
        ids.map((id) => [id, { name: id, createdAt: "2026-10-07T00:00:00.000Z" }]),
      ),
    },
  });
  const configAtom = primaryServerConfigAtom as unknown as Atom.Writable<unknown>;

  beforeEach(() => {
    threadShell.pinnedAt = "2026-01-01T00:00:00.000Z";
  });

  it("writes nothing and says so when a peer deleted the section after the menu opened", async () => {
    appAtomRegistry.set(configAtom, sections([]));
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    await useThreadActions().moveThreadToSidebarSection(target, "focus", "Focus");
    expect(commands.setSection).not.toHaveBeenCalled();
    expect(commands.unpin).not.toHaveBeenCalled();
    expect(add.mock.calls.map(([toast]) => toast.title)).toEqual(["Section was deleted"]);
  });

  it("moves into a live section and clears the pin", async () => {
    appAtomRegistry.set(configAtom, sections(["focus"]));
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    await useThreadActions().moveThreadToSidebarSection(target, "focus", "Focus");
    expect(commands.setSection).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, sectionId: "focus" },
    });
    expect(commands.unpin).toHaveBeenCalledOnce();
    expect(add).not.toHaveBeenCalled();
  });

  it("resolves whether the thread joined", async () => {
    appAtomRegistry.set(configAtom, sections(["focus"]));
    vi.spyOn(toastManager, "add").mockReturnValue("toast");
    const actions = useThreadActions();
    expect(await actions.moveThreadToSidebarSection(target, "focus", "Focus")).toBe(true);
    // The membership landed but the unpin failed: joined, and the failure was toasted.
    commands.unpin.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("nope"))));
    expect(await actions.moveThreadToSidebarSection(target, "focus", "Focus")).toBe(true);
    // The membership write itself failed: nothing moved.
    commands.setSection.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("nope"))));
    expect(await actions.moveThreadToSidebarSection(target, "focus", "Focus")).toBe(false);
    appAtomRegistry.set(configAtom, sections([]));
    expect(await actions.moveThreadToSidebarSection(target, "focus", "Focus")).toBe(false);
  });

  it("an interrupted step says nothing, like every other interrupted thread action", async () => {
    appAtomRegistry.set(configAtom, sections(["focus"]));
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    const actions = useThreadActions();
    commands.setSection.mockResolvedValueOnce(AsyncResult.failure(Cause.interrupt()));
    expect(await actions.moveThreadToSidebarSection(target, "focus", "Focus")).toBe(false);
    commands.unpin.mockResolvedValueOnce(AsyncResult.failure(Cause.interrupt()));
    expect(await actions.moveThreadToSidebarSection(target, "focus", "Focus")).toBe(true);
    expect(add).not.toHaveBeenCalled();
    // The same steps failing for real are reported.
    commands.unpin.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("nope"))));
    await actions.moveThreadToSidebarSection(target, "focus", "Focus");
    expect(add.mock.calls.map(([toast]) => toast.title)).toEqual([
      "Moved to Focus, but couldn't unpin",
    ]);
  });

  it("an unknown thread is not joined (refused, not unchanged)", async () => {
    appAtomRegistry.set(configAtom, sections(["focus"]));
    shellPresent.value = false;
    expect(await useThreadActions().moveThreadToSidebarSection(target, "focus", "Focus")).toBe(
      false,
    );
    expect(commands.setSection).not.toHaveBeenCalled();
  });

  it("a member with nothing to clear is already joined, and writes nothing", async () => {
    appAtomRegistry.set(configAtom, sections(["focus"]));
    threadShell.pinnedAt = null;
    threadShell.sidebarSectionId = "focus";
    expect(await useThreadActions().moveThreadToSidebarSection(target, "focus", "Focus")).toBe(
      true,
    );
    expect(commands.setSection).not.toHaveBeenCalled();
  });
});

describe("archive Undo on a queued thread", () => {
  const queued = (id: string) => ({
    environmentId: target.environmentId,
    threadId: ThreadId.make(id),
    draftId: null,
    addedAt: 1,
    ownerId: "device",
    label: id,
  });
  const ref = (id: string) => ({
    environmentId: target.environmentId,
    threadId: ThreadId.make(id),
  });
  const key = (id: string) => `undo-env:${id}`;
  const queuedThreadIds = () =>
    useThreadQueueStore.getState().entries.map((candidate) => candidate.threadId);
  const setArchived = (update: (archived: Set<string>) => void) => {
    const next = new Set<string>(appAtomRegistry.get(archivedShells.atom).keys);
    update(next);
    appAtomRegistry.set(archivedShells.atom, { keys: next });
  };

  beforeEach(() => {
    appAtomRegistry.set(archivedShells.atom, { keys: new Set<string>() });
    useThreadQueueStore.setState({
      mode: "local",
      readOnly: false,
      entries: [queued("a"), queued("b"), queued("c")],
      inFlight: null,
    });
    // The archive's own state reaches the shells; the unarchive's arrives when each test says.
    commands.archive.mockImplementation(async ({ input }: { input: { threadId: string } }) => {
      setArchived((archived) => archived.add(key(input.threadId)));
      return AsyncResult.success(undefined);
    });
  });
  afterEach(() => {
    useThreadQueueStore.setState({ entries: [], inFlight: null });
  });

  /** Archives a and b (one notice, one Undo for both), then runs that Undo. */
  async function archiveTwoThenUndo() {
    await useThreadActions().archiveThread(ref("a"));
    await useThreadActions().archiveThread(ref("b"));
    expect(queuedThreadIds()).toEqual(["c"]);
    await currentUndo()();
    await flushMicrotasks();
  }

  it("re-queues only once its thread reads unarchived, when the reply comes first", async () => {
    await archiveTwoThenUndo();
    expect(commands.unarchive).toHaveBeenCalledTimes(2);
    // The reply landed but the shells still read archived: the Queue would prune it at once.
    expect(queuedThreadIds()).toEqual(["c"]);
    setArchived((archived) => archived.delete(key("a")));
    await flushMicrotasks();
    // Only the thread whose state arrived; b is still read as archived.
    expect(queuedThreadIds()).toEqual(["c", "a"]);
  });

  it("re-queues at once when its unarchived state arrived before the reply", async () => {
    commands.unarchive.mockImplementation(async ({ input }: { input: { threadId: string } }) => {
      if (input.threadId === "b") setArchived((archived) => archived.delete(key("b")));
      return AsyncResult.success(undefined);
    });
    await archiveTwoThenUndo();
    expect(queuedThreadIds()).toEqual(["c", "b"]);
  });

  it("gives up silently when its thread never reads unarchived within the bound", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    await archiveTwoThenUndo();
    await vi.advanceTimersByTimeAsync(SLOW_RPC_ACK_THRESHOLD_MS - 1);
    setArchived((archived) => archived.delete(key("a")));
    await flushMicrotasks();
    expect(queuedThreadIds()).toEqual(["c", "a"]);
    await vi.advanceTimersByTimeAsync(1);
    setArchived((archived) => archived.delete(key("b")));
    await flushMicrotasks();
    expect(queuedThreadIds()).toEqual(["c", "a"]);
    expect(add).not.toHaveBeenCalled();
  });

  it("re-queues nothing when the unarchive failed", async () => {
    vi.spyOn(toastManager, "add").mockReturnValue("toast");
    commands.unarchive.mockImplementation(async ({ input }: { input: { threadId: string } }) => {
      setArchived((archived) => archived.delete(key(input.threadId)));
      return AsyncResult.failure(Cause.fail(new Error("nope")));
    });
    await archiveTwoThenUndo();
    expect(queuedThreadIds()).toEqual(["c"]);
  });

  it("an archive of a thread that was not queued re-queues nothing", async () => {
    useThreadQueueStore.setState({ entries: [queued("c")] });
    await useThreadActions().archiveThread(ref("a"));
    await currentUndo()();
    setArchived((archived) => archived.delete(key("a")));
    await flushMicrotasks();
    expect(queuedThreadIds()).toEqual(["c"]);
  });
});
