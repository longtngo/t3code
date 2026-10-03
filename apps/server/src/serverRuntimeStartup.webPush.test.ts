import * as NodeCrypto from "node:crypto";

import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpServer from "effect/unstable/http/HttpServer";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServiceLauncherClient from "./cloud/serviceLauncherClient.ts";
import * as ServerConfig from "./config.ts";
import { ServerEnvironment } from "./environment/ServerEnvironment.ts";
import { EnvironmentThemeService } from "./environmentTheme.ts";
import * as Keybindings from "./keybindings.ts";
import * as LegacyV1ThreadImporter from "./orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as EffectWorker from "./orchestration-v2/EffectWorker.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ThreadLaunch from "./orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import * as ProviderRuntimeRecovery from "./orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import { PushSubscriptionRepository } from "./persistence/Services/PushSubscription.ts";
import * as WebPushRelay from "./push/WebPushRelay.ts";
import { CrewSweep } from "./crew/CrewSweep.ts";
import { ProviderRegistry } from "./provider/Services/ProviderRegistry.ts";
import { SubagentLiveThreads } from "./subagentBackend/SubagentLiveThreads.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as ProjectService from "./project/ProjectService.ts";
import * as AgentAwarenessRelay from "./relay/AgentAwarenessRelay.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";

const THREAD_ID = ThreadId.make("push-thread");
const NOW = DateTime.makeUnsafe("2026-10-03T12:00:00.000Z");
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

function runUpdated(payload: OrchestrationV2Run): OrchestrationV2DomainEvent {
  return {
    id: EventId.make(`event:${payload.id}`),
    type: "run.updated",
    threadId: payload.threadId,
    runId: payload.id,
    occurredAt: NOW,
    payload,
  };
}

function shell(): OrchestrationV2ThreadShell {
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
  };
}

function subscription(endpoint: string) {
  const ecdh = NodeCrypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    endpoint,
    p256dh: ecdh.getPublicKey().toString("base64url"),
    auth: NodeCrypto.randomBytes(16).toString("base64url"),
    createdAt: "2026-10-03T00:00:00.000Z",
  };
}

/** A service whose unlisted members never complete, so an unexpected call shows as a hang. */
const stub = <T extends object>(overrides: Partial<Record<string, unknown>> = {}): T =>
  new Proxy(overrides as object, {
    get: (target, prop) =>
      prop in target
        ? (target as Record<string | symbol, unknown>)[prop]
        : prop === "then"
          ? undefined
          : Effect.never,
  }) as T;

