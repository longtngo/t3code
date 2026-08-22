import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as itEffect } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";

import {
  PendingBackgroundTaskRepository,
  type PendingBackgroundTaskRepositoryShape,
} from "../../persistence/Services/PendingBackgroundTask.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import {
  ThreadDeletionReactorLive,
  logCleanupCauseUnlessInterrupted,
} from "./ThreadDeletionReactor.ts";

describe("logCleanupCauseUnlessInterrupted", () => {
  const threadId = ThreadId.make("thread-deletion-reactor-test");

  it("swallows ordinary cleanup failures", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.fail("cleanup failed"),
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("preserves interrupt causes", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.interrupt,
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  });
});

describe("ThreadDeletionReactor", () => {
  const threadId = ThreadId.make("thread-deleted-cleanup");

  const deletedEvent = {
    sequence: 1,
    eventId: EventId.make("event-thread-deleted"),
    aggregateKind: "thread" as const,
    aggregateId: threadId,
    occurredAt: "2026-01-01T00:00:00.000Z",
    commandId: CommandId.make("cmd-thread-delete"),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.deleted" as const,
    payload: { threadId, deletedAt: "2026-01-01T00:00:00.000Z" },
  } as unknown as Extract<OrchestrationEvent, { type: "thread.deleted" }>;

  interface Recorded {
    readonly dispatched: Array<OrchestrationCommand>;
    readonly closedTerminals: Array<string>;
    readonly clearedTaskThreadIds: Array<string>;
  }

  const makeLayer = (recorded: Recorded, extraEventFirst?: OrchestrationEvent) => {
    // Any extra event is emitted BEFORE the deletion: the reactor consumes the
    // stream in order, so the deletion's own cleanup landing proves the earlier
    // event was already seen and skipped. Emitting it after would let "nothing
    // happened for it" mean "not reached yet".
    const events = [...(extraEventFirst ? [extraEventFirst] : []), deletedEvent];

    const engine = Layer.succeed(OrchestrationEngineService, {
      readEvents: () => Effect.die(new Error("unused")),
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          recorded.dispatched.push(command);
          return { sequence: recorded.dispatched.length };
        }),
      streamDomainEvents: Stream.fromIterable(events),
      subscribeDomainEvents: Effect.die(new Error("unused")),
      latestSequence: Effect.succeed(0),
    } as unknown as OrchestrationEngineShape);

    const terminals = Layer.succeed(TerminalManager.TerminalManager, {
      open: () => Effect.die(new Error("unused")),
      attachStream: () => Effect.die(new Error("unused")),
      write: () => Effect.void,
      resize: () => Effect.void,
      clear: () => Effect.void,
      restart: () => Effect.die(new Error("unused")),
      close: (request) =>
        Effect.sync(() => {
          recorded.closedTerminals.push(request.threadId);
        }),
      subscribe: () => Effect.succeed(() => undefined),
      subscribeMetadata: () => Effect.succeed(() => undefined),
    } satisfies TerminalManager.TerminalManager["Service"]);

    const pendingTasks = Layer.succeed(PendingBackgroundTaskRepository, {
      upsert: () => Effect.void,
      touch: () => Effect.void,
      incrementAttempts: () => Effect.void,
      getByTaskId: () => Effect.die(new Error("unused")),
      list: () => Effect.succeed([]),
      listByThreadId: () => Effect.succeed([]),
      deleteByTaskId: () => Effect.void,
      deleteByThreadId: (request) =>
        Effect.sync(() => {
          recorded.clearedTaskThreadIds.push(request.threadId);
        }),
    } satisfies PendingBackgroundTaskRepositoryShape);

    return ThreadDeletionReactorLive.pipe(
      Layer.provideMerge(engine),
      Layer.provideMerge(terminals),
      Layer.provideMerge(pendingTasks),
      Layer.provideMerge(NodeServices.layer),
    );
  };

  /**
   * Yields until the predicate holds. Deliberately clock-free: the work is done
   * by a forked fiber, and `drain` alone cannot be the signal because the queue
   * reads empty before that fiber has enqueued anything as well as after it has
   * finished.
   */
  const yieldUntil = (predicate: () => boolean) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 10_000; attempt += 1) {
        if (predicate()) {
          return;
        }
        yield* Effect.yieldNow;
      }
      return yield* Effect.die(
        new Error("Timed out waiting for the deletion reactor to process its event."),
      );
    });

  const runCleanup = (extraEventFirst?: OrchestrationEvent) =>
    Effect.gen(function* () {
      const recorded: Recorded = {
        dispatched: [],
        closedTerminals: [],
        clearedTaskThreadIds: [],
      };
      yield* Effect.gen(function* () {
        const reactor = yield* ThreadDeletionReactor;
        yield* reactor.start();
        yield* yieldUntil(() => recorded.closedTerminals.length > 0);
        yield* reactor.drain;
      }).pipe(Effect.scoped, Effect.provide(makeLayer(recorded, extraEventFirst)));
      return recorded;
    });

  // Deleting a thread stopped the provider by calling `ProviderService`
  // directly, so nothing wrote the session projection. `thread.deleted` is a
  // soft delete and `projection_thread_sessions` has no cascade, so the row
  // survived saying the session was still live - three such rows in a real
  // database. Routing the stop through the command fixes both halves at once.
  itEffect.effect("asks the session-stop command to clean up, so the projection follows", () =>
    Effect.gen(function* () {
      const recorded = yield* runCleanup();

      expect(recorded.dispatched.map((command) => command.type)).toEqual(["thread.session.stop"]);
      expect(
        recorded.dispatched.map((command) => (command as { threadId?: string }).threadId),
      ).toEqual([threadId]);
    }),
  );

  itEffect.effect("still closes terminals and clears pending background tasks", () =>
    Effect.gen(function* () {
      const recorded = yield* runCleanup();

      expect(recorded.closedTerminals).toEqual([threadId]);
      expect(recorded.clearedTaskThreadIds).toEqual([threadId]);
    }),
  );

  // The reactor subscribes to the whole domain-event stream, so a filter that
  // stopped discriminating would clean up threads that were never deleted.
  itEffect.effect("ignores domain events that are not a deletion", () =>
    Effect.gen(function* () {
      const recorded = yield* runCleanup({
        ...deletedEvent,
        sequence: 2,
        eventId: EventId.make("event-thread-archived"),
        type: "thread.archived",
        payload: {
          threadId: ThreadId.make("thread-archived-not-deleted"),
          archivedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      } as unknown as OrchestrationEvent);

      expect(recorded.dispatched.length).toBe(1);
      expect(recorded.closedTerminals).toEqual([threadId]);
    }),
  );
});
