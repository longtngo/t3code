import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { OrchestratorDispatchError } from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { CreditSpendGuard } from "../Services/CreditSpendGuard.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import {
  interruptSweeperLive,
  makeCreditSpendGuard,
  needsFreshUsageRead,
  runCreditSpendSweep,
} from "./CreditSpendGuardLive.ts";

const claudeA = ProviderInstanceId.make("claude-a");
const claudeB = ProviderInstanceId.make("claude-b");

const isoAgo = (ms: number) =>
  DateTime.formatIso(DateTime.subtract(DateTime.nowUnsafe(), { milliseconds: ms }));

const provider = (
  instanceId: ProviderInstanceId,
  usedPercent: number | null,
  checkedAt = isoAgo(0),
): ServerProvider =>
  ({
    instanceId,
    driver: "claudeAgent",
    displayName: `Claude ${instanceId}`,
    enabled: true,
    installed: true,
    checkedAt,
    ...(usedPercent === null
      ? {}
      : {
          usageLimits: {
            checkedAt,
            windows: [{ id: "seven_day", kind: "weekly", label: "Weekly", usedPercent }],
          },
        }),
  }) as unknown as ServerProvider;

interface RegistryStub {
  readonly providers: ReadonlyArray<ServerProvider>;
  /** What a fresh read returns, and how long it takes in real time. */
  readonly fresh?: {
    readonly providers: ReadonlyArray<ServerProvider>;
    readonly delayMs: number;
    /** The read dies (not a timeout) after the delay. */
    readonly fails?: boolean;
  };
}

const guardFor = (
  stub: RegistryStub,
  options: { readonly allowSpendingCredits?: boolean; readonly freshReadTimeout?: Duration.Input },
) => {
  const freshReads: Array<ProviderInstanceId> = [];
  const registry = Layer.mock(ProviderRegistry)({
    getProviders: Effect.sync(() => stub.providers),
    refreshInstance: (instanceId, refreshOptions) =>
      Effect.gen(function* () {
        freshReads.push(instanceId);
        expect(refreshOptions).toEqual({ fresh: true });
        if (stub.fresh === undefined) return yield* Effect.die("no fresh read expected");
        yield* Effect.sleep(Duration.millis(stub.fresh.delayMs));
        if (stub.fresh.fails === true) return yield* Effect.die("probe crashed");
        return stub.fresh.providers;
      }),
  });
  const layer = Layer.effect(
    CreditSpendGuard,
    makeCreditSpendGuard(
      options.freshReadTimeout === undefined ? {} : { freshReadTimeout: options.freshReadTimeout },
    ),
  ).pipe(
    Layer.provide(registry),
    Layer.provide(
      ServerSettings.layerTest({ allowSpendingCredits: options.allowSpendingCredits ?? false }),
    ),
  );
  const refusalFor = (instanceId: ProviderInstanceId) =>
    Effect.gen(function* () {
      return yield* (yield* CreditSpendGuard).refusalFor(instanceId);
    }).pipe(Effect.provide(layer));
  /** Several calls against ONE guard instance, so they can share its in-flight read. */
  const withGuard = <A, E>(f: (guard: CreditSpendGuard["Service"]) => Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      return yield* f(yield* CreditSpendGuard);
    }).pipe(Effect.provide(layer));
  return { refusalFor, withGuard, freshReads };
};

