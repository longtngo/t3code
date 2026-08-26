import { ORCHESTRATION_WS_METHODS, WS_METHODS } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { RpcClientError } from "effect/unstable/rpc";

import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";

export class EnvironmentRpcUnavailableError extends Schema.TaggedErrorClass<EnvironmentRpcUnavailableError>()(
  "EnvironmentRpcUnavailableError",
  {
    environmentId: Schema.String,
    message: Schema.String,
  },
) {}

export interface EnvironmentRpcRequestObservation {
  readonly environmentId: string;
  readonly method: string;
}

export class EnvironmentRpcRequestObserver extends Context.Reference<{
  readonly observe: (
    request: EnvironmentRpcRequestObservation,
  ) => Effect.Effect<Effect.Effect<void>>;
}>("@t3tools/client-runtime/rpc/EnvironmentRpcRequestObserver", {
  defaultValue: () => ({
    observe: () => Effect.succeed(Effect.void),
  }),
}) {}

export type EnvironmentRpcTag = keyof WsRpcProtocolClient & string;
type RpcMethod<TTag extends EnvironmentRpcTag> = WsRpcProtocolClient[TTag];

export type EnvironmentSubscriptionRpcTag =
  | typeof ORCHESTRATION_WS_METHODS.subscribeShell
  | typeof ORCHESTRATION_WS_METHODS.subscribeThread
  | typeof WS_METHODS.subscribeAuthAccess
  | typeof WS_METHODS.subscribeHostMetrics
  | typeof WS_METHODS.subscribeLlmModels
  | typeof WS_METHODS.subscribeServerConfig
  | typeof WS_METHODS.subscribeServerLifecycle
  | typeof WS_METHODS.subscribeTerminalEvents
  | typeof WS_METHODS.subscribeTerminalMetadata
  | typeof WS_METHODS.subscribePreviewEvents
  | typeof WS_METHODS.subscribeDiscoveredLocalServers
  | typeof WS_METHODS.subscribeResourceTelemetry
  | typeof WS_METHODS.previewAutomationConnect
  | typeof WS_METHODS.subscribeVcsStatus
  | typeof WS_METHODS.terminalAttach;

export type EnvironmentStreamCommandRpcTag =
  | typeof WS_METHODS.cloudInstallRelayClient
  | typeof WS_METHODS.serverUpdateServerWithProgress
  | typeof WS_METHODS.gitRunStackedAction;

export type EnvironmentStreamRpcTag =
  | EnvironmentSubscriptionRpcTag
  | EnvironmentStreamCommandRpcTag;

export type EnvironmentUnaryRpcTag = Exclude<EnvironmentRpcTag, EnvironmentStreamRpcTag>;

export interface EnvironmentRpcSubscriptionObservation {
  readonly environmentId: string;
  readonly method: EnvironmentSubscriptionRpcTag;
  readonly input: unknown;
}

export class EnvironmentRpcSubscriptionObserver extends Context.Reference<{
  readonly observe: (
    subscription: EnvironmentRpcSubscriptionObservation,
  ) => Effect.Effect<Effect.Effect<void>>;
}>("@t3tools/client-runtime/rpc/EnvironmentRpcSubscriptionObserver", {
  defaultValue: () => ({
    observe: () => Effect.succeed(Effect.void),
  }),
}) {}

export const isRpcClientError = Schema.is(RpcClientError.RpcClientError);

export type EnvironmentRpcInput<TTag extends EnvironmentRpcTag> = Parameters<RpcMethod<TTag>>[0];

export type EnvironmentRpcSuccess<TTag extends EnvironmentUnaryRpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Effect.Effect<infer A, any, any>
    ? A
    : never;

export type EnvironmentRpcFailure<TTag extends EnvironmentUnaryRpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Effect.Effect<any, infer E, any>
    ? E
    : never;

export type EnvironmentRpcStreamValue<TTag extends EnvironmentStreamRpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Stream.Stream<infer A, any, any>
    ? A
    : never;

