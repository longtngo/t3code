import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  THREAD_QUEUE_MAX_ENTRIES,
  ThreadId,
  type ContextMenuItem,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ThreadActionMenuId } from "../components/threadActionMenu.logic";
import {
  QUEUE_FULL_MESSAGE,
  QUEUE_READ_ONLY_MESSAGE,
  QUEUE_SENDING_MESSAGE,
} from "../threadQueueAdd";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const state = vi.hoisted(() => ({
  granted: new Set<string>(),
  effects: [] as string[],
  sections: null as ReadonlyArray<{ id: string; name: string; createdAt: string }> | null,
  archivedAt: null as string | null,
  sectionId: null as string | null,
  snoozedUntil: null as string | null,
  completed: deferred<void>(),
  toasts: [] as string[],
  queue: {
    entries: [] as Array<{ environmentId: string; threadId: string }>,
    inFlight: null as unknown,
    readOnly: false,
  },
  show: vi.fn<
    (
      items: ReadonlyArray<ContextMenuItem<ThreadActionMenuId>>,
      position: { x: number; y: number },
    ) => Promise<ThreadActionMenuId | null>
  >(),
}));

function recordEffect(action: string) {
  state.effects.push(action);
  state.completed.resolve();
}

vi.mock("../components/CustomSnoozeDialog", () => ({ requestCustomSnooze: vi.fn() }));
vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
}));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate: async () => recordEffect("project-settings") }),
}));
vi.mock("../state/session", () => ({
  readEnvironmentScope: (environmentId: string, scope: string) =>
    scope === AuthOrchestrationOperateScope && state.granted.has(environmentId),
}));
vi.mock("../state/entities", () => ({
  readEnvironmentServerConfigLoaded: () => true,
  readEnvironmentSupportsAutoSettleOptOut: () => true,
  readEnvironmentSupportsSidebarSections: () => state.sections !== null,
  readThreadShell: () => ({
    id: "thread",
    environmentId: "secondary",
    projectId: "project",
    title: "Thread",
    branch: "main",
    worktreePath: null,
    runtime: null,
    latestRun: null,
    archivedAt: state.archivedAt,
    sidebarSectionId: state.sectionId,
    snoozedUntil: state.snoozedUntil,
  }),
  useProjects: () => [{ id: "project", environmentId: "secondary" }],
}));
vi.mock("../state/environments", () => ({ usePrimaryEnvironmentId: () => "primary" }));
vi.mock("../state/threads", () => ({ threadEnvironment: { updateMetadata: "metadata" } }));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => async () => {
    recordEffect("metadata");
    return AsyncResult.success(undefined);
  },
}));
vi.mock("../localApi", () => ({
  readLocalApi: () => ({
    contextMenu: { show: state.show, close: () => {} },
    dialogs: {
      confirm: async () => {
        recordEffect("confirm");
        return false;
      },
    },
  }),
}));
vi.mock("@t3tools/client-runtime/state/project-grouping", () => ({
  deriveLogicalProjectKeyFromSettings: () => "project",
  derivePhysicalProjectKey: () => "project",
  selectProjectGroupingSettings: () => ({}),
}));
vi.mock("../sidebarCustomSections", () => ({
  useSidebarSections: () => state.sections,
}));
vi.mock("../sidebarProjectGrouping", () => ({
  buildPhysicalToLogicalProjectKeyMap: () => new Map(),
}));
vi.mock("../uiStateStore", () => ({
  useUiStateStore: (select: (store: unknown) => unknown) =>
    select({
      markThreadUnread: () => recordEffect("mark-unread"),
    }),
}));
vi.mock("../components/ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: {
    add: (toast: { title: string }) => {
      state.toasts.push(toast.title);
      state.completed.resolve();
    },
  },
}));
vi.mock("../threadQueueStore", () => ({
  useThreadQueueStore: {
    getState: () => ({
      ...state.queue,
      enqueue: (entry: unknown) => recordEffect(`enqueue ${JSON.stringify(entry)}`),
      remove: (key: string) => recordEffect(`remove ${key}`),
    }),
  },
}));
vi.mock("../components/Sidebar.snooze", () => ({
  resolveSnoozePresets: () => [
    { id: "hour", label: "In 1 hour", whenLabel: "3 PM", snoozedUntil: "2099-01-01T00:00:00Z" },
  ],
  snoozeWakeDescription: () => "later",
}));
vi.mock("./useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: () => recordEffect("copy") }),
}));
vi.mock("./useHandleNewThread", () => ({
  useNewThreadHandler: () => async () => recordEffect("draft"),
}));
vi.mock("./useSettings", () => ({
  useClientSettings: (select: (settings: unknown) => unknown) =>
    select({
      confirmThreadDelete: true,
      confirmThreadArchive: true,
      timestampFormat: "12-hour",
    }),
}));
vi.mock("./useThreadActions", () => ({
  canTurnThreadIntoProject: () => false,
  useThreadActions: () =>
    Object.fromEntries(
      [
        "markThreadUnread",
        "settleThread",
        "unsettleThread",
        "snoozeThread",
        "unsnoozeThread",
        "pinThread",
        "confirmAndUnpinThread",
        "archiveThread",
        "deleteThread",
      ].map((action) => [
        action,
        async () => {
          recordEffect(action === "markThreadUnread" ? "mark-unread" : action);
          return AsyncResult.success(undefined);
        },
      ]),
    ),
}));

