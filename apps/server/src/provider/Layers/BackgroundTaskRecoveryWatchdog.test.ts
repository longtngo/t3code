import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, RuntimeTaskId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

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
    hasPendingBackgroundTask: false,
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

// Effect-based poll on the live wall clock, mirroring the original async
// `waitFor`: yields the fiber so the forked sweep loop can make progress, and
// fails once the deadline passes.
const waitFor = (predicate: () => boolean, timeoutMs = 2_000): Effect.Effect<void> =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs;
    while (!predicate()) {
      if ((yield* Clock.currentTimeMillis) >= deadline) {
        throw new Error("Timed out waiting for expectation.");
      }
      yield* Effect.yieldNow;
    }
  });

describe("BackgroundTaskRecoveryWatchdog", () => {
  function createHarness(input: {
    readonly rows: ReadonlyArray<PendingBackgroundTask>;
    readonly shells: Map<ThreadId, ReturnType<typeof makeShell>>;
    readonly options?: BackgroundTaskRecoveryWatchdogLiveOptions;
    // When set, `dispatch` records the attempt and then fails. Without this the
    // fake engine can never fail, which makes every assertion about the
    // dispatch-failure path vacuous.
    readonly dispatchFails?: boolean;
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
      deleteByThreadId: ({ threadId }: { threadId: ThreadId }) =>
        Effect.sync(() => {
          for (const [id, row] of store) {
            if (row.threadId === threadId) store.delete(id);
          }
        }),
    });

    const engine = {
      readEvents: () => Stream.empty,
      streamDomainEvents: Stream.empty,
      dispatch: (command: { type: string; threadId: ThreadId; message?: { text?: string } }) =>
        Effect.suspend(() => {
          dispatched.push({
            type: command.type,
            threadId: command.threadId,
            ...(command.message?.text ? { text: command.message.text } : {}),
          });
          return input.dispatchFails
            ? Effect.die(new Error("dispatch failed"))
            : Effect.succeed({ sequence: dispatched.length });
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

    return { store, dispatched, analyticsEvents, layer };
  }

  // Resolve the watchdog service and start its sweep loop inside the test's
  // scope (provided by `it.live`'s `Effect.scoped`), so the forked sweep fiber
  // is interrupted and cleaned up automatically when the test completes.
  const startWatchdog = Effect.gen(function* () {
    const watchdog = yield* BackgroundTaskRecoveryWatchdog;
    yield* watchdog.start();
  });

  const thread = (suffix: string) => ThreadId.make(`thread-${suffix}`);

  it.live(
    "recovers a prior-boot (reboot-orphaned) task: resumes the thread and clears the row",
    () => {
      const threadId = thread("prior-boot");
      const { store, dispatched, analyticsEvents, layer } = createHarness({
        rows: [row({ taskId: "task-prior", threadId, bootId: "OLD-BOOT" })],
        shells: new Map([[threadId, makeShell(threadId, { status: "ready" })]]),
        // huge stale threshold so only the prior-boot trigger can fire
        options: { staleThresholdMs: 60 * 60 * 1000 },
      });
      return Effect.gen(function* () {
        yield* startWatchdog;
        yield* waitFor(() => dispatched.length > 0);
        expect(dispatched[0]?.type).toBe("thread.turn.start");
        expect(dispatched[0]?.threadId).toBe(threadId);
        expect(dispatched[0]?.text).toContain("restarted");
        yield* waitFor(() => store.size === 0);
        // Anonymous trip telemetry fired (no thread/task identifiers).
        yield* waitFor(() =>
          analyticsEvents.some((e) => e.event === "provider.background_task.recovered"),
        );
        const recovered = analyticsEvents.find(
          (e) => e.event === "provider.background_task.recovered",
        );
        expect(recovered?.properties?.reason).toBe("prior-boot");
        expect(recovered?.properties).not.toHaveProperty("taskId");
        expect(recovered?.properties).not.toHaveProperty("threadId");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("recovers a same-boot task whose session has died (dead-session)", () => {
    const threadId = thread("dead-session");
    const { store, dispatched, layer } = createHarness({
      rows: [row({ taskId: "task-dead", threadId, bootId: CURRENT_BOOT })],
      shells: new Map([[threadId, makeShell(threadId, { status: "stopped" })]]),
      options: { staleThresholdMs: 60 * 60 * 1000 },
    });
    return Effect.gen(function* () {
      yield* startWatchdog;
      yield* waitFor(() => dispatched.length > 0);
      expect(dispatched[0]?.text).toContain("session ended");
      yield* waitFor(() => store.size === 0);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "recovers a same-boot, live-session task that has gone silent past the stale threshold",
    () => {
      const threadId = thread("stale");
      const { store, dispatched, analyticsEvents, layer } = createHarness({
        // lastSeenAt far in the past + small stale threshold → stale
        rows: [row({ taskId: "task-stale", threadId, lastSeenAt: "2020-01-01T00:00:00.000Z" })],
        shells: new Map([[threadId, makeShell(threadId, { status: "ready" })]]),
        options: { staleThresholdMs: 50 },
      });
      return Effect.gen(function* () {
        yield* startWatchdog;
        yield* waitFor(() => dispatched.length > 0);
        expect(dispatched[0]?.text).toContain("silent");
        yield* waitFor(() => store.size === 0);
        // The stale trip carries a real silence duration for threshold tuning.
        yield* waitFor(() =>
          analyticsEvents.some((e) => e.event === "provider.background_task.recovered"),
        );
        const recovered = analyticsEvents.find(
          (e) => e.event === "provider.background_task.recovered",
        );
        expect(recovered?.properties?.reason).toBe("stale");
        expect(typeof recovered?.properties?.silentMs).toBe("number");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("leaves a fresh, same-boot, live-session task alone", () => {
    const threadId = thread("fresh");
    const { store, dispatched, layer } = createHarness({
      // lastSeenAt in the future → never stale regardless of wall-clock now
      rows: [row({ taskId: "task-fresh", threadId, lastSeenAt: "2999-01-01T00:00:00.000Z" })],
      shells: new Map([[threadId, makeShell(threadId, { status: "ready" })]]),
      options: { staleThresholdMs: 50 },
    });
    return Effect.gen(function* () {
      yield* startWatchdog;
      // give several sweeps a chance to run
      yield* Effect.sleep("150 millis");
      expect(dispatched.length).toBe(0);
      expect(store.size).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("never interrupts a thread with an active turn, even when prior-boot", () => {
    const threadId = thread("busy");
    const { store, dispatched, layer } = createHarness({
      rows: [row({ taskId: "task-busy", threadId, bootId: "OLD-BOOT" })],
      shells: new Map([
        [threadId, makeShell(threadId, { status: "running", activeTurnId: TurnId.make("turn-1") })],
      ]),
    });
    return Effect.gen(function* () {
      yield* startWatchdog;
      yield* Effect.sleep("150 millis");
      expect(dispatched.length).toBe(0);
      expect(store.size).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("never interrupts a thread with pending approvals", () => {
    const threadId = thread("pending");
    const { dispatched, layer } = createHarness({
      rows: [row({ taskId: "task-pending", threadId, bootId: "OLD-BOOT" })],
      shells: new Map([
        [threadId, makeShell(threadId, { status: "ready", hasPendingApprovals: true })],
      ]),
    });
    return Effect.gen(function* () {
      yield* startWatchdog;
      yield* Effect.sleep("150 millis");
      expect(dispatched.length).toBe(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("drops the row (no resume) when the thread is gone or archived", () => {
    const missing = thread("missing");
    const archived = thread("archived");
    const { store, dispatched, layer } = createHarness({
      rows: [
        row({ taskId: "task-missing", threadId: missing, bootId: "OLD-BOOT" }),
        row({ taskId: "task-archived", threadId: archived, bootId: "OLD-BOOT" }),
      ],
      shells: new Map([
        [
          archived,
          makeShell(archived, { status: "ready", archivedAt: "2026-01-02T00:00:00.000Z" }),
        ],
      ]),
    });
    return Effect.gen(function* () {
      yield* startWatchdog;
      yield* waitFor(() => store.size === 0);
      expect(dispatched.length).toBe(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("gives up and drops the row after the recovery attempt cap, without resuming", () => {
    const threadId = thread("giveup");
    const { store, dispatched, analyticsEvents, layer } = createHarness({
      rows: [row({ taskId: "task-giveup", threadId, bootId: "OLD-BOOT", recoveryAttempts: 3 })],
      shells: new Map([[threadId, makeShell(threadId, { status: "ready" })]]),
      options: { maxRecoveryAttempts: 3, staleThresholdMs: 60 * 60 * 1000 },
    });
    return Effect.gen(function* () {
      yield* startWatchdog;
      yield* waitFor(() => store.size === 0);
      expect(dispatched.length).toBe(0);
      yield* waitFor(() =>
        analyticsEvents.some((e) => e.event === "provider.background_task.recovery_gave_up"),
      );
    }).pipe(Effect.provide(layer));
  });

  // Regression for the 2026-08-08 incident: three orphaned tasks on ONE thread
  // must produce exactly ONE turn-start. The harness reproduces the condition
  // that caused it — `getThreadShellById` keeps returning `activeTurnId: null`
  // after a dispatch, exactly as the real projection does until the provider
  // emits its turn-started event.
  //
  // `sweepIntervalMs` is past the test's lifetime so the sweep runs once: what
  // is measured is one sweep's behaviour, not a race against the next one.
  it.live("recovers every orphaned task on a thread with a single turn", () => {
    const threadId = thread("multi-task");
    const { store, dispatched, layer } = createHarness({
      rows: [
        row({ taskId: "task-a", threadId, bootId: "OLD-BOOT" }),
        row({ taskId: "task-b", threadId, bootId: "OLD-BOOT" }),
        row({ taskId: "task-c", threadId, bootId: "OLD-BOOT" }),
      ],
      shells: new Map([[threadId, makeShell(threadId, { status: "ready" })]]),
      options: { sweepIntervalMs: 60_000, staleThresholdMs: 60 * 60 * 1000 },
    });
    return Effect.gen(function* () {
      yield* startWatchdog;
      yield* waitFor(() => dispatched.length > 0);
      // Settle before asserting. Asserting on `store.size` alone would be a coin
      // flip: the buggy version passes through intermediate sizes on its way to
      // 0, so a well-timed poll could see a "correct" value and pass against the
      // very bug this test exists to catch. The buggy sweep issues all three
      // dispatches within a few ms, so a settle window makes it deterministic.
      yield* Effect.sleep("250 millis");
      expect(dispatched.length).toBe(1);
      expect(dispatched[0]?.threadId).toBe(threadId);
      // No row may be left behind: a single turn must account for all three, or
      // the leftovers come back on a later sweep and re-open the race.
      expect(store.size).toBe(0);
      for (const taskId of ["task-a", "task-b", "task-c"]) {
        expect(dispatched[0]?.text).toContain(taskId);
      }
    }).pipe(Effect.provide(layer));
  });

  // Guards against a one-recovery-per-SWEEP fix: independent threads share no
  // turn state and must still recover in the same pass.
  it.live("still recovers separate threads in the same sweep", () => {
    const first = thread("independent-a");
    const second = thread("independent-b");
    const { store, dispatched, layer } = createHarness({
      rows: [
        row({ taskId: "task-first", threadId: first, bootId: "OLD-BOOT" }),
        row({ taskId: "task-second", threadId: second, bootId: "OLD-BOOT" }),
      ],
      shells: new Map([
        [first, makeShell(first, { status: "ready" })],
        [second, makeShell(second, { status: "ready" })],
      ]),
      options: { sweepIntervalMs: 60_000, staleThresholdMs: 60 * 60 * 1000 },
    });
    return Effect.gen(function* () {
      yield* startWatchdog;
      yield* waitFor(() => store.size === 0);
      expect(dispatched.length).toBe(2);
      expect(dispatched.map((d) => d.threadId).sort()).toEqual([first, second].sort());
    }).pipe(Effect.provide(layer));
  });

  // `starting` is the window the incident actually exploited: the reactor's
  // first write after a turn-start is `status:"starting"` with
  // `activeTurnId:null`, so a guard keyed only on `activeTurnId` reads it as
  // idle and starts a second turn. Prior-boot rows make this sharpest, since
  // their reason short-circuits before session status is consulted at all.
  it.live("treats a starting session as busy, not idle", () => {
    const threadId = thread("starting");
    const { store, dispatched, layer } = createHarness({
      rows: [row({ taskId: "task-starting", threadId, bootId: "OLD-BOOT" })],
      shells: new Map([[threadId, makeShell(threadId, { status: "starting" })]]),
      options: { sweepIntervalMs: 60_000, staleThresholdMs: 60 * 60 * 1000 },
    });
    return Effect.gen(function* () {
      yield* startWatchdog;
      yield* Effect.sleep("250 millis");
      expect(dispatched.length).toBe(0);
      // The row survives for a later sweep rather than being dropped.
      expect(store.size).toBe(1);
      expect(store.get("task-starting")?.recoveryAttempts).toBe(0);
    }).pipe(Effect.provide(layer));
  });

  // A dispatch that fails may still have landed server-side, so the rows must
  // survive with their attempts bumped — and the sweep must not retry them
  // immediately, which would be the concurrent-turn bug all over again.
  it.live("keeps rows, bumps attempts, and does not re-dispatch when dispatch fails", () => {
    const threadId = thread("dispatch-fails");
    const { store, dispatched, layer } = createHarness({
      rows: [
        row({ taskId: "task-x", threadId, bootId: "OLD-BOOT" }),
        row({ taskId: "task-y", threadId, bootId: "OLD-BOOT" }),
      ],
      shells: new Map([[threadId, makeShell(threadId, { status: "ready" })]]),
      options: { sweepIntervalMs: 60_000, staleThresholdMs: 60 * 60 * 1000 },
      dispatchFails: true,
    });
    return Effect.gen(function* () {
      yield* startWatchdog;
      yield* waitFor(() => dispatched.length > 0);
      yield* Effect.sleep("250 millis");
      expect(dispatched.length).toBe(1);
      expect(store.size).toBe(2);
      for (const remaining of store.values()) {
        expect(remaining.recoveryAttempts).toBe(1);
      }
    }).pipe(Effect.provide(layer));
  });

  // Give-up must not be blocked by a sibling recovering on the same thread,
  // or a dead row's lifetime would stop being bounded by the attempt cap.
  it.live("gives up on a capped row while recovering its sibling in the same sweep", () => {
    const threadId = thread("mixed-cap");
    const { store, dispatched, analyticsEvents, layer } = createHarness({
      rows: [
        row({ taskId: "task-capped", threadId, bootId: "OLD-BOOT", recoveryAttempts: 3 }),
        row({ taskId: "task-fresh", threadId, bootId: "OLD-BOOT" }),
      ],
      shells: new Map([[threadId, makeShell(threadId, { status: "ready" })]]),
      options: { sweepIntervalMs: 60_000, staleThresholdMs: 60 * 60 * 1000, maxRecoveryAttempts: 3 },
    });
    return Effect.gen(function* () {
      yield* startWatchdog;
      yield* waitFor(() => store.size === 0);
      expect(dispatched.length).toBe(1);
      // Only the recoverable row is named; the capped one was dropped, not resumed.
      expect(dispatched[0]?.text).toContain("task-fresh");
      expect(dispatched[0]?.text).not.toContain("task-capped");
      expect(
        analyticsEvents.some((e) => e.event === "provider.background_task.recovery_gave_up"),
      ).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});