export type EnvironmentRpcStreamFailure<TTag extends EnvironmentStreamRpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Stream.Stream<any, infer E, any>
    ? E
    : never;

const currentSession = Effect.fn("EnvironmentRpc.currentSession")(function* () {
  const supervisor = yield* EnvironmentSupervisor;
  return yield* SubscriptionRef.get(supervisor.session).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new EnvironmentRpcUnavailableError({
              environmentId: supervisor.target.environmentId,
              message: `${supervisor.target.label} is not connected.`,
            }),
          ),
        onSome: Effect.succeed,
      }),
    ),
  );
});

export const request = Effect.fn("EnvironmentRpc.request")(function* <
  TTag extends EnvironmentUnaryRpcTag,
>(tag: TTag, input: EnvironmentRpcInput<TTag>) {
  const supervisor = yield* EnvironmentSupervisor;
  yield* Effect.annotateCurrentSpan({
    "environment.id": supervisor.target.environmentId,
    "rpc.method": tag,
  });
  const session = yield* currentSession();
  const observer = yield* EnvironmentRpcRequestObserver;
  const method = session.client[tag] as (
    input: EnvironmentRpcInput<TTag>,
  ) => Effect.Effect<EnvironmentRpcSuccess<TTag>, EnvironmentRpcFailure<TTag>>;
  const completeObservation = yield* observer.observe({
    environmentId: supervisor.target.environmentId,
    method: tag,
  });
  return yield* method(input).pipe(Effect.ensuring(completeObservation));
});

export function runStream<TTag extends EnvironmentStreamCommandRpcTag>(
  tag: TTag,
  input: EnvironmentRpcInput<TTag>,
): Stream.Stream<
  EnvironmentRpcStreamValue<TTag>,
  EnvironmentRpcStreamFailure<TTag> | EnvironmentRpcUnavailableError,
  EnvironmentSupervisor
> {
  return Stream.unwrap(
    currentSession().pipe(
      Effect.map((session) => {
        const method = session.client[tag] as (
          input: EnvironmentRpcInput<TTag>,
        ) => Stream.Stream<EnvironmentRpcStreamValue<TTag>, EnvironmentRpcStreamFailure<TTag>>;
        return method(input);
      }),
    ),
  ).pipe(
    Stream.withSpan("EnvironmentRpc.runStream", {
      attributes: { "rpc.method": tag },
    }),
  );
}

interface SubscriptionOptions<TTag extends EnvironmentSubscriptionRpcTag> {
  readonly onExpectedFailure?: (
    cause: Cause.Cause<EnvironmentRpcStreamFailure<TTag>>,
  ) => Effect.Effect<void, never, never>;
  readonly retryExpectedFailureAfter?: Duration.Input;
  readonly resubscribe?: Stream.Stream<unknown, never, never>;
  /**
   * When set, a subscription stream that the SERVER ends NORMALLY (a clean
   * completion, not a failure) is automatically re-subscribed after this delay,
   * instead of stalling until the next session change.
   *
   * The server ends a live subscription cleanly when a bounded per-subscription
   * buffer overflows (a slow/stalled consumer fell too far behind): the completion
   * is the signal to reconnect and resync. Because `makeInput` is re-evaluated on
   * each (re)subscribe, the reconnect carries the latest resume cursor
   * (`afterSequence`), so the server replays exactly what was missed — lossless.
   * A client tears the whole stream down by SCOPE CLOSE (interruption), which is
   * NOT a normal completion, so unsubscribing never triggers a resubscribe. The
   * small delay guards against a hot loop if the server keeps ending immediately.
   */
  readonly resubscribeOnCompletionAfter?: Duration.Input;
}

/**
 * Longest an expected-failure retry will wait. Reached by doubling
 * `retryExpectedFailureAfter`, so a subscription that cannot succeed settles at
 * two attempts a minute instead of four a second.
 */
const EXPECTED_FAILURE_RETRY_CEILING = Duration.seconds(30);

