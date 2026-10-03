import * as NodeCrypto from "node:crypto";

import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type ModelSelection,
  type NotificationCategorySettings,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import {
  PushSubscriptionRepository,
  type PushSubscriptionRecord,
} from "../persistence/Services/PushSubscription.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  buildPushPayload,
  classifyPushEdge,
  filterEdgesByCategory,
  isAllowedPushEndpoint,
  makeWebPushRelay,
  type WebPushRelayThreads,
} from "./WebPushRelay.ts";

const THREAD_ID = ThreadId.make("push-thread");
const NOW = DateTime.makeUnsafe("2026-10-03T12:00:00.000Z");
const EARLIER = DateTime.makeUnsafe("2026-10-03T11:00:00.000Z");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;

function run(overrides: Partial<OrchestrationV2Run> = {}): OrchestrationV2Run {
  return {
    id: RunId.make("run-1"),
    threadId: THREAD_ID,
    ordinal: 1,
    providerInstanceId,
    modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make("message-1"),
    rootNodeId: null,
    activeAttemptId: null,
    status: "completed",
    queuePosition: null,
    requestedAt: NOW,
    startedAt: NOW,
    completedAt: NOW,
    checkpointId: null,
    contextHandoffId: null,
    ...overrides,
  };
}

function runUpdated(payload: OrchestrationV2Run, id = `event:${payload.id}`) {
  return {
    id: EventId.make(id),
    type: "run.updated",
    threadId: payload.threadId,
    runId: payload.id,
    occurredAt: NOW,
    payload,
  } satisfies OrchestrationV2DomainEvent;
}

function requestUpdated(
  overrides: Partial<OrchestrationV2RuntimeRequest> = {},
): OrchestrationV2DomainEvent {
  return {
    id: EventId.make(`event:request:${overrides.status ?? "pending"}`),
    type: "runtime-request.updated",
    threadId: THREAD_ID,
    occurredAt: NOW,
    payload: {
      id: RuntimeRequestId.make("request-1"),
      nodeId: NodeId.make("node-1"),
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "user_input",
      status: "pending",
      responseCapability: { type: "message" },
      ...overrides,
    } as OrchestrationV2RuntimeRequest,
  };
}

