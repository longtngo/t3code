import {
  boundAttachmentIds,
  findRecordedWorktreeSetup,
  mergeDirectPreviewAnnotation,
  planComposerTurn,
  snapshotComposerSend,
  withMessageContext,
  deriveAvailableRevertTurnCounts,
  deriveWorkspaceMutationId,
} from "./ChatView.logic";
import { recallCheckoutIsRepo, rememberCheckoutIsRepo } from "./ChatView.logic";
import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { deriveProviderInstanceEntries } from "../providerInstances";
import { ensureInlineContextReferences } from "../lib/composerContextReferences";
import { terminalContextReference } from "../lib/composerContextRecords";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  RunId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type WorktreeSetupSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { Atom } from "effect/reactivity";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentThreadDetails } from "../state/threads";

import type { Thread } from "../types";
import { makeThreadFixture, makeThreadProjectionFixture } from "../test-fixtures";
import {
  getAntigravitySendBlockReason,
  resolveComposerProviderSelection,
  resolveWorktreeSetupProgress,
  peekRememberedThreadTimeline,
  rememberReadyThreadTimeline,
  resetHeldThreadTimeline,
  resolveThreadSwitchTimeline,
  threadKeysShareEnvironment,
  timelineHasEphemeralPreviewUrls,
  createLocalDispatchSnapshot,
  deriveCommittedServerUserMessageIds,
  deriveComposerSendState,
  deriveLockedProvider,
  hasServerAcknowledgedLocalDispatch,
  resolveDraftPromotionNavigationTarget,
  shouldShowComposerIntentBanner,
  waitForRevertedMessage,
  // FORK: offline outbox, Escape/Stop ladder and revert-restore helpers.
  canQueueOfflineTurn,
  shouldAbortSendBeforeOfflineQueue,
  isChatSurfaceFocused,
  nextEscapeAction,
  nextStopAction,
  STOP_ESCALATION_MIN_MS,
  STOP_ESCALATION_WINDOW_MS,
  resolvePendingRevertRestore,
} from "./ChatView.logic";

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const now = "2026-03-29T00:00:00.000Z";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return makeThreadFixture({
    id: threadId,
    environmentId,
    projectId,
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    runtime: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    latestRun: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  });
}

const completedTurn = {
  runId: RunId.make("turn-1"),
  status: "completed" as const,
  requestedAt: now,
  startedAt: "2026-03-29T00:00:01.000Z",
  completedAt: "2026-03-29T00:00:10.000Z",
  assistantMessageId: null,
};

const readySession = {
  status: "completed" as const,
  providerName: "codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  activeRunId: null,
  lastError: null,
  updatedAt: "2026-03-29T00:00:10.000Z",
};

describe("resolveDraftPromotionNavigationTarget", () => {
  const serverThreadRef = { environmentId, threadId };
  const preparingRun = {
    ...completedTurn,
    status: "preparing" as const,
    startedAt: null,
    completedAt: null,
  };

  it("stays on the draft until the server owns the send", () => {
    expect(
      resolveDraftPromotionNavigationTarget({
        serverThreadRef,
        serverThread: makeThread({ latestRun: preparingRun }),
        backgroundSubmissionPending: false,
      }),
    ).toBeNull();
    expect(
      resolveDraftPromotionNavigationTarget({
        serverThreadRef,
        serverThread: makeThread(),
        backgroundSubmissionPending: false,
      }),
    ).toBeNull();
  });

  it("promotes a persisted send while its worktree is still preparing", () => {
    const serverThread = makeThread({ latestRun: preparingRun, latestUserMessageAt: now });
    expect(
      resolveDraftPromotionNavigationTarget({
        serverThreadRef,
        serverThread,
        backgroundSubmissionPending: false,
      }),
    ).toBe(serverThreadRef);
    expect(
      resolveDraftPromotionNavigationTarget({
        serverThreadRef,
        serverThread,
        backgroundSubmissionPending: true,
      }),
    ).toBeNull();
  });
});

describe("deriveComposerSendState", () => {
  it("keeps text sendable while excluding expired terminal pills", () => {
    const state = deriveComposerSendState({
      prompt: `yoo [Terminal 1](t3-context://v1/terminal/ctx-expired) waddup`,
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId,
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: now,
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("yoo  waddup");
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(true);
  });
});

describe("shouldShowComposerIntentBanner", () => {
  const base = {
    hasCondition: true,
    isDismissed: false,
    composerHasContent: false,
    wasShownForCurrentCondition: false,
  };

  it("stays hidden during passive browsing (even though the composer autofocuses)", () => {
    expect(shouldShowComposerIntentBanner(base)).toBe(false);
  });

  it("shows once the composer has draft content", () => {
    expect(shouldShowComposerIntentBanner({ ...base, composerHasContent: true })).toBe(true);
  });

  it("stays mounted after the draft clears once shown for the current condition", () => {
    expect(shouldShowComposerIntentBanner({ ...base, wasShownForCurrentCondition: true })).toBe(
      true,
    );
  });

  it("never shows when dismissed or without the condition", () => {
    expect(
      shouldShowComposerIntentBanner({ ...base, composerHasContent: true, isDismissed: true }),
    ).toBe(false);
    expect(
      shouldShowComposerIntentBanner({ ...base, composerHasContent: true, hasCondition: false }),
    ).toBe(false);
  });
});

describe("hasServerAcknowledgedLocalDispatch", () => {
  it("acknowledges a settled newer background turn", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestRun: completedTurn, runtime: readySession }),
      { submissionIntent: "background" },
    );
    const newerTurn = {
      ...completedTurn,
      runId: RunId.make("turn-2"),
      requestedAt: "2026-03-29T00:01:00.000Z",
      startedAt: "2026-03-29T00:01:01.000Z",
      completedAt: "2026-03-29T00:01:30.000Z",
    };

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestRun: newerTurn,
        runtime: { ...readySession, updatedAt: newerTurn.completedAt },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("holds a first send while the thread shell still reports a preparing run", () => {
    const localDispatch = createLocalDispatchSnapshot(makeThread());
    const preparingRun = {
      ...completedTurn,
      status: "preparing" as const,
      startedAt: null,
      completedAt: null,
    };

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "disconnected",
        latestRun: preparingRun,
        runtime: { ...readySession, status: "preparing", activeRunId: preparingRun.runId },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });

  it("waits for the matching running turn before acknowledging", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestRun: completedTurn, runtime: readySession }),
    );
    const runningTurn = {
      ...completedTurn,
      runId: RunId.make("turn-2"),
      status: "running" as const,
      requestedAt: "2026-03-29T00:01:00.000Z",
      startedAt: "2026-03-29T00:01:01.000Z",
      completedAt: null,
    };

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestRun: runningTurn,
        runtime: {
          ...readySession,
          status: "running",
          activeRunId: RunId.make("turn-other"),
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestRun: runningTurn,
        runtime: {
          ...readySession,
          status: "running",
          activeRunId: runningTurn.runId,
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("acknowledges a steering message projected onto the current running run", () => {
    const runningRun = {
      ...completedTurn,
      status: "running" as const,
      completedAt: null,
    };
    const runningRuntime = {
      ...readySession,
      status: "running" as const,
      activeRunId: runningRun.runId,
    };
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestRun: runningRun, runtime: runningRuntime }),
      { latestUserMessageId: MessageId.make("message-before-steer") },
    );

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestRun: runningRun,
        latestUserMessageId: MessageId.make("message-steer"),
        runtime: runningRuntime,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });
});

