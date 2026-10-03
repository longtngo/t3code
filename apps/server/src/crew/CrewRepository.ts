/**
 * CrewRepository - typed reads and writes over `crew_tasks` and `crew_reports`.
 *
 * Everything here is deliberately dumb: no policy, no derived state, no clock. The
 * rendering ladder is a pure function over a task plus its thread's live session
 * (`derive.ts`), and the delivery rules live in the sweep. What this file owns is the
 * two invariants that have to hold at the storage layer, because nothing above it can
 * enforce them under concurrency:
 *
 *  - A task holds a slot while `status = 'open'`, so `countOpenTasks` is the only
 *    admission test and it counts rows, not memory.
 *  - `notedAt IS NULL` *is* the delivery queue. `stampNoted` therefore stamps
 *    conditionally and reports whether it won, so two sweeps racing the same report
 *    deliver it once.
 *
 * @module CrewRepository
 */
import {
  CREW_REPORTS_PER_TASK_LIMIT,
  CrewReport,
  CrewReportId,
  CrewTask,
  CrewTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProviderSessionRuntimeRepositoryError,
} from "../persistence/Errors.ts";

export type CrewRepositoryError = ProviderSessionRuntimeRepositoryError;

const TaskIdRequest = Schema.Struct({ taskId: CrewTaskId });
const CrewThreadIdRequest = Schema.Struct({ crewThreadId: ThreadId });
const ParentThreadIdRequest = Schema.Struct({ parentThreadId: ThreadId });
const CloseTaskRequest = Schema.Struct({ taskId: CrewTaskId, updatedAt: Schema.String });
const StampNotedRequest = Schema.Struct({ reportId: CrewReportId, notedAt: Schema.String });
const CountResult = Schema.Struct({ count: Schema.Number });
const ReportIdResult = Schema.Struct({ reportId: CrewReportId });

const TASK_COLUMNS = `
  task_id AS "taskId",
  parent_thread_id AS "parentThreadId",
  crew_thread_id AS "crewThreadId",
  project_id AS "projectId",
  base_ref AS "baseRef",
  branch AS "branch",
  worktree_path AS "worktreePath",
  provider AS "provider",
  status AS "status",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const REPORT_COLUMNS = `
  report_id AS "reportId",
  task_id AS "taskId",
  state AS "state",
  note AS "note",
  created_at AS "createdAt",
  noted_at AS "notedAt",
  reply_to AS "replyTo"
