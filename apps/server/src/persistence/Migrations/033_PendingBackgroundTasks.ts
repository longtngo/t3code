/**
 * Adds `pending_background_tasks`: the durable record of in-flight background
 * tasks (backgrounded shell watchers, fire-and-forget `Agent`/Task subagents)
 * that the recovery heartbeat reconciles after a server restart.
 *
 * The existing wake path (`maybeWakeThreadForCompletedTask`) only resumes an
 * idle thread when a `task.completed` event arrives. If the server process is
 * restarted (BE/FE rebuild) while a background task is in flight, the SDK
 * subprocess and the task die with it, that event never fires, and the thread
 * waits forever. Nothing persisted survived the restart to notice the orphan —
 * this table is that missing record.
 *
 * A row is written for every `task.started` and deleted on
 * `task.completed`/`stopped`; "background-ness" cannot be known at start time
 * (a background task's `task_started` still carries its launching turn id), so
 * the recovery watchdog distinguishes genuine orphans by idle-thread state +
 * `boot_id`/session-liveness rather than at write time.
 *
 * `boot_id` is a per-process UUID minted at startup. A row whose `boot_id`
 * differs from the current process's is owned by a dead process → orphaned.
 */
import * as SqlClient from "effect/unstable/sql/SqlClient";
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
