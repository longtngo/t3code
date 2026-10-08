import { RegistryContext } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type {
  QueueSlotSettings,
  ThreadQueueDocument,
  ThreadQueueSetInput,
} from "@t3tools/contracts";
import { type Atom, AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const UPDATE_SETTINGS = "environment-data:server:update-settings";

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
    latestRun: null,
    pendingBackgroundTasks: [],
    createdAt: "2026-09-13T10:00:00.000Z",
    updatedAt: "2026-09-13T10:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    pinnedAt: null,
    runtime: running
      ? {
          status: "running",
          activeRunId: "turn-1",
          providerName: instanceId,
          providerInstanceId: instanceId,
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
    primary: null as { environmentId: string } | null,
    /** Runs as each command lands, before it resolves. */
    onCommand: null as ((label: string, value: unknown) => void) | null,
  };
});

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({ presentationById: fixture.presentationById }),
  // No primary unless a test sets one: slot settings then come from the local store.
  usePrimaryEnvironment: () => fixture.primary,
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
  const { Atom } = await import("effect/reactivity");
  const { DEFAULT_SERVER_SETTINGS } = await import("@t3tools/contracts");
  const primaryServerConfigAtom = Atom.make<{ settings: Record<string, unknown> } | null>(null);
  return {
    ...(await importOriginal<typeof import("../state/server")>()),
    environmentServerConfigsAtom: Atom.make(fixture.configs),
    primaryServerConfigAtom,
    primaryServerSettingsAtom: Atom.make(
      (get) => get(primaryServerConfigAtom)?.settings ?? DEFAULT_SERVER_SETTINGS,
    ),
  };
});
// The network boundary: every command the coordinator dispatches lands here.
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: { label: string }) => async (value: unknown) => {
    fixture.commandCalls.push({ label: command.label, value });
    fixture.onCommand?.(command.label, value);
    const { AsyncResult } = await import("effect/reactivity");
    // A settings write is the queue-slot import; the server accepts it.
    const patch = (value as { input?: { patch?: { queueSlotsImport?: unknown } } }).input?.patch;
    return AsyncResult.success(
      command.label === UPDATE_SETTINGS ? { queueSlots: patch?.queueSlotsImport } : undefined,
    );
  },
}));

import { useComposerDraftStore } from "../composerDraftStore";
import { useQueueSlotSettingsStore } from "../queueSlotSettingsStore";
import { primaryServerConfigAtom } from "../state/server";
import { renderDom } from "../testing/renderDom";
import { type ThreadQueueEntry } from "../threadQueueRules";
import {
  queueDeviceId,
  removeSentThreadFromQueue,
  useThreadQueueStore,
  type ThreadQueueConnection,
} from "../threadQueueStore";
import { ThreadQueueCoordinator } from "./ThreadQueueCoordinator";

const env = fixture.env as ThreadQueueEntry["environmentId"];
const threadId = (id: string) => id as ThreadQueueEntry["threadId"];
const startedThreadIds = () =>
  fixture.commandCalls.flatMap(({ value }) => {
    const input = (value as { input?: { threadId?: string; message?: unknown } }).input;
    return input?.message !== undefined ? [input.threadId] : [];
  });

beforeEach(async () => {
  localStorage.clear();
  fixture.commandCalls.length = 0;
  fixture.primary = null;
  fixture.onCommand = null;
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  });
  useThreadQueueStore.getState().setConnection({
    primaryId: null,
    noPrimary: true,
    configSource: null,
    capability: false,
    connected: false,
    canWrite: true,
  });
  await useThreadQueueStore.persist.rehydrate();
  useThreadQueueStore.setState({ entries: [], paused: false, inFlight: null });
  useQueueSlotSettingsStore.setState({
    slots: 1,
    perProvider: true,
    providerSlots: { codex: 1, claudeAgent: 1 },
  });
});

afterEach(() => {
  localStorage.clear();
  useThreadQueueStore.getState().setWriter(null);
});

