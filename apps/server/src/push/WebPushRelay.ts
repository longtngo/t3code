/**
 * WebPushRelay - sends VAPID Web Push notifications for two thread edges (a run
 * finishing; an agent asking the user a question) to the browser PWA, so they
 * arrive with the tab frozen (screen off). The WebSocket-driven foreground notifier
 * (`apps/web/src/lib/notifier.ts`) cannot cover that case.
 *
 * Edges are classified from the orchestrator v2 domain event itself, by positive
 * match: a `run.updated` whose run reached a terminal status, or a
 * `runtime-request.updated` that opened a pending `user_input` request. The stream
 * handler is O(1) and only enqueues the edge (invariant 18: the domain-event hub is
 * unbounded, so an internal reader must take promptly); reads and HTTP sends run on
 * a `DrainableWorker`.
 *
 * @module WebPushRelay
 */
import { DEFAULT_SERVER_SETTINGS, isInterimBackgroundLiveness } from "@t3tools/contracts";
import type {
  NotificationCategorySettings,
  OrchestrationV2DomainEvent,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import webpush from "web-push";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import {
  PushSubscriptionRepository,
  type PushSubscriptionRecord,
} from "../persistence/Services/PushSubscription.ts";
import { forkParked } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";

// ---------------------------------------------------------------------------
// VAPID keys (server secret, generated once)
// ---------------------------------------------------------------------------

const WEB_PUSH_VAPID_KEY_PAIR_SECRET = "web-push-vapid-key-pair";
// VAPID requires a contact subject (mailto:/https:). Not user-visible; used only in
// the signed JWT the push service may use to contact the app operator.
const VAPID_SUBJECT = "mailto:notifications@t3code.local";

const VapidKeyPair = Schema.Struct({
  publicKey: Schema.String,
  privateKey: Schema.String,
});
type VapidKeyPair = typeof VapidKeyPair.Type;

const VapidKeyPairJson = Schema.fromJsonString(VapidKeyPair);
const decodeVapidKeyPair = Schema.decodeUnknownEffect(VapidKeyPairJson);
const encodeVapidKeyPair = Schema.encodeEffect(VapidKeyPairJson);

const VAPID_SECRET_RESOURCE = `secret ${WEB_PUSH_VAPID_KEY_PAIR_SECRET}`;

const readVapidKeyPair = Effect.fn("readVapidKeyPair")(function* (
  secrets: ServerSecretStore.ServerSecretStore["Service"],
) {
  const encoded = yield* secrets.get(WEB_PUSH_VAPID_KEY_PAIR_SECRET);
  if (Option.isNone(encoded)) {
    return null;
  }
  return yield* decodeVapidKeyPair(new TextDecoder().decode(encoded.value)).pipe(
    Effect.mapError(
      (cause) =>
        new ServerSecretStore.SecretStoreDecodeError({ resource: VAPID_SECRET_RESOURCE, cause }),
    ),
  );
});

/**
 * Read the persisted VAPID key pair, generating and persisting one on first use.
 * TOCTOU-safe (create + catch AlreadyExists -> re-read), so two concurrent boots
 * converge on a single key pair rather than racing into two.
 */
export const getOrCreateVapidKeys = Effect.fn("getOrCreateVapidKeys")(function* (
  secrets: ServerSecretStore.ServerSecretStore["Service"],
) {
  const existing = yield* readVapidKeyPair(secrets);
  if (existing !== null) {
    return existing;
  }

  const generated = webpush.generateVAPIDKeys();
  const encoded = yield* encodeVapidKeyPair(generated).pipe(
    Effect.mapError(
      (cause) =>
        new ServerSecretStore.SecretStoreEncodeError({ resource: VAPID_SECRET_RESOURCE, cause }),
    ),
  );
  return yield* secrets
    .create(WEB_PUSH_VAPID_KEY_PAIR_SECRET, new TextEncoder().encode(encoded))
    .pipe(
      Effect.as(generated as VapidKeyPair),
      Effect.catchIf(ServerSecretStore.isSecretStoreError, (error) =>
        ServerSecretStore.isSecretAlreadyExistsError(error)
          ? readVapidKeyPair(secrets).pipe(
              Effect.flatMap((concurrent) =>
                concurrent !== null
                  ? Effect.succeed(concurrent)
                  : Effect.fail(
                      new ServerSecretStore.SecretStoreConcurrentReadError({
                        resource: VAPID_SECRET_RESOURCE,
                      }),
                    ),
              ),
            )
          : Effect.fail(error),
      ),
    );
});

// ---------------------------------------------------------------------------
// Pure edge classification (unit-tested)
// ---------------------------------------------------------------------------

export type ThreadNotifyEdge =
  | { readonly kind: "finished"; readonly outcome: "completed" | "error" | "interrupted" }
  | { readonly kind: "asking" };

export interface PushEdge {
  readonly threadId: ThreadId;
  /** One push per key: a run id or a runtime-request id. */
  readonly key: string;
  readonly edge: ThreadNotifyEdge;
}

/**
 * The push edge a domain event raises, or `null`.
 *
 * Positive match only; every other event type and every unlisted status is `null`:
 * - `run.updated` with status `completed` -> finished/completed, `failed` ->
 *   finished/error, `interrupted` or `cancelled` -> finished/interrupted. A run
 *   that never started (a withdrawn or restart-cancelled queued message) does not
 *   "finish", except a failure, which is the alert people keep. A run completed
 *   before `notBefore` (this relay's start) is history being re-written, not news.
 * - `runtime-request.updated` opening a `pending` `user_input` request -> asking.
 *   Approvals are not "asking", matching the fork's V1 `hasPendingUserInput` edge.
 */
export function classifyPushEdge(
  event: OrchestrationV2DomainEvent,
  notBefore: DateTime.Utc,
): PushEdge | null {
  switch (event.type) {
    case "run.updated": {
      const run = event.payload;
      if (run.completedAt !== null && DateTime.isLessThan(run.completedAt, notBefore)) {
        return null;
      }
      const started = run.startedAt !== null;
      const finished = (outcome: "completed" | "error" | "interrupted"): PushEdge => ({
        threadId: run.threadId,
        key: `run:${run.id}`,
        edge: { kind: "finished", outcome },
      });
      switch (run.status) {
        case "completed":
          return started ? finished("completed") : null;
        case "failed":
          return finished("error");
        case "interrupted":
        case "cancelled":
          return started ? finished("interrupted") : null;
        default:
          return null;
      }
    }
    case "runtime-request.updated": {
      const request = event.payload;
      return request.kind === "user_input" && request.status === "pending"
        ? { threadId: event.threadId, key: `request:${request.id}`, edge: { kind: "asking" } }
        : null;
    }
    default:
      return null;
  }
}

/** Post-settlement background work, as the web notifier derives it from the same shell. */
function backgroundLivenessOf(shell: OrchestrationV2ThreadShell): "monitoring" | null {
  return (shell.pendingBackgroundTasks?.length ?? 0) > 0 ? "monitoring" : null;
}

/**
 * Which category an edge belongs to. A finish splits on live background work: an
 * agent that fans out to subagents settles once per wake-up, and the last of those
 * is the genuinely final completion. A failure never becomes an interim finish.
 * Mirrored by `categoryForCompletion` in the web notifier.
 */
function categoryForEdge(
  edge: ThreadNotifyEdge,
  backgroundLiveness: "working" | "monitoring" | null,
): keyof NotificationCategorySettings {
  if (edge.kind === "asking") {
    return "needsInput";
  }
  if (edge.outcome === "error") {
    return "failed";
  }
  return isInterimBackgroundLiveness(backgroundLiveness) ? "finishedBackground" : "finished";
}

/** Drop the edges whose category the user has switched off. */
export function filterEdgesByCategory(
  edges: ReadonlyArray<ThreadNotifyEdge>,
  categories: NotificationCategorySettings,
  backgroundLiveness: "working" | "monitoring" | null,
): ReadonlyArray<ThreadNotifyEdge> {
  return edges.filter((edge) => categories[categoryForEdge(edge, backgroundLiveness)]);
}

/** Build the JSON push payload the service-worker `push` handler renders. */
export function buildPushPayload(input: {
  readonly edge: ThreadNotifyEdge;
  readonly title: string;
  readonly url: string;
  readonly threadId: string;
}): string {
  const body =
    input.edge.kind === "asking"
      ? "Waiting for your input"
      : input.edge.outcome === "error"
        ? "Task stopped with an error"
        : input.edge.outcome === "interrupted"
          ? "Task was interrupted"
          : "Task finished";
  return JSON.stringify({
    title: input.title,
    body,
    // `tag` coalesces same-thread notifications on the device.
    tag: input.threadId,
    url: input.url,
    // The SW suppresses a "finished" push while a tab is visible (the foreground
    // notifier covers it); an "asking" push has no foreground counterpart.
    kind: input.edge.kind,
  });
}

function isPrivateOrLoopbackIp(host: string): boolean {
  const h = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  // IPv6 loopback / unique-local / link-local.
  if (h === "::1" || h === "::" || /^f[cd][0-9a-f]{0,2}:/i.test(h) || /^fe80:/i.test(h)) {
    return true;
  }
  // IPv4 loopback / private / link-local / unspecified.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 127 ||
      a === 10 ||
      a === 0 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 169 && b === 254)
    );
  }
  return false;
}