describe("deriveCommittedServerUserMessageIds", () => {
  it("tracks only committed user turn items, not assistant rows or projection-only messages", () => {
    const turnStartId = MessageId.make("message-turn-start");
    const steerId = MessageId.make("message-steer");
    const assistantId = MessageId.make("message-assistant");
    const committedAt = DateTime.makeUnsafe("2026-06-26T17:50:15.180Z");
    const runId = RunId.make("run:thread:thread-1:ordinal:1");
    const visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem> = [
      {
        position: 0,
        visibility: "local",
        sourceThreadId: threadId,
        sourceItemId: TurnItemId.make("turn-item:message-turn-start"),
        item: {
          id: TurnItemId.make("turn-item:message-turn-start"),
          threadId,
          runId,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: null,
          startedAt: committedAt,
          completedAt: committedAt,
          updatedAt: committedAt,
          createdBy: "user",
          creationSource: "web",
          type: "user_message",
          messageId: turnStartId,
          inputIntent: "turn_start",
          text: "start",
          attachments: [],
        },
      },
      {
        position: 1,
        visibility: "local",
        sourceThreadId: threadId,
        sourceItemId: TurnItemId.make("turn-item:message-assistant"),
        item: {
          id: TurnItemId.make("turn-item:message-assistant"),
          threadId,
          runId,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 2,
          status: "completed",
          title: null,
          startedAt: committedAt,
          completedAt: committedAt,
          updatedAt: committedAt,
          type: "assistant_message",
          messageId: assistantId,
          text: "working",
          streaming: false,
        },
      },
      {
        position: 2,
        visibility: "local",
        sourceThreadId: threadId,
        sourceItemId: TurnItemId.make("turn-item:message-steer"),
        item: {
          id: TurnItemId.make("turn-item:message-steer"),
          threadId,
          runId,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 3,
          status: "completed",
          title: null,
          startedAt: committedAt,
          completedAt: committedAt,
          updatedAt: committedAt,
          createdBy: "user",
          creationSource: "web",
          type: "user_message",
          messageId: steerId,
          inputIntent: "steer",
          text: "continue",
          attachments: [],
        },
      },
    ];

    expect(deriveCommittedServerUserMessageIds(visibleTurnItems)).toEqual(
      new Set([turnStartId, steerId]),
    );
  });
});

describe("resolveThreadSwitchTimeline", () => {
  afterEach(() => {
    resetHeldThreadTimeline();
  });

  const held = { threadKey: "env-1:thread-a", entries: ["a1", "a2"] };

  it("paints a remembered destination instead of the last-viewed thread", () => {
    rememberReadyThreadTimeline(held);
    rememberReadyThreadTimeline({ threadKey: "env-1:thread-b", entries: ["b1", "b2"] });
    expect(peekRememberedThreadTimeline<string[]>("env-1:thread-a")).toEqual(["a1", "a2"]);
    expect(
      resolveThreadSwitchTimeline({
        loading: true,
        activeThreadKey: "env-1:thread-a",
        nextEntries: [],
      }),
    ).toEqual({ entries: ["a1", "a2"], displayThreadKey: "env-1:thread-a" });
  });

  it("does not hold another environment's timeline across a jump", () => {
    expect(threadKeysShareEnvironment("env-1:thread-a", "env-2:thread-b")).toBe(false);
    expect(
      resolveThreadSwitchTimeline({
        loading: true,
        activeThreadKey: "env-2:thread-b",
        nextEntries: [],
        lastReady: held,
      }),
    ).toEqual({ entries: [], displayThreadKey: "env-2:thread-b" });
  });

  it("does not remember a timeline that still has handoff blob previews", () => {
    expect(
      timelineHasEphemeralPreviewUrls([
        {
          kind: "message",
          message: {
            id: MessageId.make("preview-message"),
            role: "user",
            text: "Preview",
            runId: null,
            streaming: false,
            createdAt: "2026-09-10T12:00:00.000Z",
            updatedAt: "2026-09-10T12:00:00.000Z",
            attachments: [
              {
                type: "image",
                id: "preview",
                name: "preview.png",
                mimeType: "image/png",
                sizeBytes: 1,
                previewUrl: "blob:handoff",
              },
            ],
          },
        },
      ]),
    ).toBe(true);
    expect(
      timelineHasEphemeralPreviewUrls([
        {
          kind: "message",
          message: {
            id: MessageId.make("preview-message"),
            role: "user",
            text: "Preview",
            runId: null,
            streaming: false,
            createdAt: "2026-09-10T12:00:00.000Z",
            updatedAt: "2026-09-10T12:00:00.000Z",
            attachments: [
              {
                type: "image",
                id: "preview",
                name: "preview.png",
                mimeType: "image/png",
                sizeBytes: 1,
                previewUrl: "https://cdn.example/a.png",
              },
            ],
          },
        },
      ]),
    ).toBe(false);
  });
});

