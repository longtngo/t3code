import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
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
import { AnalyticsService } from "../../telemetry/Services/AnalyticsService.ts";
import {
  ProviderRuntimeIngestionService,
  type TurnActivitySnapshot,
} from "../../orchestration/Services/ProviderRuntimeIngestion.ts";
import { ProviderTurnStallWatchdog } from "../Services/ProviderTurnStallWatchdog.ts";
import {
  makeProviderTurnStallWatchdogLive,
  type ProviderTurnStallWatchdogLiveOptions,
} from "./ProviderTurnStallWatchdog.ts";

const defaultModelSelection = {
  instanceId: "claude" as never,
  model: "claude-opus-4-8",
} as const;

const projectId = ProjectId.make("project-stall-watchdog");

type SessionStatus = "starting" | "running" | "ready" | "interrupted" | "stopped" | "error";

interface ShellSeed {
  readonly status: SessionStatus;
  readonly activeTurnId: TurnId | null;
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
    messages: [],
    session: {
      threadId,
      status: seed.status,
      providerName: "claudeAgent" as const,
      runtimeMode: "full-access" as const,
      activeTurnId: seed.activeTurnId,
      lastError: null,
      updatedAt: now,
    },
    activities: [],
    proposedPlans: [],
    checkpoints: [],
    deletedAt: null,
  };
}

const drainFibers = Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, {
  discard: true,
});

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async (): Promise<void> => {
    if (await predicate()) {
      return;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error("Timed out waiting for expectation.");
    }
    await Effect.runPromise(Effect.yieldNow);
    return poll();
  };
  return poll();
}

