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

const shellPresent = vi.hoisted(() => ({ value: true }));
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
vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  readEnvironmentSupportsPinning: () => true,
  readEnvironmentSupportsPinReorder: () => true,
  readEnvironmentSupportsSettlement: () => true,
  readEnvironmentSupportsSnooze: () => true,
  readEnvironmentSupportsSidebarSections: () => true,
  readThreadShell: () => (shellPresent.value ? threadShell : null),
}));
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
});
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

  it("runs a drop's follow-up once the notice woke the thread", async () => {
    const undoAlso = vi.fn();
    await useThreadActions().snoozeThread(target, new Date(Date.now() + 60_000).toISOString(), {
      undoAlso,
    });
    expect(undoAlso).not.toHaveBeenCalled();
    await currentUndo()();
    expect(commands.unsnooze).toHaveBeenCalledOnce();
    expect(undoAlso).toHaveBeenCalledOnce();
  });

  it("skips the follow-up when the wake fails", async () => {
    vi.spyOn(toastManager, "add").mockReturnValue("toast");
    commands.unsnooze.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("nope"))));
    const undoAlso = vi.fn();
    await useThreadActions().snoozeThread(target, new Date(Date.now() + 60_000).toISOString(), {
      undoAlso,
    });
    await currentUndo()();
    expect(undoAlso).not.toHaveBeenCalled();
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
