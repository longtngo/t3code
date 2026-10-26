/**
 * Adds `push_subscriptions`: Web Push targets for notifications while the PWA is frozen.
 * `endpoint` is the primary key so re-registering is an idempotent upsert. Formerly the fork's
 * 034; CREATE TABLE IF NOT EXISTS lets a DB that applied 034 just record this id.
 */
import * as SqlClient from "effect/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint    TEXT PRIMARY KEY,
      p256dh      TEXT NOT NULL,
      auth        TEXT NOT NULL,
      created_at  TEXT NOT NULL
    )
  `;
});
