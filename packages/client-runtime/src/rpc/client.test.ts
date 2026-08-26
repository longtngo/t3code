import {
  EnvironmentId,
  type RelayClientInstallProgressEvent,
  WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { RpcClientError } from "effect/unstable/rpc";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as RpcSession from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import {
  EnvironmentRpcRequestObserver,
  expectedFailureRetryDelay,
  request,
  runStream,
  subscribe,
} from "./client.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const INSTALL_CHECKING: RelayClientInstallProgressEvent = {
  type: "progress",
  stage: "checking",
};
const INSTALL_DOWNLOADING: RelayClientInstallProgressEvent = {
  type: "progress",
  stage: "downloading",
};

function session(client: WsRpcProtocolClient): RpcSession.RpcSession {
  return {
    client,
    initialConfig: Effect.never,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

const makeHarness = Effect.fn("TestEnvironmentRpc.makeHarness")(function* () {
  const state = yield* SubscriptionRef.make<SupervisorConnectionState>(AVAILABLE_CONNECTION_STATE);
  const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
    Option.none(),
  );
  const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none());
  const retryCount = yield* Ref.make(0);
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state,
    session: activeSession,
    prepared,
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Ref.update(retryCount, (count) => count + 1),
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  return {
    activeSession,
    retryCount,
    supervisor,
  };
});