describe("CreditSpendGuard.refusalFor", () => {
  it.live("refuses an instance whose window reads 100% with spending off", () =>
    Effect.gen(function* () {
      const guard = guardFor({ providers: [provider(claudeA, 100)] }, {});
      const reason = yield* guard.refusalFor(claudeA);
      expect(reason).toContain("100% of Weekly");
      expect(reason).toContain("Allow to spend credits");
    }),
  );

  it.live("allows an instance below 100%", () =>
    Effect.gen(function* () {
      const guard = guardFor({ providers: [provider(claudeA, 99)] }, {});
      expect(yield* guard.refusalFor(claudeA)).toBeNull();
    }),
  );

  it.live("allows everything while the switch is on, even at 100%", () =>
    Effect.gen(function* () {
      const guard = guardFor(
        { providers: [provider(claudeA, 100, isoAgo(3_600_000))] },
        { allowSpendingCredits: true },
      );
      expect(yield* guard.refusalFor(claudeA)).toBeNull();
      // The switch is read first: no usage re-read happens for a stale reading.
      expect(guard.freshReads).toEqual([]);
    }),
  );

  it.live("allows an instance with no limits, an unknown instance and an unavailable probe", () =>
    Effect.gen(function* () {
      const unavailable = {
        ...provider(claudeB, 100),
        usageLimits: {
          checkedAt: isoAgo(0),
          windows: [{ id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 100 }],
          unavailable: { reason: "probeFailed" },
        },
      } as unknown as ServerProvider;
      const guard = guardFor({ providers: [provider(claudeA, null), unavailable] }, {});
      expect(yield* guard.refusalFor(claudeA)).toBeNull();
      expect(yield* guard.refusalFor(claudeB)).toBeNull();
      expect(yield* guard.refusalFor(ProviderInstanceId.make("missing"))).toBeNull();
    }),
  );

  it.live("judges each instance by its own account", () =>
    Effect.gen(function* () {
      const guard = guardFor({ providers: [provider(claudeA, 100), provider(claudeB, 40)] }, {});
      expect(yield* guard.refusalFor(claudeA)).not.toBeNull();
      expect(yield* guard.refusalFor(claudeB)).toBeNull();
    }),
  );

  it.live("re-reads a stale near-limit reading and refuses on the slow fresh 100%", () =>
    Effect.gen(function* () {
      // The fresh read is genuinely slow (0.3 s, inside the measured 0.4-1.8 s band's
      // order) so a gate that stopped waiting at request time would miss the 100%.
      const guard = guardFor(
        {
          providers: [provider(claudeA, 95, isoAgo(10 * 60_000))],
          fresh: { providers: [provider(claudeA, 100)], delayMs: 300 },
        },
        { freshReadTimeout: Duration.seconds(2) },
      );
      expect(yield* guard.refusalFor(claudeA)).toContain("100% of Weekly");
      expect(guard.freshReads).toEqual([claudeA]);
    }),
  );

  it.live("keeps the existing reading when the fresh read outlasts the timeout", () =>
    Effect.gen(function* () {
      const stale95 = guardFor(
        {
          providers: [provider(claudeA, 95, isoAgo(10 * 60_000))],
          fresh: { providers: [provider(claudeA, 100)], delayMs: 2_000 },
        },
        { freshReadTimeout: Duration.millis(100) },
      );
      const started = yield* Clock.currentTimeMillis;
      // Fail-open by choice: the timed-out read cannot add a 100% it never returned.
      expect(yield* stale95.refusalFor(claudeA)).toBeNull();
      expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(1_500);

      const stale100 = guardFor(
        {
          providers: [provider(claudeA, 100, isoAgo(10 * 60_000))],
          fresh: { providers: [provider(claudeA, 0)], delayMs: 2_000 },
        },
        { freshReadTimeout: Duration.millis(100) },
      );
      // ...but an existing affirmative 100% still blocks.
      expect(yield* stale100.refusalFor(claudeA)).not.toBeNull();
    }),
  );

  it.live("does not re-read a recent reading or one far from the limit", () =>
    Effect.gen(function* () {
      const recent = guardFor({ providers: [provider(claudeA, 95, isoAgo(5_000))] }, {});
      expect(yield* recent.refusalFor(claudeA)).toBeNull();
      const far = guardFor({ providers: [provider(claudeA, 50, isoAgo(3_600_000))] }, {});
      expect(yield* far.refusalFor(claudeA)).toBeNull();
      expect([...recent.freshReads, ...far.freshReads]).toEqual([]);
    }),
  );
});

describe("CreditSpendGuard.refusalFor after a reset and on failed reads", () => {
  const isoAhead = (ms: number) => isoAgo(-ms);
  const windowAt = (instanceId: ProviderInstanceId, checkedAt: string, resetsAt: string) =>
    ({
      ...provider(instanceId, 100, checkedAt),
      usageLimits: {
        checkedAt,
        windows: [
          { id: "five_hour", kind: "session", label: "Session", usedPercent: 100, resetsAt },
        ],
      },
    }) as unknown as ServerProvider;

  it.live("allows a recent 100% reading whose window reset 10 s ago, without a re-read", () =>
    Effect.gen(function* () {
      const guard = guardFor(
        { providers: [windowAt(claudeA, isoAgo(30_000), isoAgo(10_000))] },
        {},
      );
      expect(yield* guard.refusalFor(claudeA)).toBeNull();
      expect(guard.freshReads).toEqual([]);
      // Control: the same reading with the reset still ahead refuses.
      const ahead = guardFor(
        { providers: [windowAt(claudeA, isoAgo(30_000), isoAhead(60_000))] },
        {},
      );
      expect(yield* ahead.refusalFor(claudeA)).toContain("100% of Session");
    }),
  );

  it.live("allows a stale 100% past its reset when the fresh read times out", () =>
    Effect.gen(function* () {
      const guard = guardFor(
        {
          providers: [windowAt(claudeA, isoAgo(10 * 60_000), isoAgo(60_000))],
          fresh: { providers: [provider(claudeA, 100)], delayMs: 2_000 },
        },
        { freshReadTimeout: Duration.millis(100) },
      );
      expect(yield* guard.refusalFor(claudeA)).toBeNull();
      expect(guard.freshReads).toEqual([claudeA]);
    }),
  );

  it.live("keeps the existing reading, promptly, when the fresh read fails outright", () =>
    Effect.gen(function* () {
      const failing = (usedPercent: number) =>
        guardFor(
          {
            providers: [provider(claudeA, usedPercent, isoAgo(10 * 60_000))],
            fresh: { providers: [provider(claudeA, 0)], delayMs: 50, fails: true },
          },
          { freshReadTimeout: Duration.seconds(3) },
        );
      const started = yield* Clock.currentTimeMillis;
      expect(yield* failing(95).refusalFor(claudeA)).toBeNull();
      // A failure ends the wait at once instead of running out the 3 s timeout.
      expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(1_500);
      expect(yield* failing(100).refusalFor(claudeA)).toContain("100% of Weekly");
    }),
  );

  it.live("shares one fresh read across five concurrent near-limit starts", () =>
    Effect.gen(function* () {
      const guard = guardFor(
        {
          providers: [provider(claudeA, 99, isoAgo(10 * 60_000))],
          fresh: { providers: [provider(claudeA, 100)], delayMs: 300 },
        },
        { freshReadTimeout: Duration.seconds(2) },
      );
      const reasons = yield* guard.withGuard((service) =>
        Effect.all(
          Array.from({ length: 5 }, () => service.refusalFor(claudeA)),
          { concurrency: "unbounded" },
        ),
      );
      expect(guard.freshReads).toEqual([claudeA]);
      expect(reasons.every((reason) => reason?.includes("100% of Weekly"))).toBe(true);
    }),
  );
});

