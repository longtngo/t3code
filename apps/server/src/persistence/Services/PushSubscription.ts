/**
 * PushSubscriptionRepository - Repository for browser Web Push subscriptions.
 *
 * Owns the durable set of `PushManager` subscriptions the server sends VAPID-signed
 * Web Push messages to, so background thread notifications reach a device with the
 * PWA tab frozen (screen off). See migration 037 for the rationale. Rows are keyed by
 * `endpoint` (idempotent re-register) and pruned when a send returns 404/410.
 *
 * @module PushSubscriptionRepository
 */
import { IsoDateTime } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProviderSessionRuntimeRepositoryError } from "../Errors.ts";

export const PushSubscriptionRecord = Schema.Struct({
  /** Push-service endpoint URL (FCM etc.); the PRIMARY KEY / device identity. */
  endpoint: Schema.String,
  /** Client public key for Web Push message encryption (not a secret). */
  p256dh: Schema.String,
  /** Client auth secret for Web Push message encryption. */
  auth: Schema.String,
  createdAt: IsoDateTime,
});
export type PushSubscriptionRecord = typeof PushSubscriptionRecord.Type;

export const DeletePushSubscriptionInput = Schema.Struct({ endpoint: Schema.String });
export type DeletePushSubscriptionInput = typeof DeletePushSubscriptionInput.Type;

export type PushSubscriptionRepositoryError = ProviderSessionRuntimeRepositoryError;

/**
 * PushSubscriptionRepositoryShape - Service API for push-subscription persistence.
 */
export interface PushSubscriptionRepositoryShape {
  /** Insert or replace a subscription row. Upserts by `endpoint`. */
  readonly upsert: (
    subscription: PushSubscriptionRecord,
  ) => Effect.Effect<void, PushSubscriptionRepositoryError>;

  /** List all stored subscriptions (the push fan-out target set). */
  readonly list: () => Effect.Effect<
    ReadonlyArray<PushSubscriptionRecord>,
    PushSubscriptionRepositoryError
  >;

  /** Delete a subscription by endpoint (called when a send returns 404/410). */
  readonly deleteByEndpoint: (
    input: DeletePushSubscriptionInput,
  ) => Effect.Effect<void, PushSubscriptionRepositoryError>;
}

/**
 * PushSubscriptionRepository - Service tag for push-subscription persistence.
 */
export class PushSubscriptionRepository extends Context.Service<
  PushSubscriptionRepository,
  PushSubscriptionRepositoryShape
>()("t3/persistence/Services/PushSubscription/PushSubscriptionRepository") {}
