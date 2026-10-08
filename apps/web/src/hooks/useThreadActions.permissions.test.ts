import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  EnvironmentAuthorizationError,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const state = vi.hoisted(() => ({
  scopes: new Map<string, Set<string>>(),
  threads: [] as {
    environmentId: EnvironmentId;
    id: ThreadId;
    projectId: ProjectId;
    title: string;
    worktreePath: string | null;
    session: { status: "ready" | "stopped" } | null;
    latestTurn: null;
  }[],
  requests: [] as { action: string; environmentId: string; input: { threadId?: string } }[],
  localEffects: [] as string[],
  confirm: vi.fn<(message: string) => Promise<boolean>>(),
  toasts: [] as string[],
  afterRequest: undefined as ((action: string) => void) | undefined,
  /** Actions the server answers with a failure, or that throw. */
  failing: new Map<string, "refused" | "thrown">(),
  sessionLookupFails: false,
}));

vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
  useRef: (current: unknown) => ({ current }),
}));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ state: { matches: [] }, navigate: async () => {} }),
}));
vi.mock("../state/session", () => ({
  environmentSession: { sessionStateAtom: "session" },
  readEnvironmentScope: (environmentId: string, scope: string) =>
    state.scopes.get(environmentId)?.has(scope) === true,
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand:
    (action: string) =>
    async (request: { environmentId: string; input: { threadId?: string } }) => {
      state.requests.push({ action, ...request });
      const scope =
        action === "removeWorktree" ? AuthSourceControlWriteScope : AuthOrchestrationOperateScope;
      if (!state.scopes.get(request.environmentId)?.has(scope)) {
        return AsyncResult.failure(Cause.fail(new Error("Server denied the request")));
      }
      state.afterRequest?.(action);
      const failing = state.failing.get(action);
      if (failing === "thrown") throw new Error("socket closed");
      if (failing === "refused") return AsyncResult.failure(Cause.fail(new Error("refused")));
      return AsyncResult.success(undefined);
    },
}));
vi.mock("../state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => async (environmentId: string) =>
    state.sessionLookupFails
      ? AsyncResult.failure(Cause.fail(new Error("Session lookup failed")))
      : AsyncResult.success({
          authenticated: true,
          scopes: [...(state.scopes.get(environmentId) ?? [])],
          auth: { serverUpdateScope: "environment:maintain" },
        }),
}));
vi.mock("../state/threads", () => ({
  threadEnvironment: Object.fromEntries(
    [
      "archive",
      "unarchive",
      "delete",
      "settle",
      "unsettle",
      "pin",
      "unpin",
      "reorderPin",
      "snooze",
      "unsnooze",
      "stopSession",
    ].map((action) => [action, action]),
  ),
}));
vi.mock("../state/vcs", () => ({
  vcsEnvironment: { removeWorktree: "removeWorktree", refreshStatus: "refreshStatus" },
}));
vi.mock("../state/entities", () => ({
  readEnvironmentSupportsPinning: () => true,
  readEnvironmentSupportsPinReorder: () => true,
  readEnvironmentSupportsSettlement: () => true,
  readEnvironmentSupportsSnooze: () => true,
  readThreadShell: (ref: ScopedThreadRef) =>
    state.threads.find(
      (thread) => thread.environmentId === ref.environmentId && thread.id === ref.threadId,
    ) ?? null,
  readThreadShells: () => state.threads,
  readEnvironmentThreadRefs: (environmentId: EnvironmentId) =>
    state.threads
      .filter((thread) => thread.environmentId === environmentId)
      .map((thread) => ({ environmentId, threadId: thread.id })),
  readProject: () => ({ workspaceRoot: "/project" }),
}));
vi.mock("../components/Sidebar.logic", () => ({
  getFallbackThreadIdAfterDelete: () => null,
  pinOrderKeyBetween: () => "a",
}));
vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: (select: (store: unknown) => unknown) =>
    select({
      clearDraftThread: () => state.localEffects.push("clear-draft"),
      clearProjectDraftThreadById: () => state.localEffects.push("clear-project-draft"),
    }),
}));
vi.mock("../terminalUiStateStore", () => ({
  useTerminalUiStateStore: (select: (store: unknown) => unknown) =>
    select({
      clearTerminalUiState: () => state.localEffects.push("clear-terminal-ui"),
    }),
}));
vi.mock("../uiStateStore", () => ({
  useUiStateStore: (select: (store: unknown) => unknown) =>
    select({
      markThreadVisited: () => state.localEffects.push("mark-visited"),
    }),
}));
vi.mock("../lib/archivedThreadsState", () => ({
  refreshArchivedThreadsForEnvironment: () => state.localEffects.push("refresh-archive"),
}));
vi.mock("../lib/composerDraftUploads", () => ({
  releaseComposerDraftUploads: () => state.localEffects.push("release-uploads"),
}));
vi.mock("../localApi", () => ({
  readLocalApi: () => ({ dialogs: { confirm: state.confirm } }),
}));
vi.mock("../threadRoutes", () => ({
  resolveThreadRouteRef: () => null,
  buildThreadRouteParams: (ref: ScopedThreadRef) => ref,
}));
vi.mock("../components/ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: {
    add: (toast: { title?: string }) => {
      if (toast.title) state.toasts.push(toast.title);
    },
  },
}));
vi.mock("./useHandleNewThread", () => ({ useNewThreadHandler: () => async () => {} }));
vi.mock("./useSettings", () => ({
  useClientSettings: (select: (settings: unknown) => unknown) =>
    select({
      sidebarThreadSortOrder: "createdAt",
      confirmThreadDelete: true,
      confirmThreadUnpin: true,
    }),
}));

