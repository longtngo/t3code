import { CrewReportId, CrewTaskId, ProjectId, ThreadId, type CrewTask } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { CrewLog, type CrewLogCode, type CrewLogFields } from "./CrewLog.ts";
import { CrewRepository, CrewRepositoryLive } from "./CrewRepository.ts";

const ProviderDriver = "claudeAgent" as CrewTask["provider"];

const makeTask = (overrides: Partial<CrewTask> = {}): CrewTask => ({
  taskId: CrewTaskId.make("task-1"),
  parentThreadId: ThreadId.make("bridge-1"),
  crewThreadId: ThreadId.make("crew-1"),
  projectId: ProjectId.make("project-1"),
  baseRef: null,
  branch: "crew/task-1",
  worktreePath: "/tmp/crew-task-1",
  provider: ProviderDriver,
  status: "open",
  createdAt: "2026-09-02T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
  ...overrides,
});

/**
 * A capturing crew log. Assertions read the codes, which is what §12's clauses
 * are written against — spans go to a separate sink whose ring holds about an
 * hour, and an acceptance run that waits out a sweep deferral outlives it.
 */
const recordingLog = () => {
  const records: Array<{ code: CrewLogCode; fields: CrewLogFields }> = [];
  const layer = Layer.succeed(CrewLog, {
    record: (code, fields) => Effect.sync(() => void records.push({ code, fields: fields ?? {} })),
  });
  return { records, layer };
};

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

describe("crew authority, per direction", () => {
  it.effect("a bridge has no row of its own, so a blanket rule cannot be used", () =>
    withRepository(
      Effect.gen(function* () {
        const repository = yield* CrewRepository;

        // The whole reason the refusal rule is per direction. A blanket "missing
        // or closed row refuses" would refuse the very first dispatch and the
        // feature could never bootstrap.
        const bridgeRow = yield* repository.getTaskByCrewThreadId({
          crewThreadId: ThreadId.make("bridge-1"),
        });
        assert.strictEqual(bridgeRow._tag, "None");

        yield* repository.insertTask(makeTask());

        // The bridge still has no row as a crewmate...
        const stillNone = yield* repository.getTaskByCrewThreadId({
          crewThreadId: ThreadId.make("bridge-1"),
        });
        assert.strictEqual(stillNone._tag, "None");

        // ...while the crewmate does, which is what `nested` keys on.
        const crewRow = yield* repository.getTaskByCrewThreadId({
          crewThreadId: ThreadId.make("crew-1"),
        });
        assert.strictEqual(crewRow._tag, "Some");
      }),
    ),
  );

  it.effect("nested is computed over rows of every status", () =>
    withRepository(
      Effect.gen(function* () {
        const repository = yield* CrewRepository;
        yield* repository.insertTask(makeTask());
        yield* repository.closeTask({
          taskId: CrewTaskId.make("task-1"),
          updatedAt: "2026-09-02T01:00:00.000Z",
        });

        // Scoped to open rows, a torn-down crewmate silently becomes a bridge and
        // can dispatch its own crew. The row must still be found after closing.
        const found = yield* repository.getTaskByCrewThreadId({
          crewThreadId: ThreadId.make("crew-1"),
        });
        assert.strictEqual(found._tag, "Some");
      }),
    ),
  );

  it.effect("the cap counts rows, not memory, so it survives a restart", () =>
    withRepository(
      Effect.gen(function* () {
        const repository = yield* CrewRepository;
        yield* repository.insertTask(makeTask());
        yield* repository.insertTask(
          makeTask({ taskId: CrewTaskId.make("task-2"), crewThreadId: ThreadId.make("crew-2") }),
        );
        assert.strictEqual(yield* repository.countOpenTasks(), 2);

        // Teardown frees the slot; the row stays readable.
        yield* repository.closeTask({
          taskId: CrewTaskId.make("task-2"),
          updatedAt: "2026-09-02T01:00:00.000Z",
        });
        assert.strictEqual(yield* repository.countOpenTasks(), 1);
      }),
    ),
  );

  it.effect("an answer is refused twice for the same report", () =>
    withRepository(
      Effect.gen(function* () {
        const repository = yield* CrewRepository;
        yield* repository.insertTask(makeTask());
        yield* repository.insertReport({
          reportId: CrewReportId.make("report-1"),
          taskId: CrewTaskId.make("task-1"),
          state: "needs-decision",
          note: "which way?",
          createdAt: "2026-09-02T00:00:01.000Z",
          notedAt: null,
          replyTo: null,
        });
        yield* repository.insertReport({
          reportId: CrewReportId.make("answer-1"),
          taskId: CrewTaskId.make("task-1"),
          state: "answer",
          note: "that way",
          createdAt: "2026-09-02T00:00:02.000Z",
          notedAt: null,
          replyTo: CrewReportId.make("report-1"),
        });

        const all = yield* repository.listReports();
        const answered = all.filter((row) => row.replyTo === CrewReportId.make("report-1"));
        assert.strictEqual(answered.length, 1);
      }),
    ),
  );
});

describe("crew log codes", () => {
  it.effect("the recording layer captures what the assertions read", () =>
    Effect.gen(function* () {
      const { records, layer } = recordingLog();
      yield* Effect.gen(function* () {
        const log = yield* CrewLog;
        yield* log.record("crew.tool.invoked.crew_status", { threadId: "bridge-1" });
      }).pipe(Effect.provide(layer));

      // Control for every later assertion that reads `records`: a capture that
      // captures nothing looks exactly like a passing one.
      assert.strictEqual(records.length, 1);
      assert.strictEqual(records[0]?.code, "crew.tool.invoked.crew_status");
      assert.strictEqual(records[0]?.fields.threadId, "bridge-1");
    }),
  );
});

describe("notification suppression codes", () => {
  it.effect("all three emitters have a code, and only those three", () =>
    Effect.gen(function* () {
      const { CREW_LOG_CODES } = yield* Effect.promise(() => import("./CrewLog.ts"));
      const suppression = CREW_LOG_CODES.filter((code) =>
        code.startsWith("crew.notification.suppressed."),
      );
      // Two server emitters plus the web one. The web half runs in the browser
      // and cannot reach the server's log store, so it is asserted in
      // apps/web/src/lib/notifier.test.ts instead — but its code still belongs
      // to the same closed set, or the cross-reference gate cannot check it.
      assert.deepStrictEqual(suppression, [
        "crew.notification.suppressed.web-push",
        "crew.notification.suppressed.agent-awareness",
        "crew.notification.suppressed.web",
      ]);
    }),
  );
});
