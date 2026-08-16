/**
 * WebPushRelay — sends VAPID Web Push notifications for two thread edges (a turn
 * finishing; a thread starting to ask the user a question) to the browser PWA, so
 * they arrive with the tab frozen (screen off) — the case the WebSocket-driven
 * foreground notifier (`apps/web/src/lib/notifier.ts`) structurally cannot cover.
 *
 * Structurally mirrors `relay/AgentAwarenessRelay.ts` (which does the same edge
 * selection for the mobile/APNs path): subscribe to `streamDomainEvents`, queue
 * per-thread work through a serial `DrainableWorker`, read the current
 * `OrchestrationThreadShell`, and fan out. (The worker serialises, it does not
 * coalesce — fire-once is enforced by the prev-state comparison in `processThread`,
 * not the queue.) It differs in transport (VAPID → FCM via `web-push`) and — critically —
 * in dedup: it is an EDGE detector (fire once on a specific transition), not a
 * change detector, and it stores the specific previous fields per thread rather than
 * a coarse state-identity string.
 *
 * @module WebPushRelay
 */
import type {
  OrchestrationEvent,
  OrchestrationLatestTurnState,
  ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import webpush from "web-push";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PushSubscriptionRepository } from "../persistence/Services/PushSubscription.ts";

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
 * TOCTOU-safe (create + catch AlreadyExists → re-read), so two concurrent boots
 * converge on a single key pair rather than racing into two. Exported so both the
 * relay and the `ServerConfig` assembler can obtain the public key.
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

/** The subset of thread-shell state the notification edges are computed from. */
export interface ThreadNotifyState {
  readonly latestTurnState: OrchestrationLatestTurnState | null;
  readonly hasPendingUserInput: boolean;
}

export type ThreadNotifyEdge =
  | { readonly kind: "finished"; readonly outcome: "completed" | "error" | "interrupted" }
  | { readonly kind: "asking" };

function isTerminalTurnState(
  state: OrchestrationLatestTurnState,
): state is "completed" | "error" | "interrupted" {
  return state !== "running";
}

/**
 * Compute which notification edges to fire given the PREVIOUSLY observed state and
 * the current state. Mirrors the shipped foreground `classifyThreadCompletion`:
 * "finished" fires only on a `running` → terminal transition; "asking" fires only on
 * an explicit `hasPendingUserInput` `false` → `true` transition.
 *
 * On first sight of a thread (`previous === null`) this returns no edges — the caller
 * records the current state as the baseline WITHOUT notifying, so a thread that was
 * already terminal or already asking when the server (re)started never emits a stale
 * push.
 */