const SERVER_CONNECTION: ThreadQueueConnection = {
  primaryId: "env-primary" as ThreadQueueEntry["environmentId"],
  noPrimary: false,
  configSource: "live",
  capability: true,
  connected: true,
  canWrite: true,
};
const queuedOnServer = (id: string) => ({
  environmentId: env,
  threadId: threadId(id),
  draftId: null,
  addedAt: 1,
  ownerId: queueDeviceId(),
  label: id,
});

// A queue shown from the last document, but disconnected, sends nothing.
describe("ThreadQueueCoordinator while the queue is pending", () => {
  it("claims nothing", async () => {
    useComposerDraftStore
      .getState()
      .setPrompt(scopeThreadRef(env, threadId("queued-b")), "continue queued-b");
    const store = useThreadQueueStore.getState();
    store.setConnection(SERVER_CONNECTION);
    store.receiveDocument(
      {
        bootId: "boot-1",
        revision: 1,
        paused: false,
        inFlight: null,
        lastFailure: null,
        entries: [queuedOnServer("queued-b")],
      },
      Date.now(),
    );
    store.setConnection({ ...SERVER_CONNECTION, connected: false });
    expect(useThreadQueueStore.getState()).toMatchObject({
      mode: "pending",
      entries: [{ threadId: "queued-b" }],
    });

    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const claims = countClaims();
    try {
      await renderDom(<ThreadQueueCoordinator />);
      await act(async () => {});
      expect(claims.attempts).toBe(0);
    } finally {
      claims.restore();
      error.mockRestore();
    }
    expect(useThreadQueueStore.getState().inFlight).toBeNull();
    expect(startedThreadIds()).toEqual([]);
  });
});

/** Counts claim attempts; past `limit` it throws, which ends a spinning re-decide loop fast. */
function countClaims(limit = 20) {
  const { claimEntry } = useThreadQueueStore.getState();
  const counter = {
    attempts: 0,
    restore: () => useThreadQueueStore.setState({ claimEntry }),
  };
  useThreadQueueStore.setState({
    claimEntry: (input) => {
      counter.attempts += 1;
      if (counter.attempts > limit) throw new Error("claim attempts spun");
      return claimEntry(input);
    },
  });
  return counter;
}

