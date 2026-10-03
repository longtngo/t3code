// FORK Stop ladder (registry inv 7): the cooperative rung ends the turn and keeps
// the provider session; it escalates to the hard stop when the provider rejects
// it or does not end the turn within COOPERATIVE_INTERRUPT_GRACE.
import { assert, it } from "@effect/vitest";
import {
  NodeId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  ProviderAdapterInterruptError,
  ProviderAdapterProtocolError,
  type ProviderAdapterV2InterruptInput,
  type ProviderAdapterV2SessionRuntime,
} from "./ProviderAdapter.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnControlService from "./ProviderTurnControlService.ts";

const driver = ProviderDriverKind.make("codex");
const providerInstanceId = ProviderInstanceId.make("codex");

/** How a fake provider answers the cooperative rung. */
type CooperativeBehaviour =
  | "ends-turn"
  | "acks-but-wedged"
  | "rejects"
  // The turn ended natively just before the interrupt arrived: the adapter
  // answers "not active" (Codex, OpenCode); the projection may lag behind.
  | "turn-already-gone"
  | "turn-already-gone-projected";

interface Unit {
  readonly threadId: ThreadId;
  readonly sessionId: ProviderSessionId;
  readonly providerThreadId: ProviderThreadId;
  readonly providerTurnId: ProviderTurnId;
  readonly calls: Array<ProviderAdapterV2InterruptInput>;
  turn: OrchestrationV2ProviderTurn;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly behaviour: CooperativeBehaviour;
}

const makeUnit = (
  name: string,
  behaviour: CooperativeBehaviour,
  now: DateTime.Utc,
  turnStatus: OrchestrationV2ProviderTurn["status"] = "running",
): Unit => {
  const threadId = ThreadId.make(`thread:ladder:${name}`);
  const sessionId = ProviderSessionId.make(`provider-session:ladder:${name}`);
  const providerThreadId = ProviderThreadId.make(`provider-thread:ladder:${name}`);
  const providerTurnId = ProviderTurnId.make(`provider-turn:ladder:${name}`);
  return {
    threadId,
    sessionId,
    providerThreadId,
    providerTurnId,
    calls: [],
    behaviour,
    providerThread: {
      id: providerThreadId,
      driver,
      providerInstanceId,
      providerSessionId: sessionId,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: { driver, nativeId: `native-thread:${name}`, strength: "strong" },
      nativeConversationHeadRef: null,
      status: "not_loaded",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
    },
    turn: {
      id: providerTurnId,
      providerThreadId,
      nodeId: NodeId.make(`node:ladder:${name}`),
      runAttemptId: RunAttemptId.make(`run-attempt:ladder:${name}`),
      nativeTurnRef: { driver, nativeId: `native-turn:${name}`, strength: "strong" },
      ordinal: 1,
      status: turnStatus,
      startedAt: now,
      completedAt: null,
    },
  };
};

const makeRuntime = (unit: Unit, now: DateTime.Utc): ProviderAdapterV2SessionRuntime => ({
  instanceId: providerInstanceId,
  driver,
  providerSessionId: unit.sessionId,
  providerSession: {
    id: unit.sessionId,
    driver,
    providerInstanceId,
    status: "running",
    cwd: "/workspace",
    model: "gpt-5.4",
    capabilities: CodexProviderCapabilitiesV2,
    createdAt: now,
    updatedAt: now,
    lastError: null,
  },
  events: Stream.empty,
  ensureThread: () => Effect.die("unused ensureThread"),
  resumeThread: () => Effect.die("unused resumeThread"),
  startTurn: () => Effect.die("unused startTurn"),
  steerTurn: () => Effect.die("unused steerTurn"),
  interruptTurn: (input) =>
    Effect.gen(function* () {
      unit.calls.push(input);
      const endTurn = Effect.sync(() => {
        unit.turn = { ...unit.turn, status: "interrupted", completedAt: now };
      });
      if (input.cooperative !== true) return yield* endTurn;
      if (unit.behaviour === "rejects") {
        return yield* new ProviderAdapterInterruptError({
          driver,
          providerThreadId: unit.providerThreadId,
          providerTurnId: unit.providerTurnId,
          cause: "this provider cannot end a turn without restarting",
        });
      }
      if (unit.behaviour === "turn-already-gone-projected") {
        // A provider whose error does not say why; the projection does.
        unit.turn = { ...unit.turn, status: "completed", completedAt: now };
        return yield* new ProviderAdapterInterruptError({
          driver,
          providerThreadId: unit.providerThreadId,
          providerTurnId: unit.providerTurnId,
        });
      }
      if (unit.behaviour === "turn-already-gone") {
        return yield* new ProviderAdapterProtocolError({
          driver,
          detail: `Provider turn ${unit.providerTurnId} is not active and cannot be interrupted`,
        });
      }
      if (unit.behaviour === "ends-turn") yield* endTurn;
    }),
  respondToRuntimeRequest: () => Effect.die("unused respondToRuntimeRequest"),
  readThreadSnapshot: () => Effect.die("unused readThreadSnapshot"),
  rollbackThread: () => Effect.die("unused rollbackThread"),
  forkThread: () => Effect.die("unused forkThread"),
});

