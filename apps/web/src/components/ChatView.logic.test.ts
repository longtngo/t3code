import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { Thread, ThreadShell } from "../types";
import {
  MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
  MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  branchMismatchKey,
  buildExpiredTerminalContextToastCopy,
  buildLoadingThreadFromShell,
  buildThreadTurnInterruptInput,
  canQueueOfflineTurn,
  createLocalDispatchSnapshot,
  deriveComposerSendState,
  dismissBranchMismatchForSession,
  ENVIRONMENT_RECONNECT_WARNING_GRACE_MS,
  getStartedThreadModelChangeBlockReason,
  hasEnvironmentReconnectWarningGraceElapsed,
  hasServerAcknowledgedLocalDispatch,
  isBranchMismatchDismissedForSession,
  reconcileMountedTerminalThreadIds,
  reconcileRetainedMountedThreadIds,
  resolveBackgroundDraftWorkspaceOptions,
  resolveDraftPromotionNavigationTarget,
  resolveThreadMetadataUpdateForNextTurn,
  resolveSendEnvMode,
  resolveDraftHeroState,
  scheduleEnvironmentReconnectWarning,
  shoulderTabReserve,
  startNewThreadForProject,
  shouldAbortSendBeforeOfflineQueue,
  shouldDockDraftHeroForSubmission,
  shouldShowComposerIntentBanner,
  shouldReleaseTimelineAnchorForToolActivity,
  shouldShowPlanFollowUpPrompt,
  shouldWriteThreadErrorToCurrentServerThread,
  isChatSurfaceFocused,
  nextEscapeAction,
  nextStopAction,
  STOP_ESCALATION_MIN_MS,
  STOP_ESCALATION_WINDOW_MS,
} from "./ChatView.logic";

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const now = "2026-03-29T00:00:00.000Z";

describe("shoulderTabReserve", () => {
  it("ignores the top drawer when measuring the shoulder tab band", () => {
    const elementAt = (top: number) => ({ getBoundingClientRect: () => ({ top }) }) as HTMLElement;
    const elements = new Map<string, HTMLElement>([
      ['[data-chat-composer-form="true"]', elementAt(20)],
      [".chat-composer-shoulder-tab", elementAt(100)],
      ['[data-chat-composer-main-surface="true"]', elementAt(128)],
    ]);
    const overlay = {
      querySelector: (selector: string) => elements.get(selector) ?? null,
    } as HTMLElement;

    expect(shoulderTabReserve(overlay)).toBe(28);
    elements.set(".chat-composer-tasks-tab", elementAt(100));
    expect(shoulderTabReserve(overlay)).toBe(0);
  });
});

describe("draft hero submission transition", () => {
  it("does not dock the composer before a background submission", () => {
    expect(
      shouldDockDraftHeroForSubmission({
        isDraftHeroState: true,
        activeThreadKey: "environment-local:thread-1",
        submissionIntent: "background",
      }),
    ).toBe(false);
  });

  it("keeps the composer in the hero layout until navigation after server promotion", () => {
    expect(
      resolveDraftHeroState({
        isLocalDraftThread: false,
        hasTimelineEntries: true,
        isWorking: true,
        draftHeroDockRequested: false,
        backgroundSubmissionPending: true,
      }),
    ).toBe(true);
  });

  it("does not auto-navigate a background submission after server promotion", () => {
    expect(
      resolveDraftPromotionNavigationTarget({
        serverThreadRef: { environmentId, threadId },
        serverThreadStarted: true,
        backgroundSubmissionPending: true,
      }),
    ).toBeNull();
  });
});