function shell(overrides: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell {
  return {
    id: THREAD_ID,
    projectId: ProjectId.make("push-project"),
    title: "Push thread",
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: THREAD_ID, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "completed",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    providerInstanceHistory: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

/** A real browser-shaped subscription: P-256 public key + 16-byte auth secret. */
function subscription(endpoint: string): PushSubscriptionRecord {
  const ecdh = NodeCrypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    endpoint,
    p256dh: ecdh.getPublicKey().toString("base64url"),
    auth: NodeCrypto.randomBytes(16).toString("base64url"),
    createdAt: "2026-10-03T00:00:00.000Z",
  };
}

// ---------------------------------------------------------------------------
// Pure classification
// ---------------------------------------------------------------------------

describe("classifyPushEdge", () => {
  it("raises a finished edge for each terminal run status", () => {
    const outcome = (status: OrchestrationV2Run["status"]) =>
      classifyPushEdge(runUpdated(run({ status })), NOW)?.edge;
    assert.deepEqual(outcome("completed"), { kind: "finished", outcome: "completed" });
    assert.deepEqual(outcome("failed"), { kind: "finished", outcome: "error" });
    assert.deepEqual(outcome("interrupted"), { kind: "finished", outcome: "interrupted" });
    assert.deepEqual(outcome("cancelled"), { kind: "finished", outcome: "interrupted" });
    assert.equal(classifyPushEdge(runUpdated(run()), NOW)?.key, "run:run-1");
  });

  it("raises nothing for a run that is still active or rolled back", () => {
    for (const status of [
      "preparing",
      "queued",
      "starting",
      "running",
      "waiting",
      "rolled_back",
    ] as const) {
      assert.isNull(classifyPushEdge(runUpdated(run({ status, completedAt: null })), NOW), status);
    }
  });

  it("does not call a run that never started finished, unless it failed", () => {
    const unstarted = (status: OrchestrationV2Run["status"]) =>
      classifyPushEdge(runUpdated(run({ status, startedAt: null })), NOW);
    assert.isNull(unstarted("cancelled"));
    assert.isNull(unstarted("interrupted"));
    assert.isNull(unstarted("completed"));
    assert.deepEqual(unstarted("failed")?.edge, { kind: "finished", outcome: "error" });
  });

  it("ignores a run that completed before the relay started", () => {
    assert.isNull(classifyPushEdge(runUpdated(run({ completedAt: EARLIER })), NOW));
  });

  it("raises asking only for a pending user_input request", () => {
    assert.deepEqual(classifyPushEdge(requestUpdated(), NOW), {
      threadId: THREAD_ID,
      key: "request:request-1",
      edge: { kind: "asking" },
    });
    assert.isNull(classifyPushEdge(requestUpdated({ status: "resolved" }), NOW));
    assert.isNull(classifyPushEdge(requestUpdated({ kind: "permission" }), NOW));
    assert.isNull(classifyPushEdge(requestUpdated({ kind: "command" }), NOW));
  });

  it("raises nothing for unrelated event types", () => {
    const created = {
      id: EventId.make("event:created"),
      type: "run.created",
      threadId: THREAD_ID,
      occurredAt: NOW,
      payload: run(),
    } satisfies OrchestrationV2DomainEvent;
    assert.isNull(classifyPushEdge(created, NOW));
  });
});

describe("isAllowedPushEndpoint", () => {
  it("allows real public push-service HTTPS endpoints", () => {
    assert.isTrue(isAllowedPushEndpoint("https://fcm.googleapis.com/fcm/send/abc123"));
    assert.isTrue(isAllowedPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x"));
    assert.isTrue(isAllowedPushEndpoint("https://web.push.apple.com/abc"));
  });

  it("rejects non-HTTPS, private, loopback, local and garbage endpoints", () => {
    for (const endpoint of [
      "http://fcm.googleapis.com/x",
      "https://127.0.0.1/x",
      "https://10.0.0.5/x",
      "https://192.168.1.1/x",
      "https://172.16.0.1/x",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/x",
      "https://localhost/x",
      "https://printer.local/x",
      "https://intranet/x",
      "not a url",
      "",
    ]) {
      assert.isFalse(isAllowedPushEndpoint(endpoint), endpoint);
    }
  });
});

describe("buildPushPayload", () => {
  it("names the edge so the service worker can suppress a finished push", () => {
    const finished = JSON.parse(
      buildPushPayload({
        edge: { kind: "finished", outcome: "completed" },
        title: "My thread",
        url: "/env/thread",
        threadId: "thread-1",
      }),
    );
    assert.deepEqual(finished, {
      title: "My thread",
      body: "Task finished",
      tag: "thread-1",
      url: "/env/thread",
      kind: "finished",
    });
    const asking = JSON.parse(
      buildPushPayload({ edge: { kind: "asking" }, title: "t", url: "/u", threadId: "id" }),
    );
    assert.equal(asking.body, "Waiting for your input");
    assert.equal(asking.kind, "asking");
  });
});

describe("filterEdgesByCategory", () => {
  const allOn: NotificationCategorySettings = {
    finished: true,
    finishedBackground: true,
    needsInput: true,
    failed: true,
  };
  const finishedEdge = { kind: "finished", outcome: "completed" } as const;
  const failedEdge = { kind: "finished", outcome: "error" } as const;
  const askingEdge = { kind: "asking" } as const;

  it("routes a finish to finishedBackground only while background work remains", () => {
    const noInterim = { ...allOn, finishedBackground: false };
    assert.deepEqual(filterEdgesByCategory([finishedEdge], noInterim, "monitoring"), []);
    assert.deepEqual(filterEdgesByCategory([finishedEdge], noInterim, null), [finishedEdge]);
  });

  it("keeps a failure in its own category and gates asking on needsInput", () => {
    const noInterim = { ...allOn, finishedBackground: false };
    assert.deepEqual(filterEdgesByCategory([failedEdge], noInterim, "monitoring"), [failedEdge]);
    assert.deepEqual(
      filterEdgesByCategory([askingEdge], { ...allOn, needsInput: false }, null),
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// Relay service
// ---------------------------------------------------------------------------

interface Harness {
  readonly sent: Array<string>;
  readonly deleted: Array<string>;
}

const makeHarness = (input: {
  readonly subscriptions: ReadonlyArray<PushSubscriptionRecord>;
  readonly respond?: (
    request: HttpClientRequest.HttpClientRequest,
    url: URL,
  ) => Effect.Effect<number>;
  readonly onDelete?: (endpoint: string) => Effect.Effect<void>;
  readonly threads: WebPushRelayThreads;
  readonly settings?: Parameters<typeof ServerSettings.layerTest>[0];
}) =>
  Effect.gen(function* () {
    const harness: Harness = { sent: [], deleted: [] };
    let subscriptions = [...input.subscriptions];
    const secrets = new Map<string, Uint8Array>();
    const httpClient = HttpClient.make((request, url) =>
      Effect.sync(() => harness.sent.push(url.toString())).pipe(
        Effect.andThen(input.respond?.(request, url) ?? Effect.succeed(201)),
        Effect.map((status) => HttpClientResponse.fromWeb(request, new Response(null, { status }))),
      ),
    );
    const relay = yield* makeWebPushRelay(input.threads).pipe(
      Effect.provideService(
        ServerSecretStore.ServerSecretStore,
        ServerSecretStore.ServerSecretStore.of({
          get: (name) => Effect.sync(() => Option.fromUndefinedOr(secrets.get(name))),
          create: (name, value) => Effect.sync(() => void secrets.set(name, value)),
          set: (name, value) => Effect.sync(() => void secrets.set(name, value)),
          remove: (name) => Effect.sync(() => void secrets.delete(name)),
          getOrCreateRandom: () => Effect.die("unused"),
        }),
      ),
      Effect.provideService(ServerEnvironment, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("push-env")),
        getDescriptor: Effect.die("unused"),
      }),
      Effect.provideService(PushSubscriptionRepository, {
        upsert: () => Effect.die("unused"),
        list: () => Effect.sync(() => subscriptions),
        deleteByEndpoint: ({ endpoint }) =>
          Effect.sync(() => {
            harness.deleted.push(endpoint);
            subscriptions = subscriptions.filter((row) => row.endpoint !== endpoint);
          }).pipe(Effect.andThen(input.onDelete?.(endpoint) ?? Effect.void)),
      }),
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provide(ServerSettings.layerTest(input.settings ?? {})),
    );
    return { relay, harness, remaining: () => subscriptions };
  });

const stubThreads = (
  current: OrchestrationV2ThreadShell | null = shell(),
): WebPushRelayThreads => ({
  streamDomainEvents: Stream.empty,
  getThreadShell: () => Effect.succeed(current),
});

const FCM = "https://fcm.googleapis.com/fcm/send/device-a";

describe("WebPushRelay", () => {
  it.effect("pushes a VAPID-signed, encrypted message when a run completes", () =>
    Effect.gen(function* () {
      const requests: Array<HttpClientRequest.HttpClientRequest> = [];
      const { relay, harness } = yield* makeHarness({
        subscriptions: [subscription(FCM)],
        threads: stubThreads(),
        respond: (request) => Effect.sync(() => requests.push(request)).pipe(Effect.as(201)),
      });
      yield* relay.handleEvent(runUpdated(run()));
      yield* relay.drain;
      assert.deepEqual(harness.sent, [FCM]);
      const headers = requests[0]!.headers;
      assert.equal(headers["content-encoding"], "aes128gcm");
      assert.match(headers["authorization"] ?? "", /^vapid t=.+, k=.+/);
      assert.equal(headers["urgency"], "high");
    }).pipe(Effect.scoped),
  );

  it.effect("pushes nothing for active runs, duplicates, approvals or a silenced category", () =>
    Effect.gen(function* () {
      const { relay, harness } = yield* makeHarness({
        subscriptions: [subscription(FCM)],
        threads: stubThreads(),
        settings: { notificationCategories: { finished: false } },
      });
      yield* relay.handleEvent(runUpdated(run({ status: "running", completedAt: null })));
      yield* relay.handleEvent(requestUpdated({ kind: "permission" }));
      // `finished` is off for this user: a completion stays silent.
      yield* relay.handleEvent(runUpdated(run()));
      yield* relay.drain;
      assert.deepEqual(harness.sent, []);

      // A failure is its own category and still pushes, exactly once per run.
      const failed = run({ id: RunId.make("run-failed"), status: "failed" });
      yield* relay.handleEvent(runUpdated(failed, "event:failed:1"));
      yield* relay.handleEvent(runUpdated(failed, "event:failed:2"));
      yield* relay.drain;
      assert.deepEqual(harness.sent, [FCM]);
    }).pipe(Effect.scoped),
  );

  it.effect("pushes nothing for a deleted thread", () =>
    Effect.gen(function* () {
      const { relay, harness } = yield* makeHarness({
        subscriptions: [subscription(FCM)],
        threads: stubThreads(shell({ deletedAt: NOW })),
      });
      yield* relay.handleEvent(runUpdated(run()));
      yield* relay.handleEvent(requestUpdated());
      yield* relay.drain;
      assert.deepEqual(harness.sent, []);
    }).pipe(Effect.scoped),
  );

  it.effect("prunes a 410 Gone endpoint without waiting on a hung peer", () =>
    Effect.gen(function* () {
      const gone = "https://fcm.googleapis.com/fcm/send/gone";
      const hung = "https://fcm.googleapis.com/fcm/send/hung";
      const live = "https://updates.push.services.mozilla.com/wpush/v2/live";
      const pruned = yield* Deferred.make<void>();
      const delivered = yield* Deferred.make<void>();
      let hungCalls = 0;
      const { relay, harness, remaining } = yield* makeHarness({
        subscriptions: [subscription(hung), subscription(gone), subscription(live)],
        threads: stubThreads(),
        respond: (_request, url) => {
          switch (url.toString()) {
            case gone:
              return Effect.succeed(410);
            case hung:
              // Hangs on the first push only, so the second round completes.
              hungCalls += 1;
              return hungCalls === 1 ? Effect.never : Effect.succeed(201);
            default:
              return Deferred.succeed(delivered, undefined).pipe(Effect.as(201));
          }
        },
        onDelete: () => Deferred.succeed(pruned, undefined).pipe(Effect.asVoid),
      });
      yield* relay.handleEvent(runUpdated(run()));
      // Both resolve while the hung endpoint is still outstanding.
      yield* Deferred.await(pruned);
      yield* Deferred.await(delivered);
      assert.deepEqual(harness.deleted, [gone]);
      assert.sameMembers(harness.sent, [hung, gone, live]);
      assert.sameMembers(
        remaining().map((row) => row.endpoint),
        [hung, live],
      );
      // The hung send is bounded; the worker is free again afterwards.
      yield* TestClock.adjust("15 seconds");
      yield* relay.drain;
      yield* relay.handleEvent(requestUpdated());
      yield* relay.drain;
      assert.equal(harness.sent.filter((endpoint) => endpoint === live).length, 2);
    }).pipe(Effect.scoped),
  );
});

// ---------------------------------------------------------------------------
// Invariant 18: a relay that falls behind must not pin the event hub
// ---------------------------------------------------------------------------

const databaseLayer = SqlitePersistenceMemory;
const storesLayer = Layer.mergeAll(
  databaseLayer,
  EventStore.layer.pipe(Layer.provideMerge(databaseLayer)),
  ProjectionStore.layer.pipe(Layer.provideMerge(databaseLayer)),
);
const sinkLayer = Layer.mergeAll(storesLayer, EventSink.layer.pipe(Layer.provide(storesLayer)));

function appThread(threadId: ThreadId): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make(`project:${threadId}`),
    title: `Thread ${threadId}`,
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

it.live("keeps draining the domain-event hub while every push send is stuck", () => {
  const lastEdgeQueued = Deferred.makeUnsafe<void>();
  const queuedLogger = Logger.make(({ message }) => {
    const [text, fields] = Array.isArray(message) ? message : [message];
    if (
      text === "web push edge queued" &&
      (fields as { readonly key?: string } | undefined)?.key === "run:run-last"
    ) {
      Deferred.doneUnsafe(lastEdgeQueued, Effect.void);
    }
  });
  return Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const threadA = appThread(ThreadId.make("thread:push-stuck-a"));
    const threadB = appThread(ThreadId.make("thread:push-stuck-b"));
    yield* sink.write({
      events: [threadA, threadB].map((thread) => ({
        id: EventId.make(`event:push-stuck:created:${thread.id}`),
        type: "thread.created" as const,
        threadId: thread.id,
        providerInstanceId,
        occurredAt: now,
        payload: thread,
      })),
    });
    const senderEntered = yield* Deferred.make<void>();
    const cursorRead = yield* Deferred.make<void>();
    const { relay, harness } = yield* makeHarness({
      subscriptions: [subscription(FCM)],
      // The orchestrator's `streamDomainEvents`, over a real sink. Every event written
      // after the cursor is read reaches the relay (replayed or live).
      threads: {
        streamDomainEvents: Stream.unwrap(
          sink.latestSequence().pipe(
            Effect.tap(() => Deferred.succeed(cursorRead, undefined)),
            Effect.map((latest) => sink.stream({ afterSequence: latest })),
          ),
        ).pipe(Stream.map((stored) => stored.event)),
        getThreadShell: (threadId) => Effect.succeed(shell({ id: threadId })),
      },
      respond: () => Deferred.succeed(senderEntered, undefined).pipe(Effect.andThen(Effect.never)),
    });
    yield* relay.start();
    yield* Deferred.await(cursorRead);
    // Completions must postdate the relay's start to count as news.
    const completedAt = yield* DateTime.now;
    yield* sink.write({
      events: [
        runUpdated(
          run({ id: RunId.make("run-first"), threadId: threadA.id, completedAt }),
          "event:push-stuck:first",
        ),
      ],
    });
    yield* Deferred.await(senderEntered);

    // The worker is now stuck inside its first send. Flood the hub.
    const flood = 1_500;
    yield* sink.write({
      events: Array.from({ length: flood }, (_, index) => ({
        id: EventId.make(`event:push-stuck:flood:${index}`),
        type: "thread.metadata-updated" as const,
        threadId: threadB.id,
        occurredAt: now,
        payload: { ...threadB, title: `Flood ${index}` },
      })),
    });
    yield* sink.write({
      events: [
        runUpdated(
          run({ id: RunId.make("run-last"), threadId: threadB.id, completedAt }),
          "event:push-stuck:last",
        ),
      ],
    });
    // The handler took the last event while the send is still stuck. The deadline
    // only turns an inline-blocking handler into an assertion instead of a timeout.
    const signal = yield* Deferred.await(lastEdgeQueued).pipe(Effect.timeoutOption("30 seconds"));
    if (Option.isNone(signal)) {
      assert.fail(`relay stopped taking events; hub still holds ${yield* sink.liveBacklog}`);
    }
    assert.equal(yield* sink.liveBacklog, 0);
    assert.deepEqual(harness.sent, [FCM]);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        sinkLayer,
        Logger.layer([queuedLogger], { mergeWithExisting: true }),
        Layer.succeed(References.MinimumLogLevel, "Debug"),
      ),
    ),
  );
});
