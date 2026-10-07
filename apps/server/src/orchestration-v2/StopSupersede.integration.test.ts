// FORK Stop ladder: a hard run.interrupt supersedes the cooperative interrupt
// still queued for the same thread, so exactly one (hard) stop reaches the
// provider. Pins the Orchestrator's `supersedeCooperativeInterrupts` return.
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type { ProviderAdapterV2Event, ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { layerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };

it.live.each([
  ["the same thread", true],
  ["another thread", false],
] as const)("a hard Stop on %s and the cooperative interrupt queued before it", ([, sameThread]) =>
  Effect.scoped(
    Effect.gen(function* () {
      const name = `u4r2-supersede-${sameThread ? "same" : "other"}`;
      const cwd = yield* checkpointWorkspace(name);
      const interrupts: Array<string> = [];
      const turns = new Map<string, OrchestrationV2ProviderTurn>();
      const adapter: ProviderAdapterV2Shape = {
        instanceId,
        driver,
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: (input) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
            return {
              instanceId,
              driver,
              providerSessionId: input.providerSessionId,
              providerSession: {
                id: input.providerSessionId,
                driver,
                providerInstanceId: instanceId,
                status: "ready",
                cwd,
                model: modelSelection.model,
                capabilities: CodexProviderCapabilitiesV2,
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
              events: Stream.fromQueue(events),
              ensureThread: ({ threadId }) =>
                Effect.succeed({
                  id: ProviderThreadId.make(`provider-thread:${threadId}`),
                  driver,
                  providerInstanceId: instanceId,
                  providerSessionId: input.providerSessionId,
                  appThreadId: threadId,
                  ownerNodeId: null,
                  nativeThreadRef: { driver, nativeId: `native:${threadId}`, strength: "strong" },
                  nativeConversationHeadRef: null,
                  status: "idle",
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  forkedFrom: null,
                  createdAt: now,
                  updatedAt: now,
                }),
              resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
              startTurn: (turn) =>
                Effect.gen(function* () {
                  const providerTurn: OrchestrationV2ProviderTurn = {
                    id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                    providerThreadId: turn.providerThread.id,
                    nodeId: turn.rootNodeId,
                    runAttemptId: turn.attemptId,
                    nativeTurnRef: {
                      driver,
                      nativeId: `native:${turn.attemptId}`,
                      strength: "strong",
                    },
                    ordinal: turn.providerTurnOrdinal,
                    status: "running",
                    startedAt: now,
                    completedAt: null,
                  };
                  turns.set(providerTurn.id, providerTurn);
                  yield* Queue.offer(events, {
                    type: "provider_turn.updated",
                    driver,
                    providerTurn,
                  });
                }),
              steerTurn: () => Effect.void,
              interruptTurn: (input) =>
                Effect.gen(function* () {
                  interrupts.push(
                    `${input.providerThread.appThreadId}:${input.cooperative === true ? "cooperative" : "hard"}`,
                  );
                  const turn = turns.get(input.providerTurnId);
                  if (turn === undefined || turn.status !== "running") return;
                  const ended = { ...turn, status: "interrupted" as const, completedAt: now };
                  turns.set(turn.id, ended);
                  yield* Queue.offer(events, {
                    type: "provider_turn.updated",
                    driver,
                    providerTurn: ended,
                  });
                }),
              respondToRuntimeRequest: () => Effect.void,
              readThreadSnapshot: () => Effect.die("unused"),
              rollbackThread: () => Effect.die("unused"),
              forkThread: () => Effect.die("unused"),
            };
          }),
      };
      const now = yield* DateTime.now;
      const layer = layerWithRegistry({ name }, ProviderAdapterRegistry.layerSingle(adapter), {
        runEffectWorker: false,
      });
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const start = (key: string) =>
          Effect.gen(function* () {
            const threadId = ThreadId.make(`thread:${name}:${key}`);
            yield* orchestrator.dispatch({
              type: "thread.create",
              commandId: CommandId.make(`create-${key}`),
              threadId,
              projectId: ProjectId.make(`project:${name}`),
              title: key,
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: cwd,
              createdBy: "user",
              creationSource: "web",
            });
            const running = yield* orchestrator.streamDomainEvents.pipe(
              Stream.filter(
                (event) =>
                  event.type === "provider-turn.updated" &&
                  event.threadId === threadId &&
                  event.payload.status === "running",
              ),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped,
            );
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`first-${key}`),
              threadId,
              messageId: MessageId.make(`message:${key}`),
              text: "work",
              attachments: [],
              modelSelection,
              dispatchMode: { type: "start_immediately" },
              createdBy: "user",
              creationSource: "web",
            });
            yield* worker.drain();
            yield* Fiber.join(running);
            const projection = yield* orchestrator.getThreadProjection(threadId);
            return { threadId, runId: projection.runs[0]!.id };
          });
        const a = yield* start("a");
        const b = sameThread ? a : yield* start("b");
        // First press on A queues the cooperative rung; the worker has not run it.
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("press-1"),
          threadId: a.threadId,
          runId: a.runId,
          holdQueue: true,
          mode: "cooperative",
        });
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("press-2"),
          threadId: b.threadId,
          runId: b.runId,
          holdQueue: true,
          mode: "hard",
        });
        yield* worker.drain();
        if (sameThread) {
          assert.deepEqual(interrupts, [`${a.threadId}:hard`], "exactly one, hard, stop");
        } else {
          assert.sameMembers(interrupts, [`${a.threadId}:cooperative`, `${b.threadId}:hard`]);
        }
      }).pipe(Effect.provide(layer));
    }),
  ),
);