export function classifyThreadNotifyEdges(
  previous: ThreadNotifyState | null,
  current: ThreadNotifyState,
): ReadonlyArray<ThreadNotifyEdge> {
  if (previous === null) {
    return [];
  }

  const edges: ThreadNotifyEdge[] = [];

  if (
    previous.latestTurnState === "running" &&
    current.latestTurnState !== null &&
    isTerminalTurnState(current.latestTurnState)
  ) {
    edges.push({ kind: "finished", outcome: current.latestTurnState });
  }

  if (previous.hasPendingUserInput === false && current.hasPendingUserInput === true) {
    edges.push({ kind: "asking" });
  }

  return edges;
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
    // The SW uses this to decide suppression: a "finished" push is redundant when a
    // visible tab exists (the foreground notifier covers it), but an "asking" push
    // has no foreground counterpart and must always show.
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
 * push service — non-HTTPS, loopback/private IPs, or single-label/`.local` hosts —
 * to blunt blind-SSRF via `pushSubscriptions.register`. Real push services (FCM,
 * Mozilla, WNS, Apple) are public HTTPS DNS names and pass.
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

/** Events that can change `latestTurn.state` or `hasPendingUserInput`. */
function isPushRelevantEvent(event: OrchestrationEvent): boolean {
  switch (event.type) {
    case "thread.session-set":
    case "thread.turn-diff-completed":
    case "thread.reverted":
      return true;
    case "thread.activity-appended":
      return (
        event.payload.activity.kind === "user-input.requested" ||
        event.payload.activity.kind === "user-input.resolved"
      );
    default:
      return false;
  }
}

function eventThreadId(event: OrchestrationEvent): ThreadId | null {
  const payload = event.payload as { readonly threadId?: unknown };
  if (typeof payload.threadId === "string") {
    return payload.threadId as ThreadId;
  }
  if (event.aggregateKind === "thread" && typeof event.aggregateId === "string") {
    return event.aggregateId as ThreadId;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** Typed error carrying the push service's HTTP status (drives 404/410 pruning). */
class WebPushSendError extends Data.TaggedError("WebPushSendError")<{
  readonly statusCode: number | null;
}> {}

export interface WebPushRelayShape {
  /** The VAPID public key (base64url) clients feed to `PushManager.subscribe`. */
  readonly vapidPublicKey: string;
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class WebPushRelay extends Context.Service<WebPushRelay, WebPushRelayShape>()(
  "t3/push/WebPushRelay",
) {}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const serverEnvironment = yield* ServerEnvironment;
  const pushRepo = yield* PushSubscriptionRepository;

  const vapidKeys = yield* getOrCreateVapidKeys(secrets);
  webpush.setVapidDetails(VAPID_SUBJECT, vapidKeys.publicKey, vapidKeys.privateKey);

  const previousStateByThreadRef = yield* Ref.make(new Map<ThreadId, ThreadNotifyState>());

  // Send one push to one subscription. Bounded by a socket timeout so a hung FCM
  // connection can never wedge the worker; prunes the subscription on 404/410 (gone),
  // logs and swallows everything else so one bad endpoint never aborts the batch.
  const sendToSubscription = (
    subscription: { readonly endpoint: string; readonly p256dh: string; readonly auth: string },
    payload: string,
  ) =>
    Effect.tryPromise({
      try: () =>
        webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          payload,
          { TTL: 120, urgency: "high", timeout: 10_000 },
        ),
      catch: (error) =>
        new WebPushSendError({
          statusCode: (error as { statusCode?: number } | null)?.statusCode ?? null,
        }),
    }).pipe(
      Effect.timeout("15 seconds"),
      Effect.asVoid,
      Effect.catchTag("WebPushSendError", (error) =>
        error.statusCode === 404 || error.statusCode === 410
          ? Effect.logInfo("pruning gone push subscription", {
              endpoint: subscription.endpoint,
              statusCode: error.statusCode,
            }).pipe(
              Effect.andThen(pushRepo.deleteByEndpoint({ endpoint: subscription.endpoint })),
              Effect.catchCause(() => Effect.void),
            )
          : Effect.logWarning("web push send failed", {
              endpoint: subscription.endpoint,
              statusCode: error.statusCode,
            }),
      ),
      // Anything left (e.g. the socket timeout) — log and move on.
      Effect.catchCause((cause) =>
        Effect.logWarning("web push send timed out or errored", {
          endpoint: subscription.endpoint,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const processThread = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const shellOption = yield* snapshotQuery.getThreadShellById(threadId);
      if (Option.isNone(shellOption)) {
        yield* Ref.update(previousStateByThreadRef, (map) => {
          const next = new Map(map);
          next.delete(threadId);
          return next;
        });
        return;
      }

      const shell = shellOption.value;
      const current: ThreadNotifyState = {
        latestTurnState: shell.latestTurn?.state ?? null,
        hasPendingUserInput: shell.hasPendingUserInput,
      };
      const previousMap = yield* Ref.get(previousStateByThreadRef);
      const previous = previousMap.get(threadId) ?? null;
      const edges = classifyThreadNotifyEdges(previous, current);

      // Advance the baseline only AFTER the send attempt below. The worker is a
      // single serial fiber, so there is no concurrent re-process to guard against;
      // advancing before the send would instead silently drop a screen-off alert if
      // the shell/subscription read fails, since a terminal edge never re-emits.
      const advanceBaseline = Ref.update(previousStateByThreadRef, (map) => {
        const next = new Map(map);
        next.set(threadId, current);
        return next;
      });

      if (edges.length > 0) {
        const subscriptions = yield* pushRepo.list().pipe(Effect.orElseSucceed(() => []));
        if (subscriptions.length > 0) {
          const environmentId = yield* serverEnvironment.getEnvironmentId;
          const url = `/${environmentId}/${threadId}`;
          for (const edge of edges) {
            const payload = buildPushPayload({ edge, title: shell.title, url, threadId });
            yield* Effect.forEach(
              subscriptions,
              (subscription) => sendToSubscription(subscription, payload),
              { concurrency: 8, discard: true },
            );
          }
        }
      }

      yield* advanceBaseline;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("web push relay failed for thread", {
          threadId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const worker = yield* makeDrainableWorker(processThread);

  const start: WebPushRelayShape["start"] = Effect.fn("WebPushRelay.start")(function* () {
    yield* Effect.logInfo("web push relay enabled");
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        const threadId = eventThreadId(event);
        if (threadId === null || !isPushRelevantEvent(event)) {
          return Effect.void;
        }
        return worker.enqueue(threadId).pipe(Effect.asVoid);
      }),
    );
  });

  return {
    vapidPublicKey: vapidKeys.publicKey,
    start,
  } satisfies WebPushRelayShape;
});

export const layer = Layer.effect(WebPushRelay, make);
