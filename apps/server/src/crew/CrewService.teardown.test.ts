import {
  CrewTaskId,
  ProjectId,
  ThreadId,
  type CrewTask,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { ServerSettingsService } from "../serverSettings.ts";
import { CrewLog, type CrewLogCode, type CrewLogFields } from "./CrewLog.ts";
import { CrewService, CrewServiceLive, CrewTeardownHooksService } from "./CrewService.ts";
import { CrewRepository, CrewRepositoryLive } from "./CrewRepository.ts";

const BRIDGE = ThreadId.make("bridge-1");
const CREWMATE = ThreadId.make("crew-1");
const TASK = CrewTaskId.make("task-1");

const makeTask = (overrides: Partial<CrewTask> = {}): CrewTask => ({
  taskId: TASK,
  parentThreadId: BRIDGE,
  crewThreadId: CREWMATE,
  projectId: ProjectId.make("project-1"),
  baseRef: null,
  branch: "crew/task-1",
  worktreePath: "/tmp/crew-task-1",
  provider: "claudeAgent" as CrewTask["provider"],
  status: "open",
  createdAt: "2026-09-02T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
  ...overrides,
});

interface Options {
  /**
   * `"fail"` stubs step 2 to fail, which is the arm the step exists to retire.
   * A recovery record left behind means the watchdog resumes the torn-down
   * thread on its next sweep.
   */
  readonly step2?: "ok" | "fail";
  readonly stopSession?: "ok" | "fail";
  readonly crewmateArchived?: boolean;
  readonly crewmateMissing?: boolean;
  /** The Settings master switch. Defaults on so the teardown cases read normally. */
  readonly crewEnabled?: boolean;
  /** Makes the settings read fail, to assert the switch fails closed. */
  readonly crewSettingsFail?: boolean;
}

const harness = (options: Options = {}) => {
  const records: Array<{ code: CrewLogCode; fields: CrewLogFields }> = [];
  const commands: Array<string> = [];
  const calls: Array<string> = [];
  /** Stands in for the watchdog's per-thread map. */
  const recoveryRecords = new Set<string>([CREWMATE]);

  const shellFor = (threadId: ThreadId) =>
    threadId === CREWMATE && options.crewmateMissing === true
      ? Option.none()
      : Option.some({
          id: threadId,
          projectId: ProjectId.make("project-1"),
          archivedAt:
            threadId === CREWMATE && options.crewmateArchived === true
              ? "2026-09-02T02:00:00.000Z"
              : null,
          session: null,
          modelSelection: { instanceId: "claudeAgent", model: "opus" },
          runtimeMode: "full-access",
          interactionMode: "default",
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
        });

  const layer = CrewServiceLive({ env: {} }).pipe(
    Layer.provideMerge(CrewRepositoryLive),
    Layer.provideMerge(
      Layer.succeed(CrewLog, {
        record: (code, fields) =>
          Effect.sync(() => void records.push({ code, fields: fields ?? {} })),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(CrewTeardownHooksService, {
        clearRecoveryRecord: (threadId: ThreadId) =>
          options.step2 === "fail"
            ? Effect.die("step 2 stubbed to fail")
            : Effect.sync(() => {
                calls.push("clearRecoveryRecord");
                recoveryRecords.delete(threadId);
              }),
        revokeActiveMcpThread: () => Effect.sync(() => void calls.push("revokeActiveMcpThread")),
        closeTerminals: () => Effect.sync(() => void calls.push("closeTerminals")),
        stopSession: () =>
          options.stopSession === "fail"
            ? Effect.die("stopSession fails deterministically")
            : Effect.sync(() => void calls.push("stopSession")),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(OrchestrationEngineService, {
        dispatch: (command: OrchestrationCommand) =>
          Effect.sync(() => {
            commands.push(command.type);
            return { sequence: commands.length };
          }),
      } as never),
    ),
    Layer.provideMerge(
      Layer.succeed(ProjectionSnapshotQuery, {
        getThreadShellById: (threadId: ThreadId) => Effect.succeed(shellFor(threadId)),
        getProjectShellById: () => Effect.succeed(Option.none()),
      } as never),
    ),
    Layer.provideMerge(Layer.succeed(GitWorkflowService, {} as never)),
    Layer.provideMerge(
      Layer.succeed(ServerSettingsService, {
        getRawSettings:
          options.crewSettingsFail === true
            ? Effect.die("settings unavailable")
            : Effect.succeed({
                enableAgentBrowserAccess: true,
                enableCrew: options.crewEnabled ?? true,
              }),
      } as never),
    ),
    Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
    Layer.provideMerge(NodeServices.layer),
  );

  const run = <E>(
    body: Effect.Effect<void, E, CrewService | CrewRepository | SqlClient.SqlClient>,
  ) =>
    Effect.gen(function* () {
      yield* runMigrations({});
      yield* body;
    }).pipe(Effect.provide(layer));

  /**
   * The watchdog's resume branch has no archival check, so a stop it is still
   * waiting on fires against the torn-down thread on the next sweep.
   */
  const watchdogWouldResume = () => recoveryRecords.has(CREWMATE);

  return { run, records, commands, calls, watchdogWouldResume };
};

const codes = (records: ReadonlyArray<{ code: CrewLogCode }>) => records.map((r) => r.code);

describe("one service instance serves many callers", () => {
  it.effect("attributes each call to the thread that made it, not the one that built it", () => {
    const h = harness();
    return h.run(
      Effect.gen(function* () {
        const repository = yield* CrewRepository;
        const crew = yield* CrewService;

        // Two bridges, one CrewService instance — which is the situation an MCP
        // mount creates. The caller used to be read once at construction, so a
        // single registration-time instance attributed every call to whichever
        // thread happened to build it. That is the defect this pins.
        const other = ThreadId.make("bridge-2");
        yield* repository.insertTask(makeTask());
        yield* repository.insertTask(
          makeTask({
            taskId: CrewTaskId.make("task-2"),
            parentThreadId: other,
            crewThreadId: ThreadId.make("crew-2"),
          }),
        );

        const mine = yield* crew.status({}, BRIDGE);
        const theirs = yield* crew.status({}, other);

        assert.deepStrictEqual(
          mine.map((task) => String(task.taskId)),
          ["task-1"],
        );
        assert.deepStrictEqual(
          theirs.map((task) => String(task.taskId)),
          ["task-2"],
        );
      }),
    );
  });
});

describe("the Settings master switch", () => {
  it.effect("dispatch is refused while crew is off, and teardown still works", () => {
    const h = harness({ crewEnabled: false });
    return h.run(
      Effect.gen(function* () {
        const repository = yield* CrewRepository;
        const crew = yield* CrewService;
        yield* repository.insertTask(makeTask());

        const refusal = yield* crew.dispatch({ prompt: "go" }, BRIDGE).pipe(Effect.flip);
        assert.strictEqual(refusal.reason, "disabled");
        assert.include(codes(h.records), "crew.dispatch.refused.disabled");

        // The way out stays open. Refusing teardown too would strand every
        // crewmate dispatched before the switch was turned off, with no way to
        // close its row or free its slot.
        yield* crew.teardown({ taskId: TASK }, BRIDGE);
        assert.include(h.calls, "stopSession");
        assert.deepStrictEqual(
          (yield* crew.status({}, BRIDGE)).map((task) => task.status),
          ["closed"],
        );
      }),
    );
  });

  it.effect("a settings read that fails refuses the dispatch rather than allowing it", () => {
    // The fail-closed direction had no coverage: flipping the read's fallback
    // from `false` to `true` — silently making the master switch fail OPEN —
    // left the whole crew suite green. This is the test that kills that mutant.
    const h = harness({ crewSettingsFail: true });
    return h.run(
      Effect.gen(function* () {
        const crew = yield* CrewService;
        const refusal = yield* crew.dispatch({ prompt: "go" }, BRIDGE).pipe(Effect.flip);
        assert.strictEqual(refusal.reason, "disabled");
      }),
    );
  });

  it.effect("with crew on, dispatch gets past the switch to the later checks", () => {
    // The negative arm alone would pass on a dispatch that refuses for any
    // reason at all. This asserts the gate *opened*: the same call, same
    // fixture, now refuses at `nested` — a check that lives downstream of the
    // switch and can only be reached through it.
    const h = harness();
    return h.run(
      Effect.gen(function* () {
        const repository = yield* CrewRepository;
        const crew = yield* CrewService;
        // Makes BRIDGE a crewmate, so the next check after the switch refuses.
        yield* repository.insertTask(makeTask({ crewThreadId: BRIDGE }));

        const refusal = yield* crew.dispatch({ prompt: "go" }, BRIDGE).pipe(Effect.flip);
        assert.strictEqual(refusal.reason, "nested");
        assert.notInclude(codes(h.records), "crew.dispatch.refused.disabled");
      }),
    );
  });
});

describe("crew teardown", () => {
  it.effect("step 2 working -> the watchdog has nothing left to resume", () =>
    (() => {
      const h = harness({ step2: "ok" });
      return h.run(
        Effect.gen(function* () {
          const repository = yield* CrewRepository;
          const crew = yield* CrewService;
          yield* repository.insertTask(makeTask());

          yield* crew.teardown({ taskId: TASK }, BRIDGE);

          assert.include(h.calls, "clearRecoveryRecord");
          assert.strictEqual(h.watchdogWouldResume(), false);
        }),
      );
    })(),
  );

  it.effect("step 2 stubbed to fail -> the watchdog would resume a dead thread", () =>
    (() => {
      const h = harness({ step2: "fail" });
      return h.run(
        Effect.gen(function* () {
          const repository = yield* CrewRepository;
          const crew = yield* CrewService;
          yield* repository.insertTask(makeTask());

          yield* crew.teardown({ taskId: TASK }, BRIDGE);

          // The defect step 2 retires, asserted positively: with the record left
          // behind, the watchdog dispatches a turn to a thread that is stopped,
          // archived and closed. This arm must be red on the correct
          // implementation, which the sibling above pins.
          assert.strictEqual(h.watchdogWouldResume(), true);
          assert.include(codes(h.records), "crew.teardown.step-failed.2");

          // And it must not latch: the row still closed, the later steps still ran.
          const task = yield* repository.getTaskByCrewThreadId({ crewThreadId: CREWMATE });
          assert.strictEqual(Option.getOrThrow(task).status, "closed");
          assert.include(h.calls, "stopSession");
        }),
      );
    })(),
  );

  it.effect("the row is closed first, before any cleanup runs", () =>
    (() => {
      const h = harness();
      return h.run(
        Effect.gen(function* () {
          const repository = yield* CrewRepository;
          const crew = yield* CrewService;
          yield* repository.insertTask(makeTask());

          yield* crew.teardown({ taskId: TASK }, BRIDGE);

          const task = yield* repository.getTaskByCrewThreadId({ crewThreadId: CREWMATE });
          assert.strictEqual(Option.getOrThrow(task).status, "closed");
          // Step 2 precedes step 5. The one ordering constraint besides step 1.
          assert.isBelow(h.calls.indexOf("clearRecoveryRecord"), h.calls.indexOf("stopSession"));
        }),
      );
    })(),
  );

  it.effect("a stopSession failure still frees the slot", () =>
    (() => {
      const h = harness({ stopSession: "fail" });
      return h.run(
        Effect.gen(function* () {
          const repository = yield* CrewRepository;
          const crew = yield* CrewService;
          yield* repository.insertTask(makeTask());

          yield* crew.teardown({ taskId: TASK }, BRIDGE);

          // Holding the slot on this error is what revision 11 did, and the call
          // fails deterministically — so Retry re-ran it forever and the cap
          // reached zero.
          assert.strictEqual(yield* repository.countOpenTasks(), 0);
          assert.include(codes(h.records), "crew.teardown.step-failed.5");
        }),
      );
    })(),
  );

  it.effect("the worktree path and branch are cleared from the crewmate's meta", () =>
    (() => {
      const h = harness();
      return h.run(
        Effect.gen(function* () {
          const repository = yield* CrewRepository;
          const crew = yield* CrewService;
          yield* repository.insertTask(makeTask());

          yield* crew.teardown({ taskId: TASK }, BRIDGE);

          // Step 6 is what stops `ensureThreadWorktree` re-creating a directory
          // the operator deleted.
          assert.include(h.commands, "thread.meta.update");
        }),
      );
    })(),
  );

  it.effect("an already-archived crewmate is not archived twice", () =>
    (() => {
      const h = harness({ crewmateArchived: true });
      return h.run(
        Effect.gen(function* () {
          const repository = yield* CrewRepository;
          const crew = yield* CrewService;
          yield* repository.insertTask(makeTask());

          yield* crew.teardown({ taskId: TASK }, BRIDGE);

          assert.notInclude(h.commands, "thread.archive");
          assert.strictEqual(yield* repository.countOpenTasks(), 0);
        }),
      );
    })(),
  );

  it.effect("a deleted crewmate does not fail the teardown", () =>
    (() => {
      const h = harness({ crewmateMissing: true });
      return h.run(
        Effect.gen(function* () {
          const repository = yield* CrewRepository;
          const crew = yield* CrewService;
          yield* repository.insertTask(makeTask());

          yield* crew.teardown({ taskId: TASK }, BRIDGE);

          assert.strictEqual(yield* repository.countOpenTasks(), 0);
          assert.notInclude(h.commands, "thread.archive");
        }),
      );
    })(),
  );

  it.effect("teardown refuses a task this thread did not dispatch", () =>
    (() => {
      const h = harness();
      return h.run(
        Effect.gen(function* () {
          const repository = yield* CrewRepository;
          const crew = yield* CrewService;
          yield* repository.insertTask(makeTask({ parentThreadId: ThreadId.make("someone-else") }));

          const outcome = yield* Effect.result(crew.teardown({ taskId: TASK }, BRIDGE));

          assert.strictEqual(outcome._tag, "Failure");
          assert.include(codes(h.records), "crew.tool.refused.crew_teardown.no-row");
          assert.strictEqual(yield* repository.countOpenTasks(), 1);
        }),
      );
    })(),
  );

  it.effect("teardown refuses a task that is already closed", () =>
    (() => {
      const h = harness();
      return h.run(
        Effect.gen(function* () {
          const repository = yield* CrewRepository;
          const crew = yield* CrewService;
          yield* repository.insertTask(makeTask({ status: "closed" }));

          const outcome = yield* Effect.result(crew.teardown({ taskId: TASK }, BRIDGE));

          assert.strictEqual(outcome._tag, "Failure");
          assert.include(codes(h.records), "crew.tool.refused.crew_teardown.no-row");
        }),
      );
    })(),
  );
});
