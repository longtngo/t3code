/**
 * WebPushRelay - Web Push for a run finishing or an agent asking a question, so they reach a
 * frozen PWA. Edges match domain events positively; the handler only enqueues (invariant 18:
 * the event hub is unbounded) and a `DrainableWorker` does reads and sends.
 *
 * @module WebPushRelay
 */
import { DEFAULT_SERVER_SETTINGS, isInterimBackgroundLiveness } from "@t3tools/contracts";
import type {
  NotificationCategorySettings,
  OrchestrationV2DomainEvent,
  OrchestrationV2ThreadShell,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
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

// VAPID keys (server secret, generated once)

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
              Effect.filterOrFail(
                (concurrent): concurrent is VapidKeyPair => concurrent !== null,
                () =>
                  new ServerSecretStore.SecretStoreConcurrentReadError({
                    resource: VAPID_SECRET_RESOURCE,
                  }),
              ),
            )
          : Effect.fail(error),
      ),
    );
});

// Pure edge classification (unit-tested)

export type ThreadNotifyEdge =
  | { readonly kind: "finished"; readonly outcome: "completed" | "error" | "interrupted" }
  | { readonly kind: "asking" };

export interface PushEdge {
  readonly threadId: ThreadId;
  /** One push per key: a run id or a runtime-request id. */
  readonly key: string;
  readonly edge: ThreadNotifyEdge;
  /** The finished run; null for an asking edge. */
  readonly runId: RunId | null;
  /** When the finished run started; null for an asking edge or an unstarted run. */
  readonly startedAt: DateTime.Utc | null;
}

/**
 * The push edge a domain event raises, or `null` (positive match only). A terminal
 * `run.updated` finishes, except a never-started non-failed run or one completed before
 * `notBefore`; a pending `user_input` request asks. Approvals are not "asking".
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
        runId: run.id,
        startedAt: run.startedAt,
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
        ? {
            threadId: event.threadId,
            key: `request:${request.id}`,
            edge: { kind: "asking" },
            runId: null,
            startedAt: null,
          }
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
 * Whether another run started after `runId` or is executing or waiting. Compares start times,
 * not ordinals: queued runs can run out of order. The shell holds only the top run's start,
 * so a later-started, already-ended lower run is missed (1 of 3,594 runs).
 */
function anotherRunStarted(
  shell: OrchestrationV2ThreadShell,
  runId: RunId,
  startedAt: DateTime.Utc | null,
): boolean {
  // This run cannot have started after itself, so no id check is needed.
  const latestStartedAfter =
    startedAt !== null &&
    shell.latestRunStartedAt != null &&
    DateTime.isGreaterThan(shell.latestRunStartedAt, startedAt);
  const otherExecuting =
    (shell.activityRunStatus === "running" || shell.activityRunStatus === "waiting") &&
    shell.activeRunId !== runId;
  return latestStartedAfter || otherExecuting;
}

/**
 * Whether the thread moved past `runId`: a later run started, or one is live or queued next.
 * A run cancelled before starting does not count. Push only: foreground notifiers apply
 * neither this nor the grace, and never see a wake-continued finish anyway.
 */
function continuedPast(
  shell: OrchestrationV2ThreadShell,
  runId: RunId,
  startedAt: DateTime.Utc | null,
): boolean {
  // A run waiting on the user is not active; `anotherRunStarted` covers it.
  const otherActive = shell.activeRunId !== null && shell.activeRunId !== runId;
  const latestPending =
    shell.latestRunId !== null &&
    shell.latestRunId !== runId &&
    ["queued", "preparing", "starting", "running", "waiting"].includes(shell.status);
  return otherActive || latestPending || anotherRunStarted(shell, runId, startedAt);
}

/**
 * An edge's category. A finish splits on live background work: only the last settle of a
 * subagent fan-out is final. A failure is never interim. `categoryForCompletion` in the web
 * notifier mirrors this; `continuedPast` liveness and the grace are push-only.
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

// Service

/**
 * Remembered push keys; a run or request re-written later must not push twice.
 * In memory and bounded: a rewrite of a run more than this many edges old pushes
 * again. Accepted: terminal runs are not normally re-written, and a duplicate
 * notification is cheaper than an unbounded set or a table for it.
 */
export const MAX_REMEMBERED_PUSH_KEYS = 1_000;
const SEND_TIMEOUT = "15 seconds";
/**
 * How long a finish that reads as final waits for a continuation before it pushes.
 * Claude starts its own wake a median 0.72 s after the finish (169 of 287 within
 * 5 s), often before that wake reaches the shell. Counted from when the relay takes
 * the edge.
 */
