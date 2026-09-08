import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Composite index for the thread-detail reads that filter activities by kind.
 *
 * Every pre-existing index on this table is (thread_id, sequence...) or
 * (thread_id, created_at), so a query asking for one kind within a thread could
 * only be served by scanning all of that thread's activities and testing `kind`
 * row by row.
 *
 * The win is `listUserInputLifecycleByThreadId`, which `refreshThreadShellSummary`
 * runs in the projector on both turn-lifecycle events and six activity kinds —
 * several times per turn, on the command worker, inside the write transaction.
 * Measured on a real 1.28M-row table, heaviest thread (82,130 rows):
 *
 *     without this index   SEARCH ... idx_..._thread_sequence + TEMP B-TREE   ~50 ms
 *     with this index      SEARCH ... idx_..._thread_kind    + TEMP B-TREE    ~0.07 ms
 *
 * An earlier version of this comment justified the index with the pinned-activity
 * CTE in `ProjectionSnapshotQuery` instead, quoting 131 ms -> 0.1 ms. That number
 * was real but described a state that does not occur: the CTE is CROSS JOINed
 * behind a pending approval or pending user input, and with none outstanding the
 * join yields no rows and the scan never runs. In practice that path measured
 * 0.06 -> 0.05 ms, and 2x in a forced worst case.
 *
 * Write cost is small: +16% per row in a transaction, +32% on an autocommit
 * insert, ~+2.5 microseconds absolute, and 76 MiB on disk. Building it costs a
 * one-time ~2 s stall, during the migration step that runs ahead of every
 * startup phase.
 *
 * A partial index over just the three lifecycle kinds is the alternative, and it
 * is NOT ruled out on performance: SQLite does pick it for this query, at
 * 0.072 ms against this index's 0.069 ms, for 94 KB instead of 76 MiB. It is
 * ruled out on coupling, which is tighter than "keep the lists in sync" suggests:
 * the query's `IN` list must match the index's EXACTLY, element order included.
 * Measured - reordering the same three kinds, dropping one, or adding a fourth all
 * fall back to the `..._thread_sequence` scan. So a pure no-op refactor of
 * `listUserInputLifecycleByThreadId` silently returns it to the ~50 ms scan, and
 * nothing enforces the coupling. That is the failure shape this file exists to
 * remove. 76 MiB on a multi-gigabyte database buys that decoupling.
 *
 * (SQLite does refuse a partial index for a SINGLE-kind equality like
 * `kind = 'approval.requested'`, since it cannot prove that implies the index's
 * `IN` list. That was the shape of the earlier, retired justification, and is why
 * this paragraph once claimed partial indexes were unusable here.)
 *
 * HAZARD: this table has no `sqlite_stat1` and nothing in the repo runs `ANALYZE`
 * or `PRAGMA optimize`. If that ever changes, `getLatestTaskActivity` — which
 * today rides (thread_id, sequence DESC) and stops at LIMIT 1 — switches to this
 * index plus a TEMP B-TREE sort over every task row in the thread, measured at
 * ~0.02 ms -> ~43-78 ms. Add `NOT INDEXED` to that query before introducing
 * statistics.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_thread_kind
    ON projection_thread_activities(thread_id, kind)
  `;
});