describe("shouldReleaseTimelineAnchorForToolActivity", () => {
  const activeTurnId = TurnId.make("active-turn");
  const anchorMessageId = MessageId.make("anchored-message");
  const activeToolEntry = {
    id: "tool-entry",
    kind: "work" as const,
    createdAt: now,
    entry: {
      id: "active-tool",
      createdAt: now,
      turnId: activeTurnId,
      label: "Run command",
      tone: "tool" as const,
      command: "git status",
    },
  };

  it("releases the send anchor for tool activity in the active turn", () => {
    expect(
      shouldReleaseTimelineAnchorForToolActivity({
        anchorMessageId,
        liveFollowEnabled: true,
        runningTurnId: activeTurnId,
        timelineEntries: [activeToolEntry],
      }),
    ).toBe(true);
  });

  it("keeps the anchor while the user reads history", () => {
    expect(
      shouldReleaseTimelineAnchorForToolActivity({
        anchorMessageId,
        liveFollowEnabled: false,
        runningTurnId: activeTurnId,
        timelineEntries: [activeToolEntry],
      }),
    ).toBe(false);
  });

  it("ignores tool activity from earlier turns", () => {
    expect(
      shouldReleaseTimelineAnchorForToolActivity({
        anchorMessageId,
        liveFollowEnabled: true,
        runningTurnId: activeTurnId,
        timelineEntries: [
          {
            ...activeToolEntry,
            entry: {
              ...activeToolEntry.entry,
              turnId: TurnId.make("previous-turn"),
            },
          },
        ],
      }),
    ).toBe(false);
  });

  it("ignores thinking and error rows without tool activity", () => {
    expect(
      shouldReleaseTimelineAnchorForToolActivity({
        anchorMessageId,
        liveFollowEnabled: true,
        runningTurnId: activeTurnId,
        timelineEntries: [
          {
            ...activeToolEntry,
            entry: {
              id: "thinking-entry",
              createdAt: now,
              turnId: activeTurnId,
              label: "Thinking",
              tone: "thinking",
            },
          },
          {
            ...activeToolEntry,
            id: "error-entry",
            entry: {
              id: "error-entry",
              createdAt: now,
              turnId: activeTurnId,
              label: "Provider error",
              tone: "error",
            },
          },
        ],
      }),
    ).toBe(false);
  });

  it("does nothing without an anchor or running turn", () => {
    const input = {
      anchorMessageId,
      liveFollowEnabled: true,
      runningTurnId: activeTurnId,
      timelineEntries: [activeToolEntry],
    };

    expect(shouldReleaseTimelineAnchorForToolActivity({ ...input, anchorMessageId: null })).toBe(
      false,
    );
    expect(shouldReleaseTimelineAnchorForToolActivity({ ...input, runningTurnId: null })).toBe(
      false,
    );
  });
});

describe("environment reconnect warning grace", () => {
  afterEach(() => vi.useRealTimers());

  it("shows a persistent reconnect after the grace period", () => {
    vi.useFakeTimers();
    const showWarning = vi.fn();

    scheduleEnvironmentReconnectWarning(showWarning);
    vi.advanceTimersByTime(ENVIRONMENT_RECONNECT_WARNING_GRACE_MS - 1);
    expect(showWarning).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(showWarning).toHaveBeenCalledOnce();
  });

  it("cancels the warning when the connection recovers during the grace period", () => {
    vi.useFakeTimers();
    const showWarning = vi.fn();

    const cancel = scheduleEnvironmentReconnectWarning(showWarning);
    cancel();
    vi.advanceTimersByTime(ENVIRONMENT_RECONNECT_WARNING_GRACE_MS);

    expect(showWarning).not.toHaveBeenCalled();
  });

  it("does not reuse elapsed grace from another environment", () => {
    const anotherEnvironmentId = EnvironmentId.make("environment-remote");

    expect(hasEnvironmentReconnectWarningGraceElapsed(environmentId, environmentId)).toBe(true);
    expect(hasEnvironmentReconnectWarningGraceElapsed(anotherEnvironmentId, environmentId)).toBe(
      false,
    );
  });
});

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
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
    session: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  };
}

const completedTurn = {
  turnId: TurnId.make("turn-1"),
  state: "completed" as const,
  requestedAt: now,
  startedAt: "2026-03-29T00:00:01.000Z",
  completedAt: "2026-03-29T00:00:10.000Z",
  assistantMessageId: null,
};

const readySession = {
  threadId,
  status: "ready" as const,
  providerName: "codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeMode: "full-access" as const,
  activeTurnId: null,
  lastError: null,
  updatedAt: "2026-03-29T00:00:10.000Z",
};