describe("resolveComposerProviderSelection", () => {
  const catalogModels: ServerProvider["models"] = [
    { slug: "gemini-pro", name: "Gemini Pro", isCustom: false, capabilities: null },
  ];

  function entry(driver: string, instanceId = driver, overrides: Partial<ServerProvider> = {}) {
    return deriveProviderInstanceEntries([
      {
        driver: ProviderDriverKind.make(driver),
        instanceId: ProviderInstanceId.make(instanceId),
        enabled: true,
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
        version: null,
        checkedAt: now,
        models: [],
        slashCommands: [],
        skills: [],
        ...overrides,
      },
    ])[0]!;
  }

  function importedThread(instanceId: ProviderInstanceId) {
    return makeThread({
      modelSelection: { instanceId, model: "default" },
      itemCount: 1,
    });
  }

  it.each([
    ["claudeAgent", "claude_work"],
    ["codex", "codex_work"],
    ["ollama", "local_models"],
  ])("keeps imported %s history selectable through its custom instance", (driver, instanceId) => {
    const importedEntry = entry(driver, instanceId);
    const entries = [entry(driver === "codex" ? "claudeAgent" : "codex"), importedEntry];
    const thread = importedThread(importedEntry.instanceId);
    const lockedProvider = deriveLockedProvider({
      thread,
      selectedProvider: entries[0]!.instanceId,
      threadProvider: thread.modelSelection.instanceId,
      providers: entries.map((entry) => entry.snapshot),
    });

    expect(thread.runtime).toBeNull();
    expect(lockedProvider).toBe(driver);
    expect(
      resolveComposerProviderSelection({
        entries,
        candidateInstanceIds: [thread.modelSelection.instanceId],
        lockedProvider,
        lockedInstanceId: thread.modelSelection.instanceId,
      }).selectedProviderEntry?.instanceId,
    ).toBe(importedEntry.instanceId);
  });

  it("keeps the session driver authoritative over instance and draft selections", () => {
    const selected = entry("claudeAgent", "claude_work");
    const sessionEntry = entry("ollama", "local_models");
    const thread = importedThread(selected.instanceId);

    expect(
      deriveLockedProvider({
        thread: {
          ...thread,
          runtime: {
            ...readySession,
            providerName: sessionEntry.driverKind,
            providerInstanceId: sessionEntry.instanceId,
          },
        },
        selectedProvider: selected.instanceId,
        threadProvider: thread.modelSelection.instanceId,
        providers: [selected.snapshot, sessionEntry.snapshot],
      }),
    ).toBe(sessionEntry.driverKind);
  });

  it.each(["missing", "disabled"] as const)(
    "does not move imported history to another driver when its instance is %s",
    (state) => {
      const imported = entry("claudeAgent", "claude_work", { enabled: false });
      const other = entry("codex");
      const entries = state === "missing" ? [other] : [other, imported];
      const thread = importedThread(imported.instanceId);
      const lockedProvider = deriveLockedProvider({
        thread,
        selectedProvider: other.instanceId,
        threadProvider: thread.modelSelection.instanceId,
        providers: entries.map((entry) => entry.snapshot),
      });

      expect(lockedProvider).not.toBeNull();
      expect(
        resolveComposerProviderSelection({
          entries,
          candidateInstanceIds: [other.instanceId, imported.instanceId],
          lockedProvider,
          lockedInstanceId: imported.instanceId,
        }).selectedProviderEntry,
      ).toBeUndefined();
    },
  );

  it("keeps a signed-out selection instead of silently switching providers", () => {
    const signedOutEntry = entry("antigravity", "google_work", {
      status: "error",
      auth: { status: "unauthenticated" },
      models: catalogModels,
    });
    const selection = resolveComposerProviderSelection({
      entries: [entry("codex"), signedOutEntry],
      candidateInstanceIds: [signedOutEntry.instanceId],
      lockedProvider: null,
      lockedInstanceId: null,
    });

    expect(selection.selectedProviderEntry?.instanceId).toBe(signedOutEntry.instanceId);
    expect(
      getAntigravitySendBlockReason(selection.selectedProviderEntry?.snapshot, "gemini-pro"),
    ).toBe("Sign in to Antigravity in provider settings before sending.");
  });

  it("blocks a saved model that a ready catalog no longer lists", () => {
    const provider = entry("antigravity", "google_work", {
      status: "ready",
      models: catalogModels,
    }).snapshot;

    expect(getAntigravitySendBlockReason(provider, "saved-model-not-in-current-catalog")).toBe(
      "That Antigravity model is no longer available. Choose another model.",
    );
    expect(getAntigravitySendBlockReason(provider, "gemini-pro")).toBeNull();
  });

  it("allows a saved native model to retry after a provider error without changing it", () => {
    const provider = entry("antigravity", "google_work", {
      status: "error",
      models: catalogModels,
    }).snapshot;

    expect(
      getAntigravitySendBlockReason(provider, "saved-model-not-in-current-catalog"),
    ).toBeNull();
  });

  it("does not continue an existing Antigravity thread in another profile after deletion", () => {
    const missingInstanceId = ProviderInstanceId.make("google_work");
    const selection = resolveComposerProviderSelection({
      entries: [entry("antigravity")],
      candidateInstanceIds: [missingInstanceId],
      lockedProvider: ProviderDriverKind.make("antigravity"),
      lockedInstanceId: missingInstanceId,
    });

    expect(selection.selectedProviderEntry).toBeUndefined();
    expect(selection.unavailableProviderInstanceId).toBe(missingInstanceId);
  });

  it("keeps the session's continuation group when another instance was selected", () => {
    const sessionEntry = entry("antigravity", "google_work", {
      enabled: false,
      continuation: { groupKey: "work-profile" },
    });
    const anotherEntry = entry("antigravity", "google_personal", {
      continuation: { groupKey: "personal-profile" },
    });
    const selection = resolveComposerProviderSelection({
      entries: [sessionEntry, anotherEntry],
      candidateInstanceIds: [anotherEntry.instanceId, sessionEntry.instanceId],
      lockedProvider: ProviderDriverKind.make("antigravity"),
      lockedInstanceId: sessionEntry.instanceId,
    });

    expect(selection.selectedProviderEntry).toBeUndefined();
  });
});

describe("checkout Git memory", () => {
  it("does not confuse an environment id containing the separator with a path", () => {
    rememberCheckoutIsRepo(EnvironmentId.make("env"), "a:b", false);
    expect(recallCheckoutIsRepo(EnvironmentId.make("env:a"), "b")).toBeUndefined();
  });
});

