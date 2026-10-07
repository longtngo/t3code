import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import * as ClaudeAdapterV2 from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";
import { ProviderAdapterV2RuntimePolicy } from "../../orchestration-v2/ProviderAdapter.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ProviderEventLoggers from "../ProviderEventLoggers.ts";
import * as ResetCreditCoordinator from "../resetCreditCoordinator.ts";
import * as ModelManifest from "../ModelManifest.ts";
import { ClaudeDriver, getCachedCapabilitiesDroppingMisses } from "./ClaudeDriver.ts";

describe("getCachedCapabilitiesDroppingMisses", () => {
  const makeCountingCache = (results: ReadonlyArray<string | undefined>) =>
    Effect.gen(function* () {
      let lookups = 0;
      const cache = yield* Cache.make({
        capacity: 1,
        timeToLive: Duration.minutes(5),
        lookup: () =>
          Effect.sync(() => {
            const result = results[Math.min(lookups, results.length - 1)];
            lookups += 1;
            return result;
          }),
      });
      return { cache, lookupCount: () => lookups };
    });

  it.effect("re-probes on the next read after a failed probe (undefined)", () =>
    Effect.gen(function* () {
      const { cache, lookupCount } = yield* makeCountingCache([undefined, "capabilities"]);

      expect(yield* getCachedCapabilitiesDroppingMisses(cache, "key")).toBeUndefined();
      expect(lookupCount()).toBe(1);

      // The miss must not be pinned for the TTL: the next read re-probes.
      expect(yield* getCachedCapabilitiesDroppingMisses(cache, "key")).toBe("capabilities");
      expect(lookupCount()).toBe(2);
    }),
  );

  it.effect("serves successful probes from the cache without re-probing", () =>
    Effect.gen(function* () {
      const { cache, lookupCount } = yield* makeCountingCache(["capabilities"]);

      expect(yield* getCachedCapabilitiesDroppingMisses(cache, "key")).toBe("capabilities");
      expect(yield* getCachedCapabilitiesDroppingMisses(cache, "key")).toBe("capabilities");
      expect(lookupCount()).toBe(1);
    }),
  );
});

// FORK: the "Offer to compact threads" server setting must reach the adapter
// that answers Claude Code's resume question.
describe("ClaudeDriver offerThreadCompaction wiring", () => {
  const driverLayer = (offerThreadCompaction: boolean) =>
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-claude-driver-offer-" }).pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(IdAllocator.layer),
      Layer.provideMerge(ServerSettings.layerTest({ offerThreadCompaction })),
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
              interrupt: Effect.void,
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

  it.effect("answers the resume question itself when the setting is off", () =>
    Effect.scoped(resumeAnswer().pipe(Effect.provide(driverLayer(false)))).pipe(
      Effect.map((settled) =>
        expect(settled).toEqual({ behavior: "completed", result: "continue" }),
      ),
    ),
  );

  it.effect("asks the user when the setting is on", () =>
    Effect.scoped(resumeAnswer().pipe(Effect.provide(driverLayer(true)))).pipe(
      Effect.map((settled) => expect(settled).toBe("asked")),
    ),
  );
});
