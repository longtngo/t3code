/**
 * Shared Web Push subscription registration, used by BOTH the WS RPC handler
 * (`ws.ts`) and the HTTP route (`http.ts`, hit by the service worker's
 * `pushsubscriptionchange` background re-register). Single-sourcing keeps the
 * SSRF guard (`isAllowedPushEndpoint`) from drifting between the two entry points.
 *
 * Returns a discriminated outcome rather than throwing so neither caller's error
 * channel widens: a persistence failure is caught HERE and mapped to "error", the
 * disallowed-endpoint case to "rejected". The WS handler collapses both non-success
 * outcomes to `{ ok: false }` (its historical contract); the HTTP route maps
 * registered→204, rejected→403, error→500.
 */
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { PushSubscriptionRepository } from "../persistence/Services/PushSubscription.ts";
import { isAllowedPushEndpoint } from "./WebPushRelay.ts";

export interface RegisterPushSubscriptionInput {
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
}

export type RegisterPushSubscriptionOutcome = "registered" | "rejected" | "error";

export const registerPushSubscription = (
  input: RegisterPushSubscriptionInput,
): Effect.Effect<RegisterPushSubscriptionOutcome, never, PushSubscriptionRepository> =>
  Effect.gen(function* () {
    if (!isAllowedPushEndpoint(input.endpoint)) {
      yield* Effect.logWarning("rejected push subscription with disallowed endpoint", {
        endpoint: input.endpoint,
      });
      return "rejected" as const;
    }
    const repo = yield* PushSubscriptionRepository;
    const createdAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    return yield* repo
      .upsert({
        endpoint: input.endpoint,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        createdAt,
      })
      .pipe(
        Effect.as("registered" as const),
        Effect.catchCause((cause) =>
          Effect.logWarning("push subscription register failed", {
            cause: Cause.pretty(cause),
          }).pipe(Effect.as("error" as const)),
        ),
      );
  });
