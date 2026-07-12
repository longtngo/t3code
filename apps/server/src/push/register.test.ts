import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  PushSubscriptionRepository,
  type PushSubscriptionRecord,
  type PushSubscriptionRepositoryShape,
} from "../persistence/Services/PushSubscription.ts";
import { registerPushSubscription } from "./register.ts";

const ALLOWED = "https://fcm.googleapis.com/fcm/send/abc123";
const DISALLOWED = "https://192.168.1.1/x";

const makeRepo = (opts?: { readonly failUpsert?: boolean }) => {
  const upserts: PushSubscriptionRecord[] = [];
  const repo: PushSubscriptionRepositoryShape = {
    upsert: (record) => {
      upserts.push(record);
      // A defect exercises the catchCause path (registered→error) without needing
      // to construct the concrete repository error type.
      return opts?.failUpsert ? Effect.die(new Error("upsert boom")) : Effect.void;
    },
    list: () => Effect.succeed([]),
    deleteByEndpoint: () => Effect.void,
  };
  return { repo, upserts };
};

it.effect("registers an allowed endpoint and upserts the subscription", () => {
  const { repo, upserts } = makeRepo();
  return Effect.gen(function* () {
    const outcome = yield* registerPushSubscription({
      endpoint: ALLOWED,
      keys: { p256dh: "p256dh-value", auth: "auth-value" },
    });
    assert.strictEqual(outcome, "registered");
    assert.strictEqual(upserts.length, 1);
    assert.strictEqual(upserts[0]?.endpoint, ALLOWED);
    assert.strictEqual(upserts[0]?.p256dh, "p256dh-value");
    assert.strictEqual(upserts[0]?.auth, "auth-value");
  }).pipe(Effect.provideService(PushSubscriptionRepository, repo));
});

it.effect("rejects a disallowed (SSRF) endpoint without touching the repository", () => {
  const { repo, upserts } = makeRepo();
  return Effect.gen(function* () {
    const outcome = yield* registerPushSubscription({
      endpoint: DISALLOWED,
      keys: { p256dh: "p256dh-value", auth: "auth-value" },
    });
    assert.strictEqual(outcome, "rejected");
    assert.strictEqual(upserts.length, 0);
  }).pipe(Effect.provideService(PushSubscriptionRepository, repo));
});

it.effect("maps a persistence failure to error (never escapes as a failure)", () => {
  const { repo } = makeRepo({ failUpsert: true });
  return Effect.gen(function* () {
    const outcome = yield* registerPushSubscription({
      endpoint: ALLOWED,
      keys: { p256dh: "p256dh-value", auth: "auth-value" },
    });
    assert.strictEqual(outcome, "error");
  }).pipe(Effect.provideService(PushSubscriptionRepository, repo));
});