describe("environment RPC", () => {
  it.effect("observes unary requests until they complete", () =>
    Effect.gen(function* () {
      const observations: string[] = [];
      const client = {
        [WS_METHODS.cloudGetRelayClientStatus]: () =>
          Effect.succeed({ status: "available", version: "2026.6.0" }),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));

      const result = yield* request(WS_METHODS.cloudGetRelayClientStatus, {}).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(
          EnvironmentRpcRequestObserver,
          EnvironmentRpcRequestObserver.of({
            observe: ({ environmentId, method }) =>
              Effect.sync(() => {
                observations.push(`start:${environmentId}:${method}`);
                return Effect.sync(() => {
                  observations.push(`finish:${environmentId}:${method}`);
                });
              }),
          }),
        ),
      );

      expect(result).toEqual({ status: "available", version: "2026.6.0" });
      expect(observations).toEqual([
        `start:${TARGET.environmentId}:${WS_METHODS.cloudGetRelayClientStatus}`,
        `finish:${TARGET.environmentId}:${WS_METHODS.cloudGetRelayClientStatus}`,
      ]);
    }),
  );

  it.effect("binds finite streaming commands to one active session", () =>
    Effect.gen(function* () {
      const firstEvents = yield* Queue.unbounded<RelayClientInstallProgressEvent>();
      const secondEvents = yield* Queue.unbounded<RelayClientInstallProgressEvent>();
      const firstClient = {
        [WS_METHODS.cloudInstallRelayClient]: () => Stream.fromQueue(firstEvents),
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.cloudInstallRelayClient]: () => Stream.fromQueue(secondEvents),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
      const resultFiber = yield* runStream(WS_METHODS.cloudInstallRelayClient, {}).pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* Effect.yieldNow;

      yield* Queue.offer(firstEvents, INSTALL_CHECKING);
      yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));
      yield* Queue.offer(secondEvents, INSTALL_DOWNLOADING);
      yield* Queue.offer(firstEvents, INSTALL_DOWNLOADING);

      expect(yield* Fiber.join(resultFiber)).toEqual([INSTALL_CHECKING, INSTALL_DOWNLOADING]);
    }),
  );

  it.effect("switches durable subscriptions when the supervisor replaces the session", () =>
    Effect.gen(function* () {
      const subscriptions: string[] = [];
      const firstClient = {
        [WS_METHODS.subscribeTerminalEvents]: () => {
          subscriptions.push("first");
          return Stream.never;
        },
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.subscribeTerminalEvents]: () => {
          subscriptions.push("second");
          return Stream.never;
        },
      } as unknown as WsRpcProtocolClient;
      const { activeSession, retryCount, supervisor } = yield* makeHarness();
      const awaitSubscriptions = Effect.fn("TestEnvironmentRpc.awaitSubscriptions")(function* (
        count: number,
      ) {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (subscriptions.length >= count) {
            return;
          }
          yield* Effect.yieldNow;
        }
        return yield* Effect.die(new Error(`Expected ${count} durable subscriptions.`));
      });

      const subscriptionFiber = yield* subscribe(WS_METHODS.subscribeTerminalEvents, {}).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
      yield* awaitSubscriptions(1);
      yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));
      yield* awaitSubscriptions(2);
      yield* Fiber.interrupt(subscriptionFiber);

      expect(subscriptions).toEqual(["first", "second"]);
      expect(yield* Ref.get(retryCount)).toBe(0);
    }),
  );

  it.effect("keeps durable subscriptions alive across a transport failure and new session", () =>
    Effect.gen(function* () {
      const subscriptions: string[] = [];
      const firstClient = {
        [WS_METHODS.subscribeTerminalEvents]: () => {
          subscriptions.push("first");
          return Stream.fail(
            new RpcClientError.RpcClientError({
              reason: new RpcClientError.RpcClientDefect({
                message: "socket closed",
                cause: new Error("socket closed"),
              }),
            }),
          );
        },
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.subscribeTerminalEvents]: () => {
          subscriptions.push("second");
          return Stream.never;
        },
      } as unknown as WsRpcProtocolClient;
      const { activeSession, retryCount, supervisor } = yield* makeHarness();

      const subscriptionFiber = yield* subscribe(WS_METHODS.subscribeTerminalEvents, {}).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
      for (let attempt = 0; attempt < 100 && subscriptions.length < 1; attempt += 1) {
        yield* Effect.yieldNow;
      }
      yield* SubscriptionRef.set(activeSession, Option.none());
      yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));

      for (let attempt = 0; attempt < 100 && subscriptions.length < 2; attempt += 1) {
        yield* Effect.yieldNow;
      }
      yield* Fiber.interrupt(subscriptionFiber);

      expect(subscriptions).toEqual(["first", "second"]);
      expect(yield* Ref.get(retryCount)).toBe(0);
    }),
  );

  it.effect("surfaces domain subscription failures without reconnecting", () =>
    Effect.gen(function* () {
      const domainError = new Error("terminal subscription rejected");
      const client = {
        [WS_METHODS.subscribeTerminalEvents]: () => Stream.fail(domainError),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, retryCount, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const error = yield* subscribe(WS_METHODS.subscribeTerminalEvents, {}).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.flip,
      );

      expect(error).toBe(domainError);
      expect(yield* Ref.get(retryCount)).toBe(0);
    }),
  );

  it.effect("keeps handled domain failures dormant until a replacement session arrives", () =>
    Effect.gen(function* () {
      const domainError = new Error("terminal subscription rejected");
      const subscriptions: string[] = [];
      const observedFailures: Error[] = [];
      const firstClient = {
        [WS_METHODS.subscribeTerminalEvents]: () => {
          subscriptions.push("first");
          return Stream.fail(domainError);
        },
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.subscribeTerminalEvents]: () => {
          subscriptions.push("second");
          return Stream.never;
        },
      } as unknown as WsRpcProtocolClient;
      const { activeSession, retryCount, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
      const subscriptionFiber = yield* subscribe(
        WS_METHODS.subscribeTerminalEvents,
        {},
        {
          onExpectedFailure: (cause) =>
            Effect.sync(() => {
              observedFailures.push(Cause.squash(cause) as Error);
            }),
        },
      ).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      for (let attempt = 0; attempt < 100 && observedFailures.length < 1; attempt += 1) {
        yield* Effect.yieldNow;
      }

      expect(subscriptions).toEqual(["first"]);
      expect(observedFailures).toEqual([domainError]);

      yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));
      for (let attempt = 0; attempt < 100 && subscriptions.length < 2; attempt += 1) {
        yield* Effect.yieldNow;
      }
      yield* Fiber.interrupt(subscriptionFiber);

      expect(subscriptions).toEqual(["first", "second"]);
      expect(yield* Ref.get(retryCount)).toBe(0);
    }),
  );

  it.effect("retries handled domain failures within the same session when configured", () =>
    Effect.gen(function* () {
      const domainError = new Error("thread not found yet");
      const subscriptionCount = yield* Ref.make(0);
      const expectedFailureCount = yield* Ref.make(0);
      const client = {
        [WS_METHODS.subscribeTerminalEvents]: () =>
          Stream.unwrap(
            Ref.getAndUpdate(subscriptionCount, (count) => count + 1).pipe(
              Effect.map((count) => (count === 0 ? Stream.fail(domainError) : Stream.never)),
            ),
          ),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const subscriptionFiber = yield* subscribe(
        WS_METHODS.subscribeTerminalEvents,
        {},
        {
          onExpectedFailure: () => Ref.update(expectedFailureCount, (count) => count + 1),
          retryExpectedFailureAfter: "100 millis",
        },
      ).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(expectedFailureCount)) >= 1) {
          break;
        }
        yield* Effect.yieldNow;
      }

      expect(yield* Ref.get(subscriptionCount)).toBe(1);
      expect(yield* Ref.get(expectedFailureCount)).toBe(1);

      yield* TestClock.adjust("100 millis");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(subscriptionCount)) >= 2) {
          break;
        }
        yield* Effect.yieldNow;
      }
      yield* Fiber.interrupt(subscriptionFiber);

      expect(yield* Ref.get(subscriptionCount)).toBe(2);
      expect(yield* Ref.get(expectedFailureCount)).toBe(1);
    }),
  );

  it.effect("stops retrying a subscription the server permanently refuses", () =>
    Effect.gen(function* () {
      // A thread the server has never heard of, or an archived one, fails the
      // snapshot every time. This used to resubscribe every 250ms forever,
      // re-issuing the HTTP snapshot fetch on each attempt: measured at 3.35
      // requests a second, indefinitely, against one dead thread id.
      const domainError = new Error("Thread abc was not found");
      const subscriptionCount = yield* Ref.make(0);
      const client = {
        [WS_METHODS.subscribeTerminalEvents]: () =>
          Stream.unwrap(
            Ref.update(subscriptionCount, (count) => count + 1).pipe(
              Effect.as(Stream.fail(domainError)),
            ),
          ),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const subscriptionFiber = yield* subscribe(
        WS_METHODS.subscribeTerminalEvents,
        {},
        { onExpectedFailure: () => Effect.void, retryExpectedFailureAfter: "250 millis" },
      ).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );

      // An hour of simulated time, far past the backoff budget. Under the old
      // fixed 250ms retry this would be ~14,400 subscriptions.
      for (let tick = 0; tick < 60; tick += 1) {
        yield* TestClock.adjust("60 seconds");
        for (let pump = 0; pump < 40; pump += 1) {
          yield* Effect.yieldNow;
        }
      }
      yield* Fiber.interrupt(subscriptionFiber);

      // One initial attempt plus the retry limit.
      expect(yield* Ref.get(subscriptionCount)).toBe(13);
    }),
  );

  it.effect("gives a subscription its retry budget back once it produces a value", () =>
    Effect.gen(function* () {
      // Otherwise a subscription that flaps occasionally over a long session
      // would eventually exhaust a cap meant for permanent refusals.
      const subscriptionCount = yield* Ref.make(0);
      const client = {
        [WS_METHODS.subscribeTerminalEvents]: () =>
          Stream.unwrap(
            Ref.getAndUpdate(subscriptionCount, (count) => count + 1).pipe(
              Effect.map((count) =>
                count % 2 === 0
                  ? Stream.fail(new Error("transient"))
                  : Stream.make({ ok: true }).pipe(Stream.concat(Stream.fail(new Error("again")))),
              ),
            ),
          ),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const subscriptionFiber = yield* subscribe(
        WS_METHODS.subscribeTerminalEvents,
        {},
        { onExpectedFailure: () => Effect.void, retryExpectedFailureAfter: "250 millis" },
      ).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );

      for (let tick = 0; tick < 60; tick += 1) {
        yield* TestClock.adjust("10 seconds");
        for (let pump = 0; pump < 40; pump += 1) {
          yield* Effect.yieldNow;
        }
      }
      yield* Fiber.interrupt(subscriptionFiber);

      // Every other attempt emits, so the budget never runs out and the
      // subscription keeps recovering well past the 13 a dead one gets.
      expect(yield* Ref.get(subscriptionCount)).toBeGreaterThan(13);
    }),
  );

  it.effect("does not classify subscription defects as expected failures", () =>
    Effect.gen(function* () {
      const defect = new Error("subscription invariant failed");
      let expectedFailureCount = 0;
      const client = {
        [WS_METHODS.subscribeTerminalEvents]: () => Stream.die(defect),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const exit = yield* subscribe(
        WS_METHODS.subscribeTerminalEvents,
        {},
        {
          onExpectedFailure: () =>
            Effect.sync(() => {
              expectedFailureCount += 1;
            }),
        },
      ).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.exit,
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(true);
      }
      expect(expectedFailureCount).toBe(0);
    }),
  );

  it.effect(
    "resubscribes after the server ENDS the stream normally when resubscribeOnCompletionAfter is set",
    () =>
      Effect.gen(function* () {
        // Models the server-side bounded-buffer overflow: the subscription stream
        // COMPLETES (no error). With the option set, the client must reconnect
        // (resync) rather than stall.
        const subscriptionCount = yield* Ref.make(0);
        const client = {
          [WS_METHODS.subscribeTerminalEvents]: () =>
            Stream.unwrap(
              Ref.update(subscriptionCount, (count) => count + 1).pipe(Effect.as(Stream.empty)),
            ),
        } as unknown as WsRpcProtocolClient;
        const { activeSession, supervisor } = yield* makeHarness();

        yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
        const subscriptionFiber = yield* subscribe(
          WS_METHODS.subscribeTerminalEvents,
          {},
          { resubscribeOnCompletionAfter: "100 millis" },
        ).pipe(
          Stream.runDrain,
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.forkChild,
        );

        for (let attempt = 0; attempt < 100; attempt += 1) {
          if ((yield* Ref.get(subscriptionCount)) >= 1) break;
          yield* Effect.yieldNow;
        }
        // First subscription completed; the client is now waiting out the delay.
        expect(yield* Ref.get(subscriptionCount)).toBe(1);

        yield* TestClock.adjust("100 millis");
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if ((yield* Ref.get(subscriptionCount)) >= 2) break;
          yield* Effect.yieldNow;
        }
        // The clean completion triggered a resubscribe (the resync path).
        expect(yield* Ref.get(subscriptionCount)).toBe(2);

        // Client unsubscribe (scope close) is interruption, NOT a completion, so it
        // must not spawn further resubscriptions.
        yield* Fiber.interrupt(subscriptionFiber);
        yield* TestClock.adjust("500 millis");
        expect(yield* Ref.get(subscriptionCount)).toBe(2);
      }),
  );

  it.effect("does NOT resubscribe on a clean completion when the option is absent", () =>
    Effect.gen(function* () {
      const subscriptionCount = yield* Ref.make(0);
      const client = {
        [WS_METHODS.subscribeTerminalEvents]: () =>
          Stream.unwrap(
            Ref.update(subscriptionCount, (count) => count + 1).pipe(Effect.as(Stream.empty)),
          ),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const subscriptionFiber = yield* subscribe(WS_METHODS.subscribeTerminalEvents, {}).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );

      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(subscriptionCount)) >= 1) break;
        yield* Effect.yieldNow;
      }
      yield* TestClock.adjust("1 second");
      // Without the option, a clean completion is terminal — no resubscribe.
      expect(yield* Ref.get(subscriptionCount)).toBe(1);
      yield* Fiber.interrupt(subscriptionFiber);
    }),
  );
});

describe("expectedFailureRetryDelay", () => {
  it("starts at the caller's delay and doubles", () => {
    expect(Duration.toMillis(expectedFailureRetryDelay("250 millis", 0))).toBe(250);
    expect(Duration.toMillis(expectedFailureRetryDelay("250 millis", 1))).toBe(500);
    expect(Duration.toMillis(expectedFailureRetryDelay("250 millis", 4))).toBe(4_000);
  });

  it("caps, so a long-lived dead subscription settles at twice a minute", () => {
    expect(Duration.toMillis(expectedFailureRetryDelay("250 millis", 7))).toBe(30_000);
    expect(Duration.toMillis(expectedFailureRetryDelay("250 millis", 99))).toBe(30_000);
  });

  it("does not overflow into an unwaitable delay", () => {
    // 2 ** 1024 is Infinity, and a Duration of Infinity never fires.
    const delay = expectedFailureRetryDelay("250 millis", 5_000);
    expect(Number.isFinite(Duration.toMillis(delay))).toBe(true);
    expect(Duration.toMillis(delay)).toBe(30_000);
  });
});