import { useThreadActionMenu } from "./useThreadActionMenu";

const target = {
  environmentId: EnvironmentId.make("secondary"),
  threadId: ThreadId.make("thread"),
};
const position = { x: 10, y: 20 };
const createMenu = () =>
  useThreadActionMenu({
    threadRef: target,
    projectCwd: "/project",
    onStartRename: () => recordEffect("rename"),
    canShareWithGuest: false,
  });

beforeEach(() => {
  state.granted = new Set(["primary"]);
  state.effects = [];
  state.sections = null;
  state.archivedAt = null;
  state.sectionId = null;
  state.snoozedUntil = null;
  state.completed = deferred<void>();
  state.toasts = [];
  state.queue = { entries: [], inFlight: null, readOnly: false };
  state.show.mockReset().mockResolvedValue(null);
});

describe("thread menu permissions", () => {
  it.each(["rename", "regenerate-title", "delete", "pin", "settle", "archive"] as const)(
    "%s rechecks after the native menu closes",
    async (action) => {
      state.granted.add("secondary");
      const choice = deferred<ThreadActionMenuId | null>();
      state.show.mockReturnValue(choice.promise);
      createMenu().openMenu(position);
      state.granted.delete("secondary");
      choice.resolve(action);
      await state.completed.promise;
      expect(state.effects).toEqual([]);
    },
  );
});

describe("thread menu section moves", () => {
  const ids = () => state.show.mock.calls[0]![0].map((item) => item.id);
  const createdAt = "2026-10-07T00:00:00.000Z";
  const sections = [
    { id: "focus", name: "Focus", createdAt },
    { id: "work", name: "Work", createdAt },
  ];

  it("offers Move to section and Move to Active on a live thread", () => {
    state.sections = sections;
    state.sectionId = "focus";
    createMenu().openMenu(position);
    expect(ids()).toEqual(expect.arrayContaining(["move-to-section", "move-to-active"]));
  });

  it("hides both on an archived thread, like the command palette", () => {
    state.sections = sections;
    state.sectionId = "focus";
    state.archivedAt = createdAt;
    createMenu().openMenu(position);
    expect(ids()).not.toContain("move-to-section");
    expect(ids()).not.toContain("move-to-active");
  });
});

describe("thread menu queue", () => {
  const queued = { environmentId: "secondary", threadId: "thread" };
  const item = (id: string) => state.show.mock.calls[0]![0].find((entry) => entry.id === id);
  const choose = async (action: ThreadActionMenuId) => {
    state.granted.add("secondary");
    state.show.mockResolvedValue(action);
    createMenu().openMenu(position);
    // Every awaited step here is a resolved mock, so one macrotask drains the dispatch.
    // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- a zero-delay macrotask boundary: openMenu fires its dispatch and returns nothing to await
    await new Promise((resolve) => setImmediate(resolve));
  };

  it("adds the thread to the queue", async () => {
    await choose("queue");
    expect(state.effects).toEqual([
      `enqueue ${JSON.stringify({ environmentId: "secondary", threadId: "thread", draftId: null, label: "Thread" })}`,
    ]);
    expect(state.toasts).toEqual([]);
  });

  it("on a snoozed thread queues it, then wakes it, like a drop from Snoozed on the Queue", async () => {
    state.snoozedUntil = "2999-01-01T00:00:00.000Z";
    await choose("queue");
    expect(state.effects).toEqual([
      `enqueue ${JSON.stringify({ environmentId: "secondary", threadId: "thread", draftId: null, label: "Thread" })}`,
      "unsnoozeThread",
    ]);
  });

  it("offers Remove from queue for a queued thread, and removes it", async () => {
    state.queue.entries = [queued];
    await choose("unqueue");
    expect(item("unqueue")?.label).toBe("Remove from queue");
    expect(item("queue")).toBeUndefined();
    expect(state.effects).toEqual(["remove secondary:thread"]);
  });

  it("says the queue is full rather than doing nothing", async () => {
    state.queue.entries = Array.from({ length: THREAD_QUEUE_MAX_ENTRIES }, (_, index) => ({
      environmentId: "secondary",
      threadId: `other-${index}`,
    }));
    await choose("queue");
    expect(state.effects).toEqual([]);
    expect(state.toasts).toEqual([QUEUE_FULL_MESSAGE]);
  });

  it("says the thread is already sending rather than doing nothing", async () => {
    state.queue.inFlight = { entry: queued, sentAt: null };
    await choose("queue");
    expect(state.effects).toEqual([]);
    expect(state.toasts).toEqual([QUEUE_SENDING_MESSAGE]);
  });

  it("says the queue is read-only when it turned read-only while the menu was open", async () => {
    state.queue.readOnly = true;
    await choose("queue");
    expect(state.effects).toEqual([]);
    expect(state.toasts).toEqual([QUEUE_READ_ONLY_MESSAGE]);
  });

  it("disables the queue item on an archived thread", () => {
    state.granted.add("secondary");
    state.archivedAt = "2026-10-08T00:00:00.000Z";
    createMenu().openMenu(position);
    expect(item("queue")?.disabled).toBe(true);
  });

  it("disables the queue item while the queue is read-only", () => {
    state.granted.add("secondary");
    state.queue.readOnly = true;
    createMenu().openMenu(position);
    expect(item("queue")?.disabled).toBe(true);
  });
});
