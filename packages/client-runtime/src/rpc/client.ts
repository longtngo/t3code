import {
  EnvironmentAuthorizationError,
  clientRpcRequiredScopes,
  authScopeRequiredResponse,
  type EnvironmentId,
  type ClientGuardedRpcTag,
  ORCHESTRATION_V2_WS_METHODS,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { RpcClientError } from "effect/rpc";

import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";

export class EnvironmentRpcUnavailableError extends Schema.TaggedError<EnvironmentRpcUnavailableError>()(
  "EnvironmentRpcUnavailableError",
  {
    environmentId: Schema.String,
    message: Schema.String,
  },
) {}

export interface EnvironmentRpcRequestObservation {
  readonly environmentId: string;
  readonly environmentLabel: string;
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
  | typeof WS_METHODS.providerAuthSubscribe
  | typeof WS_METHODS.providerInstallSubscribe
  | typeof ORCHESTRATION_V2_WS_METHODS.subscribeShell
  | typeof ORCHESTRATION_V2_WS_METHODS.subscribeThread
  | typeof ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput
  | typeof ORCHESTRATION_V2_WS_METHODS.searchThreadStream
  | typeof WS_METHODS.subscribeAuthAccess
  | typeof WS_METHODS.subscribeHostMetrics
  | typeof WS_METHODS.subscribeLlmModels
  | typeof WS_METHODS.subscribeServerConfig
  | typeof WS_METHODS.subscribeServerLifecycle
  | typeof WS_METHODS.scheduledTasksSubscribe
  | typeof WS_METHODS.serverGetStorageCleanupReport
  | typeof WS_METHODS.serverGetDatabaseStorage
  | typeof WS_METHODS.subscribeTerminalMetadata
  | typeof WS_METHODS.subscribePreviewEvents
  | typeof WS_METHODS.subscribeDiscoveredLocalServers
  | typeof WS_METHODS.subscribeDeviceState
  | typeof WS_METHODS.subscribeResourceTelemetry
  | typeof WS_METHODS.serverSubscribeThreadQueue
  | typeof WS_METHODS.pullRequestsSubscribeRefreshes
  | typeof WS_METHODS.subscribeVcsStatus
  | typeof WS_METHODS.subscribeWorktreeSetup
  | typeof WS_METHODS.subscribeProjectClones
  | typeof WS_METHODS.terminalAttach
  | typeof WS_METHODS.terminalObserve;

export type EnvironmentStreamCommandRpcTag =
  | typeof WS_METHODS.chatGptHandoffSubscribe
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
const isEnvironmentAuthorizationError = Schema.is(EnvironmentAuthorizationError);

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
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
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

export const getInitialServerConfig = Effect.fn("EnvironmentRpc.getInitialServerConfig")(
  function* () {
    const session = yield* currentSession();
    return yield* session.initialConfig;
  },
);

/** Installed by the shared command boundary. A missing boundary denies protected writes. */
export class RpcPermissionGuard extends Context.Reference<{
  readonly authorize: (
    environmentId: EnvironmentId,
    method: string,
    input: unknown,
  ) => Effect.Effect<void, EnvironmentAuthorizationError>;
}>("@t3tools/client-runtime/rpc/RpcPermissionGuard", {
  defaultValue: () => ({
    authorize: (_environmentId, method, input) => {
      const scope = clientRpcRequiredScopes(method, input)[0];
      return scope === undefined
        ? Effect.void
        : Effect.fail(
            new EnvironmentAuthorizationError({
              ...authScopeRequiredResponse(scope),
              message: `This connection requires ${scope}.`,
            }),
          );
    },
  }),
}) {}

const authorizeRequest = Effect.fn("EnvironmentRpc.authorize")(function* (
  method: string,
  input: unknown,
) {
  if (clientRpcRequiredScopes(method, input).length === 0) return;
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  const guard = yield* RpcPermissionGuard;
  yield* guard.authorize(supervisor.target.environmentId, method, input);
});

export const requestGuarded = Effect.fn("EnvironmentRpc.request")(function* <
  TTag extends EnvironmentUnaryRpcTag,
>(tag: TTag, input: EnvironmentRpcInput<TTag>) {
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  yield* Effect.annotateCurrentSpan({
    "environment.id": supervisor.target.environmentId,
    "rpc.method": tag,
  });
  const session = yield* currentSession();
  yield* authorizeRequest(tag, input);
  const observer = yield* EnvironmentRpcRequestObserver;
  const method = session.client[tag] as (
    input: EnvironmentRpcInput<TTag>,
  ) => Effect.Effect<EnvironmentRpcSuccess<TTag>, EnvironmentRpcFailure<TTag>>;
  const completeObservation = yield* observer.observe({
    environmentId: supervisor.target.environmentId,
    environmentLabel: supervisor.target.label,
    method: tag,
  });
  return yield* method(input).pipe(Effect.ensuring(completeObservation));
});

export function runStreamGuarded<TTag extends EnvironmentStreamCommandRpcTag>(
  tag: TTag,
  input: EnvironmentRpcInput<TTag>,
): Stream.Stream<
  EnvironmentRpcStreamValue<TTag>,
  | EnvironmentRpcStreamFailure<TTag>
  | EnvironmentRpcUnavailableError
  | EnvironmentAuthorizationError,
  EnvironmentSupervisor.EnvironmentSupervisor
> {
  return Stream.unwrap(
    authorizeRequest(tag, input).pipe(
      Effect.andThen(currentSession()),
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
  readonly onDefect?: (
    cause: Cause.Cause<EnvironmentRpcStreamFailure<TTag>>,
  ) => Effect.Effect<void, never, never>;
  readonly onExpectedFailure?: (
    cause: Cause.Cause<EnvironmentRpcStreamFailure<TTag>>,
  ) => Effect.Effect<void, never, never>;
  readonly retryExpectedFailureAfter?: Duration.Input;
  readonly resubscribe?: Stream.Stream<unknown, never, never>;
  /**
   * Re-subscribe after this delay when the SERVER ends the stream normally (it does so on per-sub
   * buffer overflow, as a resync signal). `makeInput` re-runs, so the latest `afterSequence` makes it
   * lossless. Unsubscribing is interruption, not completion, so it never resubscribes; the delay
   * guards a hot loop.
   */
  readonly resubscribeOnCompletionAfter?: Duration.Input;
}

/**
 * Longest a retry will wait. Reached by doubling the caller's own delay, so a
 * subscription that cannot make progress settles at two attempts a minute
 * instead of four a second.
 */
const SUBSCRIPTION_RETRY_CEILING = Duration.seconds(30);

/**
 * Consecutive expected failures (a permanent "no", e.g. an unknown or archived thread) before the
 * subscription gives up on this session, since the retry is invisible to the user. Safe: the counter
 * resets on the next value and every new session, so reconnect, refresh or remount re-arm it.
 */
const EXPECTED_FAILURE_RETRY_LIMIT = 12;

/**
 * Backoff for consecutive fruitless attempts, whether the last one failed or
 * completed: the base delay doubled per attempt, capped. `attempt` is
 * zero-based, so the first retry is the caller's own delay and nothing changes
 * for a subscription that recovers immediately.
 */
export function subscriptionRetryDelay(base: Duration.Input, attempt: number): Duration.Duration {
  const decoded = Duration.fromInputUnsafe(base);
  // Bounded before the shift: 2 ** 1024 is Infinity, and Duration.times of
  // Infinity is not a delay anyone can wait on.
  const doublings = Math.min(Math.max(attempt, 0), 30);
  return Duration.min(Duration.times(decoded, 2 ** doublings), SUBSCRIPTION_RETRY_CEILING);
}

/**
 * How long a subscription must last for its completion to clear the resubscribe budget. Time, not
 * "did it emit": an overflowing stream emits its whole buffer before ending, so emission is true in
 * exactly the runaway case this bounds.
 */
const HEALTHY_SUBSCRIPTION_MILLIS = 10_000;

function subscribeDynamicMapped<TTag extends EnvironmentSubscriptionRpcTag, A>(
  tag: TTag,
  makeInput: (session: RpcSession) => Effect.Effect<EnvironmentRpcInput<TTag>>,
  mapStream: (
    session: RpcSession,
    stream: Stream.Stream<EnvironmentRpcStreamValue<TTag>, EnvironmentRpcStreamFailure<TTag>>,
  ) => Stream.Stream<A, EnvironmentRpcStreamFailure<TTag>>,
  options?: SubscriptionOptions<TTag>,
): Stream.Stream<
  A,
  EnvironmentRpcStreamFailure<TTag>,
  EnvironmentSupervisor.EnvironmentSupervisor
> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
      const observer = yield* EnvironmentRpcSubscriptionObserver;
      const sessionChanges = SubscriptionRef.changes(supervisor.session);
      // Consecutive expected failures. Lives out here so it survives the
      // `subscribeToSession` recursion, and is cleared on every new session and
      // on every emitted value — the two things that count as evidence the
      // subscription can work.
      const expectedFailures = yield* Ref.make(0);
      // Consecutive resubscribes triggered by a NORMAL completion. Carried across
      // the `subscribeToSession` recursion like the failure budget above, and
      // cleared by the same two pieces of evidence: a new session, and a
      // subscription that lasted long enough to have done its job.
      const completionResubscribes = yield* Ref.make(0);
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
              const resetCompletionResubscribes = Ref.set(completionResubscribes, 0);
              const method = (
                tag === WS_METHODS.subscribeServerConfig
                  ? session.subscribeServerConfig
                  : session.client[tag]
              ) as (
                input: EnvironmentRpcInput<TTag>,
              ) => Stream.Stream<
                EnvironmentRpcStreamValue<TTag>,
                EnvironmentRpcStreamFailure<TTag>
              >;
              const subscribeToSession = (): Stream.Stream<A, EnvironmentRpcStreamFailure<TTag>> =>
                Stream.suspend(() => {
                  // Hoisted out of the `Effect.gen` because the recovery below now reads it
                  // from the pipe level. Same lifetime either way: the gen runs once per
                  // `subscribeToSession()` call, and each call re-enters this closure.
                  let producedValue = false;
                  return Stream.unwrap(
                    Effect.gen(function* () {
                      const input = yield* makeInput(session);
                      const startedAtMillis = yield* Clock.currentTimeMillis;
                      const completeObservation = yield* observer.observe({
                        environmentId: supervisor.target.environmentId,
                        method: tag,
                        input,
                      });
                      // A value proves the subscription works, so the failure budget starts over. Recorded
                      // synchronously and flushed in `catchCause`, NOT with `Stream.tap`: an Effect boundary per
                      // element makes `switchMap` drop a value the old session had buffered (why upstream's
                      // `mapStream` tag is a plain `Stream.map` too).
                      const liveOnce = mapStream(session, method(input)).pipe(
                        Stream.map((value) => {
                          producedValue = true;
                          return value;
                        }),
                        Stream.ensuring(completeObservation),
                      );
                      // A NORMAL completion (server ended cleanly, e.g. overflow -> resync) re-subscribes with
                      // fresh input. Failures go to `catchCause`; interruption (unsubscribe) never resubscribes.
                      const resubscribeAfter = options?.resubscribeOnCompletionAfter;
                      const live =
                        resubscribeAfter === undefined
                          ? liveOnce
                          : liveOnce.pipe(
                              Stream.concat(
                                Stream.unwrap(
                                  Effect.gen(function* () {
                                    // Backed off but never given up: a clean completion is a
                                    // resync request, and abandoning it silently freezes the
                                    // thread. The delay grows to the ceiling and stays there.
                                    const elapsed =
                                      (yield* Clock.currentTimeMillis) - startedAtMillis;
                                    const attempt =
                                      elapsed >= HEALTHY_SUBSCRIPTION_MILLIS
                                        ? yield* Ref.set(completionResubscribes, 1).pipe(
                                            Effect.as(0),
                                          )
                                        : yield* Ref.getAndUpdate(
                                            completionResubscribes,
                                            (count) => count + 1,
                                          );
                                    yield* Effect.sleep(
                                      subscriptionRetryDelay(resubscribeAfter, attempt),
                                    );
                                    return subscribeToSession();
                                  }),
                                ),
                              ),
                            );
                      return live;
                    }),
                  ).pipe(
                    Stream.tapCause((cause) =>
                      options?.onDefect !== undefined &&
                      cause.reasons.some(
                        (reason) =>
                          reason._tag === "Die" ||
                          (reason._tag === "Fail" &&
                            isRpcClientError(reason.error) &&
                            reason.error.reason._tag === "RpcClientDefect"),
                      )
                        ? options.onDefect(cause)
                        : Effect.void,
                    ),
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
                        const handled = Stream.fromEffect(options.onExpectedFailure(cause)).pipe(
                          Stream.drain,
                        );
                        const retryAfter = options.retryExpectedFailureAfter;
                        // An authorization failure does not heal by retrying.
                        const isAuthorizationFailure = cause.reasons.some(
                          (reason) =>
                            reason._tag === "Fail" && isEnvironmentAuthorizationError(reason.error),
                        );
                        if (retryAfter === undefined || isAuthorizationFailure) {
                          return handled;
                        }
                        // Backed off and capped: a permanent "no" (unknown or
                        // archived thread) otherwise retried every 250ms forever,
                        // re-fetching the snapshot each time.
                        const giveUp: Stream.Stream<
                          A,
                          EnvironmentRpcStreamFailure<TTag>
                        > = Stream.empty;
                        return handled.pipe(
                          Stream.concat(
                            Stream.unwrap(
                              Effect.gen(function* () {
                                if (producedValue) {
                                  producedValue = false;
                                  yield* resetExpectedFailures;
                                }
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
                                yield* Effect.sleep(subscriptionRetryDelay(retryAfter, attempt));
                                return subscribeToSession();
                              }),
                            ),
                          ),
                        );
                      }
                      return Stream.failCause(cause);
                    }),
                  );
                });
              // A new session is fresh evidence the subscription can work, so it
              // re-arms the resubscribe budget the way an emitted value re-arms
              // the failure budget.
              return Stream.fromEffect(resetCompletionResubscribes).pipe(
                Stream.drain,
                Stream.concat(Stream.suspend(subscribeToSession)),
              );
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

export function subscribeDynamic<TTag extends EnvironmentSubscriptionRpcTag>(
  tag: TTag,
  makeInput: (session: RpcSession) => Effect.Effect<EnvironmentRpcInput<TTag>>,
  options?: SubscriptionOptions<TTag>,
): Stream.Stream<
  EnvironmentRpcStreamValue<TTag>,
  EnvironmentRpcStreamFailure<TTag>,
  EnvironmentSupervisor.EnvironmentSupervisor
> {
  return subscribeDynamicMapped(tag, makeInput, (_session, stream) => stream, options);
}

/** Tags each value before `switchMap` can buffer it across a session change. */
export function subscribeDynamicWithSession<TTag extends EnvironmentSubscriptionRpcTag>(
  tag: TTag,
  makeInput: (session: RpcSession) => Effect.Effect<EnvironmentRpcInput<TTag>>,
  options?: SubscriptionOptions<TTag>,
): Stream.Stream<
  readonly [session: RpcSession, value: EnvironmentRpcStreamValue<TTag>],
  EnvironmentRpcStreamFailure<TTag>,
  EnvironmentSupervisor.EnvironmentSupervisor
> {
  return subscribeDynamicMapped(
    tag,
    makeInput,
    (session, stream) => stream.pipe(Stream.map((value) => [session, value] as const)),
    options,
  );
}

export function subscribe<TTag extends EnvironmentSubscriptionRpcTag>(
  tag: TTag,
  input: EnvironmentRpcInput<TTag>,
  options?: SubscriptionOptions<TTag>,
): Stream.Stream<
  EnvironmentRpcStreamValue<TTag>,
  EnvironmentRpcStreamFailure<TTag>,
  EnvironmentSupervisor.EnvironmentSupervisor
> {
  return subscribeDynamic(tag, () => Effect.succeed(input), options);
}

export const request = <TTag extends Exclude<EnvironmentUnaryRpcTag, ClientGuardedRpcTag>>(
  tag: TTag,
  input: EnvironmentRpcInput<TTag>,
) => requestGuarded(tag, input);

export const runStream = <
  TTag extends Exclude<EnvironmentStreamCommandRpcTag, ClientGuardedRpcTag>,
>(
  tag: TTag,
  input: EnvironmentRpcInput<TTag>,
) => runStreamGuarded(tag, input);
