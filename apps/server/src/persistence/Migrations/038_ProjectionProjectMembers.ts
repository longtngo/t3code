/**
 * Adds `members_json` (JSON `WorkspaceMember[]`) to `projection_projects`. `NOT NULL DEFAULT
 * '[]'` because the table already has live rows, which must decode as an empty list rather
 * than fail on a NULL column.
 */
import * as SqlClient from "effect/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_projects ADD COLUMN members_json TEXT NOT NULL DEFAULT '[]'
  `;
});
