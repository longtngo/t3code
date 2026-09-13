import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { executeQueuedSend, type QueuedSendCommands } from "./executeQueuedSend";
import { planQueuedSend, type QueuedSendSnapshot } from "./queuedSend";

const env = EnvironmentId.make("env-1");
const threadId = ThreadId.make("thread-1");
const projectId = ProjectId.make("project-1");
const threadRef = scopeThreadRef(env, threadId);
const draftId = DraftId.make("draft-1");
const codex = ProviderInstanceId.make("codex");

const provider: ServerProvider = {
  instanceId: codex,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [
    { slug: "gpt-5.5", name: "gpt-5.5", isCustom: false, capabilities: {} },
    { slug: "gpt-5.4", name: "gpt-5.4", isCustom: false, capabilities: {} },
  ],
  slashCommands: [],
  skills: [],
} as ServerProvider;

function shell(overrides: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell {
  return {
    environmentId: env,
    id: threadId,
    projectId,
    title: "Thread",
    modelSelection: createModelSelection(codex, "gpt-5.5"),
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-09-13T10:00:00.000Z",
    updatedAt: "2026-09-13T10:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: "2026-09-13T10:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    pullRequests: [],
    ...overrides,
  } as EnvironmentThreadShell;
}

function serverSnapshot(overrides: Partial<QueuedSendSnapshot> = {}): QueuedSendSnapshot {
  return {
    environmentId: env,
    threadId,
    draftId: null,
    draft: useComposerDraftStore.getState().getComposerDraft(threadRef),
    draftSession: null,
    shell: shell(),
    project: { id: projectId, workspaceRoot: "/repo", defaultModelSelection: null },
    providers: [provider],
    settings: DEFAULT_UNIFIED_SETTINGS,
    environmentConnected: true,
    currentGitBranch: null,
    loadBalancingEnabled: false,
    randomHex: () => "abcd",
    ...overrides,
  };
}

function draftSnapshot(overrides: Partial<QueuedSendSnapshot> = {}): QueuedSendSnapshot {
  const store = useComposerDraftStore.getState();
  return serverSnapshot({
    draftId,
    draft: store.getComposerDraft(draftId),
    draftSession: store.getDraftSession(draftId),
    shell: null,
    ...overrides,
  });
}

function recordingCommands(options: { failStart?: boolean } = {}) {
  const calls: Array<{ command: string; value: unknown }> = [];
  const ok = (command: string) => async (value: unknown) => {
    calls.push({ command, value });
    return AsyncResult.success(undefined);
  };
  const commands: QueuedSendCommands = {
    updateThreadMetadata: ok("updateThreadMetadata"),
    setThreadRuntimeMode: ok("setThreadRuntimeMode"),
    setThreadInteractionMode: ok("setThreadInteractionMode"),
    startThreadTurn: async (value) => {
      calls.push({ command: "startThreadTurn", value });
      return options.failStart
        ? AsyncResult.failure(Cause.fail(new Error("provider exploded")))
        : AsyncResult.success(undefined);
    },
  } as QueuedSendCommands;
  return { calls, commands };
}

const ids = {
  messageId: MessageId.make("message-1"),
  now: () => "2026-09-13T12:00:00.000Z",
  newThreadId: () => ThreadId.make("thread-rotated"),
};

describe("planQueuedSend", () => {
  beforeEach(() => {
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    });
  });

  it("an empty draft plans nothing", () => {
    expect(planQueuedSend(serverSnapshot()).kind).toBe("empty");
    useComposerDraftStore.getState().setPrompt(threadRef, "   ");
    expect(planQueuedSend(serverSnapshot()).kind).toBe("empty");
  });

  it("a follow-up sends the draft text with the thread's provider and no bootstrap", () => {
    useComposerDraftStore.getState().setPrompt(threadRef, "run the tests");
    const plan = planQueuedSend(serverSnapshot());
    expect(plan).toMatchObject({
      kind: "send",
      isLocalDraftThread: false,
      outgoingMessageText: "run the tests",
      bootstrap: undefined,
      runtimeMode: "full-access",
      interactionMode: "default",
    });
    expect(plan.kind === "send" && plan.modelSelection.model).toBe("gpt-5.5");
  });

  it("refuses what Send handles with UI, and says why", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(threadRef, "hello");
    const reason = (snapshot: QueuedSendSnapshot) => {
      const plan = planQueuedSend(snapshot);
      return plan.kind === "refused" ? plan.reason : plan.kind;
    };
    expect(reason(serverSnapshot({ environmentConnected: false }))).toMatch(/not connected/);
    expect(reason(serverSnapshot({ shell: shell({ hasPendingUserInput: true }) }))).toMatch(
      /waiting on an answer/,
    );
    expect(reason(serverSnapshot({ shell: shell({ latestUserMessageAt: null }) }))).toMatch(
      /no messages/,
    );
    expect(reason(serverSnapshot({ providers: null }))).toMatch(/not loaded/);
    expect(reason(serverSnapshot({ providers: [] }))).toMatch(/No provider/);
    expect(reason(serverSnapshot({ project: null }))).toMatch(/project/);
    expect(reason(serverSnapshot({ shell: null }))).toMatch(/no longer available/);

    store.setPrompt(threadRef, "/usage-limits");
    expect(reason(serverSnapshot())).toMatch(/command/);
  });

  it("a new-thread draft creates its thread from the draft session", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(scopeProjectRef(env, projectId), draftId, {
      threadId,
      branch: "main",
      worktreePath: null,
      createdAt: "2026-09-13T09:00:00.000Z",
      envMode: "local",
      runtimeMode: "approval-required",
      interactionMode: "default",
    });
    store.setPrompt(draftId, "start here");
    const plan = planQueuedSend(draftSnapshot());
    expect(plan).toMatchObject({
      kind: "send",
      isLocalDraftThread: true,
      runtimeMode: "approval-required",
      bootstrap: {
        createThread: {
          projectId,
          title: "start here",
          branch: "main",
          createdAt: "2026-09-13T09:00:00.000Z",
        },
      },
    });
  });
});

