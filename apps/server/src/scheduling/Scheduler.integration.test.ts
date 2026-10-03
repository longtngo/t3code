import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Duration from "effect/Duration";
import * as Logger from "effect/Logger";
import { type ServerProvider } from "@t3tools/contracts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { makeCreditSpendGuard } from "../provider/Layers/CreditSpendGuardLive.ts";
import { assert, expect, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as UsageLimitRecoveryWorker from "../orchestration-v2/UsageLimitRecoveryWorker.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { creditSpendGuardAllowAll } from "../orchestration-v2/ProviderTurnStartService.testkit.ts";
import { CreditSpendGuard } from "../provider/Services/CreditSpendGuard.ts";
import * as Scheduler from "./Scheduler.ts";

it.effect.each(["on time", "after restart"])(
  "runs Scheduled Tasks and a persisted limit retry through the same scheduler %s",
  (scenario) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const resetAt = DateTime.formatIso(DateTime.add(now, { seconds: 60 }));
      const thread: OrchestrationV2ThreadShell = {
        id: ThreadId.make("thread:limited"),
        projectId: ProjectId.make("project:test"),
        title: "Limited",
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy: "user",
        creationSource: "web",
        branch: null,
        worktreePath: null,
        lineage: {
          rootThreadId: ThreadId.make("thread:limited"),
          parentThreadId: null,
          relationshipToParent: null,
        },
        forkedFrom: null,
        activeProviderThreadId: null,
        latestRunId: RunId.make("run:limited"),
        latestRunCompletedAt: now,
        activeRunId: null,
        status: "failed",
        lastErrorClass: "usage_limit",
        usageLimitResetAt: resetAt,
        pendingRuntimeRequest: null,
        latestVisibleMessage: null,
        latestUserMessageAt: now,
        hasActionableProposedPlan: false,
        itemCount: 1,
        visibleItemCount: 1,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        pinnedAt: null,
        deletedAt: null,
        limitRecovery: {
          runId: RunId.make("run:limited"),
          resetAt,
          autoResume: true,
          requestId: CommandId.make("recovery:choice"),
        },
      };
      if (scenario === "after restart") {
        yield* TestClock.adjust("65 seconds");
      }
      const current = yield* Ref.make(thread);
      const commands = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
      const receipts = yield* Queue.unbounded<"task" | "retry">();
      const dependencies = Layer.mergeAll(
        NodeCrypto.layer,
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          launch: () =>
            Queue.offer(receipts, "task").pipe(
              Effect.andThen(Effect.die("fixture dispatch failure")),
            ),
        }),
        creditSpendGuardAllowAll,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: () => Ref.get(current),
          dispatch: (command) =>
            Ref.update(commands, (all) => [...all, command]).pipe(
              Effect.andThen(
                Ref.update(current, (shell) => ({ ...shell, status: "running" as const })),
              ),
              Effect.andThen(Queue.offer(receipts, "retry")),
              Effect.as({ sequence: 1, storedEvents: [] }),
            ),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getLimitRecoveryCandidates: () =>
            Ref.get(current).pipe(
              Effect.map((shell) => (shell.status === "failed" ? [shell] : [])),
            ),
        }),
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        }),
      );
      const workers = Layer.mergeAll(
        ScheduledTasks.layer,
        UsageLimitRecoveryWorker.workerLive,
      ).pipe(Layer.provide(dependencies), Layer.provide(Scheduler.layer));
      yield* Effect.gen(function* () {
        const tasks = yield* ScheduledTasks.ScheduledTaskService;
        const { task } = yield* tasks.upsert({
          title: "Scheduled work",
          prompt: "Run scheduled work",
          enabled: true,
          schedule: { type: "interval", everyMs: 60_000 },
          projectId: thread.projectId,
          workspaceStrategy: { type: "root" },
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
        });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE scheduled_tasks SET next_run_at = ${resetAt} WHERE task_id = ${task.id}`;
        if (scenario === "on time") {
          yield* TestClock.adjust("55 seconds");
          assert.deepEqual(yield* Ref.get(commands), []);
        }
        yield* TestClock.adjust("5 seconds");
        assert.deepEqual([yield* Queue.take(receipts), yield* Queue.take(receipts)].sort(), [
          "retry",
          "task",
        ]);
        const delivered = yield* Ref.get(commands);
        assert.equal(delivered.length, 1);
        expect(delivered[0]).toMatchObject({
          type: "message.dispatch",
          usageLimitContinuationOfRunId: thread.latestRunId,
          usageLimitRecoveryRequestId: thread.limitRecovery!.requestId,
          text: "Continue where you left off.",
        });
      }).pipe(Effect.provide(workers));
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("retries a limit resume the credit gate refused once spending is allowed", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const resetAt = DateTime.formatIso(DateTime.add(now, { seconds: 60 }));
    const thread: OrchestrationV2ThreadShell = {
      id: ThreadId.make("thread:limited"),
      projectId: ProjectId.make("project:test"),
      title: "Limited",
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "user",
      creationSource: "web",
      branch: null,
      worktreePath: null,
      lineage: {
        rootThreadId: ThreadId.make("thread:limited"),
        parentThreadId: null,
        relationshipToParent: null,
      },
      forkedFrom: null,
      activeProviderThreadId: null,
      latestRunId: RunId.make("run:limited"),
      latestRunCompletedAt: now,
      activeRunId: null,
      status: "failed",
      lastErrorClass: "usage_limit",
      usageLimitResetAt: resetAt,
      pendingRuntimeRequest: null,
      latestVisibleMessage: null,
      latestUserMessageAt: now,
      hasActionableProposedPlan: false,
      itemCount: 1,
      visibleItemCount: 1,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      pinnedAt: null,
      deletedAt: null,
      limitRecovery: {
        runId: RunId.make("run:limited"),
        resetAt,
        autoResume: true,
        requestId: CommandId.make("recovery:choice"),
      },
    };
    const current = yield* Ref.make(thread);
    const commands = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
    const delivered = yield* Queue.unbounded<"retry">();
    const blocked = yield* Ref.make(true);
    const refusals = yield* Ref.make(0);
    const dependencies = Layer.mergeAll(
      Layer.succeed(
        CreditSpendGuard,
        CreditSpendGuard.of({
          // The recovery poller must not use the re-reading gate.
          refusalFor: () => Effect.die("recovery must use cachedRefusalFor"),
          cachedRefusalFor: () =>
            Ref.get(blocked).pipe(
              Effect.tap((isBlocked) =>
                isBlocked ? Ref.update(refusals, (n) => n + 1) : Effect.void,
              ),
              Effect.map((isBlocked) => (isBlocked ? "Codex is at 100%." : null)),
            ),
        }),
      ),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: () => Ref.get(current),
        dispatch: (command) =>
          Ref.update(commands, (all) => [...all, command]).pipe(
            Effect.andThen(Queue.offer(delivered, "retry")),
            Effect.as({ sequence: 1, storedEvents: [] }),
          ),
      }),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getLimitRecoveryCandidates: () => Ref.get(current).pipe(Effect.map((shell) => [shell])),
      }),
      Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
      }),
    );
    yield* Effect.gen(function* () {
      // Past the reset, but the gate still refuses: several sweeps run, none sends.
      yield* TestClock.adjust("75 seconds");
      assert.isAbove(yield* Ref.get(refusals), 1);
      assert.deepEqual(yield* Ref.get(commands), []);
      // Spending allowed again: the same thread is still a candidate and resumes.
      yield* Ref.set(blocked, false);
      yield* TestClock.adjust("5 seconds");
      assert.equal(yield* Queue.take(delivered), "retry");
      expect((yield* Ref.get(commands))[0]).toMatchObject({
        type: "message.dispatch",
        usageLimitContinuationOfRunId: thread.latestRunId,
      });
    }).pipe(
      Effect.provide(
        UsageLimitRecoveryWorker.workerLive.pipe(
          Layer.provide(dependencies),
          Layer.provide(Scheduler.layer),
        ),
      ),
    );
  }),
);

const claude = ProviderInstanceId.make("claude");
const FAR = "2099-01-01T00:00:00.000Z";

const shellFor = (id: string, now: DateTime.Utc, resetAt: string): OrchestrationV2ThreadShell =>
  ({
    id: ThreadId.make(id),
    projectId: ProjectId.make("project:test"),
    title: id,
    providerInstanceId: claude,
    modelSelection: { instanceId: claude, model: "claude" },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdBy: "user",
    creationSource: "web",
    branch: null,
    worktreePath: null,
    lineage: { rootThreadId: ThreadId.make(id), parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    activeProviderThreadId: null,
    latestRunId: RunId.make(`run:${id}`),
    latestRunCompletedAt: now,
    activeRunId: null,
    status: "failed",
    lastErrorClass: "usage_limit",
    usageLimitResetAt: resetAt,
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: now,
    hasActionableProposedPlan: false,
    itemCount: 1,
    visibleItemCount: 1,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    pinnedAt: null,
    deletedAt: null,
    limitRecovery: {
      runId: RunId.make(`run:${id}`),
      resetAt,
      autoResume: true,
      requestId: CommandId.make(`recovery:${id}`),
    },
  }) as OrchestrationV2ThreadShell;

it.effect(
  "a resume blocked for an hour by a full weekly window costs no usage reads, then resumes once",
  () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const resetAt = DateTime.formatIso(DateTime.add(now, { seconds: 60 }));
      const candidates = yield* Ref.make([
        shellFor("a", now, resetAt),
        shellFor("b", now, resetAt),
      ]);
      const commands = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
      const allow = yield* Ref.make(false);
      const freshReads = yield* Ref.make(0);
      const refusalCalls = yield* Ref.make(0);
      const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
      const providerAt = (checkedAt: string): ServerProvider =>
        ({
          instanceId: claude,
          driver: "claudeAgent",
          displayName: "Claude",
          enabled: true,
          installed: true,
          checkedAt,
          usageLimits: {
            checkedAt,
            windows: [
              { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 100, resetsAt: FAR },
            ],
          },
        }) as unknown as ServerProvider;
      const published = yield* Ref.make([providerAt(DateTime.formatIso(now))]);
      const registry = Layer.mock(ProviderRegistry)({
        getProviders: Ref.get(published),
        refreshInstance: () =>
          Effect.gen(function* () {
            yield* Ref.update(freshReads, (n) => n + 1);
            yield* Effect.sleep(Duration.millis(500));
            const next = [providerAt(yield* nowIso)];
            yield* Ref.set(published, next);
            return next;
          }),
      });
      const settings = Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Ref.get(allow).pipe(
          Effect.map((a) => ({ ...DEFAULT_SERVER_SETTINGS, allowSpendingCredits: a })),
        ),
      });
      const guardLayer = Layer.effect(CreditSpendGuard, makeCreditSpendGuard()).pipe(
        Layer.provide(registry),
        Layer.provide(settings),
      );
      const countingGuard = Layer.effect(
        CreditSpendGuard,
        Effect.gen(function* () {
          const inner = yield* CreditSpendGuard;
          return CreditSpendGuard.of({
            refusalFor: (id) =>
              Ref.update(refusalCalls, (n) => n + 1).pipe(Effect.andThen(inner.refusalFor(id))),
            cachedRefusalFor: inner.cachedRefusalFor,
          });
        }),
      ).pipe(Layer.provide(guardLayer));
      let refusalLogs = 0;
      const logCounter = Logger.make(({ message }) => {
        if (String(message).includes("credit")) refusalLogs += 1;
      });
      const deps = Layer.mergeAll(
        countingGuard,
        settings,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: (threadId) =>
            Ref.get(candidates).pipe(Effect.map((all) => all.find((t) => t.id === threadId)!)),
          dispatch: (command) =>
            Ref.update(commands, (all) => [...all, command]).pipe(
              // The real projection stops listing a thread once its resume run exists.
              Effect.andThen(
                Ref.update(candidates, (all) =>
                  all.filter((t) => !("threadId" in command) || t.id !== command.threadId),
                ),
              ),
              Effect.as({ sequence: 1, storedEvents: [] }),
            ),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getLimitRecoveryCandidates: () => Ref.get(candidates),
        }),
      );
      yield* Effect.gen(function* () {
        yield* TestClock.adjust("60 minutes");
        const hour = {
          refusalCalls: yield* Ref.get(refusalCalls),
          freshReads: yield* Ref.get(freshReads),
          dispatched: (yield* Ref.get(commands)).length,
        };
        assert.equal(hour.dispatched, 0);
        // Blocked for an hour of 5 s sweeps: no fresh usage read, no turn-start gate call,
        // and the refusal logged once per thread rather than every sweep.
        assert.equal(hour.freshReads, 0);
        assert.equal(hour.refusalCalls, 0);
        assert.equal(refusalLogs, 2);
        yield* Ref.set(allow, true);
        yield* TestClock.adjust("60 seconds");
        const after = (yield* Ref.get(commands)).map(
          (c) => `${c.type}:${"threadId" in c ? c.threadId : ""}`,
        );
        assert.deepEqual(after.sort(), ["message.dispatch:a", "message.dispatch:b"]);
      }).pipe(
        Effect.provide(
          UsageLimitRecoveryWorker.workerLive.pipe(
            Layer.provide(deps),
            Layer.provide(Scheduler.layer),
            Layer.provide(Logger.layer([logCounter], { mergeWithExisting: false })),
          ),
        ),
      );
    }),
);