import { useThreadActions } from "./useThreadActions";
import { nextThreadQueueAction } from "../components/threadQueue.logic";
import { useThreadQueueLeavingStore } from "../threadQueueLeaving";
import { useThreadQueueStore } from "../threadQueueStore";

const primary = EnvironmentId.make("primary");
const secondary = EnvironmentId.make("secondary");
const target = { environmentId: secondary, threadId: ThreadId.make("thread") };
type ThreadActions = ReturnType<typeof useThreadActions>;
const operations = [
  {
    name: "archive",
    run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.archiveThread(ref),
  },
  {
    name: "unarchive",
    run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.unarchiveThread(ref),
  },
  {
    name: "settle",
    run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.settleThread(ref),
  },
  {
    name: "unsettle",
    run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.unsettleThread(ref),
  },
  {
    name: "snooze",
    run: (actions: ThreadActions, ref: ScopedThreadRef) =>
      actions.snoozeThread(ref, "2099-01-01T00:00:00Z"),
  },
  {
    name: "unsnooze",
    run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.unsnoozeThread(ref),
  },
  { name: "pin", run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.pinThread(ref) },
  {
    name: "unpin",
    run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.unpinThread(ref),
  },
  {
    name: "reorderPin",
    run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.reorderPinnedThread(ref, "b"),
  },
] as const;

beforeEach(() => {
  state.scopes = new Map([
    [primary, new Set([AuthOrchestrationOperateScope])],
    [secondary, new Set<string>()],
  ]);
  state.threads = [
    {
      environmentId: secondary,
      id: target.threadId,
      projectId: ProjectId.make("project"),
      title: "Thread",
      worktreePath: null,
      session: null,
      latestTurn: null,
    },
  ];
  state.requests = [];
  state.localEffects = [];
  state.confirm.mockReset().mockResolvedValue(true);
  state.toasts = [];
  state.afterRequest = undefined;
  state.failing = new Map();
  state.sessionLookupFails = false;
});

describe("thread action permissions", () => {
  it.each(operations)("$name requires the target environment's grant", async ({ run }) => {
    const result = await run(useThreadActions(), target);
    expect(result._tag).toBe("Failure");
    expect(state.requests).toEqual([]);
    expect(state.localEffects).toEqual([]);
  });

  it.each(operations)("$name rechecks a retained callback after revocation", async ({ run }) => {
    state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
    const actions = useThreadActions();
    state.scopes.get(secondary)!.clear();
    await run(actions, target);
    expect(state.requests).toEqual([]);
  });

  it.each(operations)(
    "$name works after the target gains only task permission",
    async ({ name, run }) => {
      const actions = useThreadActions();
      state.scopes.get(primary)!.clear();
      state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
      expect((await run(actions, target))._tag).toBe("Success");
      expect(state.requests).toEqual([
        expect.objectContaining({ action: name, environmentId: secondary }),
      ]);
    },
  );

  it.each(["confirmAndDeleteThread", "confirmAndUnpinThread"] as const)(
    "%s blocks a forbidden confirmation",
    async (action) => {
      await useThreadActions()[action](target);
      expect(state.confirm).not.toHaveBeenCalled();
      expect(state.requests).toEqual([]);
    },
  );

  it.each(["confirmAndDeleteThread", "confirmAndUnpinThread"] as const)(
    "%s rechecks after the confirmation",
    async (action) => {
      state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
      const confirmation = deferred<boolean>();
      state.confirm.mockReturnValue(confirmation.promise);
      const result = useThreadActions()[action](target);
      expect(state.confirm).toHaveBeenCalledOnce();
      state.scopes.get(secondary)!.clear();
      confirmation.resolve(true);
      await result;
      expect(state.requests).toEqual([]);
      expect(state.localEffects).toEqual([]);
    },
  );

  it("identifies the missing task scope when thread deletion is denied", async () => {
    const result = await useThreadActions().deleteThread(target);

    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") throw new Error("Expected permission denial");
    const error = Cause.squash<unknown>(result.cause);
    expect(error).toBeInstanceOf(EnvironmentAuthorizationError);
    expect(error).toMatchObject({ requiredScope: AuthOrchestrationOperateScope });
    expect(state.requests).toEqual([]);
    expect(state.localEffects).toEqual([]);
  });

  it("deletes an archived thread only with its own environment's grant", async () => {
    state.threads = [];
    const actions = useThreadActions();
    await actions.deleteThread(target);
    expect(state.requests).toEqual([]);
    state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
    expect((await actions.deleteThread(target))._tag).toBe("Success");
    expect(state.requests).toEqual([
      expect.objectContaining({ action: "delete", environmentId: secondary }),
    ]);
  });

  it("stops before delete and local cleanup when permission is revoked during session stop", async () => {
    state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
    state.threads[0]!.session = { status: "ready" };
    state.afterRequest = () => state.scopes.get(secondary)!.clear();
    expect((await useThreadActions().deleteThread(target))._tag).toBe("Failure");
    expect(state.requests.map((request) => request.action)).toEqual(["stopSession"]);
    expect(state.localEffects).toEqual([]);
  });

  it.each([
    { reason: "without source-control permission", sessionLookupFails: false },
    { reason: "when the permission lookup fails", sessionLookupFails: true },
  ])("deletes a worktree thread and keeps its worktree $reason", async ({ sessionLookupFails }) => {
    state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
    state.threads[0]!.worktreePath = "/worktrees/thread";
    state.sessionLookupFails = sessionLookupFails;
    expect((await useThreadActions().deleteThread(target))._tag).toBe("Success");
    expect(state.confirm).not.toHaveBeenCalled();
    expect(state.requests.map((request) => request.action)).toEqual(["stopSession", "delete"]);
    expect(state.localEffects).toContain("clear-terminal-ui");
  });

  it("does not request worktree removal after its grant is revoked during delete", async () => {
    state.scopes
      .get(secondary)!
      .add(AuthOrchestrationOperateScope)
      .add(AuthSourceControlWriteScope);
    state.threads[0]!.worktreePath = "/worktrees/thread";
    state.afterRequest = () => state.scopes.get(secondary)!.delete(AuthSourceControlWriteScope);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // The thread is already gone, so cleanup reports itself in a toast
      // instead of failing the deletion.
      const result = await useThreadActions().deleteThread(target);
      expect(result._tag).toBe("Success");
      expect(state.requests.map((request) => request.action)).toEqual(["stopSession", "delete"]);
      expect(state.toasts).toContain("Failed to delete worktree");
      expect(state.localEffects).toContain("clear-terminal-ui");
    } finally {
      consoleError.mockRestore();
    }
  });
});

