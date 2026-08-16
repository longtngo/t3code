import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProviderSessionRuntimeRepositoryError,
} from "../Errors.ts";
import {
  DeletePushSubscriptionInput,
  PushSubscriptionRecord,
  PushSubscriptionRepository,
  type PushSubscriptionRepositoryShape,
} from "../Services/PushSubscription.ts";

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ProviderSessionRuntimeRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makePushSubscriptionRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Insert a subscription, or replace the encryption material for a re-registered
  // endpoint. `created_at` is preserved on conflict (first-seen time).
  const upsertRow = SqlSchema.void({
    Request: PushSubscriptionRecord,
    execute: (subscription) =>
      sql`
        INSERT INTO push_subscriptions (
          endpoint,
          p256dh,
          auth,
          created_at
        )
        VALUES (
          ${subscription.endpoint},
          ${subscription.p256dh},
          ${subscription.auth},
          ${subscription.createdAt}
        )
        ON CONFLICT (endpoint)
        DO UPDATE SET
          p256dh = excluded.p256dh,
          auth = excluded.auth
      `,
  });

  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: PushSubscriptionRecord,
    execute: () =>
      sql`
        SELECT
          endpoint AS "endpoint",
          p256dh AS "p256dh",
          auth AS "auth",
          created_at AS "createdAt"
        FROM push_subscriptions
        ORDER BY created_at ASC, endpoint ASC
      `,
  });

  const deleteRowByEndpoint = SqlSchema.void({
    Request: DeletePushSubscriptionInput,
    execute: ({ endpoint }) =>
      sql`
        DELETE FROM push_subscriptions
        WHERE endpoint = ${endpoint}
      `,
  });

  const upsert: PushSubscriptionRepositoryShape["upsert"] = (subscription) =>
    upsertRow(subscription).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "PushSubscriptionRepository.upsert:query",
          "PushSubscriptionRepository.upsert:encodeRequest",
        ),
      ),
    );

  const list: PushSubscriptionRepositoryShape["list"] = () =>
    listRows(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "PushSubscriptionRepository.list:query",
          "PushSubscriptionRepository.list:decodeRows",
        ),
      ),
    );

  const deleteByEndpoint: PushSubscriptionRepositoryShape["deleteByEndpoint"] = (input) =>
    deleteRowByEndpoint(input).pipe(
      Effect.mapError(toPersistenceSqlError("PushSubscriptionRepository.deleteByEndpoint:query")),
    );

  return {
    upsert,
    list,
    deleteByEndpoint,
  } satisfies PushSubscriptionRepositoryShape;
});

export const PushSubscriptionRepositoryLive = Layer.effect(
  PushSubscriptionRepository,
  makePushSubscriptionRepository,
);