describe("ProviderTurnStallWatchdog", () => {
  let runtime: ManagedRuntime.ManagedRuntime<ProviderTurnStallWatchdog, unknown> | null = null;
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
    readonly activity: Map<ThreadId, TurnActivitySnapshot>;
    readonly shells: Map<ThreadId, ReturnType<typeof makeShell>>;
    readonly options?: ProviderTurnStallWatchdogLiveOptions;
    // Simulates the SDK auto-starting the resumed turn after a forceful stop.
    readonly onTurnStart?: (threadId: ThreadId) => void;
  }) {
    const dispatched: Array<{ type: string; threadId: ThreadId; tone?: string }> = [];

    const engine = {
      readEvents: () => Stream.empty,
      streamDomainEvents: Stream.empty,
      dispatch: (command: { type: string; threadId: ThreadId; activity?: { tone?: string } }) =>
        Effect.sync(() => {
          dispatched.push({
            type: command.type,
            threadId: command.threadId,
            ...(command.activity?.tone ? { tone: command.activity.tone } : {}),
          });
          // Simulate the reactor: a forceful stop tears the session down and the
          // ingestion tracker drops the (now terminal) turn's activity entry.
          if (command.type === "thread.session.stop") {
            const shell = input.shells.get(command.threadId);
            if (shell) {
              input.shells.set(command.threadId, {
                ...shell,
                session: { ...shell.session, status: "stopped", activeTurnId: null },
              });
            }
            input.activity.delete(command.threadId);
          }
          if (command.type === "thread.turn.start") {
            input.onTurnStart?.(command.threadId);
          }
          return { sequence: dispatched.length };
        }),
    };

    const ingestion = {
      start: () => Effect.void,
      drain: Effect.void,
      listTurnActivity: Effect.sync(() => Array.from(input.activity.values())),
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

    const layer = makeProviderTurnStallWatchdogLive({
      stallThresholdMs: 1_000,
      sweepIntervalMs: 20,
      stopGraceMs: 60_000,
      ...input.options,
    }).pipe(
      Layer.provideMerge(Layer.succeed(OrchestrationEngineService, engine as never)),
      Layer.provideMerge(Layer.succeed(ProviderRuntimeIngestionService, ingestion as never)),
      Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery, projection as never)),
      Layer.provideMerge(analytics),
      Layer.provideMerge(NodeServices.layer),
    );

    runtime = ManagedRuntime.make(layer);
    return { dispatched, analyticsEvents };
  }

  async function startWatchdog() {
    const watchdog = await runtime!.runPromise(Effect.service(ProviderTurnStallWatchdog));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(watchdog.start().pipe(Scope.provide(scope)));
  }

  const nowMillis = () => Effect.runPromise(Clock.currentTimeMillis);

  function staleEntry(
    threadId: ThreadId,
    turnId: TurnId,
    nowMs: number,
    overrides?: Partial<TurnActivitySnapshot>,
  ): TurnActivitySnapshot {
    return {
      threadId,
      turnId,
      lastEventAt: nowMs - 60_000,
      lastEventType: "item.completed",
      synthetic: false,
      ...overrides,
    };
  }

  it("stops then resumes a stalled active turn", async () => {
    const threadId = ThreadId.make("thread-stall-happy");
    const turnId = TurnId.make("turn-stall-happy");
    const nowMs = await nowMillis();
    const harness = createHarness({
      activity: new Map([[threadId, staleEntry(threadId, turnId, nowMs)]]),
      shells: new Map([[threadId, makeShell(threadId, { status: "running", activeTurnId: turnId })]]),
    });

    await startWatchdog();

    await waitFor(() => harness.dispatched.some((c) => c.type === "thread.turn.start"));

    const types = harness.dispatched.map((c) => c.type);
    expect(types).toContain("thread.activity.append");
    expect(types).toContain("thread.session.stop");
    expect(types).toContain("thread.turn.start");
    // stop must precede the resume (turn.start queues behind an active turn).
    expect(types.indexOf("thread.session.stop")).toBeLessThan(types.indexOf("thread.turn.start"));
    // Anonymous trip telemetry fired with the silence duration (no identifiers).
    const trip = harness.analyticsEvents.find(
      (e) => e.event === "provider.turn_stall.recovered",
    );
    expect(trip).toBeDefined();
    expect(typeof trip?.properties?.silentMs).toBe("number");
    expect(trip?.properties).not.toHaveProperty("threadId");
  });

  it("does not trip while a foreground tool is in flight (last event item.started)", async () => {
    const threadId = ThreadId.make("thread-stall-inflight");
    const turnId = TurnId.make("turn-stall-inflight");
    const nowMs = await nowMillis();
    const harness = createHarness({
      activity: new Map([
        [threadId, staleEntry(threadId, turnId, nowMs, { lastEventType: "item.started" })],
      ]),
      shells: new Map([[threadId, makeShell(threadId, { status: "running", activeTurnId: turnId })]]),
    });

    await startWatchdog();
    await Effect.runPromise(drainFibers);
    await Effect.runPromise(drainFibers);

    expect(harness.dispatched.some((c) => c.type === "thread.session.stop")).toBe(false);
  });

  it("does not trip a synthetic (background) turn", async () => {
    const threadId = ThreadId.make("thread-stall-synthetic");
    const turnId = TurnId.make("turn-stall-synthetic");
    const nowMs = await nowMillis();
    const harness = createHarness({
      activity: new Map([[threadId, staleEntry(threadId, turnId, nowMs, { synthetic: true })]]),
      shells: new Map([[threadId, makeShell(threadId, { status: "running", activeTurnId: turnId })]]),
    });

    await startWatchdog();
    await Effect.runPromise(drainFibers);
    await Effect.runPromise(drainFibers);

    expect(harness.dispatched.some((c) => c.type === "thread.session.stop")).toBe(false);
  });

  it("does not trip when the turn is fresh (within the threshold)", async () => {
    const threadId = ThreadId.make("thread-stall-fresh");
    const turnId = TurnId.make("turn-stall-fresh");
    const nowMs = await nowMillis();
    const harness = createHarness({
      activity: new Map([
        [threadId, staleEntry(threadId, turnId, nowMs, { lastEventAt: nowMs })],
      ]),
      shells: new Map([[threadId, makeShell(threadId, { status: "running", activeTurnId: turnId })]]),
    });

    await startWatchdog();
    await Effect.runPromise(drainFibers);
    await Effect.runPromise(drainFibers);

    expect(harness.dispatched.some((c) => c.type === "thread.session.stop")).toBe(false);
  });

  it("does not trip when the thread is waiting on the user", async () => {
    const threadId = ThreadId.make("thread-stall-pending");
    const turnId = TurnId.make("turn-stall-pending");
    const nowMs = await nowMillis();
    const harness = createHarness({
      activity: new Map([[threadId, staleEntry(threadId, turnId, nowMs)]]),
      shells: new Map([
        [
          threadId,
          makeShell(threadId, {
            status: "running",
            activeTurnId: turnId,
            hasPendingApprovals: true,
          }),
        ],
      ]),
    });

    await startWatchdog();
    await Effect.runPromise(drainFibers);
    await Effect.runPromise(drainFibers);

    expect(harness.dispatched.some((c) => c.type === "thread.session.stop")).toBe(false);
  });

  it("does not trip when the tracked turn differs from the projection's active turn", async () => {
    const threadId = ThreadId.make("thread-stall-transition");
    const nowMs = await nowMillis();
    const harness = createHarness({
      activity: new Map([
        [threadId, staleEntry(threadId, TurnId.make("turn-old"), nowMs)],
      ]),
      shells: new Map([
        [
          threadId,
          makeShell(threadId, { status: "running", activeTurnId: TurnId.make("turn-new") }),
        ],
      ]),
    });

    await startWatchdog();
    await Effect.runPromise(drainFibers);
    await Effect.runPromise(drainFibers);

    expect(harness.dispatched.some((c) => c.type === "thread.session.stop")).toBe(false);
  });

  it("gives up with an error activity after exhausting recovery attempts", async () => {
    const threadId = ThreadId.make("thread-stall-giveup");
    const activity = new Map<ThreadId, TurnActivitySnapshot>();
    const shells = new Map<ThreadId, ReturnType<typeof makeShell>>();
    const firstTurn = TurnId.make("turn-giveup-1");
    const nowMs = await nowMillis();
    activity.set(threadId, staleEntry(threadId, firstTurn, nowMs));
    shells.set(threadId, makeShell(threadId, { status: "running", activeTurnId: firstTurn }));

    let resumeCount = 0;
    const harness = createHarness({
      activity,
      shells,
      options: { maxRecoveryAttempts: 1 },
      // The resumed turn itself immediately re-stalls (new turn id, no activity).
      onTurnStart: (resumedThreadId) => {
        resumeCount += 1;
        const resumedTurn = TurnId.make(`turn-giveup-resumed-${resumeCount}`);
        shells.set(
          resumedThreadId,
          makeShell(resumedThreadId, { status: "running", activeTurnId: resumedTurn }),
        );
        activity.set(resumedThreadId, staleEntry(resumedThreadId, resumedTurn, nowMs));
      },
    });

    await startWatchdog();

    // After attempt 1 recovers and the resumed turn re-stalls, the cap (1) is
    // exceeded and the watchdog gives up with an error activity.
    await waitFor(() =>
      harness.dispatched.some((c) => c.type === "thread.activity.append"),
    );
    await waitFor(() => {
      const stops = harness.dispatched.filter((c) => c.type === "thread.session.stop");
      const starts = harness.dispatched.filter((c) => c.type === "thread.turn.start");
      return stops.length === 1 && starts.length === 1;
    });
    // Give a few more sweeps to prove it does NOT keep stopping/resuming.
    await Effect.runPromise(drainFibers);
    await Effect.runPromise(drainFibers);

    expect(harness.dispatched.filter((c) => c.type === "thread.session.stop").length).toBe(1);
    expect(harness.dispatched.filter((c) => c.type === "thread.turn.start").length).toBe(1);
    expect(resumeCount).toBe(1);
  });

  it("resumes protecting a thread when a new turn appears after giving up", async () => {
    const threadId = ThreadId.make("thread-stall-unmute");
    const activity = new Map<ThreadId, TurnActivitySnapshot>();
    const shells = new Map<ThreadId, ReturnType<typeof makeShell>>();
    const firstTurn = TurnId.make("turn-unmute-1");
    const nowMs = await nowMillis();
    activity.set(threadId, staleEntry(threadId, firstTurn, nowMs));
    shells.set(threadId, makeShell(threadId, { status: "running", activeTurnId: firstTurn }));

    let resumeCount = 0;
    // The watchdog-resumed turn re-stalls, forcing a give-up at cap 1.
    const harness = createHarness({
      activity,
      shells,
      options: { maxRecoveryAttempts: 1 },
      onTurnStart: (tid) => {
        resumeCount += 1;
        const resumed = TurnId.make(`turn-unmute-resumed-${resumeCount}`);
        shells.set(tid, makeShell(tid, { status: "running", activeTurnId: resumed }));
        activity.set(tid, staleEntry(tid, resumed, nowMs));
      },
    });

    await startWatchdog();

    // Wait for the give-up (error-tone activity).
    await waitFor(() => harness.dispatched.some((c) => c.tone === "error"));
    expect(harness.dispatched.filter((c) => c.type === "thread.session.stop").length).toBe(1);

    // The user manually continues — a genuinely different turn id appears.
    const userTurn = TurnId.make("turn-unmute-user");
    shells.set(threadId, makeShell(threadId, { status: "running", activeTurnId: userTurn }));
    activity.set(threadId, staleEntry(threadId, userTurn, nowMs));

    // The watchdog un-mutes and protects the new turn (a second stop).
    await waitFor(
      () => harness.dispatched.filter((c) => c.type === "thread.session.stop").length >= 2,
    );
  });
});