export const FINAL_FINISH_GRACE_MILLIS = 5_000;

/** An edge and when the relay took it (epoch millis). */
interface TakenEdge {
  readonly edge: PushEdge;
  readonly takenAt: number;
}

export interface WebPushRelayShape {
  /** The VAPID public key (base64url) clients feed to `PushManager.subscribe`. */
  readonly vapidPublicKey: string;
  /** The stream handler: classify and enqueue, never wait. */
  readonly handleEvent: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  readonly drain: Effect.Effect<void>;
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  /**
   * Take no new edges: shutdown is about to cancel in-flight runs, which is not the user's
   * work ending. Queued edges still send, and held finishes send now unless another run started.
   * Ctrl-C signals the whole group, so CLIs may exit first and their runs may still push.
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
  // carry the subscription token. TracerDisabledWhen alone does both (the client skips
  // the span and its header injection); TracerPropagationEnabled is a second guard that
  // no test can tell apart while the first holds.
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
  const sendToSubscription = Effect.fn("WebPushRelay.sendToSubscription")(
    function* (subscription: PushSubscriptionRecord, payload: string) {
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
    },
    (effect, subscription) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("web push send errored", {
            endpoint: endpointOrigin(subscription.endpoint),
            cause: Cause.pretty(cause),
          }),
        ),
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

  // Held finishes wait in their own fibers, never in the serial worker; `drain` also
  // waits for them, and `stop` cuts their wait short.
  const held = yield* FiberSet.make();
  const stopSignal = yield* Deferred.make<void>();

  /** The shell to classify against, or null when the thread gets no push. */
  const readShell = (threadId: ThreadId) =>
    threads.getThreadShell(threadId).pipe(
      Effect.map((shell) =>
        // A delegated subagent's run and questions belong to its parent's turn; the
        // web notifier and the thread list skip these threads too.
        shell === null ||
        shell.deletedAt !== null ||
        shell.lineage.relationshipToParent === "subagent"
          ? null
          : shell,
      ),
    );

  const livenessFor = (shell: OrchestrationV2ThreadShell, { runId, startedAt }: PushEdge) =>
    runId !== null && continuedPast(shell, runId, startedAt)
      ? "working"
      : backgroundLivenessOf(shell);

  /**
   * Finishes held for their grace, per thread. An asking push sent meanwhile marks
   * them, so a held finish whose re-read fails does not replace that question on the
   * device. Entries live only while held.
   */
  const heldFinishes = new Map<ThreadId, Set<{ askedSince: boolean }>>();

  const send = Effect.fn("WebPushRelay.send")(function* (
    { threadId, key, runId, edge }: PushEdge,
    shell: OrchestrationV2ThreadShell,
    backgroundLiveness: "working" | "monitoring" | null,
  ) {
    const categories = yield* readNotificationCategories;
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
    if (edge.kind === "asking") {
      for (const hold of heldFinishes.get(threadId) ?? []) hold.askedSince = true;
    }
    // Counts pushes per category in the logs; nothing else records a send.
    yield* Effect.logInfo("web push dispatched", {
      threadId,
      key,
      runId,
      category: categoryForEdge(edge, backgroundLiveness),
      backgroundLiveness,
    });
  });

  // Reads failed before anything was sent: forget the key so a later rewrite of the
  // same run or request can still push. Individual sends never fail here.
  const forgetOnFailure = ({ threadId, key }: PushEdge) =>
    Effect.catchCause((cause: Cause.Cause<unknown>) =>
      Effect.sync(() => rememberedKeys.delete(key)).pipe(
        Effect.andThen(
          Effect.logWarning("web push relay failed for thread", {
            threadId,
            cause: Cause.pretty(cause),
          }),
        ),
      ),
    );

