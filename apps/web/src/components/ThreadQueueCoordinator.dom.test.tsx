import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// Stores and the real send pipeline stay live; only where the coordinator reads the
// environment (shells, server config, connection) and the outgoing commands are stubbed.
const fixture = vi.hoisted(() => {
  const env = "env-1";
  // Two drivers' default instances: both picker-visible under default settings.
  const model = { codex: "gpt-5.5", claudeAgent: "claude-sonnet-4-5" } as const;
  const provider = (instanceId: keyof typeof model) => ({
    instanceId,
    driver: instanceId,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [
      { slug: model[instanceId], name: model[instanceId], isCustom: false, capabilities: {} },
    ],
    slashCommands: [],
    skills: [],
  });
  const shell = (id: string, instanceId: keyof typeof model, running: boolean) => ({
    environmentId: env,
    id,
    projectId: "project-1",
    title: id,
    modelSelection: { instanceId, model: model[instanceId] },
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
    session: running
      ? {
          threadId: id,
          status: "running",
          providerName: instanceId,
          providerInstanceId: instanceId,
          runtimeMode: "full-access",
          activeTurnId: "turn-1",
          lastError: null,
          updatedAt: "2026-09-13T10:00:00.000Z",
        }
      : null,
    latestUserMessageAt: "2026-09-13T10:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    pullRequests: [],
  });
  return {
    env,
    threads: [
      shell("busy-on-a", "codex", true),
      shell("queued-a", "codex", false),
      shell("queued-b", "claudeAgent", false),
    ],
    configs: new Map([[env, { providers: [provider("codex"), provider("claudeAgent")] }]]),
    presentationById: new Map([[env, { connection: { phase: "connected" } }]]),
    commandCalls: [] as Array<{ label: string; value: unknown }>,
  };
});

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({ presentationById: fixture.presentationById }),
}));
vi.mock("../state/entities", () => ({
  useThreadShells: () => fixture.threads,
  useAllEnvironmentShellsBootstrapped: () => true,
  readThreadShell: (ref: { threadId: string }) =>
    fixture.threads.find((thread) => thread.id === ref.threadId) ?? null,
  readProject: () => ({ id: "project-1", workspaceRoot: "/repo", defaultModelSelection: null }),
  readEnvironmentSupportsLocalOnlyStatus: () => false,
}));
vi.mock("../state/server", async (importOriginal) => {
  const { Atom } = await import("effect/unstable/reactivity");
  return {
    ...(await importOriginal<typeof import("../state/server")>()),
    environmentServerConfigsAtom: Atom.make(fixture.configs),
  };
});
// The network boundary: every command the coordinator dispatches lands here.
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: { label: string }) => async (value: unknown) => {
    fixture.commandCalls.push({ label: command.label, value });
    const { AsyncResult } = await import("effect/unstable/reactivity");
    return AsyncResult.success(undefined);
  },
}));

import { useComposerDraftStore } from "../composerDraftStore";
import { useQueueSlotSettingsStore } from "../queueSlotSettingsStore";
import { renderDom } from "../testing/renderDom";
import { useThreadQueueStore, type ThreadQueueEntry } from "../threadQueueStore";
import { ThreadQueueCoordinator } from "./ThreadQueueCoordinator";

const env = fixture.env as ThreadQueueEntry["environmentId"];
const threadId = (id: string) => id as ThreadQueueEntry["threadId"];
const startedThreadIds = () =>
  fixture.commandCalls.flatMap(({ value }) => {
    const input = (value as { input?: { threadId?: string; message?: unknown } }).input;
    return input?.message !== undefined ? [input.threadId] : [];
  });

beforeEach(() => {
  localStorage.clear();
  fixture.commandCalls.length = 0;
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  });
  useThreadQueueStore.setState({ entries: [], paused: false, inFlight: null });
  useQueueSlotSettingsStore.setState({
    slots: 1,
    perProvider: true,
    providerSlots: { codex: 1, claudeAgent: 1 },
  });
});

afterEach(() => {
  localStorage.clear();
});

describe("ThreadQueueCoordinator per-provider slots", () => {
  it("skips an entry whose instance is full and sends the one whose instance is free", async () => {
    const drafts = useComposerDraftStore.getState();
    for (const thread of fixture.threads as unknown as EnvironmentThreadShell[]) {
      drafts.setPrompt(scopeThreadRef(env, thread.id), `continue ${thread.id}`);
    }
    const queue = useThreadQueueStore.getState();
    queue.enqueue({ environmentId: env, threadId: threadId("queued-a"), draftId: null });
    queue.enqueue({ environmentId: env, threadId: threadId("queued-b"), draftId: null });

    let started!: () => void;
    const sent = new Promise<void>((resolve) => (started = resolve));
    const unsubscribe = useThreadQueueStore.subscribe((state) => {
      if (state.inFlight?.sentAt != null) started();
    });

    await renderDom(<ThreadQueueCoordinator />);
    // The claim is synchronous on mount: queued-a sits first but its instance is busy.
    expect(useThreadQueueStore.getState().inFlight?.entry.threadId).toBe("queued-b");

    await sent;
    unsubscribe();
    expect(startedThreadIds()).toEqual(["queued-b"]);
    expect(useThreadQueueStore.getState().entries.map((entry) => entry.threadId)).toEqual([
      "queued-a",
    ]);
  });
});