describe("needsFreshUsageRead", () => {
  const now = Date.parse("2026-10-03T12:00:00.000Z");
  const limits = (usedPercent: number, checkedAt: string) => ({
    checkedAt,
    windows: [{ id: "five_hour", kind: "session" as const, label: "Session", usedPercent }],
  });

  it("is true only for an old reading at or above 90%", () => {
    expect(needsFreshUsageRead(limits(90, "2026-10-03T11:58:59.000Z"), now)).toBe(true);
    expect(needsFreshUsageRead(limits(89, "2026-10-03T11:00:00.000Z"), now)).toBe(false);
    expect(needsFreshUsageRead(limits(99, "2026-10-03T11:59:30.000Z"), now)).toBe(false);
    expect(needsFreshUsageRead(limits(99, "not-a-date"), now)).toBe(true);
    expect(needsFreshUsageRead(undefined, now)).toBe(false);
  });
});

describe("runCreditSpendSweep", () => {
  const projectId = ProjectId.make("project");
  const shell = (threadId: string, activeRunId: string | null) =>
    ({
      id: ThreadId.make(threadId),
      projectId,
      activeRunId: activeRunId === null ? null : RunId.make(activeRunId),
    }) as unknown as OrchestrationV2ThreadShell;
  const run = (id: string, instanceId: ProviderInstanceId) =>
    ({
      id: RunId.make(id),
      providerInstanceId: instanceId,
      status: "running",
    }) as unknown as OrchestrationV2Run;

  type Interrupt = Extract<OrchestrationV2ServerCommand, { readonly type: "run.interrupt" }>;
  const harness = (behaviour: { readonly fail?: string; readonly hang?: string } = {}) => {
    const interrupts: Array<Interrupt> = [];
    const runs = new Map([
      ["thread-a", run("run-a", claudeA)],
      ["thread-b", run("run-b", claudeB)],
      ["thread-a2", run("run-a2", claudeA)],
    ]);
    const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
      getShellSnapshot: () =>
        Effect.succeed({
          schemaVersion: 1,
          snapshotSequence: 0,
          threads: [
            shell("thread-a", "run-a"),
            shell("thread-b", "run-b"),
            shell("thread-a2", "run-a2"),
            shell("thread-idle", null),
          ],
          archivedThreads: [],
        } as never),
      getThreadRecords: (threadId) => Effect.succeed({ runs: [runs.get(threadId)!] } as never),
      dispatch: (command) =>
        Effect.gen(function* () {
          if (command.type !== "run.interrupt") return yield* Effect.die("unexpected command");
          interrupts.push(command);
          if (String(command.runId) === behaviour.hang) return yield* Effect.never;
          if (String(command.runId) === behaviour.fail) {
            return yield* new OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
              cause: "refused",
            });
          }
          return { sequence: 1, storedEvents: [] };
        }),
    });
    return { threads, interrupts, runIds: () => interrupts.map((entry) => String(entry.runId)) };
  };

  it.effect("stops every run on the newly blocked instance once, like the user's Stop", () =>
    Effect.gen(function* () {
      const { threads, interrupts, runIds } = harness();
      const swept = yield* Ref.make<ReadonlySet<ProviderInstanceId>>(new Set());
      const sweep = (providers: ReadonlyArray<ServerProvider>) =>
        runCreditSpendSweep({ allowSpendingCredits: false, providers, swept }).pipe(
          Effect.provide(threads),
        );

      yield* sweep([provider(claudeA, 100), provider(claudeB, 40)]);
      expect(runIds()).toEqual(["run-a", "run-a2"]);
      expect(interrupts[0]).toMatchObject({
        commandId: CommandId.make("credit-spend-guard:interrupt:run-a"),
        // The cooperative rung with the queue held: queued messages stay queued.
        mode: "cooperative",
        holdQueue: true,
      });
      expect(interrupts[0]?.reason).toContain("100% of Weekly");

      // Still blocked: edge-triggered, so no second interrupt.
      yield* sweep([provider(claudeA, 100), provider(claudeB, 40)]);
      expect(interrupts).toHaveLength(2);

      // Unblocked, then blocked again: a new spell sweeps again.
      yield* sweep([provider(claudeA, 10), provider(claudeB, 40)]);
      yield* sweep([provider(claudeA, 100), provider(claudeB, 40)]);
      expect(interrupts).toHaveLength(4);
    }),
  );

  it.effect("does nothing while spending is allowed", () =>
    Effect.gen(function* () {
      const { threads, interrupts } = harness();
      const swept = yield* Ref.make<ReadonlySet<ProviderInstanceId>>(new Set());
      yield* runCreditSpendSweep({
        allowSpendingCredits: true,
        providers: [provider(claudeA, 100), provider(claudeB, 100)],
        swept,
      }).pipe(Effect.provide(threads));
      expect(interrupts).toEqual([]);
    }),
  );

  it.effect("retries an instance whose interrupt failed, without skipping its other runs", () =>
    Effect.gen(function* () {
      const { threads, runIds } = harness({ fail: "run-a" });
      const swept = yield* Ref.make<ReadonlySet<ProviderInstanceId>>(new Set());
      const sweep = runCreditSpendSweep({
        allowSpendingCredits: false,
        providers: [provider(claudeA, 100)],
        swept,
      }).pipe(Effect.provide(threads));

      yield* sweep;
      expect(runIds()).toEqual(["run-a", "run-a2"]);
      yield* sweep;
      expect(runIds()).toEqual(["run-a", "run-a2", "run-a", "run-a2"]);
    }),
  );

  it.effect("gives up on a wedged interrupt after 30 s and retries it next sweep", () =>
    Effect.gen(function* () {
      const { threads, runIds } = harness({ hang: "run-a" });
      const swept = yield* Ref.make<ReadonlySet<ProviderInstanceId>>(new Set());
      const sweep = runCreditSpendSweep({
        allowSpendingCredits: false,
        providers: [provider(claudeA, 100)],
        swept,
      }).pipe(Effect.provide(threads));

      const fiber = yield* Effect.forkChild(sweep);
      yield* TestClock.adjust("29 seconds");
      expect(runIds()).toEqual(["run-a"]);
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(fiber);
      // The wedged run did not stall the next one, and its instance is swept again.
      expect(runIds()).toEqual(["run-a", "run-a2"]);
      expect(yield* Ref.get(swept)).toEqual(new Set());
    }),
  );
});

