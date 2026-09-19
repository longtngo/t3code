import {
  CrewReportId,
  CrewTaskId,
  ProjectId,
  ThreadId,
  type CrewReport,
  type CrewReportState,
  type CrewTask,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { CrewRepository, CrewRepositoryLive } from "./CrewRepository.ts";

const ProviderDriver = "claudeAgent" as CrewTask["provider"];

const makeTask = (overrides: Partial<CrewTask> = {}): CrewTask => ({
  taskId: CrewTaskId.make("task-1"),
  parentThreadId: ThreadId.make("bridge-1"),
  crewThreadId: ThreadId.make("crew-1"),
  projectId: ProjectId.make("project-1"),
  baseRef: null,
  branch: "crew/one",
  worktreePath: "/tmp/crew-one",
  provider: ProviderDriver,
  status: "open",
  createdAt: "2026-09-02T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
  ...overrides,
});

const makeReport = (overrides: Partial<CrewReport> = {}): CrewReport => ({
  reportId: CrewReportId.make("report-1"),
  taskId: CrewTaskId.make("task-1"),
  state: "progress",
  note: "still going",
  createdAt: "2026-09-02T00:00:01.000Z",
  notedAt: null,
  replyTo: null,
  ...overrides,
});

/**
 * A fresh in-memory database per test, and the migrations run inside it.
 *
 * Sharing one database across the block would let a row written by an earlier test
 * satisfy a later one's assertion. Here it also trips `ix_crew_tasks_crew` by
 * accident, which would mask the one test that is supposed to trip it on purpose.
 */
const withRepository = <E>(body: Effect.Effect<void, E, CrewRepository | SqlClient.SqlClient>) =>
  Effect.gen(function* () {
    yield* runMigrations({});
    yield* body;
  }).pipe(
    Effect.provide(
      Layer.mergeAll(CrewRepositoryLive).pipe(
        Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
      ),
    ),
  );

describe("CrewRepository", () => {
  it.effect("round-trips a task by its crew thread id", () =>
    withRepository(
      Effect.gen(function* () {
        const repository = yield* CrewRepository;

        // Control: the lookup must be answering from a row this test wrote, not
        // returning Some for whatever it is handed.
        const before = yield* repository.getTaskByCrewThreadId({
          crewThreadId: ThreadId.make("crew-1"),
        });
        assert.ok(Option.isNone(before));

        const task = makeTask();
        yield* repository.insertTask(task);

        const found = yield* repository.getTaskByCrewThreadId({ crewThreadId: task.crewThreadId });
        assert.deepStrictEqual(Option.getOrThrow(found), task);

        const other = yield* repository.getTaskByCrewThreadId({
          crewThreadId: ThreadId.make("crew-does-not-exist"),
        });
        assert.ok(Option.isNone(other));
      }),
    ),
  );

  it.effect("counts only open tasks as holding a slot", () =>
    withRepository(
      Effect.gen(function* () {
        const repository = yield* CrewRepository;

        assert.strictEqual(yield* repository.countOpenTasks(), 0);

        yield* repository.insertTask(makeTask());
        yield* repository.insertTask(
          makeTask({ taskId: CrewTaskId.make("task-2"), crewThreadId: ThreadId.make("crew-2") }),
        );
        assert.strictEqual(yield* repository.countOpenTasks(), 2);

        yield* repository.closeTask({
          taskId: CrewTaskId.make("task-2"),
          updatedAt: "2026-09-02T01:00:00.000Z",
        });
        assert.strictEqual(yield* repository.countOpenTasks(), 1);

        // Closing releases the slot; it does not erase the record the panel and the
        // teardown log still read.
        const closed = yield* repository.getTaskByCrewThreadId({
          crewThreadId: ThreadId.make("crew-2"),
        });
        assert.strictEqual(Option.getOrThrow(closed).status, "closed");
        assert.strictEqual(Option.getOrThrow(closed).updatedAt, "2026-09-02T01:00:00.000Z");

        const open = yield* repository.listOpenTasks();
        assert.deepStrictEqual(
          open.map((task) => task.taskId),
          ["task-1"],
        );
      }),
    ),
  );

  it.effect("stampNoted reports the winner exactly once", () =>
    withRepository(
      Effect.gen(function* () {
        const repository = yield* CrewRepository;
        yield* repository.insertTask(makeTask());
        yield* repository.insertReport(makeReport());

        const first = yield* repository.stampNoted({
          reportId: CrewReportId.make("report-1"),
          notedAt: "2026-09-02T00:00:02.000Z",
        });
        const second = yield* repository.stampNoted({
          reportId: CrewReportId.make("report-1"),
          notedAt: "2026-09-02T00:00:03.000Z",
        });

        // Two sweeps race one report; exactly one delivers it. The losing arm is
        // asserted positively as `false`, not as "not true".
        assert.strictEqual(first, true);
        assert.strictEqual(second, false);

        const remaining = yield* repository.selectUnnoted();
        assert.deepStrictEqual(remaining, []);

        // And the loser must not have moved the timestamp the winner wrote.
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{ readonly noted_at: string }>`
          SELECT noted_at FROM crew_reports WHERE report_id = 'report-1'
        `;
        assert.strictEqual(rows[0]?.noted_at, "2026-09-02T00:00:02.000Z");
      }),
    ),
  );

  it.effect("stampNoted on a row that does not exist reports no win", () =>
    withRepository(
      Effect.gen(function* () {
        const repository = yield* CrewRepository;
        const won = yield* repository.stampNoted({
          reportId: CrewReportId.make("report-absent"),
          notedAt: "2026-09-02T00:00:02.000Z",
        });
        assert.strictEqual(won, false);
      }),
    ),
  );

  it.effect("selectUnnoted puts blocked crewmates ahead of chatty ones", () =>
    withRepository(
      Effect.gen(function* () {
        const repository = yield* CrewRepository;
        yield* repository.insertTask(makeTask());

        // Inserted in the order `created_at` alone would return them, so a passing
        // assertion has to be coming from the state rank rather than from insertion
        // order.
        const rows: ReadonlyArray<readonly [string, CrewReportState]> = [
          ["report-done", "done"],
          ["report-answer", "answer"],
          ["report-progress", "progress"],
          ["report-decision", "needs-decision"],
        ];
        let tick = 0;
        for (const [reportId, state] of rows) {
          tick += 1;
          yield* repository.insertReport(
            makeReport({
              reportId: CrewReportId.make(reportId),
              state,
              createdAt: `2026-09-02T00:00:0${tick}.000Z`,
            }),
          );
        }

        const unnoted = yield* repository.selectUnnoted();
        assert.deepStrictEqual(
          unnoted.map((report) => report.reportId),
          ["report-decision", "report-progress", "report-done", "report-answer"],
        );
      }),
    ),
  );

  it.effect("countNonAnswerReports excludes the bridge's own replies", () =>
    withRepository(
      Effect.gen(function* () {
        const repository = yield* CrewRepository;
        yield* repository.insertTask(makeTask());

        yield* repository.insertReport(makeReport({ reportId: CrewReportId.make("r1") }));
        yield* repository.insertReport(
          makeReport({ reportId: CrewReportId.make("r2"), state: "needs-decision" }),
        );
        yield* repository.insertReport(
          makeReport({
            reportId: CrewReportId.make("r3"),
            state: "answer",
            replyTo: CrewReportId.make("r2"),
          }),
        );

        // Three rows exist; two count. A talkative bridge must not exhaust the
        // budget its crewmate needs in order to report `done`.
        const sql = yield* SqlClient.SqlClient;
        const all = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM crew_reports WHERE task_id = 'task-1'
        `;
        assert.strictEqual(all[0]?.count, 3);
        assert.strictEqual(
          yield* repository.countNonAnswerReports({ taskId: CrewTaskId.make("task-1") }),
          2,
        );
      }),
    ),
  );

  it.effect("scopes reads to one task and one parent", () =>
    withRepository(
      Effect.gen(function* () {
        const repository = yield* CrewRepository;

        yield* repository.insertTask(makeTask());
        yield* repository.insertTask(
          makeTask({
            taskId: CrewTaskId.make("task-2"),
            crewThreadId: ThreadId.make("crew-2"),
            createdAt: "2026-09-02T00:00:05.000Z",
          }),
        );
        yield* repository.insertTask(
          makeTask({
            taskId: CrewTaskId.make("task-other"),
            parentThreadId: ThreadId.make("bridge-2"),
            crewThreadId: ThreadId.make("crew-other"),
          }),
        );

        const mine = yield* repository.getTasksByParentThreadId({
          parentThreadId: ThreadId.make("bridge-1"),
        });
        assert.deepStrictEqual(
          mine.map((task) => task.taskId),
          ["task-1", "task-2"],
        );

        yield* repository.insertReport(makeReport({ reportId: CrewReportId.make("a") }));
        yield* repository.insertReport(
          makeReport({ reportId: CrewReportId.make("b"), taskId: CrewTaskId.make("task-2") }),
        );
        assert.strictEqual(
          yield* repository.countNonAnswerReports({ taskId: CrewTaskId.make("task-1") }),
          1,
        );
      }),
    ),
  );
});