/**
 * Consecutive expected failures before the subscription gives up on this
 * session. Something the server answers with a permanent "no" — a thread it has
 * never heard of, or one that is archived — is not going to start succeeding on
 * attempt 500, and the retry is invisible to the user, so it has to end itself.
 *
 * Ending is safe because it is not permanent: the counter resets on the next
 * emitted value and on every new session, so a reconnect, a refresh or a
 * remount all re-arm it.
 */
const EXPECTED_FAILURE_RETRY_LIMIT = 12;

/**
 * Backoff for consecutive expected failures: the base delay doubled per
 * attempt, capped. `attempt` is zero-based, so the first retry is the caller's
 * own delay and nothing changes for a subscription that recovers immediately.
 */
export function expectedFailureRetryDelay(
  base: Duration.Input,
  attempt: number,
): Duration.Duration {
  const decoded = Duration.fromInputUnsafe(base);
  // Bounded before the shift: 2 ** 1024 is Infinity, and Duration.times of
  // Infinity is not a delay anyone can wait on.
  const doublings = Math.min(Math.max(attempt, 0), 30);
  return Duration.min(Duration.times(decoded, 2 ** doublings), EXPECTED_FAILURE_RETRY_CEILING);
}

export function subscribeDynamic<TTag extends EnvironmentSubscriptionRpcTag>(
  tag: TTag,
  makeInput: (session: RpcSession) => Effect.Effect<EnvironmentRpcInput<TTag>>,
  options?: SubscriptionOptions<TTag>,
): Stream.Stream<
  EnvironmentRpcStreamValue<TTag>,
  EnvironmentRpcStreamFailure<TTag>,
  EnvironmentSupervisor
> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const supervisor = yield* EnvironmentSupervisor;
      const observer = yield* EnvironmentRpcSubscriptionObserver;
      const sessionChanges = SubscriptionRef.changes(supervisor.session);
      // Consecutive expected failures. Lives out here so it survives the
      // `subscribeToSession` recursion, and is cleared on every new session and
      // on every emitted value — the two things that count as evidence the
      // subscription can work.
      const expectedFailures = yield* Ref.make(0);
      const sessions =
        options?.resubscribe === undefined
          ? sessionChanges
          : Stream.merge(
              sessionChanges,
              options.resubscribe.pipe(
                Stream.mapEffect(() => SubscriptionRef.get(supervisor.session)),
              ),
            );
      return sessions.pipe(
        Stream.switchMap(
          Option.match({
            onNone: () => Stream.empty,
            onSome: (session) => {
              const resetExpectedFailures = Ref.set(expectedFailures, 0);
              const method = session.client[tag] as (
                input: EnvironmentRpcInput<TTag>,
              ) => Stream.Stream<
                EnvironmentRpcStreamValue<TTag>,
                EnvironmentRpcStreamFailure<TTag>
              >;
              const subscribeToSession = (): Stream.Stream<
                EnvironmentRpcStreamValue<TTag>,
                EnvironmentRpcStreamFailure<TTag>
              > =>
                Stream.suspend(() =>
                  Stream.unwrap(
                    Effect.gen(function* () {
                      const input = yield* makeInput(session);
                      const completeObservation = yield* observer.observe({
                        environmentId: supervisor.target.environmentId,
                        method: tag,
                        input,
                      });
                      // Each subscription's observation completes when that
                      // subscription ends, so a resubscribe below is observed as a
                      // fresh subscription rather than one long-running span.
                      const liveOnce = method(input).pipe(
                        // A value proves the subscription works, so the failure
                        // budget starts over. Without this a subscription that
                        // flaps once an hour would eventually exhaust its cap.
                        Stream.tap(() => resetExpectedFailures),
                        Stream.ensuring(completeObservation),
                      );
                      // When enabled, a NORMAL completion of the live stream (the
                      // server ended it cleanly, e.g. a bounded-buffer overflow →
                      // resync) re-subscribes with fresh input rather than stalling.
                      // Failures still flow to `catchCause` below; interruption
                      // (client unsubscribe / scope close) is not a completion, so it
                      // never resubscribes.
                      const live =
                        options?.resubscribeOnCompletionAfter === undefined
                          ? liveOnce
                          : liveOnce.pipe(
                              Stream.concat(
                                Stream.fromEffect(
                                  Effect.sleep(options.resubscribeOnCompletionAfter),
                                ).pipe(Stream.drain),
                              ),
                              Stream.concat(Stream.suspend(subscribeToSession)),
                            );
                      return live.pipe(
                        Stream.catchCause((cause) => {
                          const hasOnlyExpectedFailures =
                            cause.reasons.length > 0 &&
                            cause.reasons.every((reason) => reason._tag === "Fail");
                          const isTransportFailure =
                            hasOnlyExpectedFailures &&
                            cause.reasons.every(
                              (reason) => reason._tag === "Fail" && isRpcClientError(reason.error),
                            );
                          if (isTransportFailure) {
                            return Stream.fromEffect(
                              Effect.logWarning(
                                "Durable RPC subscription lost its transport; waiting for the next session.",
                                {
                                  cause: Cause.pretty(cause),
                                  method: tag,
                                  environmentId: supervisor.target.environmentId,
                                },
                              ),
                            ).pipe(Stream.drain);
                          }
                          if (hasOnlyExpectedFailures && options?.onExpectedFailure !== undefined) {
                            const handled = Stream.fromEffect(
                              options.onExpectedFailure(cause),
                            ).pipe(Stream.drain);
                            const retryAfter = options.retryExpectedFailureAfter;
                            if (retryAfter === undefined) {
                              return handled;
                            }
                            // Backed off and capped. A permanent "no" from the
                            // server — a thread it has never heard of, or an
                            // archived one — used to retry every 250ms forever,
                            // re-issuing the snapshot fetch each time, because
                            // an expected failure was read as a transient one.
                            const giveUp: Stream.Stream<
                              EnvironmentRpcStreamValue<TTag>,
                              EnvironmentRpcStreamFailure<TTag>
                            > = Stream.empty;
                            return handled.pipe(
                              Stream.concat(
                                Stream.unwrap(
                                  Effect.gen(function* () {
                                    const attempt = yield* Ref.getAndUpdate(
                                      expectedFailures,
                                      (count) => count + 1,
                                    );
                                    if (attempt >= EXPECTED_FAILURE_RETRY_LIMIT) {
                                      yield* Effect.logWarning(
                                        "Durable RPC subscription gave up after repeated expected failures; a new session, refresh or remount will retry.",
                                        {
                                          attempts: attempt,
                                          method: tag,
                                          environmentId: supervisor.target.environmentId,
                                        },
                                      );
                                      return giveUp;
                                    }
                                    yield* Effect.sleep(
                                      expectedFailureRetryDelay(retryAfter, attempt),
                                    );
                                    return subscribeToSession();
                                  }),
                                ),
                              ),
                            );
                          }
                          return Stream.failCause(cause);
                        }),
                      );
                    }),
                  ),
                );
              return subscribeToSession();
            },
          }),
        ),
      );
    }),
  ).pipe(
    Stream.withSpan("EnvironmentRpc.subscribe", {
      attributes: { "rpc.method": tag },
    }),
  );
}

export function subscribe<TTag extends EnvironmentSubscriptionRpcTag>(
  tag: TTag,
  input: EnvironmentRpcInput<TTag>,
  options?: SubscriptionOptions<TTag>,
): Stream.Stream<
  EnvironmentRpcStreamValue<TTag>,
  EnvironmentRpcStreamFailure<TTag>,
  EnvironmentSupervisor
> {
  return subscribeDynamic(tag, () => Effect.succeed(input), options);
}

export const config = Effect.gen(function* () {
  const session = yield* currentSession();
  return yield* session.initialConfig;
}).pipe(Effect.withSpan("EnvironmentRpc.config"));