const controlLayer = (units: ReadonlyArray<Unit>, now: DateTime.Utc) => {
  const runtimes = new Map(units.map((unit) => [unit.sessionId, makeRuntime(unit, now)]));
  return ProviderTurnControlService.layer.pipe(
    Layer.provide(
      Layer.merge(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getProviderControlContext: (threadId) =>
            Effect.sync(() => {
              const unit = units.find((candidate) => candidate.threadId === threadId)!;
              return {
                providerThread: unit.providerThread,
                providerTurn: unit.turn,
                attempt: undefined,
                message: undefined,
                run: undefined,
              };
            }),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          get: (providerSessionId) =>
            Effect.succeed(Option.fromNullishOr(runtimes.get(providerSessionId))),
        }),
      ),
    ),
  );
};

const interruptCooperatively = (unit: Unit) =>
  Effect.flatMap(ProviderTurnControlService.ProviderTurnControlServiceV2, (control) =>
    control.interrupt({
      threadId: unit.threadId,
      providerSessionId: unit.sessionId,
      providerThreadId: unit.providerThreadId,
      providerTurnId: unit.providerTurnId,
      cooperative: true,
    }),
  );

const rungs = (unit: Unit) =>
  unit.calls.map((call) =>
    call.cooperative === true ? "cooperative" : call.requestRuntimeRestart ? "hard" : "other",
  );

it.effect("the cooperative rung ends the turn and keeps the session", () =>
  Effect.gen(function* () {
    const unit = makeUnit("ends", "ends-turn", yield* DateTime.now);
    const outcome = yield* interruptCooperatively(unit).pipe(
      Effect.provide(controlLayer([unit], yield* DateTime.now)),
    );
    assert.equal(outcome, "cooperative");
    assert.deepEqual(rungs(unit), ["cooperative"]);
  }),
);

it.effect("a turn that already ended gets no interrupt at all", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const unit = makeUnit("settled", "ends-turn", now, "completed");
    const outcome = yield* interruptCooperatively(unit).pipe(
      Effect.provide(controlLayer([unit], now)),
    );
    assert.equal(outcome, "cooperative");
    assert.deepEqual(rungs(unit), []);
  }),
);

it.effect("a provider that cannot cooperate falls back to the hard stop at once", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const unit = makeUnit("rejects", "rejects", now);
    // No clock advance: the escalation must not wait out the grace.
    const outcome = yield* interruptCooperatively(unit).pipe(
      Effect.provide(controlLayer([unit], now)),
    );
    assert.equal(outcome, "hard");
    assert.deepEqual(rungs(unit), ["cooperative", "hard"]);
    assert.equal(unit.turn.status, "interrupted");
  }),
);

// Multi-unit: one wedged turn escalating must not touch a healthy turn's
// cooperative stop running beside it, and vice versa.
it.effect("a turn the cooperative rung leaves running escalates after the grace, alone", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const wedged = makeUnit("wedged", "acks-but-wedged", now);
    const healthy = makeUnit("healthy", "ends-turn", now);
    const layer = controlLayer([wedged, healthy], now);
    const wedgedFiber = yield* interruptCooperatively(wedged).pipe(
      Effect.provide(layer),
      Effect.forkChild,
    );
    const healthyOutcome = yield* interruptCooperatively(healthy).pipe(Effect.provide(layer));
    assert.equal(healthyOutcome, "cooperative");
    assert.deepEqual(rungs(healthy), ["cooperative"]);

    const graceMs = ProviderTurnControlService.COOPERATIVE_INTERRUPT_GRACE;
    yield* TestClock.adjust("7900 millis");
    assert.deepEqual(rungs(wedged), ["cooperative"], `no escalation before ${String(graceMs)}`);
    assert.equal(wedged.turn.status, "running");

    yield* TestClock.adjust("200 millis");
    assert.equal(yield* Fiber.join(wedgedFiber), "hard");
    assert.deepEqual(rungs(wedged), ["cooperative", "hard"]);
    assert.equal(wedged.turn.status, "interrupted");
    assert.deepEqual(rungs(healthy), ["cooperative"]);
  }),
);

// Multi-unit: a turn that ended on its own just before the cooperative
// interrupt is a finished Stop on every provider, never a reason to restart the
// runtime (which would kill its background work). A real refusal beside it
// still escalates.
it.effect("a turn that ended before the cooperative interrupt never escalates", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const lagging = makeUnit("gone-lagging", "turn-already-gone", now);
    const projected = makeUnit("gone-projected", "turn-already-gone-projected", now);
    const refusing = makeUnit("refusing", "rejects", now);
    const layer = controlLayer([lagging, projected, refusing], now);
    const outcomes = yield* Effect.forEach(
      [lagging, projected, refusing],
      (unit) => interruptCooperatively(unit).pipe(Effect.provide(layer)),
      { concurrency: "unbounded" },
    );
    assert.deepEqual(outcomes, ["cooperative", "cooperative", "hard"]);
    assert.deepEqual(rungs(lagging), ["cooperative"]);
    assert.deepEqual(rungs(projected), ["cooperative"]);
    assert.deepEqual(rungs(refusing), ["cooperative", "hard"]);
  }),
);