`;

function toSqlOrDecodeError(operation: string) {
  return (cause: unknown): CrewRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(`${operation}:decode`)(cause)
      : toPersistenceSqlError(`${operation}:query`)(cause);
}

export interface CrewRepositoryShape {
  readonly insertTask: (task: CrewTask) => Effect.Effect<void, CrewRepositoryError>;

  readonly getTaskByCrewThreadId: (input: {
    readonly crewThreadId: ThreadId;
  }) => Effect.Effect<Option.Option<CrewTask>, CrewRepositoryError>;

  readonly getTasksByParentThreadId: (input: {
    readonly parentThreadId: ThreadId;
  }) => Effect.Effect<ReadonlyArray<CrewTask>, CrewRepositoryError>;

  /** Rows still holding a slot. The admission test; counts rows, never memory. */
  readonly countOpenTasks: () => Effect.Effect<number, CrewRepositoryError>;

  /** Every `open` task, in creation order — the boot orphan reap reads this. */
  readonly listOpenTasks: () => Effect.Effect<ReadonlyArray<CrewTask>, CrewRepositoryError>;

  /**
   * Every task, of every status. The delivery sweep needs it: its select does not
   * exclude closed tasks, so a report filed one tick before its row closed still
   * has to resolve to that row.
   */
  readonly listAllTasks: () => Effect.Effect<ReadonlyArray<CrewTask>, CrewRepositoryError>;

  readonly closeTask: (input: {
    readonly taskId: CrewTaskId;
    readonly updatedAt: string;
  }) => Effect.Effect<void, CrewRepositoryError>;

  readonly insertReport: (report: CrewReport) => Effect.Effect<void, CrewRepositoryError>;

  /**
   * Undelivered reports, `needs-decision` and `progress` ahead of the rest so a
   * blocked crewmate is unblocked before a chatty one is transcribed.
   */
  readonly selectUnnoted: () => Effect.Effect<ReadonlyArray<CrewReport>, CrewRepositoryError>;

  /**
   * Stamp a report as handled. Returns `true` only if this call is the one that
   * stamped it — a second caller racing the same row gets `false` and must not
   * deliver. Without that, one report is delivered twice.
   */
  readonly stampNoted: (input: {
    readonly reportId: CrewReportId;
    readonly notedAt: string;
  }) => Effect.Effect<boolean, CrewRepositoryError>;

  /** Rows counting against {@link CREW_REPORTS_PER_TASK_LIMIT}; answers excluded. */
  readonly countNonAnswerReports: (input: {
    readonly taskId: CrewTaskId;
  }) => Effect.Effect<number, CrewRepositoryError>;

  /** Every report for one task, oldest first. */
  readonly listReportsByTaskId: (input: {
    readonly taskId: CrewTaskId;
  }) => Effect.Effect<ReadonlyArray<CrewReport>, CrewRepositoryError>;

  /**
   * Every report, oldest first. `crew_answer` needs it to resolve a report id to
   * its task and to see whether an answer already names that report; both are
   * bounded by the per-task cap.
   */
  readonly listReports: () => Effect.Effect<ReadonlyArray<CrewReport>, CrewRepositoryError>;
}

export class CrewRepository extends Context.Service<CrewRepository, CrewRepositoryShape>()(
  "t3/crew/CrewRepository",
) {}

const makeCrewRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertTaskRow = SqlSchema.void({
    Request: CrewTask,
    execute: (task) => sql`
      INSERT INTO crew_tasks (
        task_id, parent_thread_id, crew_thread_id, project_id, base_ref,
        branch, worktree_path, provider, status, created_at, updated_at
      ) VALUES (
        ${task.taskId}, ${task.parentThreadId}, ${task.crewThreadId}, ${task.projectId},
        ${task.baseRef}, ${task.branch}, ${task.worktreePath}, ${task.provider},
        ${task.status}, ${task.createdAt}, ${task.updatedAt}
      )
    `,
  });

  const findTaskByCrewThreadId = SqlSchema.findOneOption({
    Request: CrewThreadIdRequest,
    Result: CrewTask,
    execute: ({ crewThreadId }) => sql`
      SELECT ${sql.literal(TASK_COLUMNS)}
      FROM crew_tasks
      WHERE crew_thread_id = ${crewThreadId}
    `,
  });

  const findTasksByParentThreadId = SqlSchema.findAll({
    Request: ParentThreadIdRequest,
    Result: CrewTask,
    execute: ({ parentThreadId }) => sql`
      SELECT ${sql.literal(TASK_COLUMNS)}
      FROM crew_tasks
      WHERE parent_thread_id = ${parentThreadId}
      ORDER BY created_at ASC, task_id ASC
    `,
  });

  const countOpenTaskRows = SqlSchema.findOne({
    Request: Schema.Void,
    Result: CountResult,
    execute: () => sql`
      SELECT COUNT(*) AS "count" FROM crew_tasks WHERE status = 'open'
    `,
  });

  const findOpenTaskRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: CrewTask,
    execute: () => sql`
      SELECT ${sql.literal(TASK_COLUMNS)}
      FROM crew_tasks
      WHERE status = 'open'
      ORDER BY created_at ASC, task_id ASC
    `,
  });

  const findAllTaskRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: CrewTask,
    execute: () => sql`
      SELECT ${sql.literal(TASK_COLUMNS)}
      FROM crew_tasks
      ORDER BY created_at ASC, task_id ASC
    `,
  });

  const closeTaskRow = SqlSchema.void({
    Request: CloseTaskRequest,
    execute: ({ taskId, updatedAt }) => sql`
      UPDATE crew_tasks
      SET status = 'closed', updated_at = ${updatedAt}
      WHERE task_id = ${taskId}
    `,
  });

  const insertReportRow = SqlSchema.void({
    Request: CrewReport,
    execute: (report) => sql`
      INSERT INTO crew_reports (
        report_id, task_id, state, note, created_at, noted_at, reply_to
      ) VALUES (
        ${report.reportId}, ${report.taskId}, ${report.state}, ${report.note},
        ${report.createdAt}, ${report.notedAt}, ${report.replyTo}
      )
    `,
  });

  const findUnnotedReportRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: CrewReport,
    execute: () => sql`
      SELECT ${sql.literal(REPORT_COLUMNS)}
      FROM crew_reports
      WHERE noted_at IS NULL
      ORDER BY
        CASE state WHEN 'needs-decision' THEN 0 WHEN 'progress' THEN 1 ELSE 2 END,
        created_at ASC,
        rowid ASC
    `,
  });

  // Conditional on the row still being unnoted, and RETURNING so the winner is
  // identified in the same statement. A read-then-write would let two sweeps both
  // observe NULL and both deliver.
  const stampNotedRows = SqlSchema.findAll({
    Request: StampNotedRequest,
    Result: ReportIdResult,
    execute: ({ reportId, notedAt }) => sql`
      UPDATE crew_reports
      SET noted_at = ${notedAt}
      WHERE report_id = ${reportId} AND noted_at IS NULL
      RETURNING report_id AS "reportId"
    `,
  });

  const findReportRowsByTaskId = SqlSchema.findAll({
    Request: TaskIdRequest,
    Result: CrewReport,
    execute: ({ taskId }) => sql`
      SELECT ${sql.literal(REPORT_COLUMNS)}
      FROM crew_reports
      WHERE task_id = ${taskId}
      ORDER BY created_at ASC, rowid ASC
    `,
  });

  const findAllReportRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: CrewReport,
    execute: () => sql`
      SELECT ${sql.literal(REPORT_COLUMNS)}
      FROM crew_reports
      ORDER BY created_at ASC, rowid ASC
    `,
  });

  const countNonAnswerReportRows = SqlSchema.findOne({
    Request: TaskIdRequest,
    Result: CountResult,
    execute: ({ taskId }) => sql`
      SELECT COUNT(*) AS "count"
      FROM crew_reports
      WHERE task_id = ${taskId} AND state != 'answer'
    `,
  });

  const shape: CrewRepositoryShape = {
    insertTask: (task) =>
      insertTaskRow(task).pipe(Effect.mapError(toSqlOrDecodeError("CrewRepository.insertTask"))),

    getTaskByCrewThreadId: (input) =>
      findTaskByCrewThreadId(input).pipe(
        Effect.mapError(toSqlOrDecodeError("CrewRepository.getTaskByCrewThreadId")),
      ),

    getTasksByParentThreadId: (input) =>
      findTasksByParentThreadId(input).pipe(
        Effect.mapError(toSqlOrDecodeError("CrewRepository.getTasksByParentThreadId")),
      ),

    countOpenTasks: () =>
      countOpenTaskRows().pipe(
        Effect.map((row) => row.count),
        Effect.mapError(toSqlOrDecodeError("CrewRepository.countOpenTasks")),
      ),

    listOpenTasks: () =>
      findOpenTaskRows().pipe(Effect.mapError(toSqlOrDecodeError("CrewRepository.listOpenTasks"))),

    listAllTasks: () =>
      findAllTaskRows().pipe(Effect.mapError(toSqlOrDecodeError("CrewRepository.listAllTasks"))),

    closeTask: (input) =>
      closeTaskRow(input).pipe(Effect.mapError(toSqlOrDecodeError("CrewRepository.closeTask"))),

    insertReport: (report) =>
      insertReportRow(report).pipe(
        Effect.mapError(toSqlOrDecodeError("CrewRepository.insertReport")),
      ),

    selectUnnoted: () =>
      findUnnotedReportRows().pipe(
        Effect.mapError(toSqlOrDecodeError("CrewRepository.selectUnnoted")),
      ),

    stampNoted: (input) =>
      stampNotedRows(input).pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(toSqlOrDecodeError("CrewRepository.stampNoted")),
      ),

    listReportsByTaskId: (input) =>
      findReportRowsByTaskId(input).pipe(
        Effect.mapError(toSqlOrDecodeError("CrewRepository.listReportsByTaskId")),
      ),

    listReports: () =>
      findAllReportRows().pipe(Effect.mapError(toSqlOrDecodeError("CrewRepository.listReports"))),

    countNonAnswerReports: (input) =>
      countNonAnswerReportRows(input).pipe(
        Effect.map((row) => row.count),
        Effect.mapError(toSqlOrDecodeError("CrewRepository.countNonAnswerReports")),
      ),
  };

  return shape;
});

export const CrewRepositoryLive = Layer.effect(CrewRepository)(makeCrewRepository);

export { CREW_REPORTS_PER_TASK_LIMIT };
