import { QueryClient } from "@tanstack/react-query";
import type { WsRpcClient } from "@t3tools/client-runtime";
import {
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationHistoryCursor,
  type OrchestrationShellSnapshot,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type OrchestrationThreadHistoryPageResult,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mockSubscribeThread = vi.fn();
const mockGetThreadHistoryPage = vi.fn();
const mockThreadUnsubscribe = vi.fn();
const mockCreateEnvironmentConnection = vi.fn();
const mockCreateWsRpcClient = vi.fn();
const mockWaitForSavedEnvironmentRegistryHydration = vi.fn();
const mockListSavedEnvironmentRecords = vi.fn();
const mockGetSavedEnvironmentRecord = vi.fn();
const mockReadSavedEnvironmentBearerToken = vi.fn();
const mockReadSavedEnvironmentCredential = vi.fn();
const mockSavedEnvironmentRegistrySubscribe = vi.fn();
const mockGetPrimaryKnownEnvironment = vi.hoisted(() => vi.fn());
const mockFetchRemoteSessionState = vi.fn();
const mockResolveRemoteWebSocketConnectionUrl = vi.fn(async () => "ws://remote.example.test/ws");
const mockRemoteHttpRunPromise = vi.fn((effect: Promise<unknown>) => effect);
const mockConnectionReconnects: Array<ReturnType<typeof vi.fn>> = [];
let savedEnvironmentRegistryListener: (() => void) | null = null;

function MockWsTransport() {
  return undefined;
}

vi.mock("../primary", () => ({
  getPrimaryKnownEnvironment: mockGetPrimaryKnownEnvironment,
}));

vi.mock("../../lib/runtime", () => ({
  webRuntime: {
    runPromise: mockRemoteHttpRunPromise,
  },
}));

vi.mock("./catalog", () => ({
  getSavedEnvironmentRecord: mockGetSavedEnvironmentRecord,
  hasSavedEnvironmentRegistryHydrated: vi.fn(() => true),
  listSavedEnvironmentRecords: mockListSavedEnvironmentRecords,
  persistSavedEnvironmentRecord: vi.fn(),
  readSavedEnvironmentBearerToken: mockReadSavedEnvironmentBearerToken,
  readSavedEnvironmentCredential: mockReadSavedEnvironmentCredential,
  removeSavedEnvironmentBearerToken: vi.fn(),
  useSavedEnvironmentRegistryStore: {
    subscribe: mockSavedEnvironmentRegistrySubscribe,
    getState: () => ({
      upsert: vi.fn(),
      remove: vi.fn(),
      markConnected: vi.fn(),
      rename: vi.fn(),
    }),
  },
  useSavedEnvironmentRuntimeStore: {
    getState: () => ({
      ensure: vi.fn(),
      patch: vi.fn(),
      clear: vi.fn(),
    }),
  },
  waitForSavedEnvironmentRegistryHydration: mockWaitForSavedEnvironmentRegistryHydration,
  writeSavedEnvironmentBearerToken: vi.fn(),
  writeSavedEnvironmentCredential: vi.fn(),
}));

vi.mock("./connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./connection")>()),
  createEnvironmentConnection: mockCreateEnvironmentConnection,
}));

