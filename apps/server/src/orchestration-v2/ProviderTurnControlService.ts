import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import {
  MessageId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";

const yieldToRuntime = Effect.yieldNow.pipe(
  Effect.andThen(
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          setImmediate(resolve);
        }),
    ),
  ),
);

export class ProviderTurnControlError extends Schema.TaggedError<ProviderTurnControlError>()(
  "ProviderTurnControlError",
  {
    threadId: ThreadId,
    operation: Schema.Literals(["interrupt", "restart", "steer"]),
    providerTurnId: ProviderTurnId,
    turnCompleted: Schema.optional(Schema.Boolean),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const isProviderTurnControlError = Schema.is(ProviderTurnControlError);

/**
 * FORK Stop ladder: how long the cooperative rung gets to END the turn before
 * it escalates to the hard stop. Sized on the fork's live V1 event log
 * (2026-10-02, 572 Claude cooperative interrupts, request to session leaving
 * `running`): 363 settled within 0.5 s, 491 within 5 s, 493 within 8 s and only
 * 4 more by 15 s. The 79 that missed 8 s were wedges, not slow stops: users
 * force-stopped 72 of them by hand, a median 2.7 s after the first press.
 * Same value as the fork's `INTERRUPT_REQUEST_GRACE`.
 */
export const COOPERATIVE_INTERRUPT_GRACE = Duration.seconds(8);
const COOPERATIVE_SETTLE_POLL = Duration.millis(100);

/**
 * The adapter's answer when the turn it was asked to interrupt is no longer
 * its active turn (Codex, Cursor, OpenCode, Pi; Claude returns success).
 */
const isTurnNotActiveFailure = (errorText: string) =>
  /is not active|is not the active turn/i.test(errorText);

/** Which rung an interrupt ended on. Only a hard stop ends background work. */
export type ProviderTurnInterruptOutcome = "cooperative" | "hard";

export interface ProviderTurnControlServiceV2Shape {
  readonly interrupt: (input: {
    readonly threadId: ThreadId;
    readonly providerSessionId: ProviderSessionId;
    readonly providerThreadId: ProviderThreadId;
    readonly providerTurnId: ProviderTurnId;
    /** FORK: try the cooperative rung first; see `COOPERATIVE_INTERRUPT_GRACE`. */
    readonly cooperative?: boolean;
  }) => Effect.Effect<ProviderTurnInterruptOutcome, ProviderTurnControlError>;
  readonly steer: (input: {
    readonly threadId: ThreadId;
    readonly providerSessionId: ProviderSessionId;
    readonly providerThreadId: ProviderThreadId;
    readonly providerTurnId: ProviderTurnId;
    readonly messageId: MessageId;
  }) => Effect.Effect<void, ProviderTurnControlError>;
  readonly interruptAndAwaitTerminal: (input: {
    readonly threadId: ThreadId;
    readonly providerSessionId: ProviderSessionId;
    readonly replacementProviderSessionId?: ProviderSessionId;
    readonly providerThreadId: ProviderThreadId;
    readonly providerTurnId: ProviderTurnId;
    readonly interruptedAttemptId: RunAttemptId;
  }) => Effect.Effect<void, ProviderTurnControlError>;
}

export class ProviderTurnControlServiceV2 extends Context.Service<
  ProviderTurnControlServiceV2,
  ProviderTurnControlServiceV2Shape
>()("t3/orchestration-v2/ProviderTurnControlService/ProviderTurnControlServiceV2") {}

export const layer: Layer.Layer<
  ProviderTurnControlServiceV2,
  never,
  ProjectionStore.ProjectionStoreV2 | ProviderSessionManager.ProviderSessionManagerV2
> = Layer.effect(
  ProviderTurnControlServiceV2,
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;

    const load = (input: {
      readonly threadId: ThreadId;
      readonly providerSessionId: ProviderSessionId;
      readonly replacementProviderSessionId?: ProviderSessionId;
      readonly providerThreadId: ProviderThreadId;
      readonly providerTurnId: ProviderTurnId;
      readonly operation: "interrupt" | "restart" | "steer";
      readonly messageId?: MessageId;
    }) =>
      Effect.gen(function* () {
        const context = yield* projections.getProviderControlContext(input.threadId, input);
        const { providerThread, providerTurn } = context;
        const targetsRecordedSession =
          providerThread?.providerSessionId === input.providerSessionId;
        const targetsCommittedReplacement =
          input.operation === "restart" &&
          input.replacementProviderSessionId !== undefined &&
          providerThread?.providerSessionId === input.replacementProviderSessionId;
        if (
          providerThread === undefined ||
          providerTurn === undefined ||
          (!targetsRecordedSession && !targetsCommittedReplacement) ||
          providerTurn.providerThreadId !== providerThread.id
        ) {
          return yield* new ProviderTurnControlError({
            threadId: input.threadId,
            operation: input.operation,
            providerTurnId: input.providerTurnId,
            cause: "The recorded provider execution target is no longer valid.",
          });
        }
        // A restart-session command commits the replacement binding before its
        // process-bound effect runs. The old live runtime must still receive
        // the interrupt, but only when the projection matches the exact
        // replacement captured by that same durable effect.
        const interruptProviderThread = targetsRecordedSession
          ? providerThread
          : { ...providerThread, providerSessionId: input.providerSessionId };
        if (providerTurn.status !== "running") {
          if (input.operation === "steer") {
            return yield* new ProviderTurnControlError({
              threadId: input.threadId,
              operation: "steer",
              providerTurnId: input.providerTurnId,
              turnCompleted: providerTurn.status === "completed",
              cause: "The provider turn ended before the steering message was delivered.",
            });
          }
          return {
            context,
            providerThread: interruptProviderThread,
            providerTurn,
            session: Option.none(),
          };
        }
        const session = yield* sessions.get(input.providerSessionId);
        if (Option.isNone(session)) {
          // Interrupt/restart against a already-released session must not fail
          // the durable effect (and retry 5x). The turn may still look running
          // in projection until recovery/finalization; there is no live adapter
          // to interrupt.
          if (input.operation === "interrupt" || input.operation === "restart") {
            yield* Effect.logWarning(
              "Provider interrupt/restart found no live session; treating as already stopped",
              {
                threadId: input.threadId,
                operation: input.operation,
                providerSessionId: input.providerSessionId,
                providerTurnId: input.providerTurnId,
                providerTurnStatus: providerTurn.status,
              },
            );
            return {
              context,
              providerThread: interruptProviderThread,
              providerTurn,
              session: Option.none(),
            };
          }
          return yield* new ProviderTurnControlError({
            threadId: input.threadId,
            operation: input.operation,
            providerTurnId: input.providerTurnId,
            cause: `Provider session ${input.providerSessionId} is not active.`,
          });
        }
        return { context, providerThread: interruptProviderThread, providerTurn, session };
      });

    // Terminal provider events project on a detached ingestion fiber, so the
    // cooperative rung reads the projection until the turn leaves `running`.
    // Always bounded by the caller's `COOPERATIVE_INTERRUPT_GRACE`.
    const awaitProviderTurnSettled = (input: {
      readonly threadId: ThreadId;
      readonly providerThreadId: ProviderThreadId;
      readonly providerTurnId: ProviderTurnId;
    }) =>
      Effect.gen(function* () {
        while (true) {
          const { providerTurn } = yield* projections.getProviderControlContext(
            input.threadId,
            input,
          );
          if (providerTurn?.status !== "running") return;
          yield* Effect.sleep(COOPERATIVE_SETTLE_POLL);
        }
      });

    return ProviderTurnControlServiceV2.of({
      interrupt: (input) =>
        Effect.gen(function* () {
          const loaded = yield* load({ ...input, operation: "interrupt" });
          const session = Option.isSome(loaded.session)
            ? loaded.session
            : yield* sessions.get(input.providerSessionId);
          if (Option.isNone(session)) return "hard" as const;
          if (input.cooperative === true) {
            // The turn ended before the effect ran: nothing is left to end,
            // and the session and its background work stay as they are.
            if (loaded.providerTurn.status !== "running") return "cooperative" as const;
            const settled = yield* session.value
              .interruptTurn({
                providerThread: loaded.providerThread,
                providerTurnId: loaded.providerTurn.id,
                cooperative: true,
              })
              .pipe(
                Effect.andThen(awaitProviderTurnSettled(input)),
                Effect.timeoutOption(COOPERATIVE_INTERRUPT_GRACE),
                Effect.exit,
              );
            if (Exit.isSuccess(settled) && Option.isSome(settled.value)) {
              return "cooperative" as const;
            }
            // Classified positively: the turn ended on its own between the
            // orchestrator's check and this call, so the provider no longer
            // has it. That Stop is done. Escalating would restart the runtime
            // and kill background work nobody asked to stop.
            const { providerTurn: current } = yield* projections.getProviderControlContext(
              input.threadId,
              input,
            );
            if (
              current?.status !== "running" ||
              (Exit.isFailure(settled) && isTurnNotActiveFailure(Cause.pretty(settled.cause)))
            ) {
              return "cooperative" as const;
            }
            yield* Effect.logWarning(
              "Cooperative interrupt did not end the provider turn; escalating to a hard stop",
              {
                threadId: input.threadId,
                providerSessionId: input.providerSessionId,
                providerTurnId: input.providerTurnId,
                reason: Exit.isFailure(settled) ? Cause.pretty(settled.cause) : "timeout",
              },
            );
          }
          // A settled turn reaches its adapter too: only the adapter knows
          // whether it still runs work for the thread, and each one either
          // stops it or reports there is nothing left to stop. Background work
          // the projection still shows is settled by the orchestrator after.
          yield* session.value.interruptTurn({
            providerThread: loaded.providerThread,
            providerTurnId: loaded.providerTurn.id,
            requestRuntimeRestart: true,
          });
          return "hard" as const;
        }).pipe(
          Effect.mapError((cause) =>
            isProviderTurnControlError(cause)
              ? cause
              : new ProviderTurnControlError({
                  threadId: input.threadId,
                  operation: "interrupt",
                  providerTurnId: input.providerTurnId,
                  cause,
                }),
          ),
        ),
      interruptAndAwaitTerminal: (input) =>
        Effect.gen(function* () {
          const loaded = yield* load({ ...input, operation: "restart" });
          if (Option.isNone(loaded.session)) {
            // No live adapter: nothing can emit a terminal provider-turn update
            // from interrupt. Do not poll for projection terminalization or the
            // restart effect stalls; let detach/start proceed.
            if (loaded.providerTurn.status === "running") {
              yield* Effect.logWarning(
                "Provider restart interrupt skipped; no live session for a still-projected running turn",
                {
                  threadId: input.threadId,
                  providerSessionId: input.providerSessionId,
                  providerTurnId: input.providerTurnId,
                },
              );
            }
            return;
          }

          yield* loaded.session.value.interruptTurn({
            providerThread: loaded.providerThread,
            providerTurnId: loaded.providerTurn.id,
          });

          for (let remaining = 1_000; remaining > 0; remaining -= 1) {
            const { providerTurn, attempt } = yield* projections.getProviderControlContext(
              input.threadId,
              {
                providerThreadId: input.providerThreadId,
                providerTurnId: input.providerTurnId,
                attemptId: input.interruptedAttemptId,
              },
            );
            if (
              providerTurn !== undefined &&
              providerTurn.status !== "running" &&
              attempt !== undefined &&
              attempt.status !== "running"
            ) {
              return;
            }
            // Provider terminal events are projected on a detached ingestion
            // fiber. Yield through the Node event loop instead of sleeping on
            // Effect's clock so deterministic runtimes cannot deadlock a
            // command that is waiting for that projection.
            yield* yieldToRuntime;
          }
          return yield* new ProviderTurnControlError({
            threadId: input.threadId,
            operation: "restart",
            providerTurnId: input.providerTurnId,
            cause: `Provider turn ${input.providerTurnId} did not terminalize before restart.`,
          });
        }).pipe(
          Effect.mapError((cause) =>
            isProviderTurnControlError(cause)
              ? cause
              : new ProviderTurnControlError({
                  threadId: input.threadId,
                  operation: "restart",
                  providerTurnId: input.providerTurnId,
                  cause,
                }),
          ),
        ),
      steer: (input) =>
        Effect.gen(function* () {
          const context = yield* projections.getProviderControlContext(input.threadId, input);
          const ownership = context.message?.delegatedCompletion;
          if (ownership !== undefined) {
            const projection = yield* projections.getThreadRecords(input.threadId, ["runs"], {
              runIds: [ownership.parentRunId],
            });
            const cohort = projection.runs.find(
              (run) => run.id === ownership.parentRunId,
            )?.delegatedCompletion;
            if (
              cohort?.disposition !== "open" ||
              cohort.delivery?.messageId !== input.messageId ||
              cohort.delivery.generation !== ownership.generation ||
              cohort.delivery.taskIds.length === 0
            )
              return;
          }
          const loaded = yield* load({ ...input, operation: "steer" });
          if (Option.isNone(loaded.session)) return;
          const { message, run } = loaded.context;
          if (message === undefined || run === undefined) {
            return yield* new ProviderTurnControlError({
              threadId: input.threadId,
              operation: "steer",
              providerTurnId: input.providerTurnId,
              cause: "The persisted steering message or target run is missing.",
            });
          }
          yield* loaded.session.value
            .steerTurn({
              threadId: input.threadId,
              runId: run.id,
              providerThread: loaded.providerThread,
              providerTurnId: loaded.providerTurn.id,
              message: {
                messageId: message.id,
                text: projectComposerContextForProvider({
                  text: message.text,
                  records: message.context?.records ?? [],
                }),
                attachments: message.attachments,
                createdBy: message.createdBy,
                creationSource: message.creationSource,
                ...(message.scheduledTaskId === undefined
                  ? {}
                  : { scheduledTaskId: message.scheduledTaskId }),
                ...(message.senderThreadId === undefined
                  ? {}
                  : { senderThreadId: message.senderThreadId }),
              },
            })
            .pipe(
              Effect.catch((cause) =>
                Effect.gen(function* () {
                  const current = yield* projections.getProviderControlContext(
                    input.threadId,
                    input,
                  );
                  return yield* new ProviderTurnControlError({
                    threadId: input.threadId,
                    operation: "steer",
                    providerTurnId: input.providerTurnId,
                    turnCompleted: current.providerTurn?.status === "completed",
                    cause,
                  });
                }),
              ),
            );
        }).pipe(
          Effect.mapError((cause) =>
            isProviderTurnControlError(cause)
              ? cause
              : new ProviderTurnControlError({
                  threadId: input.threadId,
                  operation: "steer",
                  providerTurnId: input.providerTurnId,
                  cause,
                }),
          ),
        ),
    });
  }),
);
