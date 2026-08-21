import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Drops the two secondary indexes on `orchestration_command_receipts`.
 *
 * The table is reached by exactly two statements - an upsert keyed on the
 * `command_id` primary key, and a lookup by that same primary key (see
 * `Layers/OrchestrationCommandReceipts.ts`). Nothing has ever queried by
 * aggregate or by result sequence, so both indexes only ever cost: on a real
 * database they held 142 MB, and every insert paid three B-tree writes instead
 * of one at 40-100k inserts a day.
 *
 * They are cheap to bring back if a query ever needs them.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP INDEX IF EXISTS idx_orch_command_receipts_aggregate`;
  yield* sql`DROP INDEX IF EXISTS idx_orch_command_receipts_sequence`;
});
