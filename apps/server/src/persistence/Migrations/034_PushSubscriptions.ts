/**
 * Adds `push_subscriptions`: the durable set of browser Web Push subscriptions the
 * server sends VAPID-signed pushes to, so background thread notifications (a turn
 * finishing, a thread asking a question) reach a device even when the PWA tab is
 * frozen — screen off / backgrounded — which the WebSocket-driven foreground
 * notifier cannot cover.
 *
 * A row is one `PushManager` subscription (per device/browser). `endpoint` is the
 * push-service URL (FCM etc.) and the PRIMARY KEY, so re-registering the same device
 * is an idempotent upsert. `p256dh`/`auth` are the client's public encryption
 * material for the Web Push message-encryption scheme (not secrets). Rows are pruned
 * when a send returns 404/410 (subscription gone).
 */
import * as SqlClient from "effect/unstable/sql/SqlClient";
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
