import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, RuntimeTaskId, ThreadId, TurnId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { makeRuntimeBootIdLive } from "../../environment/Layers/RuntimeBootId.ts";
import { AnalyticsService } from "../../telemetry/Services/AnalyticsService.ts";
import {
  PendingBackgroundTaskRepository,
  type PendingBackgroundTask,
} from "../../persistence/Services/PendingBackgroundTask.ts";
import { BackgroundTaskRecoveryWatchdog } from "../Services/BackgroundTaskRecoveryWatchdog.ts";
import {
  makeBackgroundTaskRecoveryWatchdogLive,
  type BackgroundTaskRecoveryWatchdogLiveOptions,
} from "./BackgroundTaskRecoveryWatchdog.ts";

const CURRENT_BOOT = "current-boot";
const projectId = ProjectId.make("project-bg-recovery");
const defaultModelSelection = {
  instanceId: "claude" as never,
  model: "claude-opus-4-8",
} as const;

type SessionStatus =
  | "idle"
  | "starting"
  | "running"
  | "ready"
  | "interrupted"
  | "stopped"
  | "error";

interface ShellSeed {
  readonly status: SessionStatus;
  readonly activeTurnId?: TurnId | null;
  readonly hasPendingApprovals?: boolean;
  readonly hasPendingUserInput?: boolean;
  readonly archivedAt?: string | null;
}

function makeShell(threadId: ThreadId, seed: ShellSeed) {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: threadId,
    projectId,
    title: `Thread ${threadId}`,
    modelSelection: defaultModelSelection,
    interactionMode: "default" as const,
    runtimeMode: "full-access" as const,
    branch: null,
    worktreePath: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: seed.archivedAt ?? null,
    latestUserMessageAt: null,
    hasPendingApprovals: seed.hasPendingApprovals ?? false,
    hasPendingUserInput: seed.hasPendingUserInput ?? false,
    hasActionableProposedPlan: false,
    latestTurn: null,
    session: {
      threadId,
      status: seed.status,
      providerName: "claudeAgent" as const,
      runtimeMode: "full-access" as const,
      activeTurnId: seed.activeTurnId ?? null,
      lastError: null,
      updatedAt: now,
    },
  };
}

function row(overrides: {
  readonly taskId: string;
  readonly threadId: ThreadId;
  readonly bootId?: string;
  readonly startedAt?: string;
  readonly lastSeenAt?: string;
  readonly recoveryAttempts?: number;
}): PendingBackgroundTask {
  return {
    taskId: RuntimeTaskId.make(overrides.taskId),
    threadId: overrides.threadId,
    bootId: overrides.bootId ?? CURRENT_BOOT,
    startedAt: overrides.startedAt ?? "2026-01-01T00:00:00.000Z",
    lastSeenAt: overrides.lastSeenAt ?? "2026-01-01T00:00:00.000Z",
    recoveryAttempts: overrides.recoveryAttempts ?? 0,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async (): Promise<void> => {
    if (predicate()) return;
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error("Timed out waiting for expectation.");
    }
    await Effect.runPromise(Effect.yieldNow);
    return poll();
  };
  return poll();
}