/**
 * Trust-boundary guard on a client-supplied push endpoint: the server will POST to
 * this URL on every thread edge, so reject anything that isn't a plausible public
 * push service - non-HTTPS, loopback/private IPs, or single-label/`.local` hosts -
 * to blunt blind SSRF via `pushSubscriptions.register`.
 */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    return false;
  }
  if (isPrivateOrLoopbackIp(host)) {
    return false;
  }
  // Require a dotted public name (blocks bare internal single-label hostnames).
  return host.includes(".");
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Remembered push keys; a run or request re-written later must not push twice.
 * In memory and bounded: a rewrite of a run more than this many edges old pushes
 * again. Accepted: terminal runs are not normally re-written, and a duplicate
 * notification is cheaper than an unbounded set or a table for it.
 */
export const MAX_REMEMBERED_PUSH_KEYS = 1_000;
const SEND_TIMEOUT = "15 seconds";

export interface WebPushRelayShape {
  /** The VAPID public key (base64url) clients feed to `PushManager.subscribe`. */
  readonly vapidPublicKey: string;
  /** The stream handler: classify and enqueue, never wait. */
  readonly handleEvent: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  readonly drain: Effect.Effect<void>;
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  /**
   * Stop pushing for the rest of this process. Server shutdown calls it before it
   * cancels the runs still in flight, which are not the user's work ending.
   */
  readonly stop: Effect.Effect<void>;
}

