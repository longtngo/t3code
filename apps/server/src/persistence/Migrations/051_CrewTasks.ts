/**
 * Adds `crew_tasks` and `crew_reports`: the durable record of crew orchestration.
 *
 * A *bridge* thread dispatches *crewmate* threads, each into its own git worktree.
 * `crew_tasks` is the one row per dispatch that outlives the process — the worktree
 * path and branch it must tear down, the crew thread whose provider session must be
 * exempted from the reaper, and the parent it reports back to. Without it a restart
 * leaks a worktree and a branch with nothing left that knows they exist.
 *
 * `crew_reports` is the outbox. A crewmate writes a report; the delivery sweep hands
 * it to the bridge and stamps `noted_at`. A NULL `noted_at` *is* the queue, so the
 * sweep's selection is `WHERE noted_at IS NULL` and delivery is idempotent across a
 * restart: an undelivered report is still undelivered when the process comes back.
 *
 * `ix_crew_tasks_crew` is UNIQUE, not merely an index. One crew thread belongs to at
 * most one task; two tasks pointing at the same thread would make teardown ambiguous
 * about which worktree it owns.
 *
 * `base_ref` is nullable: a task may be rooted at the project's current HEAD rather
 * than at a named ref. `reply_to` is nullable because most reports are not answers.
 */
import * as SqlClient from "effect/unstable/sql/SqlClient";
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
