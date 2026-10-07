import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Duration from "effect/Duration";
import * as Logger from "effect/Logger";
import { type ServerProvider } from "@t3tools/contracts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
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
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as UsageLimitRecoveryWorker from "../orchestration-v2/UsageLimitRecoveryWorker.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
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
      const layerDependencies = Layer.mergeAll(
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
        Layer.mock(SecretRequests.SecretRequests)({}),
      );
      const layerWorkers = Layer.mergeAll(
        ScheduledTasks.layer,
        UsageLimitRecoveryWorker.layer,
      ).pipe(Layer.provide(layerDependencies), Layer.provide(Scheduler.layer));
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
      }).pipe(Effect.provide(layerWorkers));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
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
          refusalFor: () => Effect.die("recovery must use resumeCheck"),
          // While the published reading blocks, the poller must not reach the re-reading gate.
          resumeCheck: () =>
            Ref.get(blocked).pipe(
              Effect.flatMap((isBlocked) =>
                isBlocked
                  ? Effect.die("blocked resume reached the full gate")
                  : Effect.succeed({ refusal: null, inconclusive: false }),
              ),
            ),
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
        UsageLimitRecoveryWorker.layer.pipe(
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
            resumeCheck: (id) =>
              Ref.update(refusalCalls, (n) => n + 1).pipe(Effect.andThen(inner.resumeCheck(id))),
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
          UsageLimitRecoveryWorker.layer.pipe(
            Layer.provide(deps),
            Layer.provide(Scheduler.layer),
            Layer.provide(Logger.layer([logCounter], { mergeWithExisting: false })),
          ),
        ),
      );
    }),
);

const reading = (
  checkedAt: string,
  usedPercent: number,
  resetsAt: string | undefined,
): ServerProvider =>
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
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          usedPercent,
          ...(resetsAt === undefined ? {} : { resetsAt }),
        },
      ],
    },
  }) as unknown as ServerProvider;

/**
 * Harness. `published` is what the registry publishes; `truth` is what a fresh read returns.
 * dispatch models the real chain: the run's turn start asks the real gate (refusalFor); a
 * refusal fails the run as permission_error, which drops the thread from recovery for good
 * (ProjectionStore: candidates require the latest run's failure class to be usage_limit).
 */
const recoveryHarness = (input: {
  threads: ReadonlyArray<string>;
  published: (nowIso: string) => ServerProvider;
  truth: (nowIso: string) => ServerProvider;
  dispatchFails?: Ref.Ref<boolean>;
  /**
   * Per fresh read, in order (the last repeats): "ok" returns `truth` at once, "fail"
   * dies, and a number waits that many ms before returning `truth`. Default "ok".
   */
  reads?: ReadonlyArray<"ok" | "fail" | number>;
}) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const resetAt = DateTime.formatIso(DateTime.add(now, { seconds: 60 }));
    const candidates = yield* Ref.make(input.threads.map((id) => shellFor(id, now, resetAt)));
    const outcomes = yield* Ref.make<Array<string>>([]);
    const allow = yield* Ref.make(false);
    const freshReads = yield* Ref.make(0);
    const gateCalls = yield* Ref.make({ cached: 0, full: 0 });
    const logs: Array<string> = [];
    const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
    const published = yield* Ref.make([input.published(DateTime.formatIso(now))]);
    const registry = Layer.mock(ProviderRegistry)({
      getProviders: Ref.get(published),
      refreshInstance: () =>
        Effect.gen(function* () {
          const n = yield* Ref.updateAndGet(freshReads, (k) => k + 1);
          const plan = input.reads?.[Math.min(n - 1, input.reads.length - 1)] ?? "ok";
          if (typeof plan === "number") yield* Effect.sleep(Duration.millis(plan));
          yield* Effect.yieldNow;
          if (plan === "fail") return yield* Effect.die("probe failed");
          const next = [input.truth(yield* nowIso)];
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
    const counting = Layer.effect(
      CreditSpendGuard,
      Effect.gen(function* () {
        const inner = yield* CreditSpendGuard;
        return CreditSpendGuard.of({
          refusalFor: (id) =>
            Ref.update(gateCalls, (c) => ({ ...c, full: c.full + 1 })).pipe(
              Effect.andThen(inner.refusalFor(id)),
            ),
          cachedRefusalFor: (id) =>
            Ref.update(gateCalls, (c) => ({ ...c, cached: c.cached + 1 })).pipe(
              Effect.andThen(inner.cachedRefusalFor(id)),
            ),
          resumeCheck: (id) =>
            Ref.update(gateCalls, (c) => ({ ...c, full: c.full + 1 })).pipe(
              Effect.andThen(inner.resumeCheck(id)),
            ),
        });
      }),
    ).pipe(Layer.provide(guardLayer));
    const deps = Layer.mergeAll(
      counting,
      settings,
      Layer.effect(
        ThreadManagementService.ThreadManagementService,
        Effect.gen(function* () {
          // The resume's own turn start: the real gate, where a refusal drops the thread
          // out of recovery for good (its run fails as a non-limit error).
          const turnStartGate = yield* CreditSpendGuard;
          return {
            getThreadShell: (threadId: ThreadId) =>
              Ref.get(candidates).pipe(Effect.map((all) => all.find((t) => t.id === threadId)!)),
            dispatch: (command: OrchestrationV2ServerCommand) =>
              Effect.gen(function* () {
                if (input.dispatchFails && (yield* Ref.get(input.dispatchFails))) {
                  return yield* Effect.die(new Error("dispatch failed"));
                }
                const refused = yield* turnStartGate.refusalFor(claude);
                yield* Ref.update(outcomes, (all) => [
                  ...all,
                  `${"threadId" in command ? command.threadId : ""}:${refused === null ? "started" : "REFUSED->dropped"}`,
                ]);
                yield* Ref.update(candidates, (all) =>
                  all.filter((t) => !("threadId" in command) || t.id !== command.threadId),
                );
                return { sequence: 1, storedEvents: [] } as never;
              }),
          } as never;
        }),
      ).pipe(Layer.provide(guardLayer)),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getLimitRecoveryCandidates: () => Ref.get(candidates),
      }),
    );
    const logger = Logger.make(({ message }) => {
      logs.push(String(Array.isArray(message) ? message[0] : message));
    });
    const worker = UsageLimitRecoveryWorker.layer.pipe(
      Layer.provide(deps),
      Layer.provide(Scheduler.layer),
      Layer.provide(Logger.layer([logger], { mergeWithExisting: false })),
    );
    return { worker, allow, freshReads, gateCalls, outcomes, logs, published, candidates };
  });

