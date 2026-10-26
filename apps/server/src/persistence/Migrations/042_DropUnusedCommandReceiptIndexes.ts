import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Drops the two secondary indexes on `orchestration_command_receipts`. Every query uses the
 * `command_id` primary key, so they only cost: 142 MB on a real database and three B-tree
 * writes per insert instead of one. Cheap to bring back if a query needs them.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP INDEX IF EXISTS idx_orch_command_receipts_aggregate`;
  yield* sql`DROP INDEX IF EXISTS idx_orch_command_receipts_sequence`;
});