describe("interruptSweeperLive", () => {
  it.effect("sweeps when the published usage changes", () =>
    Effect.gen(function* () {
      const changes = yield* Queue.unbounded<ReadonlyArray<ServerProvider>>();
      const providers = yield* Ref.make<ReadonlyArray<ServerProvider>>([provider(claudeA, 40)]);
      const interrupted = yield* Queue.unbounded<string>();
      const layer = interruptSweeperLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProviderRegistry)({
              getProviders: Ref.get(providers),
              streamChanges: Stream.fromQueue(changes),
            }),
            ServerSettings.layerTest({ allowSpendingCredits: false }),
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getShellSnapshot: () =>
                Effect.succeed({
                  schemaVersion: 1,
                  snapshotSequence: 0,
                  threads: [
                    {
                      id: ThreadId.make("thread-a"),
                      projectId: ProjectId.make("project"),
                      activeRunId: RunId.make("run-a"),
                    },
                  ],
                  archivedThreads: [],
                } as never),
              getThreadRecords: () =>
                Effect.succeed({
                  runs: [
                    { id: RunId.make("run-a"), providerInstanceId: claudeA, status: "running" },
                  ],
                } as never),
              dispatch: (command) =>
                Queue.offer(
                  interrupted,
                  command.type === "run.interrupt" ? String(command.runId) : "?",
                ).pipe(Effect.as({ sequence: 1, storedEvents: [] })),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const blocked = [provider(claudeA, 100)];
        yield* Ref.set(providers, blocked);
        yield* Queue.offer(changes, blocked);
        expect(yield* Queue.take(interrupted)).toBe("run-a");
      }).pipe(Effect.provide(layer));
    }),
  );
});