const snapshot = (h: Effect.Success<ReturnType<typeof recoveryHarness>>) =>
  Effect.gen(function* () {
    return {
      freshReads: yield* Ref.get(h.freshReads),
      gate: yield* Ref.get(h.gateCalls),
      outcomes: yield* Ref.get(h.outcomes),
      creditRefusedLogs: h.logs.filter((l) => l.includes("credit-refused")).length,
      unverifiedLogs: h.logs.filter((l) => l.includes("credit-unverified")).length,
      turnRefusedLogs: h.logs.filter((l) => l.includes("turn-refused")).length,
    };
  });

it.effect("runs the full gate before a resume the stale published reading would allow", () =>
  Effect.gen(function* () {
    const h = yield* recoveryHarness({
      threads: ["a"],
      // Published 4 h ago at 97%; the provider is really at 100%.
      published: () => reading("1969-12-31T20:00:00.000Z", 97, FAR),
      truth: (t) => reading(t, 100, FAR),
    });
    yield* Effect.gen(function* () {
      // In 1 s steps, so the shared fresh read (forked) runs before its 5 s timeout
      // deadline comes due on the test clock.
      for (let second = 0; second < 120; second++) yield* TestClock.adjust("1 second");
      const blocked = yield* snapshot(h);
      // Not sent into the limit, still a candidate, one fresh read, one log.
      assert.deepEqual(blocked.outcomes, []);
      assert.lengthOf(yield* Ref.get(h.candidates), 1);
      assert.equal(blocked.freshReads, 1);
      assert.equal(blocked.creditRefusedLogs, 1);
      yield* Ref.set(h.allow, true);
      yield* TestClock.adjust("10 seconds");
      assert.deepEqual((yield* snapshot(h)).outcomes, ["a:started"]);
    }).pipe(Effect.provide(h.worker));
  }),
);

it.effect("resumes once the published reset passes, with no new publish", () =>
  Effect.gen(function* () {
    const h = yield* recoveryHarness({
      threads: ["a"],
      published: () => reading("1970-01-01T00:00:00.000Z", 100, "1970-01-01T00:10:00.000Z"),
      truth: (t) => reading(t, 2, "1970-01-08T00:00:00.000Z"),
    });
    yield* Effect.gen(function* () {
      yield* TestClock.adjust("9 minutes");
      assert.deepEqual((yield* snapshot(h)).outcomes, []);
      yield* TestClock.adjust("2 minutes");
      assert.deepEqual((yield* snapshot(h)).outcomes, ["a:started"]);
    }).pipe(Effect.provide(h.worker));
  }),
);

it.effect("logs a credit refusal once per blocked spell", () =>
  Effect.gen(function* () {
    const fails = yield* Ref.make(true);
    const h = yield* recoveryHarness({
      threads: ["a"],
      published: (t) => reading(t, 100, FAR),
      truth: (t) => reading(t, 100, FAR),
      dispatchFails: fails,
    });
    yield* Effect.gen(function* () {
      yield* TestClock.adjust("5 minutes");
      assert.equal((yield* snapshot(h)).creditRefusedLogs, 1);
      // Allowed: the send is attempted (and fails), so the thread stays a candidate.
      yield* Ref.set(h.allow, true);
      yield* TestClock.adjust("30 seconds");
      // Blocked again: a new spell, logged once more.
      yield* Ref.set(h.allow, false);
      yield* TestClock.adjust("5 minutes");
      assert.equal((yield* snapshot(h)).creditRefusedLogs, 2);
    }).pipe(Effect.provide(h.worker));
  }),
);

