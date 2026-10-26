// Crew orchestration was removed; kept so migration ids stay contiguous. Its tables are unused.
/**
 * `crew_tasks`: one row per dispatch that outlives a restart, so worktrees and branches are not
 * leaked; `ix_crew_tasks_crew` is UNIQUE so teardown is never ambiguous. `crew_reports` is the
 * outbox: a NULL `noted_at` IS the queue, so delivery is idempotent across restarts.
 */
import * as SqlClient from "effect/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS crew_tasks (
      task_id          TEXT PRIMARY KEY NOT NULL,
      parent_thread_id TEXT NOT NULL,
      crew_thread_id   TEXT NOT NULL,
      project_id       TEXT NOT NULL,
      base_ref         TEXT,
      branch           TEXT NOT NULL,
      worktree_path    TEXT NOT NULL,
      provider         TEXT NOT NULL,
      status           TEXT NOT NULL,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS ix_crew_tasks_parent
    ON crew_tasks (parent_thread_id)
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS ix_crew_tasks_crew
    ON crew_tasks (crew_thread_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS ix_crew_tasks_status
    ON crew_tasks (status)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS crew_reports (
      report_id  TEXT PRIMARY KEY NOT NULL,
      task_id    TEXT NOT NULL,
      state      TEXT NOT NULL,
      note       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      noted_at   TEXT,
      reply_to   TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS ix_crew_reports_task
    ON crew_reports (task_id, created_at)
  `;
});