it.live("the startup finalizer silences web push before shutdown cancels running work", () =>
  Effect.gen(function* () {
    const sent: string[] = [];
    const order: string[] = [];
    const secrets = new Map<string, Uint8Array>();
    const httpClient = HttpClient.make((request, url) =>
      Effect.sync(() => sent.push(url.toString())).pipe(
        Effect.as(HttpClientResponse.fromWeb(request, new Response(null, { status: 201 }))),
      ),
    );
    const relayScope = yield* Scope.make();
    const relay = yield* WebPushRelay.makeWebPushRelay({
      streamDomainEvents: Stream.empty,
      getThreadShell: () => Effect.succeed(shell()),
    }).pipe(
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
        getEnvironmentId: Effect.succeed(EnvironmentId.make("e")),
        getDescriptor: Effect.die("unused"),
      }),
      Effect.provideService(PushSubscriptionRepository, {
        upsert: () => Effect.die("unused"),
        list: () => Effect.succeed([subscription("https://fcm.googleapis.com/fcm/send/x")]),
        deleteByEndpoint: () => Effect.void,
      }),
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provide(ServerSettings.layerTest({})),
      Scope.provide(relayScope),
    );
    const observedRelay = {
      ...relay,
      stop: Effect.sync(() => order.push("relay.stop")).pipe(Effect.andThen(relay.stop)),
    };

    // What reconcile("shutdown") writes for a run that was running when shutdown began.
    const cancelledRunning = runUpdated(
      run({ status: "cancelled", completedAt: yield* DateTime.now }),
    );
    const recovery = stub<ProviderRuntimeRecovery.ProviderRuntimeRecoveryService["Service"]>({
      prepareForShutdown: Effect.sync(() => order.push("prepareForShutdown")),
      reconcile: () =>
        Effect.sync(() => order.push("reconcile")).pipe(
          Effect.andThen(relay.handleEvent(cancelledRunning)),
          Effect.andThen(relay.drain),
          Effect.as({
            terminalizedRuns: 1,
            stoppedSessions: 0,
            closedRequests: 0,
            retiredEffects: 0,
            requeuedEffects: 0,
          }),
        ),
    });
    const sessions = stub<ProviderSessionManager.ProviderSessionManagerV2["Service"]>({
      shutdown: Effect.sync(() => order.push("sessions.shutdown")),
    });

    // The real startup layer; only its finalizer is under test.
    const scope = yield* Scope.make();
    const deps = Layer.mergeAll(
      Layer.succeed(ServerConfig.ServerConfig, stub({ mode: "web", port: 0, host: undefined })),
      Layer.succeed(Keybindings.Keybindings, stub()),
      Layer.succeed(LegacyV1ThreadImporter.LegacyV1ThreadImporter, stub()),
      Layer.succeed(ProviderRuntimeRecovery.ProviderRuntimeRecoveryService, recovery),
      Layer.succeed(ProviderSessionManager.ProviderSessionManagerV2, sessions),
      Layer.succeed(AgentAwarenessRelay.AgentAwarenessRelay, stub()),
      Layer.succeed(WebPushRelay.WebPushRelay, observedRelay),
      Layer.succeed(ServerLifecycleEvents.ServerLifecycleEvents, stub()),
      Layer.succeed(ServerSettings.ServerSettingsService, stub()),
      Layer.succeed(EnvironmentThemeService, stub()),
      Layer.succeed(ServerEnvironment, stub()),
      Layer.succeed(Crypto.Crypto, stub()),
      Layer.succeed(ServiceLauncherClient.ServiceLauncherClient, stub()),
      // Startup reads these only on paths this test never reaches.
      Layer.succeed(AnalyticsService.AnalyticsService, stub()),
      Layer.succeed(EnvironmentAuth.EnvironmentAuth, stub()),
      Layer.succeed(ExternalLauncher.ExternalLauncher, stub()),
      Layer.succeed(GitVcsDriver.GitVcsDriver, stub()),
      Layer.succeed(HttpServer.HttpServer, stub()),
      Layer.succeed(EffectWorker.OrchestrationEffectWorkerV2, stub()),
      Layer.succeed(Path.Path, stub()),
      Layer.succeed(ProjectService.ProjectService, stub()),
      Layer.succeed(ProjectStore.ProjectStoreV2, stub()),
      Layer.succeed(ThreadLaunch.ThreadLaunchService, stub()),
      Layer.succeed(ThreadManagement.ThreadManagementService, stub()),
      // Crew's sweep and the subagent offload's reconciler start at boot; neither is
      // under test here.
      Layer.succeed(CrewSweep, stub({ start: () => Effect.void })),
      Layer.succeed(SubagentLiveThreads, stub()),
      Layer.succeed(ProviderRegistry, stub()),
      Layer.succeed(FileSystem.FileSystem, stub()),
    );
    yield* Layer.buildWithScope(
      ServerRuntimeStartup.layerWithOptions().pipe(Layer.provide(deps)),
      scope,
    );
    yield* Effect.yieldNow;
    // Control arm: before shutdown the relay does push for this exact event shape.
    const before = runUpdated(
      run({ id: RunId.make("run-control"), status: "completed", completedAt: yield* DateTime.now }),
    );
    yield* relay.handleEvent(before);
    yield* relay.drain;
    const controlSent = sent.length;
    yield* Scope.close(scope, Exit.void);
    yield* Scope.close(relayScope, Exit.void);
    assert.equal(controlSent, 1);
    assert.deepEqual(order.slice(0, 2), ["relay.stop", "prepareForShutdown"]);
    assert.include(order, "reconcile");
    assert.equal(sent.length, 1);
  }),
);