describe("ThreadQueueCoordinator on the server's queue", () => {
  const writes: ThreadQueueSetInput[] = [];
  /** Each write's reply waits for this; a test holds it to keep a change unconfirmed. */
  let reply: Promise<void> = Promise.resolve();
  // This device's clock runs 10 minutes ahead of the server's.
  const enter = (document: Partial<ThreadQueueDocument>, connection = SERVER_CONNECTION) => {
    writes.length = 0;
    const serverTime = Date.now() - 10 * 60_000;
    const store = useThreadQueueStore.getState();
    store.setWriter({
      write: async (input) => {
        writes.push(input);
        await reply;
        return {
          ok: true,
          document: { bootId: "boot-1", revision: input.expectedRevision + 1, ...input.state },
          serverTime: Date.now() - 10 * 60_000,
        };
      },
      reportFailure: vi.fn(),
    });
    store.setConnection(connection);
    store.receiveDocument(
      {
        bootId: "boot-1",
        revision: 1,
        paused: false,
        inFlight: null,
        lastFailure: null,
        entries: [],
        ...document,
      },
      serverTime,
    );
    return serverTime;
  };
  const claimedAgo = (serverTime: number, ms: number) => ({
    entry: queuedOnServer("queued-b"),
    claimId: "other-tab",
    claimedAt: serverTime - ms,
    priorUserMessageAt: null,
    priorTurnId: null,
    priorSessionUpdatedAt: null,
    sentAt: null,
  });

  // 4 minutes old by the server's clock is 14 by this device's.
  it("ages a claim on the server's clock, not this device's", async () => {
    const serverTime = Date.now() - 10 * 60_000;
    enter({ inFlight: claimedAgo(serverTime, 4 * 60_000) });
    await renderDom(<ThreadQueueCoordinator />);
    expect(writes).toEqual([]);
    expect(useThreadQueueStore.getState().inFlight?.claimId).toBe("other-tab");
  });

  it("abandons a claim past the cap on the server's clock", async () => {
    const serverTime = Date.now() - 10 * 60_000;
    enter({ inFlight: claimedAgo(serverTime, 6 * 60_000) });
    const { clearInFlight } = useThreadQueueStore.getState();
    const clears: Array<Parameters<typeof clearInFlight>> = [];
    useThreadQueueStore.setState({
      clearInFlight: (...args) => {
        clears.push(args);
        clearInFlight(...args);
      },
    });
    try {
      await renderDom(<ThreadQueueCoordinator />);
      await vi.waitFor(() => expect(writes.map((write) => write.state.inFlight)).toEqual([null]));
      // Only while still unsent: an owner's mark-sent landing first keeps the claim.
      expect(clears).toEqual([["other-tab", true]]);
    } finally {
      useThreadQueueStore.setState({ clearInFlight });
    }
  });

  it("sends only this device's entries", async () => {
    const drafts = useComposerDraftStore.getState();
    drafts.setPrompt(scopeThreadRef(env, threadId("queued-a")), "continue queued-a");
    drafts.setPrompt(scopeThreadRef(env, threadId("queued-b")), "continue queued-b");
    useQueueSlotSettingsStore.setState({ providerSlots: { codex: 2, claudeAgent: 1 } });
    enter({
      entries: [
        { ...queuedOnServer("queued-b"), ownerId: "another-device" },
        queuedOnServer("queued-a"),
      ],
    });
    await renderDom(<ThreadQueueCoordinator />);
    expect(useThreadQueueStore.getState().inFlight?.entry.threadId).toBe("queued-a");
    await vi.waitFor(() => expect(startedThreadIds()).toEqual(["queued-a"]));
  });

  it("a claim the displayed queue refuses waits for a change instead of re-deciding at once", async () => {
    // queued-b's instance is free, but the user's removal of it is not yet confirmed.
    enter({ entries: [queuedOnServer("queued-b")] });
    let release!: () => void;
    reply = new Promise((resolve) => (release = resolve));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const claims = countClaims();
    try {
      useThreadQueueStore.getState().remove(`${env}:queued-b`);
      await renderDom(<ThreadQueueCoordinator />);
      for (let flush = 0; flush < 5; flush += 1) await act(async () => {});
      expect(claims.attempts).toBe(1);
    } finally {
      release();
      reply = Promise.resolve();
      claims.restore();
      error.mockRestore();
    }
    await vi.waitFor(() => expect(useThreadQueueStore.getState().server?.entries).toEqual([]));
    expect(startedThreadIds()).toEqual([]);
  });

  it("a claim the server answers but cannot save waits for a change instead of re-claiming at once", async () => {
    enter({ entries: [queuedOnServer("queued-b")] });
    // The state dir is unwritable: an unchanged document is accepted (nothing to write), any
    // real change fails.
    let attempts = 0;
    useThreadQueueStore.getState().setWriter({
      write: async (input) => {
        attempts += 1;
        const document = useThreadQueueStore.getState().server!;
        if (input.state.inFlight !== null) throw new Error("ThreadQueueWriteError: disk full");
        return { ok: true, document, serverTime: Date.now() - 10 * 60_000 };
      },
      reportFailure: vi.fn(),
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const claims = countClaims(50);
    try {
      await renderDom(<ThreadQueueCoordinator />);
      for (let flush = 0; flush < 200; flush += 1) await act(async () => {});
      expect(claims.attempts).toBe(1);
      // The claim, then one unchanged re-send that settles its lost reply.
      expect(attempts).toBe(2);
    } finally {
      claims.restore();
      error.mockRestore();
    }
    expect(useThreadQueueStore.getState().server?.entries).toEqual([queuedOnServer("queued-b")]);
    expect(startedThreadIds()).toEqual([]);
  });

  it("a session that may not write the queue issues nothing: no prune, no claim, no abandon", async () => {
    useComposerDraftStore
      .getState()
      .setPrompt(scopeThreadRef(env, threadId("queued-b")), "continue queued-b");
    const serverTime = Date.now() - 10 * 60_000;
    enter(
      {
        entries: [queuedOnServer("queued-b"), queuedOnServer("deleted-thread")],
        inFlight: claimedAgo(serverTime, 60 * 60_000),
      },
      { ...SERVER_CONNECTION, canWrite: false },
    );
    expect(useThreadQueueStore.getState()).toMatchObject({ mode: "server", readOnly: true });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const claims = countClaims();
    try {
      await renderDom(<ThreadQueueCoordinator />);
      await act(async () => {});
      expect(claims.attempts).toBe(0);
    } finally {
      claims.restore();
      error.mockRestore();
    }
    expect(writes).toEqual([]);
    expect(useThreadQueueStore.getState().pending).toEqual([]);
    expect(startedThreadIds()).toEqual([]);
  });
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

describe("ThreadQueueCoordinator after an entry leaves unsent", () => {
  it("sends the next entry at once instead of waiting for the next tick", async () => {
    useQueueSlotSettingsStore.setState({ providerSlots: { codex: 2, claudeAgent: 1 } });
    // queued-b has no draft (it leaves for Active); queued-a has text and a free codex slot.
    useComposerDraftStore
      .getState()
      .setPrompt(scopeThreadRef(env, threadId("queued-a")), "continue");
    const queue = useThreadQueueStore.getState();
    queue.enqueue({ environmentId: env, threadId: threadId("queued-b"), draftId: null });
    queue.enqueue({ environmentId: env, threadId: threadId("queued-a"), draftId: null });

    let started!: () => void;
    const sent = new Promise<void>((resolve) => (started = resolve));
    const unsubscribe = useThreadQueueStore.subscribe((state) => {
      if (state.inFlight?.sentAt != null) started();
    });
    vi.useFakeTimers({ toFake: ["setInterval"] });
    try {
      await renderDom(<ThreadQueueCoordinator />);
      await sent;
    } finally {
      vi.useRealTimers();
      unsubscribe();
    }
    expect(startedThreadIds()).toEqual(["queued-a"]);
  });
});

describe("ThreadQueueCoordinator with two entries on one instance", () => {
  const [other] = fixture.threads;
  const otherRuntime = other!.runtime;
  const running = (id: string) => ({ ...otherRuntime!, activeRunId: `turn-${id}` });
  // React renders between steps, so each re-decision runs at its own fake time.
  const elapse = async (ms: number) => {
    for (let at = 0; at < ms; at += 100) await act(() => vi.advanceTimersByTimeAsync(100));
  };
  beforeEach(() => {
    // Both entries are codex threads, both idle.
    other!.runtime = null;
    const drafts = useComposerDraftStore.getState();
    drafts.setPrompt(scopeThreadRef(env, threadId("queued-a")), "continue a");
    drafts.setPrompt(scopeThreadRef(env, threadId("busy-on-a")), "continue other");
    const queue = useThreadQueueStore.getState();
    queue.enqueue({ environmentId: env, threadId: threadId("queued-a"), draftId: null });
    queue.enqueue({ environmentId: env, threadId: threadId("busy-on-a"), draftId: null });
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    for (const thread of fixture.threads) {
      thread.runtime = null;
      thread.branch = null;
      thread.latestUserMessageAt = "2026-09-13T10:00:00.000Z";
    }
    other!.runtime = otherRuntime;
  });

  it("with two slots, sends the second as soon as the first goes out, not at the next tick", async () => {
    useQueueSlotSettingsStore.setState({ providerSlots: { codex: 2, claudeAgent: 1 } });
    // A started thread reads busy before its send returns, as a fast server reports it.
    fixture.onCommand = (_label, value) => {
      const input = (value as { input?: { threadId?: string; message?: unknown } }).input;
      const thread = fixture.threads.find((shell) => shell.id === input?.threadId);
      if (input?.message === undefined || !thread) return;
      thread.runtime = running(thread.id);
      thread.latestUserMessageAt = "2026-09-13T11:00:00.000Z";
    };
    await renderDom(<ThreadQueueCoordinator />);
    // Two claim settles, well inside one 15 s tick.
    await elapse(2_000);
    expect(startedThreadIds()).toEqual(["queued-a", "busy-on-a"]);
  });

  it("a claim step that throws waits for the next tick instead of retrying at once", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let attempts = 0;
    const { claimEntry } = useThreadQueueStore.getState();
    useThreadQueueStore.setState({
      claimEntry: () => {
        attempts += 1;
        throw new Error("claim broke");
      },
    });
    try {
      await renderDom(<ThreadQueueCoordinator />);
      await elapse(2_000);
      expect(attempts).toBe(1);
      await elapse(15_000);
      expect(attempts).toBe(2);
    } finally {
      error.mockRestore();
      useThreadQueueStore.setState({ claimEntry });
    }
  });

  it("with one slot, a hand send during the branch read holds the slot: the next entry waits", async () => {
    // The user sends queued-a by hand while the queue reads its branch; it has not read busy yet.
    fixture.threads[1]!.branch = "main" as never;
    fixture.onCommand = (label) => {
      if (!label.includes("refresh") || fixture.onCommand === null) return;
      fixture.onCommand = null;
      useComposerDraftStore
        .getState()
        .clearComposerContent(scopeThreadRef(env, threadId("queued-a")));
      removeSentThreadFromQueue(`${env}:queued-a`, null);
    };
    await renderDom(<ThreadQueueCoordinator />);
    await elapse(5_000);
    expect(startedThreadIds()).toEqual([]);
    expect(useThreadQueueStore.getState().inFlight).toMatchObject({
      entry: { threadId: "queued-a" },
      handSent: true,
    });
  });
});

const configAtom = primaryServerConfigAtom as unknown as Atom.Writable<{
  settings: Record<string, unknown>;
} | null>;

describe("ThreadQueueCoordinator with a primary environment", () => {
  let registry: AtomRegistry.AtomRegistry;
  const setServerSlots = (queueSlots?: QueueSlotSettings) =>
    act(async () => {
      registry.set(configAtom, { settings: queueSlots === undefined ? {} : { queueSlots } });
    });
  const mount = () =>
    renderDom(
      <RegistryContext.Provider value={registry}>
        <ThreadQueueCoordinator />
      </RegistryContext.Provider>,
    );

  beforeEach(() => {
    fixture.primary = { environmentId: "env-primary" };
    registry = AtomRegistry.make();
  });

  it("sends by the server's slots, not the device copy", async () => {
    // The device copy would send (one busy thread, five slots); the server's 0 holds the queue.
    useQueueSlotSettingsStore.setState({ slots: 5, perProvider: false, providerSlots: {} });
    const server: QueueSlotSettings = { slots: 0, perProvider: false, providerSlots: {} };
    registry.set(configAtom, { settings: { queueSlots: server } });
    useComposerDraftStore
      .getState()
      .setPrompt(scopeThreadRef(env, threadId("queued-a")), "continue queued-a");
    useThreadQueueStore
      .getState()
      .enqueue({ environmentId: env, threadId: threadId("queued-a"), draftId: null });

    await mount();
    expect(useThreadQueueStore.getState().inFlight).toBeNull();

    await setServerSlots({ ...server, slots: 5 });
    expect(useThreadQueueStore.getState().inFlight?.entry.threadId).toBe("queued-a");
  });

  it("imports the device copy once when the server has no value", async () => {
    // beforeEach's store seed saved the device copy under its storage key.
    await mount();
    await setServerSlots();
    await setServerSlots();
    const imports = fixture.commandCalls.filter((call) => call.label === UPDATE_SETTINGS);
    expect(imports.map((call) => call.value)).toEqual([
      {
        environmentId: "env-primary",
        input: {
          patch: {
            queueSlotsImport: {
              slots: 1,
              perProvider: true,
              providerSlots: { codex: 1, claudeAgent: 1 },
            },
          },
        },
      },
    ]);
  });
});