describe("worktree setup visibility", () => {
  const stage = (
    id: "fetch" | "checkout" | "submodules" | "setup-script" | "agent",
    status: "done" | "running" | "failed" | "pending",
  ) => ({
    id,
    status,
    startedAt: now,
    endedAt: status === "running" || status === "pending" ? null : now,
    percent: null,
    detail: null,
    tail: [],
  });
  const base = {
    threadId,
    phase: "running" as const,
    startedAt: now,
    endedAt: null,
    branch: "feature",
    baseRef: "main",
    worktreePath: null,
    setupScript: null,
    stages: [stage("checkout", "running"), stage("agent", "pending")],
    error: null,
    sequence: 1,
  };
  const settledDone = {
    ...base,
    phase: "done" as const,
    endedAt: now,
    stages: [stage("checkout", "done"), stage("setup-script", "done"), stage("agent", "done")],
  };

  it("uses streamed setup progress immediately without reverting to an older held snapshot", () => {
    const newest = { ...settledDone, sequence: 9 };
    const resolve = (latest: WorktreeSetupSnapshot | null, held: WorktreeSetupSnapshot | null) =>
      resolveWorktreeSetupProgress({
        threadId,
        localPreparing: false,
        runStatus: "running",
        latest,
        held,
      });
    expect(resolve(newest, base)).toEqual({ snapshot: newest, isPreparingWorktree: false });
    expect(resolve(base, newest)).toEqual({ snapshot: newest, isPreparingWorktree: false });
    const other = { ...base, threadId: ThreadId.make("another-thread") };
    expect(resolve(other, other)).toEqual({ snapshot: null, isPreparingWorktree: false });
  });

  it("reads the settled snapshot back from the thread's activities", () => {
    const activities = [
      { kind: "setup-script.started", payload: {} },
      { kind: "worktree-setup", payload: settledDone },
      { kind: "worktree-setup", payload: { not: "a snapshot" } },
    ];
    expect(findRecordedWorktreeSetup(activities, threadId)).toEqual(settledDone);
    expect(findRecordedWorktreeSetup(activities, ThreadId.make("other"))).toBeNull();
  });
});

