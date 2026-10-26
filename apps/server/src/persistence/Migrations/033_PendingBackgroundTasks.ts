/**
 * Adds `pending_background_tasks`, so a background task orphaned by a server restart (its
 * `task.completed` never fires) can be recovered. Rows are written on every `task.started`
 * since background-ness is unknown at start; recovery uses idle state and `boot_id` (a
 * per-process UUID: a different one means a dead owner).
 */
import * as SqlClient from "effect/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS pending_background_tasks (
      task_id            TEXT PRIMARY KEY,
      thread_id          TEXT NOT NULL,
      boot_id            TEXT NOT NULL,
      started_at         TEXT NOT NULL,
      last_seen_at       TEXT NOT NULL,
      recovery_attempts  INTEGER NOT NULL DEFAULT 0
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_pending_background_tasks_thread
    ON pending_background_tasks(thread_id)
  `;
});