export class WebPushRelay extends Context.Service<WebPushRelay, WebPushRelayShape>()(
  "t3/push/WebPushRelay",
) {}

/**
 * The push-service origin only. A subscription endpoint's path is its bearer token,
 * so it must not reach logs or spans.
 */
function endpointOrigin(endpoint: string): string {
  try {
    return new URL(endpoint).origin;
  } catch {
    return "<invalid endpoint>";
  }
}

/** Any tagged failure; the relay logs it and moves on. */
type TaggedFailure = { readonly _tag: string };

/** The two orchestrator reads the relay needs; `ThreadManagementService` in production. */
export interface WebPushRelayThreads {
  /** Live tail of domain events (the unbounded internal-worker form, invariant 18). */
  readonly streamDomainEvents: Stream.Stream<OrchestrationV2DomainEvent, TaggedFailure>;
  readonly getThreadShell: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationV2ThreadShell | null, TaggedFailure>;
}

export const makeWebPushRelay = Effect.fn("WebPushRelay.make")(function* (
  threads: WebPushRelayThreads,
) {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const serverEnvironment = yield* ServerEnvironment;
  const pushRepo = yield* PushSubscriptionRepository;
  const serverSettings = yield* ServerSettingsService;
  // No trace context to a third-party push service, and no span: its url.full would
  // carry the subscription token.
  const httpClient = (yield* HttpClient.HttpClient).pipe(
    HttpClient.transform((effect) =>
      effect.pipe(
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      ),
    ),
  );

  const vapidKeys = yield* getOrCreateVapidKeys(secrets);
  const notBefore = yield* DateTime.now;
  const rememberedKeys = new Set<string>();
  let stopped = false;

  // Prunes the subscription on 404/410 (gone); logs and swallows everything else so
  // one bad or hung endpoint never aborts the fan-out to the others.
  const sendToSubscription = (subscription: PushSubscriptionRecord, payload: string) =>
    Effect.gen(function* () {
      const details = webpush.generateRequestDetails(
        {
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        },
        payload,
        {
          TTL: 120,
          urgency: "high",
          vapidDetails: {
            subject: VAPID_SUBJECT,
            publicKey: vapidKeys.publicKey,
            privateKey: vapidKeys.privateKey,
          },
        },
      );
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(details.headers)) {
        // fetch computes the length itself.
        if (name.toLowerCase() !== "content-length") headers[name] = String(value);
      }
      const request = HttpClientRequest.post(details.endpoint).pipe(
        HttpClientRequest.setHeaders(headers),
        HttpClientRequest.bodyUint8Array(
          new Uint8Array(details.body ?? new Uint8Array()),
          "application/octet-stream",
        ),
      );
      const response = yield* httpClient.execute(request).pipe(Effect.timeout(SEND_TIMEOUT));
      if (response.status === 404 || response.status === 410) {
        yield* Effect.logInfo("pruning gone push subscription", {
          endpoint: endpointOrigin(subscription.endpoint),
          statusCode: response.status,
        });
        yield* pushRepo.deleteByEndpoint({ endpoint: subscription.endpoint });
        return;
      }
      if (response.status < 200 || response.status >= 300) {
        yield* Effect.logWarning("web push send failed", {
          endpoint: endpointOrigin(subscription.endpoint),
          statusCode: response.status,
        });
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("web push send errored", {
          endpoint: endpointOrigin(subscription.endpoint),
          cause: Cause.pretty(cause),
        }),
      ),
    );

  // Fail OPEN: an unreadable settings file must not silence notifications.
  const readNotificationCategories = serverSettings.getRawSettings.pipe(
    Effect.map((settings) => settings.notificationCategories),
    Effect.catchCause((cause) =>
      Effect.logWarning("notification categories unreadable; allowing all notifications", {
        cause: Cause.pretty(cause),
      }).pipe(Effect.as(DEFAULT_SERVER_SETTINGS.notificationCategories)),
    ),
  );

  const processEdge = ({ threadId, key, edge }: PushEdge) =>
    Effect.gen(function* () {
      if (stopped) return;
      const shell = yield* threads.getThreadShell(threadId);
      if (shell === null || shell.deletedAt !== null) {
        return;
      }
      // A delegated subagent's run and questions belong to its parent's turn; the
      // web notifier and the thread list skip these threads too.
      if (shell.lineage.relationshipToParent === "subagent") {
        return;
      }
      const categories = yield* readNotificationCategories;
      const backgroundLiveness = backgroundLivenessOf(shell);
      const allowed = filterEdgesByCategory([edge], categories, backgroundLiveness);
      if (allowed.length === 0) {
        yield* Effect.logDebug("web push edge suppressed by notification categories", {
          threadId,
          edge: edge.kind,
          backgroundLiveness,
        });
        return;
      }
      const subscriptions = yield* pushRepo.list();
      if (subscriptions.length === 0) {
        return;
      }
      const environmentId = yield* serverEnvironment.getEnvironmentId;
      const payload = buildPushPayload({
        edge,
        title: shell.title,
        url: `/${environmentId}/${threadId}`,
        threadId,
      });
      yield* Effect.forEach(
        subscriptions,
        (subscription) => sendToSubscription(subscription, payload),
        { concurrency: 8, discard: true },
      );
    }).pipe(
      // Reads failed before anything was sent: forget the key so a later rewrite of
      // the same run or request can still push. Individual sends never fail here.
      Effect.catchCause((cause) =>
        Effect.sync(() => rememberedKeys.delete(key)).pipe(
          Effect.andThen(
            Effect.logWarning("web push relay failed for thread", {
              threadId,
              cause: Cause.pretty(cause),
            }),
          ),
        ),
      ),
    );

  const worker = yield* makeDrainableWorker(processEdge);

  const handleEvent: WebPushRelayShape["handleEvent"] = (event) =>
    Effect.suspend(() => {
      if (stopped) return Effect.void;
      const edge = classifyPushEdge(event, notBefore);
      if (edge === null || rememberedKeys.has(edge.key)) {
        return Effect.void;
      }
      rememberedKeys.add(edge.key);
      if (rememberedKeys.size > MAX_REMEMBERED_PUSH_KEYS) {
        const oldest = rememberedKeys.values().next().value;
        if (oldest !== undefined) rememberedKeys.delete(oldest);
      }
      return worker.enqueue(edge).pipe(
        Effect.andThen(
          Effect.logDebug("web push edge queued", {
            threadId: edge.threadId,
            key: edge.key,
            edge: edge.edge.kind,
          }),
        ),
      );
    });

  const start: WebPushRelayShape["start"] = Effect.fn("WebPushRelay.start")(function* () {
    yield* Effect.logInfo("web push relay enabled");
    yield* forkParked(Stream.runForEach(threads.streamDomainEvents, handleEvent));
  });

  return WebPushRelay.of({
    vapidPublicKey: vapidKeys.publicKey,
    handleEvent,
    drain: worker.drain,
    start,
    stop: Effect.sync(() => {
      stopped = true;
    }),
  });
});

export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  return yield* makeWebPushRelay(threads);
});

export const layer = Layer.effect(WebPushRelay, make).pipe(Layer.provide(FetchHttpClient.layer));