describe("waitForRevertedMessage", () => {
  const threadRef = { environmentId: EnvironmentId.make("env-1"), threadId: ThreadId.make("t") };
  const messageId = MessageId.make("message-2");
  const requestId = CommandId.make("rollback-1");

  function projectionAtom() {
    const base = makeThreadProjectionFixture();
    const providerThreadId = ProviderThreadId.make("provider-thread");
    const projection = {
      ...base,
      thread: { ...base.thread, activeProviderThreadId: providerThreadId },
      providerThreads: [
        {
          id: providerThreadId,
          driver: "codex",
          providerInstanceId: base.thread.providerInstanceId,
          providerSessionId: ProviderSessionId.make("provider-session"),
          appThreadId: base.thread.id,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: 1,
          lastRunOrdinal: 4,
          handoffIds: [],
          forkedFrom: null,
          createdAt: base.updatedAt,
          updatedAt: base.updatedAt,
        },
      ],
      runs: [1, 2, 3, 4].map((ordinal) => ({
        id: RunId.make(`run-${ordinal}`),
        threadId: base.thread.id,
        ordinal,
        providerInstanceId: base.thread.providerInstanceId,
        modelSelection: base.thread.modelSelection,
        providerThreadId,
        userMessageId: MessageId.make(`message-${ordinal}`),
        rootNodeId: null,
        activeAttemptId: null,
        status: "completed",
        requestedAt: base.updatedAt,
        startedAt: base.updatedAt,
        completedAt: base.updatedAt,
        checkpointId: null,
        contextHandoffId: null,
      })),
      messages: [
        {
          id: messageId,
          threadId: base.thread.id,
          runId: RunId.make("run-2"),
          nodeId: null,
          role: "user",
          text: "second",
          attachments: [],
          streaming: false,
          createdAt: base.updatedAt,
          updatedAt: base.updatedAt,
        },
      ],
    } as unknown as ReturnType<typeof makeThreadProjectionFixture>;
    const state = Atom.make({ data: Option.some(projection) });
    vi.spyOn(environmentThreadDetails, "stateAtom").mockReturnValue(state as never);
    return { state, projection };
  }

  afterEach(() => vi.restoreAllMocks());

  it("rejects with the projected reason when the rollback fails for good", async () => {
    const { state, projection } = projectionAtom();
    const waiting = waitForRevertedMessage(threadRef, 1, requestId, async () => {});
    await Promise.resolve();
    appAtomRegistry.set(state, {
      data: Option.some({
        ...projection,
        thread: {
          ...projection.thread,
          rollbackFailure: { requestId, message: "The provider could not roll back." },
        },
      }),
    });

    await expect(waiting).rejects.toThrow("The provider could not roll back.");
  });

  it.each([
    ["same", "streamed"],
    ["replacement", "streamed"],
    ["replacement", "refetched"],
  ] as const)(
    "waits for the retained rollback suffix when the edited message and run are paged out (%s provider, %s)",
    async (providerIdentity, projectionSource) => {
      vi.useFakeTimers();
      const { state, projection } = projectionAtom();
      const latestRunId = RunId.make("latest-run-9");
      const latestRun = {
        ...projection.runs[3]!,
        id: latestRunId,
        ordinal: 9,
        userMessageId: MessageId.make("latest-message-9"),
        status: "cancelled" as const,
      };
      const bounded = {
        ...projection,
        messages: [],
        providerThreads: projection.providerThreads.map((thread) => ({
          ...thread,
          lastRunOrdinal: 9,
        })),
        runs: [
          {
            ...latestRun,
            id: RunId.make("old-rewound-run-3"),
            userMessageId: MessageId.make("old-rewound-message-3"),
            ordinal: 3,
            status: "rolled_back" as const,
          },
          latestRun,
        ],
      };
      const oldProviderThread = bounded.providerThreads[0]!;
      const completedProviderThread = {
        ...oldProviderThread,
        ...(providerIdentity === "replacement"
          ? { id: ProviderThreadId.make("replacement-provider-thread"), firstRunOrdinal: null }
          : {}),
        lastRunOrdinal: null,
      };
      appAtomRegistry.set(state, { data: Option.some(bounded) });
      let outcome = "pending";
      const waiting = waitForRevertedMessage(threadRef, 0, requestId, async () => {}).then(
        () => {
          outcome = "reverted";
        },
        (error: Error) => {
          outcome = error.message;
        },
      );

      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(outcome).toBe("pending");

        appAtomRegistry.set(state, {
          data: Option.some({
            ...bounded,
            thread: {
              ...bounded.thread,
              activeProviderThreadId:
                projectionSource === "refetched"
                  ? completedProviderThread.id
                  : oldProviderThread.id,
            },
            providerThreads:
              providerIdentity === "replacement"
                ? [oldProviderThread, completedProviderThread]
                : [completedProviderThread],
            runs: bounded.runs.map((run) =>
              run.id === latestRunId ? { ...run, status: "rolled_back" as const } : run,
            ),
          }),
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(outcome).toBe("reverted");
        await waiting;
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    },
  );

  it("waits for the requested target when another client finishes a shallower rewind", async () => {
    vi.useFakeTimers();
    const { state, projection } = projectionAtom();
    let outcome = "pending";
    const waiting = waitForRevertedMessage(threadRef, 1, requestId, async () => {}).then(
      () => {
        outcome = "reverted";
      },
      (error: Error) => {
        outcome = error.message;
      },
    );

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toBe("pending");

      // Our command is accepted while the earlier target-3 effect is still running.
      const shallowerRewind = {
        ...projection,
        thread: { ...projection.thread, rollbackRequestId: requestId, rollbackFailure: null },
        providerThreads: projection.providerThreads.map((thread) => ({
          ...thread,
          lastRunOrdinal: 3,
        })),
        runs: projection.runs.map((run) =>
          run.ordinal > 3 ? { ...run, status: "rolled_back" as const } : run,
        ),
      };
      appAtomRegistry.set(state, { data: Option.some(shallowerRewind) });
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toBe("pending");

      appAtomRegistry.set(state, {
        data: Option.some({
          ...shallowerRewind,
          providerThreads: shallowerRewind.providerThreads.map((thread) => ({
            ...thread,
            lastRunOrdinal: 1,
          })),
          runs: shallowerRewind.runs.map((run) =>
            run.ordinal > 1 ? { ...run, status: "rolled_back" as const } : run,
          ),
        }),
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toBe("reverted");
      await waiting;
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("rejects a stale edit already rewound by another client during attachment preparation", async () => {
    vi.useFakeTimers();
    const { state, projection } = projectionAtom();
    appAtomRegistry.set(state, {
      data: Option.some({
        ...projection,
        thread: { ...projection.thread, rollbackRequestId: CommandId.make("other-client-rewind") },
        messages: [],
        providerThreads: projection.providerThreads.map((thread) => ({
          ...thread,
          lastRunOrdinal: 1,
        })),
        runs: projection.runs.map((run) =>
          run.ordinal > 1 ? { ...run, status: "rolled_back" as const } : run,
        ),
      }),
    });
    const revert = vi.fn(async () => {});
    let outcome = "pending";
    const waiting = waitForRevertedMessage(threadRef, 1, requestId, revert).then(
      () => {
        outcome = "reverted";
      },
      () => {
        outcome = "rejected";
      },
    );

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toBe("rejected");
      expect(revert).not.toHaveBeenCalled();
      await waiting;
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

describe("canQueueOfflineTurn", () => {
  const queueable = {
    hasText: true,
    isServerThread: true,
    isFirstMessage: false,
    attachmentCount: 0,
    contextCount: 0,
    needsWorktree: false,
    hasPendingProgress: false,
    modesMatchThread: true,
  };

  it("queues a plain-text follow-up on an existing server thread", () => {
    expect(canQueueOfflineTurn(queueable)).toBe(true);
  });

  it("refuses an empty message", () => {
    expect(canQueueOfflineTurn({ ...queueable, hasText: false })).toBe(false);
  });

  it("refuses a local draft thread the server has never seen", () => {
    expect(canQueueOfflineTurn({ ...queueable, isServerThread: false })).toBe(false);
  });

  it("refuses the first message, which also derives the thread title", () => {
    expect(canQueueOfflineTurn({ ...queueable, isFirstMessage: true })).toBe(false);
  });

  it("refuses attachments and contexts, which need an upload round-trip", () => {
    expect(canQueueOfflineTurn({ ...queueable, attachmentCount: 1 })).toBe(false);
    expect(canQueueOfflineTurn({ ...queueable, contextCount: 1 })).toBe(false);
  });

  it("refuses a send that must first prepare a worktree", () => {
    expect(canQueueOfflineTurn({ ...queueable, needsWorktree: true })).toBe(false);
  });

  it("refuses while an approval or user-input prompt is pending", () => {
    expect(canQueueOfflineTurn({ ...queueable, hasPendingProgress: true })).toBe(false);
  });

  it("refuses when the composer has a mode change the replay would not apply", () => {
    // The server reads a turn's runtime/interaction mode from the THREAD; a
    // queued replay skips the settings sync, so it would run in the old mode.
    expect(canQueueOfflineTurn({ ...queueable, modesMatchThread: false })).toBe(false);
  });
});

describe("shouldAbortSendBeforeOfflineQueue", () => {
  const sendable = {
    hasActiveThread: true,
    isSendBusy: false,
    isConnecting: false,
    isRevertingCheckpoint: false,
    threadDetailLoading: false,
    settingsHydrated: true,
    sendInFlight: false,
    environmentUnavailable: false,
    hasDirectAnnotation: false,
    feedbackUploadInFlight: false,
  };

  it("does not abort a plain send while the environment is unavailable", () => {
    // The regression this pins: an unavailable environment is the offline
    // outbox's whole reason to exist, and the queue branch sits further down
    // the same function. Aborting here makes the outbox unreachable while
    // every canQueueOfflineTurn test above keeps passing.
    expect(shouldAbortSendBeforeOfflineQueue({ ...sendable, environmentUnavailable: true })).toBe(
      false,
    );
  });

  it("aborts a direct annotation while the environment is unavailable", () => {
    // An annotation carries an image and a preview payload, which
    // canQueueOfflineTurn refuses anyway; it stays on the draft instead.
    expect(
      shouldAbortSendBeforeOfflineQueue({
        ...sendable,
        environmentUnavailable: true,
        hasDirectAnnotation: true,
      }),
    ).toBe(true);
  });

  it("does not abort a direct annotation while the environment is available", () => {
    expect(shouldAbortSendBeforeOfflineQueue({ ...sendable, hasDirectAnnotation: true })).toBe(
      false,
    );
  });

  it("aborts on every non-connectivity reason", () => {
    expect(shouldAbortSendBeforeOfflineQueue(sendable)).toBe(false);
    expect(shouldAbortSendBeforeOfflineQueue({ ...sendable, hasActiveThread: false })).toBe(true);
    expect(shouldAbortSendBeforeOfflineQueue({ ...sendable, isSendBusy: true })).toBe(true);
    expect(shouldAbortSendBeforeOfflineQueue({ ...sendable, isConnecting: true })).toBe(true);
    expect(shouldAbortSendBeforeOfflineQueue({ ...sendable, isRevertingCheckpoint: true })).toBe(
      true,
    );
    expect(shouldAbortSendBeforeOfflineQueue({ ...sendable, threadDetailLoading: true })).toBe(
      true,
    );
    expect(shouldAbortSendBeforeOfflineQueue({ ...sendable, sendInFlight: true })).toBe(true);
    // A Codex feedback upload already running for this thread. Kept in this helper rather than
    // beside the call so every abort reason stays in one tested place.
    expect(shouldAbortSendBeforeOfflineQueue({ ...sendable, feedbackUploadInFlight: true })).toBe(
      true,
    );
  });
});

describe("isChatSurfaceFocused", () => {
  const body = { name: "body" } as unknown as Node;
  const insideComposer = { name: "textarea" } as unknown as Node;
  const insideOverlay = { name: "menu-item" } as unknown as Node;
  const composerRoot = { contains: (node: Node) => node === insideComposer };
  const base = {
    activeElement: insideComposer,
    bodyElement: body,
    composerRoot,
    hasOpenDialog: false,
  };

  it("answers a press typed in the composer", () => {
    expect(isChatSurfaceFocused(base)).toBe(true);
  });

  it("answers a press with focus nowhere, which is where reading the transcript leaves it", () => {
    expect(isChatSurfaceFocused({ ...base, activeElement: body })).toBe(true);
  });

  it("declines a press aimed at an overlay that took focus", () => {
    // A menu, a model picker, a terminal pane: all of them portal or focus
    // outside the composer, and all of them mean Escape by "dismiss this".
    expect(isChatSurfaceFocused({ ...base, activeElement: insideOverlay })).toBe(false);
  });

  it("declines while a dialog is open even if focus has not landed in it", () => {
    // Focus alone would say yes during the open animation, and stopping a turn
    // because a dialog was still arriving is exactly the surprise to avoid.
    expect(isChatSurfaceFocused({ ...base, activeElement: body, hasOpenDialog: true })).toBe(false);
  });

  it("does not treat an unmounted composer as containing the focus", () => {
    expect(
      isChatSurfaceFocused({ ...base, activeElement: insideComposer, composerRoot: null }),
    ).toBe(false);
  });
});

describe("nextEscapeAction", () => {
  const base = {
    isChatSurfaceActive: true,
    alreadyHandled: false,
    isAutoRepeat: false,
    isComposing: false,
    hasRunningTurn: true,
    hasPendingQuestion: false,
    heldMessageCount: 0,
    recallSupported: true,
  } as const;

  it("stops the running turn when nothing is held", () => {
    expect(nextEscapeAction(base)).toBe("stop");
  });

  it("recalls before it stops", () => {
    // The reversible rung first: a message the agent has not seen costs nothing
    // to take back, and killing the turn to undo a send is the bigger hammer.
    expect(nextEscapeAction({ ...base, heldMessageCount: 1 })).toBe("recall");
  });

  it("stops instead of recalling when the provider cannot take a message back", () => {
    // Otherwise Escape would appear to do nothing on those providers, because
    // the recall it chose is one the adapter has no way to perform.
    expect(nextEscapeAction({ ...base, heldMessageCount: 2, recallSupported: false })).toBe("stop");
  });

  it("does nothing on an idle thread with nothing held", () => {
    expect(nextEscapeAction({ ...base, hasRunningTurn: false })).toBe("none");
  });

  it("still recalls on an idle thread that is holding a message", () => {
    // A turn can finish between the send and the press. The message is still
    // waiting to be dispatched, so it is still recallable.
    expect(nextEscapeAction({ ...base, hasRunningTurn: false, heldMessageCount: 1 })).toBe(
      "recall",
    );
  });

  it("yields to an overlay that owns the press", () => {
    // Escape's first job everywhere else is "dismiss this". Stopping a turn
    // while the user is closing a dialog would be a destructive surprise.
    expect(nextEscapeAction({ ...base, isChatSurfaceActive: false })).toBe("none");
  });

  it("yields to a handler that already claimed the press", () => {
    expect(nextEscapeAction({ ...base, alreadyHandled: true })).toBe("none");
  });

  it("ignores auto-repeat, so holding Escape cannot walk the ladder", () => {
    // This is the keyboard's version of the reflexive double-click the stop
    // floor exists to refuse: a held key would otherwise deliver dozens of
    // presses and reach the force-stop without a second decision.
    expect(nextEscapeAction({ ...base, isAutoRepeat: true })).toBe("none");
  });

  it("ignores a press that is cancelling an IME composition", () => {
    expect(nextEscapeAction({ ...base, isComposing: true })).toBe("none");
  });

  it("stays out of the way while the agent is waiting on a question", () => {
    // The composer shows Cancel there, not Stop, and Cancel is deliberately off
    // the escalation ladder. Escape must not arm a rung the UI is not offering.
    expect(nextEscapeAction({ ...base, hasPendingQuestion: true })).toBe("none");
  });

  it("does not recall while a question is pending either", () => {
    // One rule rather than two: while the agent is asking, Escape belongs to
    // the question, not to the queue behind it.
    expect(nextEscapeAction({ ...base, hasPendingQuestion: true, heldMessageCount: 1 })).toBe(
      "none",
    );
  });
});

describe("nextStopAction", () => {
  const ARMED_AT = 1_000_000;

  it("sends a cooperative interrupt on the first press", () => {
    expect(nextStopAction({ threadId: "t1", armed: null, nowMs: ARMED_AT })).toBe("interrupt");
  });

  it("force-stops on a deliberate second press inside the band", () => {
    expect(
      nextStopAction({
        threadId: "t1",
        armed: { threadId: "t1", atMs: ARMED_AT },
        nowMs: ARMED_AT + 2_000,
      }),
    ).toBe("hardStop");
  });

  it("does not carry escalation across threads", () => {
    // Escalation is a judgement about ONE wedged turn. Pressing Stop on thread
    // A must not make the first press on thread B destructive.
    expect(
      nextStopAction({
        threadId: "t2",
        armed: { threadId: "t1", atMs: ARMED_AT },
        nowMs: ARMED_AT + 2_000,
      }),
    ).toBe("interrupt");
  });

  it("ignores a reflexive double-click rather than force-stopping on it", () => {
    // The floor's whole purpose. At this range the user is hammering a button
    // that appeared to do nothing; the armed styling has not even been on
    // screen long enough to read.
    expect(
      nextStopAction({
        threadId: "t1",
        armed: { threadId: "t1", atMs: ARMED_AT },
        nowMs: ARMED_AT + 120,
      }),
    ).toBe("ignore");
  });

  it("expires the arming, so a much later press is cooperative again", () => {
    // Without the ceiling, a Stop pressed once and left alone makes an
    // unrelated press ten minutes later destructive.
    expect(
      nextStopAction({
        threadId: "t1",
        armed: { threadId: "t1", atMs: ARMED_AT },
        nowMs: ARMED_AT + 600_000,
      }),
    ).toBe("interrupt");
  });

  it("holds the band exactly at both edges", () => {
    // Pin the boundaries: an off-by-one resurrects the reflex case or clips the deliberate one. The
    // constants are pinned by value first, since every assertion is CONSTANT +/- n and would stay
    // green if the window widened past the decay `nextStopAction` relies on.
    expect(STOP_ESCALATION_MIN_MS).toBe(500);
    expect(STOP_ESCALATION_WINDOW_MS).toBe(10_000);

    const at = (offset: number) =>
      nextStopAction({
        threadId: "t1",
        armed: { threadId: "t1", atMs: ARMED_AT },
        nowMs: ARMED_AT + offset,
      });
    expect(at(STOP_ESCALATION_MIN_MS - 1)).toBe("ignore");
    expect(at(STOP_ESCALATION_MIN_MS)).toBe("hardStop");
    expect(at(STOP_ESCALATION_WINDOW_MS)).toBe("hardStop");
    expect(at(STOP_ESCALATION_WINDOW_MS + 1)).toBe("interrupt");
  });

  it("falls back to the cooperative press when the clock jumps backwards", () => {
    // Fail safe, but still USABLE: treating a negative elapsed as "ignore" would
    // wedge Stop entirely until the clock caught up.
    expect(
      nextStopAction({
        threadId: "t1",
        armed: { threadId: "t1", atMs: ARMED_AT },
        nowMs: ARMED_AT - 60_000,
      }),
    ).toBe("interrupt");
  });
});

describe("resolvePendingRevertRestore", () => {
  const pending = {
    messageId: MessageId.make("msg-1"),
    text: "take this back",
    attachmentCount: 0,
    threadKey: "thread-1",
    targetTurnCount: 1,
    requestedAt: "2026-09-05T10:00:00.000Z",
  };
  const base = {
    pending,
    activeThreadKey: "thread-1",
    hasMessage: false,
    maxCheckpointTurnCount: 1,
    isThreadLoading: false,
    hasRevertFailure: false,
  };

  it("waits while the message is still in the thread", () => {
    expect(
      resolvePendingRevertRestore({ ...base, hasMessage: true, maxCheckpointTurnCount: 2 }),
    ).toBe("wait");
  });

  it("waits when the message is gone but a discarded checkpoint remains", () => {
    // A re-window or a reconnect empties the message list without a revert landing.
    expect(resolvePendingRevertRestore({ ...base, maxCheckpointTurnCount: 2 })).toBe("wait");
  });

  it("restores once the message is gone and the checkpoints match the target", () => {
    expect(resolvePendingRevertRestore(base)).toBe("restore");
  });

  it("restores when reverting to turn 0 empties the thread", () => {
    expect(
      resolvePendingRevertRestore({
        ...base,
        pending: { ...pending, targetTurnCount: 0 },
        maxCheckpointTurnCount: null,
      }),
    ).toBe("restore");
  });

  it("waits while the thread detail is loading", () => {
    // The loading placeholder spreads the shell, so it keeps the thread key while reporting no
    // messages and no checkpoints - the same shape a completed revert to turn 0 produces, which
    // is the one target the checkpoint guard below cannot separate it from.
    expect(
      resolvePendingRevertRestore({
        ...base,
        pending: { ...pending, targetTurnCount: 0 },
        maxCheckpointTurnCount: null,
        isThreadLoading: true,
      }),
    ).toBe("wait");
  });

  it("waits when no checkpoint is loaded but the target is not turn 0", () => {
    expect(resolvePendingRevertRestore({ ...base, maxCheckpointTurnCount: null })).toBe("wait");
  });

  it("waits rather than discarding when no thread is active", () => {
    // A teardown frame is transient; discarding there would lose a restore about to land.
    expect(resolvePendingRevertRestore({ ...base, activeThreadKey: null })).toBe("wait");
  });

  it("discards on a thread switch", () => {
    expect(resolvePendingRevertRestore({ ...base, activeThreadKey: "thread-2" })).toBe("discard");
  });

  it("discards when this revert's target recorded a failure", () => {
    expect(
      resolvePendingRevertRestore({
        ...base,
        hasMessage: true,
        maxCheckpointTurnCount: 2,
        hasRevertFailure: true,
      }),
    ).toBe("discard");
  });

  it("is idle with nothing pending", () => {
    expect(
      resolvePendingRevertRestore({ ...base, pending: null, maxCheckpointTurnCount: null }),
    ).toBe("idle");
  });
});

/*
 * `shouldHardStopAfterGrace` was deleted deliberately: it made the arming RIPEN into a hard stop,
 * the opposite of `nextStopAction`'s EXPIRING arming. Timed auto-escalation must be redesigned
 * against the decay band above, not restored from git.
 */

describe("mergeDirectPreviewAnnotation", () => {
  const annotation = (id: string) =>
    ({
      id,
      pageUrl: "http://localhost:5173/",
      pageTitle: null,
      comment: "tighten this",
      elements: [],
      regions: [],
      strokes: [],
      styleChanges: [],
      screenshot: {
        dataUrl: "data:image/png;base64,AAAA",
        width: 10,
        height: 10,
        cropRect: { x: 0, y: 0, width: 10, height: 10 },
      },
      createdAt: "2026-10-16T00:00:00.000Z",
    }) as const;
  const image = (id: string) =>
    ({ id, type: "image", name: `${id}.png`, mimeType: "image/png", sizeBytes: 1 }) as never;

  it("drops the screenshot claim when the attachment cap is full", () => {
    const result = mergeDirectPreviewAnnotation({
      images: [],
      fileCount: PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
      previewAnnotations: [],
      direct: { annotation: annotation("a"), image: image("crop") },
    });
    expect(result.images).toEqual([]);
    expect(result.previewAnnotations[0]?.screenshot).toBeNull();
  });
});

describe("snapshotComposerSend", () => {
  const expired = {
    id: "ctx-expired",
    threadId,
    terminalId: "default",
    terminalLabel: "Terminal 1",
    lineStart: 4,
    lineEnd: 4,
    text: "",
    createdAt: now,
  };
  const live = { ...expired, id: "ctx-live", text: "pnpm test", lineStart: 9, lineEnd: 9 };

  it("drops expired terminal contexts from the contexts and from the prompt", () => {
    const snapshot = snapshotComposerSend({
      prompt: ensureInlineContextReferences("run", [
        terminalContextReference(expired),
        terminalContextReference(live),
      ]),
      images: [],
      files: [],
      terminalContexts: [expired, live],
      sendableTerminalContexts: [live],
      previewAnnotations: [],
      reviewComments: [],
      threadContexts: [],
    });

    expect(snapshot.terminalContexts).toEqual([live]);
    expect(snapshot.messageText).toBe(
      ensureInlineContextReferences("run", [terminalContextReference(live)]).trim(),
    );
  });
});

describe("planComposerTurn", () => {
  const base = {
    messageText: "hello",
    sendQueuesBehindSetup: false,
    isServerThread: false,
    activeMessageCount: 0,
    sendEnvMode: "worktree" as const,
    worktreePath: null,
    activeThreadBranch: "main",
    resumeCompactionTokens: null,
    keepFullHistory: false,
    phase: "ready" as const,
    dispatchMode: "auto" as const,
  };

  it("prepares a worktree from the selected branch on a new thread", () => {
    expect(planComposerTurn(base)).toMatchObject({
      missingWorktreeBaseBranch: false,
      baseBranchForWorktree: "main",
      shouldQueueBehindActiveRun: false,
    });
  });

  it("refuses a new worktree without a base branch", () => {
    expect(planComposerTurn({ ...base, activeThreadBranch: null })).toMatchObject({
      missingWorktreeBaseBranch: true,
      baseBranchForWorktree: null,
    });
  });

  it("queues behind a compaction of a stale session, except for /compact itself", () => {
    const stale = { ...base, resumeCompactionTokens: 120_000 };
    for (const messageText of ["hello", "/compactfoo"]) {
      expect(planComposerTurn({ ...stale, messageText })).toMatchObject({
        compactBeforeSend: true,
        turnDispatchMode: "queue",
        shouldQueueBehindActiveRun: true,
      });
    }
    for (const messageText of ["/COMPACT", "/compact keep the API notes", "/compact\n  tests"]) {
      expect(planComposerTurn({ ...stale, messageText })).toMatchObject({
        compactBeforeSend: false,
        turnDispatchMode: "auto",
        shouldQueueBehindActiveRun: false,
      });
    }
  });

  it("queues behind a running turn only when asked to", () => {
    const running = {
      ...base,
      isServerThread: true,
      activeMessageCount: 3,
      phase: "running" as const,
    };
    expect(planComposerTurn({ ...running, dispatchMode: "queue" }).shouldQueueBehindActiveRun).toBe(
      true,
    );
    expect(planComposerTurn({ ...running, dispatchMode: "steer" })).toMatchObject({
      shouldQueueBehindActiveRun: false,
      baseBranchForWorktree: null,
    });
  });
});

describe("withMessageContext", () => {
  const context = { records: [] } as unknown as NonNullable<
    Parameters<typeof withMessageContext>[0]["context"]
  >;

  it("sends the context inline when the server supports it", () => {
    expect(withMessageContext({ text: "hi", context, supportsInlineMessageContext: true })).toEqual(
      { text: "hi", context },
    );
  });

  it("folds the context into the text for older servers", () => {
    const result = withMessageContext({ text: "hi", context, supportsInlineMessageContext: false });
    expect(result.context).toBeUndefined();
    expect(result.text).toContain("hi");
  });

  it("sends the text alone without context", () => {
    expect(
      withMessageContext({ text: "hi", context: undefined, supportsInlineMessageContext: false }),
    ).toEqual({ text: "hi" });
  });
});

describe("boundAttachmentIds", () => {
  it("prefers the uploaded id and falls back to the local one", () => {
    expect(
      boundAttachmentIds([{ id: "upload-1" }, {}], [{ id: "local-1" }, { id: "local-2" }]),
    ).toEqual(["upload-1", "local-2"]);
  });
});

describe("deriveAvailableRevertTurnCounts", () => {
  const providerThreadId = ProviderThreadId.make("provider-thread");
  const otherProviderThreadId = ProviderThreadId.make("other-provider-thread");

  function projection(input: { readonly providerSessionId: ProviderSessionId | null }) {
    const base = makeThreadProjectionFixture();
    const run = (ordinal: number) => ({
      id: RunId.make(`run-${ordinal}`),
      ordinal,
      activeAttemptId: `attempt-${ordinal}`,
    });
    const turn = (ordinal: number, attempt: number, threadId: ProviderThreadId) => ({
      id: `turn-${attempt}-${ordinal}`,
      runAttemptId: `attempt-${attempt}`,
      ordinal,
      providerThreadId: threadId,
    });
    return {
      ...base,
      thread: { ...base.thread, activeProviderThreadId: providerThreadId },
      providerThreads: [
        {
          id: providerThreadId,
          providerInstanceId: base.thread.modelSelection.instanceId,
          providerSessionId: input.providerSessionId,
        },
      ],
      runs: [run(1), run(2), run(3)],
      attempts: [1, 2, 3].map((ordinal) => ({ id: `attempt-${ordinal}`, providerTurnId: null })),
      // Run 2's latest turn moved to another provider thread, so its checkpoint cannot restore
      // this conversation.
      providerTurns: [
        turn(1, 1, providerThreadId),
        turn(1, 2, providerThreadId),
        turn(2, 2, otherProviderThreadId),
        turn(1, 3, providerThreadId),
      ],
    } as unknown as ReturnType<typeof makeThreadProjectionFixture>;
  }

  it("offers the thread start and runs whose latest turn is on the active provider thread", () => {
    const available = deriveAvailableRevertTurnCounts(
      projection({ providerSessionId: ProviderSessionId.make("session") }),
    );
    expect([...available].toSorted()).toEqual([0, 1, 3]);
  });

  it("offers nothing without a provider session to rewind", () => {
    expect(deriveAvailableRevertTurnCounts(projection({ providerSessionId: null })).size).toBe(0);
    expect(deriveAvailableRevertTurnCounts(null).size).toBe(0);
  });
});

describe("deriveWorkspaceMutationId", () => {
  const item = (id: string, type: string, status: string) =>
    ({
      item: { id: TurnItemId.make(id), type, status },
    }) as unknown as OrchestrationV2ProjectedTurnItem;

  it("keys on the latest finished command or file change and the latest checkpoint", () => {
    expect(
      deriveWorkspaceMutationId(
        [
          item("edit", "file_change", "completed"),
          item("reply", "assistant_message", "completed"),
          item("command", "command_execution", "running"),
        ],
        "2026-01-01T00:00:00.000Z",
      ),
    ).toBe(JSON.stringify(["edit", "2026-01-01T00:00:00.000Z"]));
  });

  it("is null before anything could have touched the workspace", () => {
    expect(deriveWorkspaceMutationId([item("reply", "assistant_message", "completed")], null)).toBe(
      null,
    );
  });
});