describe("buildLoadingThreadFromShell", () => {
  it("preserves shell metadata and supplies empty detail collections", () => {
    const shell = {
      environmentId,
      id: threadId,
      projectId,
      title: "Loading thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "main",
      worktreePath: null,
      latestTurn: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      session: null,
      latestUserMessageAt: now,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    } satisfies ThreadShell;

    expect(buildLoadingThreadFromShell(shell)).toMatchObject({
      environmentId,
      id: threadId,
      projectId,
      title: "Loading thread",
      branch: "main",
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
    });
  });
});

describe("resolveThreadMetadataUpdateForNextTurn", () => {
  const modelSelection = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  };

  it("updates a stale local thread branch to the active checkout", () => {
    expect(
      resolveThreadMetadataUpdateForNextTurn({
        currentModelSelection: modelSelection,
        currentBranch: "feature/thread",
        nextBranch: "feature/checkout",
      }),
    ).toEqual({ branch: "feature/checkout", worktreePath: null });
  });

  it("does not write metadata when the model and branch are unchanged", () => {
    expect(
      resolveThreadMetadataUpdateForNextTurn({
        currentModelSelection: modelSelection,
        nextModelSelection: modelSelection,
        currentBranch: "feature/current",
        nextBranch: "feature/current",
      }),
    ).toBeNull();
  });
});

describe("buildThreadTurnInterruptInput", () => {
  it("targets the session's active running turn", () => {
    const activeTurnId = TurnId.make("turn-running");

    expect(
      buildThreadTurnInterruptInput(
        makeThread({
          session: {
            ...readySession,
            status: "running",
            activeTurnId,
          },
        }),
      ),
    ).toEqual({ threadId, turnId: activeTurnId });
  });

  it("omits a turn id when the session is not running", () => {
    expect(buildThreadTurnInterruptInput(makeThread({ session: readySession }))).toEqual({
      threadId,
    });
  });
});