vi.mock("@t3tools/client-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@t3tools/client-runtime")>();
  const stubWsClient: WsRpcClient = {
    dispose: async () => undefined,
    reconnect: async () => undefined,
    isHeartbeatFresh: () => false,
    accountUsage: {
      refresh: vi.fn(),
    },
    hostMetrics: {
      subscribe: vi.fn(() => () => undefined),
    },
    llmModels: {
      subscribe: vi.fn(() => () => undefined),
      load: vi.fn(),
      unload: vi.fn(),
    },
    resourceQueue: {
      get: vi.fn(),
    },
    pushSubscriptions: {
      register: vi.fn(),
    },
    cloud: {
      getRelayClientStatus: vi.fn(),
      installRelayClient: vi.fn(),
    },
    orchestration: {
      dispatchCommand: vi.fn(),
      getTurnDiff: vi.fn(),
      getFullThreadDiff: vi.fn(),
      getArchivedShellSnapshot: vi.fn(),
      getThreadHistoryPage: mockGetThreadHistoryPage,
      subscribeShell: vi.fn(() => () => undefined),
      subscribeThread: mockSubscribeThread,
    },
    terminal: {
      open: vi.fn(),
      attach: vi.fn(() => () => undefined),
      write: vi.fn(),
      resize: vi.fn(),
      clear: vi.fn(),
      restart: vi.fn(),
      close: vi.fn(),
      onEvent: vi.fn(() => () => undefined),
      onMetadata: vi.fn(() => () => undefined),
    },
    projects: {
      searchEntries: vi.fn(),
      writeFile: vi.fn(),
      readFile: vi.fn(),
      renderMarkdownHtml: vi.fn(),
    },
    attachments: {
      upload: vi.fn(),
    },
    filesystem: {
      browse: vi.fn(),
    },
    sourceControl: {
      lookupRepository: vi.fn(),
      cloneRepository: vi.fn(),
      publishRepository: vi.fn(),
    },
    shell: {
      openInEditor: vi.fn(),
    },
    vcs: {
      pull: vi.fn(),
      refreshStatus: vi.fn(),
      onStatus: vi.fn(() => () => undefined),
      listRefs: vi.fn(),
      createWorktree: vi.fn(),
      removeWorktree: vi.fn(),
      createRef: vi.fn(),
      switchRef: vi.fn(),
      init: vi.fn(),
    },
    git: {
      runStackedAction: vi.fn(),
      resolvePullRequest: vi.fn(),
      preparePullRequestThread: vi.fn(),
    },
    review: {
      getDiffPreview: vi.fn(),
    },
    server: {
      getConfig: vi.fn(),
      refreshProviders: vi.fn(),
      discoverSourceControl: vi.fn(),
      updateProvider: vi.fn(),
      upsertKeybinding: vi.fn(),
      removeKeybinding: vi.fn(),
      getSettings: vi.fn(),
      updateSettings: vi.fn(),
      subscribeConfig: vi.fn(() => () => undefined),
      subscribeLifecycle: vi.fn(() => () => undefined),
      subscribeAuthAccess: vi.fn(() => () => undefined),
      getTraceDiagnostics: vi.fn(),
      getProcessDiagnostics: vi.fn(),
      getProcessResourceHistory: vi.fn(),
      signalProcess: vi.fn(),
    },
  };
  return {
    ...actual,
    createWsRpcClient: vi.fn(() => stubWsClient),
    fetchRemoteSessionState: mockFetchRemoteSessionState,
    resolveRemoteWebSocketConnectionUrl: mockResolveRemoteWebSocketConnectionUrl,
  };
});

vi.mock("../../rpc/wsTransport", () => ({
  WsTransport: MockWsTransport,
}));

function makeThreadShellSnapshot(params: {
  readonly threadId: ThreadId;
  readonly sessionStatus?:
    | "idle"
    | "starting"
    | "running"
    | "ready"
    | "interrupted"
    | "stopped"
    | "error";
  readonly hasPendingApprovals?: boolean;
  readonly hasPendingUserInput?: boolean;
  readonly hasActionableProposedPlan?: boolean;
  readonly hasPendingBackgroundTask?: boolean;
}): OrchestrationShellSnapshot {
  const projectId = ProjectId.make("project-1");
  const turnId = TurnId.make("turn-1");

  return {
    snapshotSequence: 1,
    projects: [],
    updatedAt: "2026-04-13T00:00:00.000Z",
    threads: [
      {
        id: params.threadId,
        projectId,
        title: "Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn:
          params.sessionStatus === "running"
            ? {
                turnId,
                state: "running",
                requestedAt: "2026-04-13T00:00:00.000Z",
                startedAt: "2026-04-13T00:00:01.000Z",
                completedAt: null,
                assistantMessageId: null,
              }
            : null,
        createdAt: "2026-04-13T00:00:00.000Z",
        updatedAt: "2026-04-13T00:00:00.000Z",
        archivedAt: null,
        session: params.sessionStatus
          ? {
              threadId: params.threadId,
              status: params.sessionStatus,
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: params.sessionStatus === "running" ? turnId : null,
              lastError: null,
              updatedAt: "2026-04-13T00:00:00.000Z",
            }
          : null,
        latestUserMessageAt: null,
        hasPendingApprovals: params.hasPendingApprovals ?? false,
        hasPendingUserInput: params.hasPendingUserInput ?? false,
        hasActionableProposedPlan: params.hasActionableProposedPlan ?? false,
        hasPendingBackgroundTask: params.hasPendingBackgroundTask ?? false,
      },
    ],
  };
}

