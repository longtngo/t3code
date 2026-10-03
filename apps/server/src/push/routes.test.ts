import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import { afterAll, describe, expect, it } from "vite-plus/test";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { pushSubscriptionsRouteLayer, pushVapidPublicKeyRouteLayer } from "../http.ts";
import {
  PushSubscriptionRepository,
  type PushSubscriptionRecord,
} from "../persistence/Services/PushSubscription.ts";
import { WebPushRelay } from "./WebPushRelay.ts";

const upserts: Array<PushSubscriptionRecord> = [];

// The session's scopes come from a test header; a real session check is not under test.
const auth = EnvironmentAuth.EnvironmentAuth.of({
  authenticateHttpRequest: (request: HttpServerRequest.HttpServerRequest) =>
    Effect.succeed({
      sessionId: AuthSessionId.make("push-route-session"),
      subject: "push-route-test",
      method: "browser-session-cookie" as const,
      scopes:
        request.headers["x-test-scope"] === "read"
          ? [AuthOrchestrationReadScope]
          : [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
    }),
} as unknown as EnvironmentAuth.EnvironmentAuth["Service"]);

// Route handlers resolve their services per request, so they must be in the app's output.
const appLayer = Layer.mergeAll(pushSubscriptionsRouteLayer, pushVapidPublicKeyRouteLayer).pipe(
  Layer.provideMerge(Layer.succeed(EnvironmentAuth.EnvironmentAuth, auth)),
  Layer.provideMerge(
    Layer.succeed(PushSubscriptionRepository, {
      upsert: (record) => Effect.sync(() => void upserts.push(record)),
      list: () => Effect.succeed([]),
      deleteByEndpoint: () => Effect.void,
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(
      WebPushRelay,
      WebPushRelay.of({
        vapidPublicKey: "test-vapid-public-key",
        handleEvent: () => Effect.void,
        drain: Effect.void,
        start: () => Effect.void,
      }),
    ),
  ),
  Layer.provide(NodeServices.layer),
);
const { handler, dispose } = HttpRouter.toWebHandler(appLayer, { disableLogger: true });
afterAll(() => dispose());

const register = (body: unknown, headers: Record<string, string> = {}) =>
  handler(
    new Request("https://backend.example/api/push/subscriptions", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

const valid = {
  endpoint: "https://fcm.googleapis.com/fcm/send/route-test",
  keys: { p256dh: "p256dh-value", auth: "auth-value" },
};

describe("push HTTP routes", () => {
  it("serves the VAPID public key without authentication", async () => {
    const response = await handler(
      new Request("https://backend.example/api/push/vapid-public-key"),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("test-vapid-public-key");
  });

  it("registers a subscription (204)", async () => {
    const before = upserts.length;
    const response = await register(valid);
    expect(response.status).toBe(204);
    expect(upserts.slice(before).map((row) => row.endpoint)).toEqual([valid.endpoint]);
  });

  it("rejects a private endpoint (403) without storing it", async () => {
    const before = upserts.length;
    const response = await register({ ...valid, endpoint: "https://192.168.1.1/x" });
    expect(response.status).toBe(403);
    expect(upserts.length).toBe(before);
  });

  it("requires the operate scope", async () => {
    const before = upserts.length;
    const response = await register(valid, { "x-test-scope": "read" });
    expect(response.status).toBe(403);
    expect(upserts.length).toBe(before);
  });

  it("rejects a malformed body (400) and a non-JSON content type (415)", async () => {
    expect((await register({ endpoint: valid.endpoint })).status).toBe(400);
    expect((await register(valid, { "content-type": "text/plain" })).status).toBe(415);
  });
});
