/**
 * Adds `checkpoint_member_states_json` to `projection_turns`. Deliberately nullable with no
 * default: NULL means "no claim" for checkpoints captured before this, which revert treats as
 * complete. `'[]'` would falsely assert "there were no members".
 */
import * as SqlClient from "effect/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_turns ADD COLUMN checkpoint_member_states_json TEXT
  `;
});