function makeThreadActivity(index: number): OrchestrationThreadActivity {
  return {
    id: EventId.make(`activity-${index}`),
    tone: "info",
    kind: "runtime.log",
    summary: `activity ${index}`,
    payload: null,
    turnId: null,
    sequence: index,
    createdAt: `2026-04-13T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
  };
}

function makeThreadDetail(
  threadId: ThreadId,
  options?: { readonly activityCount?: number },
): OrchestrationThread {
  const activityCount = options?.activityCount ?? 0;
  return {
    id: threadId,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-04-13T00:00:00.000Z",
    updatedAt: "2026-04-13T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: Array.from({ length: activityCount }, (_, index) => makeThreadActivity(index)),
    checkpoints: [],
    session: null,
  };
}

function makeHistoryCursor(turnId: string): OrchestrationHistoryCursor {
  return {
    requestedAt: "2026-04-13T00:00:00.000Z",
    turnId,
    checkpointTurnCount: null,
  };
}

function makeThreadDetailSnapshotItem(params: {
  readonly threadId: ThreadId;
  readonly hasMoreHistory: boolean;
  readonly oldestLoaded?: OrchestrationHistoryCursor;
  readonly activityCount?: number;
}): unknown {
  return {
    kind: "snapshot",
    snapshot: {
      snapshotSequence: 1,
      thread: makeThreadDetail(params.threadId, { activityCount: params.activityCount ?? 0 }),
      ...(params.oldestLoaded ? { oldestLoaded: params.oldestLoaded } : {}),
      hasMoreHistory: params.hasMoreHistory,
    },
  };
}

function makeHistoryPage(params: {
  readonly hasMoreHistory: boolean;
  readonly oldestLoaded?: OrchestrationHistoryCursor;
}): OrchestrationThreadHistoryPageResult {
  return {
    messages: [],
    activities: [],
    proposedPlans: [],
    checkpoints: [],
    ...(params.oldestLoaded ? { oldestLoaded: params.oldestLoaded } : {}),
    hasMoreHistory: params.hasMoreHistory,
  };
}

describe("retainThreadDetailSubscription", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.clearAllMocks();
    mockGetPrimaryKnownEnvironment.mockReturnValue({
      id: "env-1",
      label: "Primary environment",
      source: "window-origin",
      target: {
        httpBaseUrl: "http://127.0.0.1:3000/",
        wsBaseUrl: "ws://127.0.0.1:3000/",
      },
      environmentId: EnvironmentId.make("env-1"),
    });

    mockThreadUnsubscribe.mockImplementation(() => undefined);
    mockSubscribeThread.mockImplementation(() => mockThreadUnsubscribe);
    mockCreateWsRpcClient.mockReturnValue({
      server: {
        getConfig: vi.fn(async () => ({
          environment: {
            environmentId: EnvironmentId.make("env-remote"),
            label: "Remote env",
            platform: { os: "darwin", arch: "arm64" },
            serverVersion: "0.0.0-test",
            capabilities: { repositoryIdentity: true },
          },
        })),
      },
      isHeartbeatFresh: vi.fn(() => true),
      orchestration: {
        getThreadHistoryPage: mockGetThreadHistoryPage,
        subscribeThread: mockSubscribeThread,
      },
    });
    mockCreateEnvironmentConnection.mockImplementation((input) => {
      const reconnect = vi.fn(async () => undefined);
      mockConnectionReconnects.push(reconnect);
      queueMicrotask(() => {
        input.onConfigSnapshot?.({
          environment: {
            environmentId: input.knownEnvironment.environmentId,
            label: input.knownEnvironment.label,
            platform: { os: "darwin", arch: "arm64" },
            serverVersion: "0.0.0-test",
            capabilities: { repositoryIdentity: true },
          },
        });
      });
      return {
        kind: input.kind,
        environmentId: input.knownEnvironment.environmentId,
        knownEnvironment: input.knownEnvironment,
        client: input.client,
        ensureBootstrapped: vi.fn(async () => undefined),
        reconnect,
        dispose: vi.fn(async () => undefined),
      };
    });
    savedEnvironmentRegistryListener = null;
    mockSavedEnvironmentRegistrySubscribe.mockImplementation((listener: () => void) => {
      savedEnvironmentRegistryListener = listener;
      return () => {
        if (savedEnvironmentRegistryListener === listener) {
          savedEnvironmentRegistryListener = null;
        }
      };
    });
    mockWaitForSavedEnvironmentRegistryHydration.mockResolvedValue(undefined);
    mockListSavedEnvironmentRecords.mockReturnValue([]);
    mockGetSavedEnvironmentRecord.mockReturnValue(null);
    mockReadSavedEnvironmentBearerToken.mockResolvedValue(null);
    mockReadSavedEnvironmentCredential.mockImplementation(async () => {
      const token = await mockReadSavedEnvironmentBearerToken();
      return token ? { version: 1, method: "bearer", token } : null;
    });
    mockFetchRemoteSessionState.mockResolvedValue({
      authenticated: true,
      scopes: ["orchestration:read"],
    });
    mockConnectionReconnects.length = 0;
  });

  afterEach(async () => {
    const { resetEnvironmentServiceForTests } = await import("./service");
    await resetEnvironmentServiceForTests();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("keeps thread detail subscriptions warm across releases until idle eviction", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-1");

    const releaseFirst = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    releaseFirst();
    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();

    const releaseSecond = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    releaseSecond();
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(28 * 60 * 1000);
    expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(1);

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("subscribes without a cursor when fresh and applies sparse thread events without resubscribing", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-cursor");

    const release = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);
    // A fresh subscription carries no cursor, so the server sends a full snapshot.
    // The initial window params bound the first snapshot to the recent tail.
    expect(mockSubscribeThread.mock.calls[0]?.[0]).toEqual({
      threadId,
      fromSequenceExclusive: undefined,
      windowTurns: 15,
      maxRows: 2000,
    });

    // The thread stream is a sparse subset of the global sequence axis, so gaps
    // (6 -> 9) are normal and must NOT trigger a resubscribe; a duplicate (<= the
    // high-water mark) is ignored. Any resubscribe here would be the contiguity-bug
    // regression that turned incremental reconnect into snapshot storms.
    const emit = mockSubscribeThread.mock.calls[0]?.[1] as (item: unknown) => void;
    emit({ kind: "event", event: { sequence: 6 } });
    emit({ kind: "event", event: { sequence: 9 } });
    emit({ kind: "event", event: { sequence: 6 } });
    // A coalesced batch applies its fresh events and dedups any already-applied ones.
    emit({ kind: "events", events: [{ sequence: 9 }, { sequence: 12 }, { sequence: 15 }] });

    await Promise.resolve();
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("does not start the primary connection until the known environment has an id", async () => {
    mockGetPrimaryKnownEnvironment.mockReturnValue({
      id: "env-1",
      label: "Primary environment",
      source: "window-origin",
      target: {
        httpBaseUrl: "http://127.0.0.1:3000/",
        wsBaseUrl: "ws://127.0.0.1:3000/",
      },
    });
    const {
      listEnvironmentConnections,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());

    expect(mockCreateEnvironmentConnection).not.toHaveBeenCalled();
    expect(listEnvironmentConnections()).toEqual([]);

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("keeps non-idle thread detail subscriptions attached until the thread becomes idle", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-active");

    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();

    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId,
        sessionStatus: "ready",
        hasPendingApprovals: true,
      }),
      environmentId,
    );

    const release = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();

    connectionInput.applyShellEvent(
      {
        kind: "thread-upserted",
        sequence: 2,
        thread: makeThreadShellSnapshot({
          threadId,
          sessionStatus: "idle",
        }).threads[0]!,
      },
      environmentId,
    );

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(1);

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("reattaches retained thread detail subscriptions after a saved environment reconnect replaces the client", async () => {
    const environmentId = EnvironmentId.make("env-remote");
    const threadId = ThreadId.make("thread-reconnect");
    const record = {
      environmentId,
      label: "Remote env",
      httpBaseUrl: "http://remote.example.test",
      wsBaseUrl: "ws://remote.example.test",
      createdAt: "2026-05-01T00:00:00.000Z",
      lastConnectedAt: "2026-05-01T00:00:00.000Z",
    };
    mockListSavedEnvironmentRecords.mockReturnValue([record]);
    mockGetSavedEnvironmentRecord.mockReturnValue(record);
    mockReadSavedEnvironmentBearerToken.mockResolvedValue("bearer-token");

    const {
      disconnectSavedEnvironment,
      listEnvironmentConnections,
      reconnectSavedEnvironment,
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    savedEnvironmentRegistryListener?.();
    await vi.waitFor(() => {
      expect(
        listEnvironmentConnections().some(
          (connection) => connection.environmentId === environmentId,
        ),
      ).toBe(true);
    });
    const createConnectionCallsBeforeReconnect = mockCreateEnvironmentConnection.mock.calls.length;

    const release = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);
    expect(mockSubscribeThread.mock.calls[0]?.[0]).toEqual({
      threadId,
      fromSequenceExclusive: undefined,
      windowTurns: 15,
      maxRows: 2000,
    });

    // Apply a coalesced batch so the subscription has a high-water mark to resume
    // from (the resume cursor must be the batch's max sequence).
    const emit = mockSubscribeThread.mock.calls[0]?.[1] as (item: unknown) => void;
    emit({ kind: "events", events: [{ sequence: 40 }, { sequence: 42 }] });

    await disconnectSavedEnvironment(environmentId);
    expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(1);
    expect(
      listEnvironmentConnections().some((connection) => connection.environmentId === environmentId),
    ).toBe(false);

    const reconnectPromise = reconnectSavedEnvironment(environmentId);
    await vi.advanceTimersByTimeAsync(200);
    await reconnectPromise;
    await vi.waitFor(() => {
      expect(mockCreateEnvironmentConnection).toHaveBeenCalledTimes(
        createConnectionCallsBeforeReconnect + 1,
      );
      expect(mockSubscribeThread).toHaveBeenCalledTimes(2);
    });
    // Incremental reconnect: the resubscribe resumes from the applied sequence,
    // still carrying the initial window params.
    expect(mockSubscribeThread.mock.calls[1]?.[0]).toEqual({
      threadId,
      fromSequenceExclusive: 42,
      windowTurns: 15,
      maxRows: 2000,
    });

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("keeps healthy environment streams connected when the browser resumes from the background", async () => {
    let visibilityState: DocumentVisibilityState = "visible";
    const documentTarget = new EventTarget();
    const windowTarget = new EventTarget();
    vi.stubGlobal("document", {
      addEventListener: documentTarget.addEventListener.bind(documentTarget),
      removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
      get visibilityState() {
        return visibilityState;
      },
    });
    vi.stubGlobal("window", {
      addEventListener: windowTarget.addEventListener.bind(windowTarget),
      removeEventListener: windowTarget.removeEventListener.bind(windowTarget),
    });

    const { resetEnvironmentServiceForTests, startEnvironmentConnectionService } =
      await import("./service");
    mockCreateEnvironmentConnection.mockImplementation((input) => {
      const reconnect = vi.fn(async () => undefined);
      mockConnectionReconnects.push(reconnect);
      queueMicrotask(() => {
        input.onConfigSnapshot?.({
          environment: {
            environmentId: input.knownEnvironment.environmentId,
            label: input.knownEnvironment.label,
            platform: { os: "darwin", arch: "arm64" },
            serverVersion: "0.0.0-test",
            capabilities: { repositoryIdentity: true },
          },
        });
      });
      return {
        kind: input.kind,
        environmentId: input.knownEnvironment.environmentId,
        knownEnvironment: input.knownEnvironment,
        client: {
          ...input.client,
          isHeartbeatFresh: vi.fn(() => true),
        },
        ensureBootstrapped: vi.fn(async () => undefined),
        reconnect,
        dispose: vi.fn(async () => undefined),
      };
    });

    const stop = startEnvironmentConnectionService(new QueryClient());
    expect(mockConnectionReconnects).toHaveLength(1);

    visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("reconnects stale environment streams when the browser resumes from the background", async () => {
    let visibilityState: DocumentVisibilityState = "visible";
    const documentTarget = new EventTarget();
    const windowTarget = new EventTarget();
    vi.stubGlobal("document", {
      addEventListener: documentTarget.addEventListener.bind(documentTarget),
      removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
      get visibilityState() {
        return visibilityState;
      },
    });
    vi.stubGlobal("window", {
      addEventListener: windowTarget.addEventListener.bind(windowTarget),
      removeEventListener: windowTarget.removeEventListener.bind(windowTarget),
    });
    mockCreateWsRpcClient.mockReturnValue({
      server: {
        getConfig: vi.fn(async () => ({
          environment: {
            environmentId: EnvironmentId.make("env-remote"),
            label: "Remote env",
            platform: { os: "darwin", arch: "arm64" },
            serverVersion: "0.0.0-test",
            capabilities: { repositoryIdentity: true },
          },
        })),
      },
      isHeartbeatFresh: vi.fn(() => false),
      orchestration: {
        subscribeThread: mockSubscribeThread,
      },
    });

    const { resetEnvironmentServiceForTests, startEnvironmentConnectionService } =
      await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    expect(mockConnectionReconnects).toHaveLength(1);

    visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(mockConnectionReconnects[0]).toHaveBeenCalledTimes(1);

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("reconnects a stale environment stream on return to visible even without a preceding hidden event", async () => {
    const documentTarget = new EventTarget();
    const windowTarget = new EventTarget();
    vi.stubGlobal("document", {
      addEventListener: documentTarget.addEventListener.bind(documentTarget),
      removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
      get visibilityState() {
        return "visible" as DocumentVisibilityState;
      },
    });
    vi.stubGlobal("window", {
      addEventListener: windowTarget.addEventListener.bind(windowTarget),
      removeEventListener: windowTarget.removeEventListener.bind(windowTarget),
    });
    mockCreateWsRpcClient.mockReturnValue({
      server: {
        getConfig: vi.fn(async () => ({
          environment: {
            environmentId: EnvironmentId.make("env-remote"),
            label: "Remote env",
            platform: { os: "darwin", arch: "arm64" },
            serverVersion: "0.0.0-test",
            capabilities: { repositoryIdentity: true },
          },
        })),
      },
      isHeartbeatFresh: vi.fn(() => false),
      orchestration: {
        subscribeThread: mockSubscribeThread,
      },
    });

    const { resetEnvironmentServiceForTests, startEnvironmentConnectionService } =
      await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    expect(mockConnectionReconnects).toHaveLength(1);
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    // The mobile freeze/discard case: the tab was suspended on screen-off without
    // the JS ever observing a "hidden" transition, so it returns straight to
    // "visible" with no preceding hidden. The resync must still fire.
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(mockConnectionReconnects[0]).toHaveBeenCalledTimes(1);

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("reconnects a stale environment stream on the Page Lifecycle resume event", async () => {
    const documentTarget = new EventTarget();
    const windowTarget = new EventTarget();
    vi.stubGlobal("document", {
      addEventListener: documentTarget.addEventListener.bind(documentTarget),
      removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
      get visibilityState() {
        return "visible" as DocumentVisibilityState;
      },
    });
    vi.stubGlobal("window", {
      addEventListener: windowTarget.addEventListener.bind(windowTarget),
      removeEventListener: windowTarget.removeEventListener.bind(windowTarget),
    });
    mockCreateWsRpcClient.mockReturnValue({
      server: {
        getConfig: vi.fn(async () => ({
          environment: {
            environmentId: EnvironmentId.make("env-remote"),
            label: "Remote env",
            platform: { os: "darwin", arch: "arm64" },
            serverVersion: "0.0.0-test",
            capabilities: { repositoryIdentity: true },
          },
        })),
      },
      isHeartbeatFresh: vi.fn(() => false),
      orchestration: {
        subscribeThread: mockSubscribeThread,
      },
    });

    const { resetEnvironmentServiceForTests, startEnvironmentConnectionService } =
      await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    expect(mockConnectionReconnects).toHaveLength(1);
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    // Page Lifecycle `resume` fires on `document` when a frozen/discarded tab is
    // thawed (Chrome/Android), frequently with no visibilitychange transition.
    documentTarget.dispatchEvent(new Event("resume"));
    expect(mockConnectionReconnects[0]).toHaveBeenCalledTimes(1);

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("collapses a visibilitychange + persisted pageshow + resume thaw into one reconnect", async () => {
    const documentTarget = new EventTarget();
    const windowTarget = new EventTarget();
    vi.stubGlobal("document", {
      addEventListener: documentTarget.addEventListener.bind(documentTarget),
      removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
      get visibilityState() {
        return "visible" as DocumentVisibilityState;
      },
    });
    vi.stubGlobal("window", {
      addEventListener: windowTarget.addEventListener.bind(windowTarget),
      removeEventListener: windowTarget.removeEventListener.bind(windowTarget),
    });
    mockCreateWsRpcClient.mockReturnValue({
      server: {
        getConfig: vi.fn(async () => ({
          environment: {
            environmentId: EnvironmentId.make("env-remote"),
            label: "Remote env",
            platform: { os: "darwin", arch: "arm64" },
            serverVersion: "0.0.0-test",
            capabilities: { repositoryIdentity: true },
          },
        })),
      },
      isHeartbeatFresh: vi.fn(() => false),
      orchestration: {
        subscribeThread: mockSubscribeThread,
      },
    });

    const { resetEnvironmentServiceForTests, startEnvironmentConnectionService } =
      await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    expect(mockConnectionReconnects).toHaveLength(1);

    // A single thaw commonly fires all three foreground triggers together. The 2s
    // cooldown must collapse them to one reconnect (fake timers freeze the clock,
    // so all three land inside the cooldown window).
    const pageShow = new Event("pageshow");
    Object.defineProperty(pageShow, "persisted", { value: true });
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    windowTarget.dispatchEvent(pageShow);
    documentTarget.dispatchEvent(new Event("resume"));
    expect(mockConnectionReconnects[0]).toHaveBeenCalledTimes(1);

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("allows a larger idle cache before capacity eviction starts", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");

    for (let index = 0; index < 12; index += 1) {
      const release = retainThreadDetailSubscription(
        environmentId,
        ThreadId.make(`thread-${index + 1}`),
      );
      release();
    }

    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("disposes cached thread detail subscriptions when the environment service resets", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-2");

    const release = retainThreadDetailSubscription(environmentId, threadId);
    release();

    await resetEnvironmentServiceForTests();
    expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(1);

    stop();
  });

  it("backfills older history in paced pages until the server reports no more history", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-backfill");

    const cursor0 = makeHistoryCursor("turn-0");
    const cursor1 = makeHistoryCursor("turn-1");
    const cursor2 = makeHistoryCursor("turn-2");

    mockGetThreadHistoryPage
      .mockResolvedValueOnce(makeHistoryPage({ oldestLoaded: cursor1, hasMoreHistory: true }))
      .mockResolvedValueOnce(makeHistoryPage({ oldestLoaded: cursor2, hasMoreHistory: false }));

    const release = retainThreadDetailSubscription(environmentId, threadId);
    const emit = mockSubscribeThread.mock.calls[0]?.[1] as (item: unknown) => void;
    emit(makeThreadDetailSnapshotItem({ threadId, oldestLoaded: cursor0, hasMoreHistory: true }));

    // First page fires immediately after the snapshot, paging back from the
    // snapshot's oldestLoaded cursor.
    await vi.advanceTimersByTimeAsync(0);
    expect(mockGetThreadHistoryPage).toHaveBeenCalledTimes(1);
    expect(mockGetThreadHistoryPage.mock.calls[0]?.[0]).toEqual({
      threadId,
      beforeTurn: cursor0,
      maxTurns: 25,
      maxRows: 3000,
    });

    // The next page waits out the 150ms pacing and advances beforeTurn to the
    // previous page's oldestLoaded cursor.
    await vi.advanceTimersByTimeAsync(150);
    expect(mockGetThreadHistoryPage).toHaveBeenCalledTimes(2);
    expect(mockGetThreadHistoryPage.mock.calls[1]?.[0]).toEqual({
      threadId,
      beforeTurn: cursor1,
      maxTurns: 25,
      maxRows: 3000,
    });

    // The second page reports hasMoreHistory:false, so no further pages fire.
    await vi.advanceTimersByTimeAsync(300);
    expect(mockGetThreadHistoryPage).toHaveBeenCalledTimes(2);

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("resumes a stalled backfill after a transient page error when new events arrive", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-resume-backfill");

    const cursor0 = makeHistoryCursor("turn-0");
    const cursor1 = makeHistoryCursor("turn-1");

    // The first page fails (a transient RPC error / socket blip), stopping the
    // loop with history still pending. On an incremental reconnect the server
    // resends events (not a fresh snapshot), which must re-drive the loop; the
    // retry then succeeds and finishes.
    mockGetThreadHistoryPage
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce(makeHistoryPage({ oldestLoaded: cursor1, hasMoreHistory: false }));

    const release = retainThreadDetailSubscription(environmentId, threadId);
    const emit = mockSubscribeThread.mock.calls[0]?.[1] as (item: unknown) => void;
    emit(makeThreadDetailSnapshotItem({ threadId, oldestLoaded: cursor0, hasMoreHistory: true }));

    // First page attempted, errored, and the loop stopped — it does NOT retry on
    // its own (no busy-spin).
    await vi.advanceTimersByTimeAsync(0);
    expect(mockGetThreadHistoryPage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mockGetThreadHistoryPage).toHaveBeenCalledTimes(1);

    // A subsequent event batch (e.g. the incremental reconnect resume) re-drives
    // the backfill from the same still-pending cursor.
    emit({ kind: "events", events: [{ sequence: 100 }] });
    await vi.advanceTimersByTimeAsync(0);
    expect(mockGetThreadHistoryPage).toHaveBeenCalledTimes(2);
    expect(mockGetThreadHistoryPage.mock.calls[1]?.[0]).toEqual({
      threadId,
      beforeTurn: cursor0,
      maxTurns: 25,
      maxRows: 3000,
    });

    // The retry reported hasMoreHistory:false, so it stops for good.
    await vi.advanceTimersByTimeAsync(300);
    expect(mockGetThreadHistoryPage).toHaveBeenCalledTimes(2);

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("stops backfilling older history after the subscription is disposed", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-dispose-backfill");

    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();

    // Every page still reports more history, so the loop would run forever if it
    // ignored disposal.
    mockGetThreadHistoryPage.mockImplementation(async () =>
      makeHistoryPage({ oldestLoaded: makeHistoryCursor("turn-next"), hasMoreHistory: true }),
    );

    const release = retainThreadDetailSubscription(environmentId, threadId);
    const emit = mockSubscribeThread.mock.calls[0]?.[1] as (item: unknown) => void;
    emit(
      makeThreadDetailSnapshotItem({
        threadId,
        oldestLoaded: makeHistoryCursor("turn-0"),
        hasMoreHistory: true,
      }),
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(mockGetThreadHistoryPage).toHaveBeenCalledTimes(1);

    // Dispose the subscription mid-loop (while it is waiting out the pacing delay).
    connectionInput.applyShellEvent(
      { kind: "thread-removed", sequence: 1, threadId },
      environmentId,
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(mockGetThreadHistoryPage).toHaveBeenCalledTimes(1);

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("stops backfilling older history once the activity ceiling is reached", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-ceiling-backfill");

    mockGetThreadHistoryPage.mockResolvedValue(
      makeHistoryPage({ oldestLoaded: makeHistoryCursor("turn-next"), hasMoreHistory: true }),
    );

    const release = retainThreadDetailSubscription(environmentId, threadId);
    const emit = mockSubscribeThread.mock.calls[0]?.[1] as (item: unknown) => void;
    // The snapshot already loads the thread at the activity ceiling (3000), so
    // the backfill must not fetch even though hasMoreHistory is true.
    emit(
      makeThreadDetailSnapshotItem({
        threadId,
        oldestLoaded: makeHistoryCursor("turn-0"),
        hasMoreHistory: true,
        activityCount: 3000,
      }),
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(mockGetThreadHistoryPage).not.toHaveBeenCalled();

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("does not backfill when the snapshot reports no more history", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-legacy-backfill");

    const release = retainThreadDetailSubscription(environmentId, threadId);
    const emit = mockSubscribeThread.mock.calls[0]?.[1] as (item: unknown) => void;
    // A legacy/non-windowed snapshot omits oldestLoaded and reports no more
    // history, so the backfill loop never starts.
    emit(makeThreadDetailSnapshotItem({ threadId, hasMoreHistory: false }));

    await vi.advanceTimersByTimeAsync(1_000);
    expect(mockGetThreadHistoryPage).not.toHaveBeenCalled();

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });
});
