import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type IdleCompactionMode,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import * as ClaudeAdapterV2 from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
import * as ServerSettings from "../../serverSettings.ts";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ResetCreditCoordinator from "../resetCreditCoordinator.ts";
import * as ModelManifest from "../ModelManifest.ts";
import * as ProviderHostLive from "../ProviderHostLive.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import { ClaudeDriver } from "./ClaudeDriver.ts";

// FORK: the environment-wide idle compaction mode must reach the driver-built
// adapter that answers Claude Code's resume question.
describe("ClaudeDriver idle compaction wiring", () => {
  const driverLayer = (idleCompaction: IdleCompactionMode) =>
    ProviderHostLive.layer.pipe(Layer.provideMerge(driverDeps(idleCompaction)));
  const driverDeps = (idleCompaction: IdleCompactionMode) =>
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-claude-driver-idle-compaction-" }).pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(IdAllocator.layer),
      Layer.provideMerge(McpProviderSessions.layer),
      Layer.provideMerge(ProviderLatestVersions.layer),
      Layer.provideMerge(Layer.mock(ServerSecretStore.ServerSecretStore)({})),
      Layer.provideMerge(
        Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(
            EnvironmentId.make("00000000-0000-4000-8000-000000000001"),
          ),
        }),
      ),
      Layer.provideMerge(ServerSettings.layerTest({ idleCompaction })),
      Layer.provideMerge(
        Layer.mock(BackgroundPolicy.BackgroundPolicy)({
          shouldRunScopeWork: () => Effect.succeed(false),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
      Layer.provideMerge(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("This test makes no HTTP request")),
        ),
      ),
      Layer.provideMerge(ModelManifest.layerTest),
      Layer.provideMerge(ResetCreditCoordinator.layerTest),
    );

  // The answer the driver-built adapter gives a resume question, or "asked".
  const resumeAnswer = Effect.fnUntraced(function* () {
    let options: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions | undefined;
    const instanceId = ProviderInstanceId.make("claude-offer");
    const instance = yield* ClaudeDriver.create({
      instanceId,
      displayName: undefined,
      accentColor: undefined,
      enabled: true,
      environment: [],
      config: ClaudeDriver.defaultConfig(),
    }).pipe(
      Effect.provideService(ClaudeAdapterV2.ClaudeAgentSdkQueryRunner, {
        allocateSessionId: Effect.succeed("native-claude-offer"),
        open: (input) =>
          Effect.sync(() => {
            options = input.options;
            return {
              messages: Stream.never,
              offer: () => Effect.void,
              setModel: () => Effect.void,
              setPermissionMode: () => Effect.void,
              applyFlagSettings: () => Effect.void,
              interrupt: Effect.void,
              stopTask: () => Effect.void,
              backgroundTasks: () => Effect.succeed(false),
              close: Effect.void,
            };
          }),
        forkSession: () => Effect.die("unused forkSession"),
        subagentLaunchToolUseId: () => Effect.succeed(null),
        assertComplete: Effect.void,
      }),
    );
    const threadId = ThreadId.make("thread-claude-offer");
    const modelSelection = { instanceId, model: "claude-sonnet-4-6" };
    const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd: process.cwd(),
    });
    const runtime = yield* instance.orchestrationAdapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("provider-session-claude-offer"),
      modelSelection,
      runtimePolicy,
    });
    const asked = yield* Deferred.make<"asked">();
    yield* runtime.events.pipe(
      Stream.runForEach((event) =>
        event.type === "runtime_request.updated" ? Deferred.succeed(asked, "asked") : Effect.void,
      ),
      Effect.forkScoped,
    );
    const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
    const now = yield* DateTime.now;
    yield* runtime.startTurn({
      appThread: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make("project-claude-offer"),
        title: "Claude offer",
        providerInstanceId: instanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: providerThread.id,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
      threadId,
      runId: RunId.make("run-claude-offer"),
      runOrdinal: 1,
      providerTurnOrdinal: 1,
      attemptId: RunAttemptId.make("attempt-claude-offer"),
      rootNodeId: NodeId.make("node-claude-offer"),
      providerThread,
      message: {
        createdBy: "user",
        creationSource: "web",
        messageId: MessageId.make("message-claude-offer"),
        text: "Go.",
        attachments: [],
      },
      modelSelection,
      runtimePolicy,
    });
    const onUserDialog = options?.onUserDialog;
    if (onUserDialog === undefined) return yield* Effect.die("The query opened no dialog handler");
    const abort = new AbortController();
    const answer = onUserDialog(
      {
        dialogKind: "resume_return",
        payload: { sessionAgeMinutes: 120, estimatedTokens: 400_000 },
      } as never,
      { signal: abort.signal, requestId: "dialog-claude-offer" } as never,
    );
    // An offered question becomes a pending runtime request; an auto-answer settles.
    const settled = yield* Effect.raceFirst(
      Effect.promise(() => answer),
      Deferred.await(asked),
    );
    abort.abort();
    yield* Effect.promise(() => answer.catch(() => undefined));
    return settled;
  });

  it.effect("answers the resume question itself when idle compaction is off", () =>
    Effect.scoped(resumeAnswer().pipe(Effect.provide(driverLayer("off")))).pipe(
      Effect.map((settled) =>
        expect(settled).toEqual({ behavior: "completed", result: "continue" }),
      ),
    ),
  );

  it.effect("asks the user when idle compaction is on return", () =>
    Effect.scoped(resumeAnswer().pipe(Effect.provide(driverLayer("onReturn")))).pipe(
      Effect.map((settled) => expect(settled).toBe("asked")),
    ),
  );
});