describe("BackgroundTaskRecoveryWatchdog", () => {
  let runtime: ManagedRuntime.ManagedRuntime<BackgroundTaskRecoveryWatchdog, unknown> | null = null;
  let scope: Scope.Closeable | null = null;

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
  });

  function createHarness(input: {
    readonly rows: ReadonlyArray<PendingBackgroundTask>;
    readonly shells: Map<ThreadId, ReturnType<typeof makeShell>>;
    readonly options?: BackgroundTaskRecoveryWatchdogLiveOptions;
  }) {
    const store = new Map<string, PendingBackgroundTask>();
    for (const r of input.rows) {
      store.set(r.taskId, r);
    }
    const dispatched: Array<{ type: string; threadId: ThreadId; text?: string }> = [];

    const repository = Layer.succeed(PendingBackgroundTaskRepository, {
      upsert: (task: PendingBackgroundTask) =>
        Effect.sync(() => {
          store.set(task.taskId, task);
        }),
      touch: ({ taskId, lastSeenAt }: { taskId: RuntimeTaskId; lastSeenAt: string }) =>
        Effect.sync(() => {
          const existing = store.get(taskId);
          if (existing) store.set(taskId, { ...existing, lastSeenAt });
        }),
      incrementAttempts: ({ taskId }: { taskId: RuntimeTaskId }) =>
        Effect.sync(() => {
          const existing = store.get(taskId);
          if (existing) {
            store.set(taskId, { ...existing, recoveryAttempts: existing.recoveryAttempts + 1 });
          }
        }),
      getByTaskId: ({ taskId }: { taskId: RuntimeTaskId }) =>
        Effect.sync(() => {
          const existing = store.get(taskId);
          return existing ? Option.some(existing) : Option.none();
        }),
      list: () => Effect.sync(() => Array.from(store.values())),
      listByThreadId: ({ threadId }: { threadId: ThreadId }) =>
        Effect.sync(() => Array.from(store.values()).filter((r) => r.threadId === threadId)),
      deleteByTaskId: ({ taskId }: { taskId: RuntimeTaskId }) =>
        Effect.sync(() => {
          store.delete(taskId);
        }),
    });

    const engine = {
      readEvents: () => Stream.empty,
      streamDomainEvents: Stream.empty,
      dispatch: (command: { type: string; threadId: ThreadId; message?: { text?: string } }) =>
        Effect.sync(() => {
          dispatched.push({
            type: command.type,
            threadId: command.threadId,
            ...(command.message?.text ? { text: command.message.text } : {}),
          });
          return { sequence: dispatched.length };
        }),
    };

    const projection = {
      getCommandReadModel: () => Effect.die("unused"),
      getSnapshot: () => Effect.die("unused"),
      getShellSnapshot: () => Effect.die("unused"),
      getArchivedShellSnapshot: () => Effect.die("unused"),
      getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
      getCounts: () => Effect.die("unused"),
      getActiveProjectByWorkspaceRoot: () => Effect.die("unused"),
      getProjectShellById: () => Effect.die("unused"),
      getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
      getThreadCheckpointContext: () => Effect.die("unused"),
      getFullThreadDiffContext: () => Effect.die("unused"),
      getThreadShellById: (threadId: ThreadId) => {
        const shell = input.shells.get(threadId);
        return Effect.succeed(shell ? Option.some(shell) : Option.none());
      },
      getThreadDetailById: () => Effect.die("unused"),
    };

    const analyticsEvents: Array<{ event: string; properties?: Record<string, unknown> }> = [];
    const analytics = Layer.succeed(AnalyticsService, {
      record: (event: string, properties?: Readonly<Record<string, unknown>>) =>
        Effect.sync(() => {
          analyticsEvents.push({ event, ...(properties ? { properties } : {}) });
        }),
      flush: Effect.void,
    });

    const layer = makeBackgroundTaskRecoveryWatchdogLive({
      sweepIntervalMs: 20,
      staleThresholdMs: 50,
      maxRecoveryAttempts: 3,
      ...input.options,
    }).pipe(
      Layer.provideMerge(repository),
      Layer.provideMerge(Layer.succeed(OrchestrationEngineService, engine as never)),
      Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery, projection as never)),
      Layer.provideMerge(makeRuntimeBootIdLive(CURRENT_BOOT)),
      Layer.provideMerge(analytics),
      Layer.provideMerge(NodeServices.layer),
    );

    runtime = ManagedRuntime.make(layer);
    return { store, dispatched, analyticsEvents };
  }

  async function startWatchdog() {
    const watchdog = await runtime!.runPromise(Effect.service(BackgroundTaskRecoveryWatchdog));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(watchdog.start().pipe(Scope.provide(scope)));
  }

  const thread = (suffix: string) => ThreadId.make(`thread-${suffix}`);

  it("recovers a prior-boot (reboot-orphaned) task: resumes the thread and clears the row", async () => {
    const threadId = thread("prior-boot");
    const { store, dispatched, analyticsEvents } = createHarness({
      rows: [row({ taskId: "task-prior", threadId, bootId: "OLD-BOOT" })],
      shells: new Map([[threadId, makeShell(threadId, { status: "ready" })]]),
      // huge stale threshold so only the prior-boot trigger can fire
      options: { staleThresholdMs: 60 * 60 * 1000 },
    });
    await startWatchdog();
    await waitFor(() => dispatched.length > 0);
    expect(dispatched[0]?.type).toBe("thread.turn.start");
    expect(dispatched[0]?.threadId).toBe(threadId);
    expect(dispatched[0]?.text).toContain("restarted");
    await waitFor(() => store.size === 0);
    // Anonymous trip telemetry fired (no thread/task identifiers).
    await waitFor(() =>
      analyticsEvents.some((e) => e.event === "provider.background_task.recovered"),
    );
    const recovered = analyticsEvents.find(
      (e) => e.event === "provider.background_task.recovered",
    );
    expect(recovered?.properties?.reason).toBe("prior-boot");
    expect(recovered?.properties).not.toHaveProperty("taskId");
    expect(recovered?.properties).not.toHaveProperty("threadId");
  });

  it("recovers a same-boot task whose session has died (dead-session)", async () => {
    const threadId = thread("dead-session");
    const { store, dispatched } = createHarness({
      rows: [row({ taskId: "task-dead", threadId, bootId: CURRENT_BOOT })],
      shells: new Map([[threadId, makeShell(threadId, { status: "stopped" })]]),
      options: { staleThresholdMs: 60 * 60 * 1000 },
    });
    await startWatchdog();
    await waitFor(() => dispatched.length > 0);
    expect(dispatched[0]?.text).toContain("session ended");
    await waitFor(() => store.size === 0);
  });

  it("recovers a same-boot, live-session task that has gone silent past the stale threshold", async () => {
    const threadId = thread("stale");
    const { store, dispatched, analyticsEvents } = createHarness({
      // lastSeenAt far in the past + small stale threshold → stale
      rows: [row({ taskId: "task-stale", threadId, lastSeenAt: "2020-01-01T00:00:00.000Z" })],
      shells: new Map([[threadId, makeShell(threadId, { status: "ready" })]]),
      options: { staleThresholdMs: 50 },
    });
    await startWatchdog();
    await waitFor(() => dispatched.length > 0);
    expect(dispatched[0]?.text).toContain("silent");
    await waitFor(() => store.size === 0);
    // The stale trip carries a real silence duration for threshold tuning.
    await waitFor(() =>
      analyticsEvents.some((e) => e.event === "provider.background_task.recovered"),
    );
    const recovered = analyticsEvents.find(
      (e) => e.event === "provider.background_task.recovered",
    );
    expect(recovered?.properties?.reason).toBe("stale");
    expect(typeof recovered?.properties?.silentMs).toBe("number");
  });

  it("leaves a fresh, same-boot, live-session task alone", async () => {
    const threadId = thread("fresh");
    const { store, dispatched } = createHarness({
      // lastSeenAt in the future → never stale regardless of wall-clock now
      rows: [row({ taskId: "task-fresh", threadId, lastSeenAt: "2999-01-01T00:00:00.000Z" })],
      shells: new Map([[threadId, makeShell(threadId, { status: "ready" })]]),
      options: { staleThresholdMs: 50 },
    });
    await startWatchdog();
    // give several sweeps a chance to run
    await Effect.runPromise(Effect.sleep("150 millis"));
    expect(dispatched.length).toBe(0);
    expect(store.size).toBe(1);
  });

  it("never interrupts a thread with an active turn, even when prior-boot", async () => {
    const threadId = thread("busy");
    const { store, dispatched } = createHarness({
      rows: [row({ taskId: "task-busy", threadId, bootId: "OLD-BOOT" })],
      shells: new Map([
        [threadId, makeShell(threadId, { status: "running", activeTurnId: TurnId.make("turn-1") })],
      ]),
    });
    await startWatchdog();
    await Effect.runPromise(Effect.sleep("150 millis"));
    expect(dispatched.length).toBe(0);
    expect(store.size).toBe(1);
  });

  it("never interrupts a thread with pending approvals", async () => {
    const threadId = thread("pending");
    const { dispatched } = createHarness({
      rows: [row({ taskId: "task-pending", threadId, bootId: "OLD-BOOT" })],
      shells: new Map([[threadId, makeShell(threadId, { status: "ready", hasPendingApprovals: true })]]),
    });
    await startWatchdog();
    await Effect.runPromise(Effect.sleep("150 millis"));
    expect(dispatched.length).toBe(0);
  });

  it("drops the row (no resume) when the thread is gone or archived", async () => {
    const missing = thread("missing");
    const archived = thread("archived");
    const { store, dispatched } = createHarness({
      rows: [
        row({ taskId: "task-missing", threadId: missing, bootId: "OLD-BOOT" }),
        row({ taskId: "task-archived", threadId: archived, bootId: "OLD-BOOT" }),
      ],
      shells: new Map([
        [archived, makeShell(archived, { status: "ready", archivedAt: "2026-01-02T00:00:00.000Z" })],
      ]),
    });
    await startWatchdog();
    await waitFor(() => store.size === 0);
    expect(dispatched.length).toBe(0);
  });

  it("gives up and drops the row after the recovery attempt cap, without resuming", async () => {
    const threadId = thread("giveup");
    const { store, dispatched, analyticsEvents } = createHarness({
      rows: [row({ taskId: "task-giveup", threadId, bootId: "OLD-BOOT", recoveryAttempts: 3 })],
      shells: new Map([[threadId, makeShell(threadId, { status: "ready" })]]),
      options: { maxRecoveryAttempts: 3, staleThresholdMs: 60 * 60 * 1000 },
    });
    await startWatchdog();
    await waitFor(() => store.size === 0);
    expect(dispatched.length).toBe(0);
    await waitFor(() =>
      analyticsEvents.some((e) => e.event === "provider.background_task.recovery_gave_up"),
    );
  });
});