describe("executeQueuedSend", () => {
  beforeEach(() => {
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    });
  });

  it("starts the turn, clears the draft, and aligns changed thread settings first", async () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(threadRef, "run the tests");
    store.setRuntimeMode(threadRef, "approval-required");
    const snapshot = serverSnapshot();
    const { calls, commands } = recordingCommands();

    const outcome = await executeQueuedSend(snapshot, planQueuedSend(snapshot), commands, ids);

    expect(outcome).toEqual({ kind: "sent" });
    expect(calls.map((call) => call.command)).toEqual(["setThreadRuntimeMode", "startThreadTurn"]);
    expect(calls[1]?.value).toMatchObject({
      environmentId: env,
      input: {
        threadId,
        message: { messageId: "message-1", role: "user", text: "run the tests", attachments: [] },
        runtimeMode: "approval-required",
      },
    });
    expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.prompt ?? "").toBe("");
  });

  it("a local checkout that moved off the thread's branch moves the thread with it", async () => {
    useComposerDraftStore.getState().setPrompt(threadRef, "run the tests");
    const snapshot = serverSnapshot({
      shell: shell({ branch: "feature/old" }),
      currentGitBranch: "feature/new",
    });
    const worktree = serverSnapshot({
      shell: shell({ branch: "feature/old", worktreePath: "/wt" }),
      currentGitBranch: "feature/new",
    });
    const worktreePlan = planQueuedSend(worktree);
    expect(worktreePlan).toMatchObject({ kind: "send", persistBranch: null });
    const { calls, commands } = recordingCommands();

    await executeQueuedSend(snapshot, planQueuedSend(snapshot), commands, ids);

    expect(calls[0]).toMatchObject({
      command: "updateThreadMetadata",
      value: { input: { threadId, branch: "feature/new" } },
    });
  });

  it("a failed start puts the draft back and reports the error", async () => {
    useComposerDraftStore.getState().setPrompt(threadRef, "run the tests");
    const snapshot = serverSnapshot();
    const { commands } = recordingCommands({ failStart: true });

    const outcome = await executeQueuedSend(snapshot, planQueuedSend(snapshot), commands, ids);

    expect(outcome).toEqual({ kind: "failed", message: "provider exploded" });
    expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.prompt).toBe(
      "run the tests",
    );
  });

  it("a sent draft is marked promoted so its row leaves Not started", async () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(scopeProjectRef(env, projectId), draftId, {
      threadId,
      createdAt: "2026-09-13T09:00:00.000Z",
      envMode: "local",
    });
    store.setPrompt(draftId, "start here");
    const snapshot = draftSnapshot();
    const { calls, commands } = recordingCommands();

    const outcome = await executeQueuedSend(snapshot, planQueuedSend(snapshot), commands, ids);

    expect(outcome).toEqual({ kind: "sent" });
    expect(calls.map((call) => call.command)).toEqual(["startThreadTurn"]);
    expect(useComposerDraftStore.getState().getDraftSession(draftId)?.promotedTo).toEqual(
      threadRef,
    );
  });

  it("an empty or refused plan dispatches nothing", async () => {
    const { calls, commands } = recordingCommands();
    expect(await executeQueuedSend(serverSnapshot(), { kind: "empty" }, commands, ids)).toEqual({
      kind: "empty",
    });
    expect(calls).toEqual([]);
  });
});
