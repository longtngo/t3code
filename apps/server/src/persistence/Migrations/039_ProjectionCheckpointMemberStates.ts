/**
 * Adds `checkpoint_member_states_json` to `projection_turns`: where each
 * workspace member repository stood when a checkpoint was captured.
 *
 * Unlike `checkpoint_files_json`, this column is nullable with no default, and
 * that distinction carries meaning rather than being an oversight. A checkpoint
 * captured before this shipped genuinely does not know what its members were
 * doing, and must not claim it: NULL decodes to "no claim", which the revert
 * path treats as complete — exactly the behavior those checkpoints were
 * captured under. `'[]'` would instead assert "there were no members", which is
 * a different and possibly false statement.
 */
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_turns ADD COLUMN checkpoint_member_states_json TEXT
  `;
});