  /**
   * The shell again, for a held finish; `none` when the read failed, so the caller
   * falls back to the first read rather than losing the finish.
   */
  const rereadShell = (threadId: ThreadId) =>
    readShell(threadId).pipe(
      Effect.asSome,
      Effect.catchCause((cause) =>
        Effect.logWarning("web push re-read failed", {
          threadId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(Option.none<OrchestrationV2ThreadShell | null>())),
      ),
    );

  /**
   * After the grace, re-read and send only a finish that is still final; a late push could
   * replace a newer question. `stop` ends the wait early, dropping it only if another run has
   * STARTED. A failed re-read sends as first read, unless a question was pushed meanwhile.
   */
  const sendAfterGrace = Effect.fn("WebPushRelay.sendAfterGrace")(
    function* (
      pushEdge: PushEdge,
      runId: RunId,
      shell: OrchestrationV2ThreadShell,
      backgroundLiveness: "working" | "monitoring" | null,
      deadline: number,
      hold: { readonly askedSince: boolean },
    ) {
      const now = yield* Clock.currentTimeMillis;
      const cutShort = yield* Deferred.await(stopSignal).pipe(
        Effect.as(true),
        Effect.timeoutOrElse({
          duration: Math.max(0, deadline - now),
          orElse: () => Effect.succeed(false),
        }),
      );
      const reread = yield* rereadShell(pushEdge.threadId);
      if (Option.isNone(reread)) {
        if (hold.askedSince) {
          yield* Effect.logDebug("web push finish dropped; a question was pushed since", {
            threadId: pushEdge.threadId,
          });
          return;
        }
        return yield* send(pushEdge, shell, backgroundLiveness);
      }
      if (reread.value === null) return;
      if (cutShort) {
        if (anotherRunStarted(reread.value, runId, pushEdge.startedAt)) {
          yield* Effect.logDebug("web push finish dropped at stop; another run started", {
            threadId: pushEdge.threadId,
          });
          return;
        }
        return yield* send(pushEdge, shell, backgroundLiveness);
      }
      const rereadLiveness = livenessFor(reread.value, pushEdge);
      if (categoryForEdge(pushEdge.edge, rereadLiveness) !== "finished") {
        yield* Effect.logDebug("web push finish continued during its grace", {
          threadId: pushEdge.threadId,
          backgroundLiveness: rereadLiveness,
        });
        return;
      }
      yield* send(pushEdge, reread.value, rereadLiveness);
    },
    (effect, pushEdge) => effect.pipe(forgetOnFailure(pushEdge)),
  );

  /** Hold a final-looking finish for its grace in its own fiber, outside the worker. */
  const holdFinish = (
    pushEdge: PushEdge,
    runId: RunId,
    shell: OrchestrationV2ThreadShell,
    backgroundLiveness: "working" | "monitoring" | null,
    takenAt: number,
  ) =>
    Effect.suspend(() => {
      const hold = { askedSince: false };
      const holds = heldFinishes.get(pushEdge.threadId) ?? new Set<{ askedSince: boolean }>();
      heldFinishes.set(pushEdge.threadId, holds.add(hold));
      const release = Effect.sync(() => {
        holds.delete(hold);
        if (holds.size === 0) heldFinishes.delete(pushEdge.threadId);
      });
      return FiberSet.run(
        held,
        sendAfterGrace(
          pushEdge,
          runId,
          shell,
          backgroundLiveness,
          takenAt + FINAL_FINISH_GRACE_MILLIS,
          hold,
        ).pipe(Effect.ensuring(release)),
      );
    });

  const processEdge = Effect.fn("WebPushRelay.processEdge")(
    function* ({ edge: pushEdge, takenAt }: TakenEdge) {
      const shell = yield* readShell(pushEdge.threadId);
      if (shell === null) return;
      const backgroundLiveness = livenessFor(shell, pushEdge);
      // A finish that reads as final may be one the agent has not continued yet.
      if (
        pushEdge.runId !== null &&
        categoryForEdge(pushEdge.edge, backgroundLiveness) === "finished"
      ) {
        yield* holdFinish(pushEdge, pushEdge.runId, shell, backgroundLiveness, takenAt);
        return;
      }
      yield* send(pushEdge, shell, backgroundLiveness);
    },
    (effect, { edge: pushEdge }) => effect.pipe(forgetOnFailure(pushEdge)),
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
      return Clock.currentTimeMillis.pipe(
        Effect.flatMap((takenAt) => worker.enqueue({ edge, takenAt })),
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
    drain: worker.drain.pipe(Effect.andThen(FiberSet.awaitEmpty(held))),
    start,
    stop: Effect.sync(() => {
      stopped = true;
    }).pipe(Effect.andThen(Deferred.succeed(stopSignal, undefined))),
  });
});

export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  return yield* makeWebPushRelay(threads);
});

export const layer = Layer.effect(WebPushRelay, make).pipe(Layer.provide(FetchHttpClient.layer));