// A queued thread being archived or deleted leaves the Queue once the command landed. Until then
// the Queue's coordinator must not send it; a refused or failed command leaves it sendable.
describe("archive or delete of a queued thread", () => {
  const entry = (threadId: string) => ({
    environmentId: secondary,
    threadId: ThreadId.make(threadId),
    draftId: null,
    addedAt: 1,
    ownerId: "device",
    label: threadId,
  });
  const key = (threadId: string) => `${secondary}:${threadId}`;
  const queuedThreadIds = () =>
    useThreadQueueStore.getState().entries.map((candidate) => candidate.threadId);
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
  const remove = {
    archive: (actions: ThreadActions) => actions.archiveThread(target),
    delete: (actions: ThreadActions) => actions.deleteThread(target),
  };

  beforeEach(() => {
    state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
    useThreadQueueStore.setState({
      mode: "local",
      readOnly: false,
      entries: [entry("thread"), entry("other")],
      inFlight: null,
    });
  });
  afterEach(() => {
    useThreadQueueStore.setState({ entries: [], inFlight: null });
  });

  it.each(["archive", "delete"] as const)(
    "%s: not sent while in flight, and out of the Queue once it landed",
    async (action) => {
      const claimed: Array<[string, string | null]> = [];
      state.afterRequest = (request) => claimed.push([request, coordinatorClaims()]);
      // The mark ends only once the thread already left the Queue: no gap between the two.
      const queuedAtRelease: string[][] = [];
      const unsubscribe = useThreadQueueLeavingStore.subscribe(({ keys }) => {
        if (keys.size === 0) queuedAtRelease.push(queuedThreadIds());
      });
      try {
        expect((await remove[action](useThreadActions()))._tag).toBe("Success");
      } finally {
        unsubscribe();
      }
      expect(queuedAtRelease).toEqual([["other"]]);
      // A delete stops the thread's session first: it is not sent during that step either.
      expect(claimed).toEqual(
        (action === "delete" ? ["stopSession", "delete"] : ["archive"]).map((request) => [
          request,
          key("other"),
        ]),
      );
      expect(queuedThreadIds()).toEqual(["other"]);
      expect(useThreadQueueLeavingStore.getState().keys.size).toBe(0);
    },
  );

  it.each([
    ["archive", "refused"],
    ["archive", "thrown"],
    ["delete", "refused"],
    ["delete", "thrown"],
  ] as const)("a %s %s leaves it queued and sendable at once", async (action, failure) => {
    state.failing.set(action, failure);
    await remove[action](useThreadActions()).catch(() => {});
    expect(queuedThreadIds()).toEqual(["thread", "other"]);
    expect(coordinatorClaims()).toBe(key("thread"));
  });
});