const stepSeconds = (seconds: number) =>
  Effect.gen(function* () {
    // 1 s steps, so a forked fresh read runs before its 5 s timeout comes due.
    for (let second = 0; second < seconds; second++) yield* TestClock.adjust("1 second");
  });

// Published 4 h ago at 97%, really at 100%, and the pre-send fresh read is inconclusive:
// G outlasts the 5 s wait (the turn start would join it and see 100%), F fails once and
// the next read succeeds. Either way the resume must wait, not be sent and dropped.
it.effect.each([
  { name: "G: the first read takes 7 s", reads: [7_000, "ok"] as const },
  { name: "F: the first read fails, the next succeeds", reads: ["fail", "ok"] as const },
])("holds a resume whose pre-send read is inconclusive ($name)", ({ reads }) =>
  Effect.gen(function* () {
    const h = yield* recoveryHarness({
      threads: ["a", "b"],
      published: () => reading("1969-12-31T20:00:00.000Z", 97, FAR),
      truth: (t) => reading(t, 100, FAR),
      reads,
    });
    yield* Effect.gen(function* () {
      yield* stepSeconds(180);
      const blocked = yield* snapshot(h);
      assert.deepEqual(blocked.outcomes, []);
      assert.lengthOf(yield* Ref.get(h.candidates), 2);
      assert.equal(blocked.unverifiedLogs, 1);
      yield* Ref.set(h.allow, true);
      yield* stepSeconds(10);
      assert.deepEqual([...(yield* snapshot(h)).outcomes].sort(), ["a:started", "b:started"]);
    }).pipe(Effect.provide(h.worker));
  }),
);

it.effect("sends a resume after 3 inconclusive pre-send reads in a row", () =>
  Effect.gen(function* () {
    const h = yield* recoveryHarness({
      threads: ["a", "b"],
      published: () => reading("1969-12-31T20:00:00.000Z", 97, FAR),
      truth: (t) => reading(t, 100, FAR),
      reads: ["fail"],
    });
    yield* Effect.gen(function* () {
      // Due at 60 s; sweeps at 60, 65 and 70 s wait, the 4th (75 s) sends.
      yield* stepSeconds(74);
      const held = yield* snapshot(h);
      assert.deepEqual(held.outcomes, []);
      assert.equal(held.unverifiedLogs, 6);
      yield* stepSeconds(46);
      const after = yield* snapshot(h);
      // Fail-open after the bound: the published 97% stands.
      assert.deepEqual([...after.outcomes].sort(), ["a:started", "b:started"]);
      assert.equal(after.unverifiedLogs, 6);
      // One read per thread per due sweep (4 each) plus each turn start's own: no loop.
      assert.equal(after.freshReads, 10);
    }).pipe(Effect.provide(h.worker));
  }),
);

it.effect("restarts the inconclusive count after a conclusive answer", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const shell = shellFor("a", now, DateTime.formatIso(DateTime.add(now, { seconds: 60 })));
    const unknown = { refusal: null, inconclusive: true };
    // Two inconclusive checks, a conclusive refusal, then inconclusive from there on.
    const script = [unknown, unknown, { refusal: "Claude is at 100%.", inconclusive: false }];
    const checks = yield* Ref.make(0);
    const sentAt = yield* Ref.make<number | null>(null);
    const deps = Layer.mergeAll(
      Layer.succeed(
        CreditSpendGuard,
        CreditSpendGuard.of({
          refusalFor: () => Effect.die("recovery must use resumeCheck"),
          cachedRefusalFor: () => Effect.succeed(null),
          resumeCheck: () =>
            Ref.updateAndGet(checks, (n) => n + 1).pipe(
              Effect.map((n) => script[n - 1] ?? unknown),
            ),
        }),
      ),
      Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, allowSpendingCredits: false }),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(shell),
        dispatch: () =>
          Ref.get(checks).pipe(
            Effect.flatMap((n) => Ref.set(sentAt, n)),
            Effect.as({ sequence: 1, storedEvents: [] }),
          ),
      }),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getLimitRecoveryCandidates: () =>
          Ref.get(sentAt).pipe(Effect.map((sent) => (sent === null ? [shell] : []))),
      }),
    );
    const sweep = yield* UsageLimitRecoveryWorker.makeSweep.pipe(Effect.provide(deps));
    yield* TestClock.adjust("61 seconds");
    for (let round = 0; round < 10; round++) yield* sweep().pipe(Effect.provide(deps));
    // Checks 4-6 wait again after the refusal at check 3; check 7 sends.
    assert.equal(yield* Ref.get(sentAt), 7);
  }),
);
