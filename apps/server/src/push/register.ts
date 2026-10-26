/**
 * Web Push registration shared by the WS handler and the HTTP route, so the SSRF guard
 * (`isAllowedPushEndpoint`) cannot drift. Returns an outcome instead of throwing so neither
 * caller's error channel widens.
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

export const registerPushSubscription = Effect.fn("push.registerPushSubscription")(function* (
  input: RegisterPushSubscriptionInput,
): Effect.fn.Return<RegisterPushSubscriptionOutcome, never, PushSubscriptionRepository> {
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