describe("deriveComposerSendState", () => {
  it("treats expired terminal pills as non-sendable content", () => {
    const state = deriveComposerSendState({
      prompt: "\uFFFC",
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

    expect(state.trimmedPrompt).toBe("");
    expect(state.sendableTerminalContexts).toEqual([]);
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(false);
  });

  it("keeps text sendable while excluding expired terminal pills", () => {
    const state = deriveComposerSendState({
      prompt: `yoo \uFFFC waddup`,
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

  it("treats element contexts as sendable content (no text, no images, no terminals)", () => {
    const state = deriveComposerSendState({
      prompt: "",
      imageCount: 0,
      terminalContexts: [],
      elementContextCount: 1,
    });

    expect(state.trimmedPrompt).toBe("");
    expect(state.expiredTerminalContextCount).toBe(0);
    expect(state.hasSendableContent).toBe(true);
  });

  it("does NOT treat zero element contexts as sendable", () => {
    expect(
      deriveComposerSendState({
        prompt: "",
        imageCount: 0,
        terminalContexts: [],
        elementContextCount: 0,
      }).hasSendableContent,
    ).toBe(false);
  });
});

describe("buildExpiredTerminalContextToastCopy", () => {
  it("formats empty and omission guidance", () => {
    expect(buildExpiredTerminalContextToastCopy(1, "empty")).toEqual({
      title: "Expired terminal context won't be sent",
      description: "Remove it or re-add it to include terminal output.",
    });
    expect(buildExpiredTerminalContextToastCopy(2, "omitted")).toEqual({
      title: "Expired terminal contexts omitted from message",
      description: "Re-add it if you want that terminal output included.",
    });
  });
});

describe("getStartedThreadModelChangeBlockReason", () => {
  const providers = [
    {
      instanceId: ProviderInstanceId.make("codex"),
    },
    {
      instanceId: ProviderInstanceId.make("grok"),
      requiresNewThreadForModelChange: true,
    },
  ];

  it("allows model changes before a provider session has started", () => {
    expect(
      getStartedThreadModelChangeBlockReason({
        providers,
        hasStartedSession: false,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-other",
        },
      }),
    ).toBeNull();
  });

  it("allows unchanged model selections for restricted providers", () => {
    expect(
      getStartedThreadModelChangeBlockReason({
        providers,
        hasStartedSession: true,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
      }),
    ).toBeNull();
  });

  it("blocks started-session model changes when either provider requires a new thread", () => {
    expect(
      getStartedThreadModelChangeBlockReason({
        providers,
        hasStartedSession: true,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
      }),
    ).toEqual({
      title: "Start a new chat to change models",
      description:
        "This provider does not allow switching models after a conversation has started.",
    });
  });
});

describe("resolveSendEnvMode", () => {
  it("keeps worktree mode only for git repositories", () => {
    expect(resolveSendEnvMode({ requestedEnvMode: "worktree", isGitRepo: true })).toBe("worktree");
    expect(resolveSendEnvMode({ requestedEnvMode: "worktree", isGitRepo: false })).toBe("local");
  });
});

describe("resolveBackgroundDraftWorkspaceOptions", () => {
  it("keeps New worktree selected without reusing the launched worktree", () => {
    expect(
      resolveBackgroundDraftWorkspaceOptions({
        envMode: "worktree",
        branch: "main",
        startFromOrigin: true,
      }),
    ).toEqual({
      envMode: "worktree",
      branch: "main",
      worktreePath: null,
      startFromOrigin: true,
    });
  });
});

describe("branchMismatchKey", () => {
  it("builds a key from thread id and both branches", () => {
    expect(branchMismatchKey("thread-1", { threadBranch: "feat/a", currentBranch: "feat/b" })).toBe(
      "thread-1:feat/a:feat/b",
    );
  });

  it("returns null without a thread or mismatch", () => {
    expect(branchMismatchKey(null, { threadBranch: "a", currentBranch: "b" })).toBeNull();
    expect(branchMismatchKey("thread-1", null)).toBeNull();
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

describe("shouldShowPlanFollowUpPrompt", () => {
  const base = {
    pendingUserInputCount: 0,
    interactionMode: "plan" as const,
    latestTurnSettled: true,
    hasActionableProposedPlan: true,
    hasComposerAttachments: false,
  };

  it("shows plan actions for a settled actionable plan without attachments", () => {
    expect(shouldShowPlanFollowUpPrompt(base)).toBe(true);
  });

  it("hides plan actions while the composer has staged attachments", () => {
    expect(shouldShowPlanFollowUpPrompt({ ...base, hasComposerAttachments: true })).toBe(false);
  });

  it("preserves the existing plan follow-up gates", () => {
    expect(shouldShowPlanFollowUpPrompt({ ...base, pendingUserInputCount: 1 })).toBe(false);
    expect(shouldShowPlanFollowUpPrompt({ ...base, interactionMode: "default" })).toBe(false);
    expect(shouldShowPlanFollowUpPrompt({ ...base, latestTurnSettled: false })).toBe(false);
    expect(shouldShowPlanFollowUpPrompt({ ...base, hasActionableProposedPlan: false })).toBe(false);
  });
});

describe("session branch mismatch dismissal", () => {
  it("tracks dismissed keys and treats other keys as active", () => {
    expect(isBranchMismatchDismissedForSession("t1:a:b")).toBe(false);
    dismissBranchMismatchForSession("t1:a:b");
    expect(isBranchMismatchDismissedForSession("t1:a:b")).toBe(true);
    expect(isBranchMismatchDismissedForSession("t1:a:c")).toBe(false);
    expect(isBranchMismatchDismissedForSession(null)).toBe(false);
  });
});

describe("reconcileMountedTerminalThreadIds", () => {
  it("keeps open threads and makes the active thread most recent", () => {
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: ["thread-a", "thread-b", "thread-c"],
        openThreadIds: ["thread-a", "thread-b", "thread-c"],
        activeThreadId: "thread-a",
        activeThreadTerminalOpen: true,
        maxHiddenThreadCount: 2,
      }),
    ).toEqual(["thread-b", "thread-c", "thread-a"]);
  });

  it("drops closed threads and enforces the hidden mounted cap", () => {
    const ids = Array.from(
      { length: MAX_HIDDEN_MOUNTED_TERMINAL_THREADS + 2 },
      (_, index) => `thread-${index}`,
    );
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: ids,
        openThreadIds: ids.slice(1),
        activeThreadId: null,
        activeThreadTerminalOpen: false,
      }),
    ).toEqual(ids.slice(-MAX_HIDDEN_MOUNTED_TERMINAL_THREADS));
  });
});

describe("reconcileRetainedMountedThreadIds", () => {
  it("retains hidden open threads and adds the active open thread", () => {
    expect(
      reconcileRetainedMountedThreadIds({
        currentThreadIds: [ThreadId.make("thread-hidden")],
        openThreadIds: [ThreadId.make("thread-hidden")],
        activeThreadId: ThreadId.make("thread-active"),
        activeThreadOpen: true,
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
      }),
    ).toEqual([ThreadId.make("thread-hidden"), ThreadId.make("thread-active")]);
  });

  it("can retain the active thread as hidden when it is inactive", () => {
    expect(
      reconcileRetainedMountedThreadIds({
        currentThreadIds: [ThreadId.make("thread-active")],
        openThreadIds: [ThreadId.make("thread-active")],
        activeThreadId: ThreadId.make("thread-active"),
        activeThreadOpen: false,
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
        retainInactiveActiveThread: true,
      }),
    ).toEqual([ThreadId.make("thread-active")]);
  });

  it("evicts the oldest hidden threads beyond the configured cap", () => {
    const currentThreadIds = Array.from(
      { length: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS + 2 },
      (_, index) => ThreadId.make(`thread-${index + 1}`),
    );

    expect(
      reconcileRetainedMountedThreadIds({
        currentThreadIds,
        openThreadIds: currentThreadIds,
        activeThreadId: null,
        activeThreadOpen: false,
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
      }),
    ).toEqual(currentThreadIds.slice(-MAX_HIDDEN_MOUNTED_PREVIEW_THREADS));
  });
});

describe("shouldWriteThreadErrorToCurrentServerThread", () => {
  it("writes errors for a shell-derived active server thread", () => {
    const routeThreadRef = { environmentId, threadId };

    expect(
      shouldWriteThreadErrorToCurrentServerThread({
        activeServerThread: { environmentId, id: threadId },
        routeThreadRef,
        targetThreadId: threadId,
      }),
    ).toBe(true);
  });

  it("requires an active server thread matching the environment, route, and target", () => {
    const routeThreadRef = { environmentId, threadId };

    expect(
      shouldWriteThreadErrorToCurrentServerThread({
        activeServerThread: null,
        routeThreadRef,
        targetThreadId: threadId,
      }),
    ).toBe(false);
  });
});

describe("startNewThreadForProject", () => {
  it("starts a thread through the supplied shared handler for the active project", () => {
    const calls: Array<{ environmentId: EnvironmentId; projectId: ProjectId }> = [];
    const projectRef = { environmentId, projectId };

    expect(
      startNewThreadForProject(projectRef, (nextProjectRef) => {
        calls.push(nextProjectRef);
        return Promise.resolve();
      }),
    ).toBe(true);
    expect(calls).toEqual([projectRef]);
  });

  it("does nothing when the active project is unavailable", () => {
    let called = false;

    expect(
      startNewThreadForProject(null, () => {
        called = true;
        return Promise.resolve();
      }),
    ).toBe(false);
    expect(called).toBe(false);
  });
});

describe("hasServerAcknowledgedLocalDispatch", () => {
  it("does not acknowledge unchanged server state", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: completedTurn, session: readySession }),
    );

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: completedTurn,
        latestUserMessageId: localDispatch.latestUserMessageId,
        session: readySession,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });

  it("keeps a follow-up active while its provider session is starting", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: completedTurn, session: readySession }),
    );

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "connecting",
        latestTurn: completedTurn,
        latestUserMessageId: MessageId.make("message-followup"),
        session: {
          ...readySession,
          status: "starting",
          updatedAt: "2026-03-29T00:01:00.000Z",
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });

  it("acknowledges a settled newer turn", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: completedTurn, session: readySession }),
    );
    const newerTurn = {
      ...completedTurn,
      turnId: TurnId.make("turn-2"),
      requestedAt: "2026-03-29T00:01:00.000Z",
      startedAt: "2026-03-29T00:01:01.000Z",
      completedAt: "2026-03-29T00:01:30.000Z",
    };

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: newerTurn,
        latestUserMessageId: localDispatch.latestUserMessageId,
        session: { ...readySession, updatedAt: newerTurn.completedAt },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("waits for the matching running turn before acknowledging", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: completedTurn, session: readySession }),
    );
    const runningTurn = {
      ...completedTurn,
      turnId: TurnId.make("turn-2"),
      state: "running" as const,
      requestedAt: "2026-03-29T00:01:00.000Z",
      startedAt: "2026-03-29T00:01:01.000Z",
      completedAt: null,
    };

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: runningTurn,
        latestUserMessageId: localDispatch.latestUserMessageId,
        session: {
          ...readySession,
          status: "running",
          activeTurnId: TurnId.make("turn-other"),
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
        latestTurn: runningTurn,
        latestUserMessageId: localDispatch.latestUserMessageId,
        session: {
          ...readySession,
          status: "running",
          activeTurnId: runningTurn.turnId,
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("acknowledges a steering message projected onto the current running turn", () => {
    const runningTurn = {
      ...completedTurn,
      state: "running" as const,
      completedAt: null,
    };
    const runningSession = {
      ...readySession,
      status: "running" as const,
      activeTurnId: runningTurn.turnId,
    };
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({
        latestTurn: runningTurn,
        session: runningSession,
        messages: [
          {
            id: MessageId.make("message-before-steer"),
            role: "user",
            text: "Initial prompt",
            turnId: runningTurn.turnId,
            createdAt: runningTurn.requestedAt,
            updatedAt: runningTurn.requestedAt,
            streaming: false,
          },
        ],
      }),
    );

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: runningTurn,
        latestUserMessageId: MessageId.make("message-steer"),
        session: runningSession,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("acknowledges pending user interaction and errors immediately", () => {
    const localDispatch = createLocalDispatchSnapshot(makeThread());
    const common = {
      localDispatch,
      phase: "ready" as const,
      latestTurn: null,
      latestUserMessageId: localDispatch.latestUserMessageId,
      session: null,
      hasPendingApproval: false,
      hasPendingUserInput: false,
      threadError: null,
    };

    expect(hasServerAcknowledgedLocalDispatch({ ...common, hasPendingApproval: true })).toBe(true);
    expect(hasServerAcknowledgedLocalDispatch({ ...common, hasPendingUserInput: true })).toBe(true);
    expect(hasServerAcknowledgedLocalDispatch({ ...common, threadError: "failed" })).toBe(true);
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
    alreadyQueuedForThread: false,
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

  it("refuses a second message while one is already queued for the thread", () => {
    // Replayed turn-starts land back to back and some adapters fold the second
    // into the running turn as steering, merging N messages into one answer.
    expect(canQueueOfflineTurn({ ...queueable, alreadyQueuedForThread: true })).toBe(false);
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
    threadDetailLoading: false,
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
    expect(shouldAbortSendBeforeOfflineQueue({ ...sendable, threadDetailLoading: true })).toBe(
      true,
    );
    expect(shouldAbortSendBeforeOfflineQueue({ ...sendable, sendInFlight: true })).toBe(true);
    // Upstream #7949: a Codex feedback upload already running for this thread. Kept in this
    // helper rather than beside the call so every abort reason stays in one tested place.
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
    // Pinning the boundaries, because an off-by-one here either resurrects the
    // reflex case or clips the deliberate one.
    //
    // The two constants are pinned by value first. Every assertion below is
    // written as CONSTANT ± n, so widening the window to a minute would leave
    // them all green while quietly discarding the decay the safety argument in
    // `nextStopAction` rests on.
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

/*
 * `shouldHardStopAfterGrace` and its five tests were DELETED here, not lost.
 *
 * It said the arming RIPENS into an automatic hard stop once a grace period
 * elapses. `nextStopAction` now says the arming EXPIRES after one. Those are
 * opposite semantics over the same state, and it had no production caller — it
 * was tested, dormant code that would have misled whoever wired it next.
 *
 * If timed auto-escalation is ever wanted again it has to be redesigned against
 * the decay band above, not restored from git.
 */
