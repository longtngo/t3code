import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * For `listUserInputLifecycleByThreadId` (projector, write transaction): ~50 ms -> ~0.07 ms on
 * an 82k-row thread. Not a partial index: its `IN` list must match the query's exactly. HAZARD:
 * if `ANALYZE`/`PRAGMA optimize` is ever added, add `NOT INDEXED` to `getLatestTaskActivity`
 * first, or it switches to this index and slows from ~0.02 ms to ~43-78 ms.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_thread_kind
    ON projection_thread_activities(thread_id, kind)
  `;
});
