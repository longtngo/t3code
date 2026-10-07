// FORK Stop ladder: effects run one at a time per thread, so without help the
// second (hard) Stop press waits behind the first press's cooperative effect,
// which can take its whole grace. A hard Stop supersedes it instead.
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import { COOPERATIVE_INTERRUPT_GRACE } from "./ProviderTurnControlService.ts";

const outboxLayer = () =>
  Layer.fresh(EffectOutbox.layer.pipe(Layer.provide(SqlitePersistenceMemory)));

const interrupt = (id: string, threadId: ThreadId, cooperative: boolean) => ({
  id,
  commandId: CommandId.make(`command:${id}`),
  threadId,
  request: {
    type: "provider-turn.interrupt" as const,
    providerSessionId: ProviderSessionId.make("provider-session:ladder"),
    providerThreadId: ProviderThreadId.make("provider-thread:ladder"),
    providerTurnId: ProviderTurnId.make("provider-turn:ladder"),
    ...(cooperative ? { cooperative: true } : {}),
  },
});

/** What the hard press commits, in EventSink's order: enqueue, then cancel. */
const commitHardPress = (
  outbox: EffectOutbox.EffectOutboxV2Shape,
  id: string,
  threadId: ThreadId,
) =>
  Effect.gen(function* () {
    yield* outbox.enqueue([interrupt(id, threadId, false)]);
    const cancelled = yield* outbox.cancelUnsettled({
      threadId,
      ...EffectOutbox.supersedeCooperativeInterrupts("run:ladder"),
    });
    yield* outbox.signalCancellations(cancelled);
    yield* outbox.notifyAvailable(1);
    return cancelled;
  });

it.live("the second press stops the turn long before the cooperative grace runs out", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const threadId = ThreadId.make("thread:ladder-supersede");
    const cooperativeStarted = yield* Deferred.make<void>();
    const hardDone = yield* Deferred.make<number>();
    const hardStops: Array<string> = [];
    let cooperativeInterrupted = false;
    // The cooperative effect models a wedged turn: it would wait out its
    // grace and then escalate to a hard stop of its own.
    const executorLayer = Layer.succeed(
      EffectWorker.OrchestrationEffectExecutorV2,
      EffectWorker.OrchestrationEffectExecutorV2.of({
        execute: (effect) =>
          effect.request.type === "provider-turn.interrupt" && effect.request.cooperative === true
            ? Deferred.succeed(cooperativeStarted, undefined).pipe(
                Effect.andThen(Effect.sleep(COOPERATIVE_INTERRUPT_GRACE)),
                Effect.andThen(Effect.sync(() => hardStops.push(`escalated:${effect.id}`))),
                Effect.onInterrupt(() =>
                  Effect.sync(() => {
                    cooperativeInterrupted = true;
                  }),
                ),
              )
            : Effect.sync(() => hardStops.push(effect.id)).pipe(
                Effect.andThen(Clock.currentTimeMillis),
                Effect.flatMap((now) => Deferred.succeed(hardDone, now)),
                Effect.asVoid,
              ),
      }),
    );
    yield* Effect.gen(function* () {
      yield* EffectWorker.runDaemonWithOptions({
        concurrency: 2,
        livenessPollIntervalMs: 50,
      }).pipe(Effect.forkScoped);
      yield* outbox.enqueue([interrupt("effect:first-press", threadId, true)]);
      yield* outbox.notifyAvailable(1);
      yield* Deferred.await(cooperativeStarted);

      const pressedAt = yield* Clock.currentTimeMillis;
      const cancelled = yield* commitHardPress(outbox, "effect:second-press", threadId);
      assert.deepEqual(cancelled, ["effect:first-press"]);
      const doneAt = yield* Deferred.await(hardDone).pipe(Effect.timeout("2 seconds"));
      assert.isBelow(doneAt - pressedAt, 2_000);
      assert.deepEqual(hardStops, ["effect:second-press"], "exactly one hard stop");
      assert.isTrue(cooperativeInterrupted, "the superseded rung cannot escalate");
      const first = yield* outbox.get("effect:first-press");
      assert.equal(Option.getOrUndefined(first)?.status, "cancelled");
    }).pipe(
      Effect.provide(
        EffectWorker.layerWithOptions({ workerId: "ladder-supersede-worker" }).pipe(
          Layer.provide(
            Layer.merge(Layer.succeed(EffectOutbox.EffectOutboxV2, outbox), executorLayer),
          ),
        ),
      ),
      Effect.scoped,
    );
  }).pipe(Effect.provide(outboxLayer())),
);

// Only cooperative effects are superseded: the press's own hard effect, and an
// earlier hard stop still tearing a runtime down, run to completion.
it.effect("a hard press supersedes only cooperative interrupts", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const threadId = ThreadId.make("thread:ladder-earlier-hard");
    const other = ThreadId.make("thread:ladder-other");
    yield* outbox.enqueue([
      interrupt("effect:earlier-hard", threadId, false),
      interrupt("effect:other-thread-cooperative", other, true),
    ]);
    const running = yield* outbox.claimNext({ workerId: "w", leaseDurationMs: 30_000 });
    assert.equal(Option.getOrUndefined(running)?.id, "effect:earlier-hard");
    const cancelled = yield* commitHardPress(outbox, "effect:next-hard", threadId);
    assert.deepEqual(cancelled, []);
    assert.equal(
      Option.getOrUndefined(yield* outbox.get("effect:other-thread-cooperative"))?.status,
      "pending",
    );
    assert.equal(Option.getOrUndefined(yield* outbox.get("effect:next-hard"))?.status, "pending");
  }).pipe(Effect.provide(outboxLayer())),
);
