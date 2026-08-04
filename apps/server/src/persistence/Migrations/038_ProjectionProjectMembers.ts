/**
 * Adds `members_json` to `projection_projects`: the JSON-encoded array of
 * `WorkspaceMember` entries (additional git repositories a project's threads
 * operate on, beyond `workspaceRoot`), mirroring how `scripts_json` already
 * persists `ProjectScript[]`.
 *
 * The column is `NOT NULL DEFAULT '[]'` because, unlike `scripts_json`, it is
 * being added to a table that already has live rows: existing rows must
 * decode as an empty member list (`'[]'` is what
 * `Schema.fromJsonString(Schema.Array(WorkspaceMember))` decodes to `[]`)
 * rather than failing to decode a NULL/missing column.
 */
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_projects ADD COLUMN members_json TEXT NOT NULL DEFAULT '[]'
  `;
});
