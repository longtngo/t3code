/**
 * CreditSpendGuardLive — the side effects the turn-start gates cannot do themselves:
 * interrupting turns already running on an instance that just became blocked, and
 * rewriting the Cursor subagent flag files when Cursor's own block state flips.
 *
 * Deliberately NOT the source of truth for whether spending is allowed. The gates call
 * `creditSpendBlockedReason` live, so nothing this fiber holds — and nothing that happens
 * if it dies — can admit spend.
 *
 * @module provider/Layers/CreditSpendGuardLive
 */
import {
  CommandId,
  EventId,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  type ProviderInstanceId,
  type ServerProvider,
  ServerSettingsError,
  type TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import type { OrchestrationDispatchError } from "../../orchestration/Errors.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { reconcileAllBackends } from "../../subagentBackend/SubagentBackend.ts";
import { readCursorUsage } from "../../subagentBackend/cursorUsageRead.ts";
import { creditSpendBlockedReason, cursorOffloadBlockedReason } from "../creditSpendGuard.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import type { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import type * as ServerConfig from "../../config.ts";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

type CreditSpendGuardRuntime =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | ProviderAdapterRegistry
  | ServerConfig.ServerConfig
  | ServerSettingsService;

/** Session statuses meaning a process is actively driving this thread, so its turn can spend. */
const LIVE_SESSION_STATUSES = new Set(["idle", "starting", "running", "ready"]);

const DISPATCH_TIMEOUT = Duration.seconds(30);

export interface CreditSpendGuardMemo {
  /** Instances blocked as of the last successful tick; drives the newly-blocked edge. */
  readonly blocked: ReadonlySet<ProviderInstanceId>;
  /** Instances whose interrupt sweep did not complete, retried until it does or they unblock. */
  readonly interruptPending: ReadonlySet<ProviderInstanceId>;
  /** `threadId:turnId` already announced, so a retry tick does not repeat the timeline entry. */
  readonly announced: ReadonlySet<string>;
  /** Cursor's block state as of the last successful tick; drives the reconcile edge. */
  readonly cursorBlocked: boolean;
}

export const emptyCreditSpendGuardMemo: CreditSpendGuardMemo = {
  blocked: new Set(),
  interruptPending: new Set(),
  announced: new Set(),
  cursorBlocked: false,
};

const setDifference = <T>(left: ReadonlySet<T>, right: ReadonlySet<T>): Set<T> => {
  const next = new Set<T>();
  for (const value of left) {
    if (!right.has(value)) {
      next.add(value);
    }
  }
  return next;
};

const setIntersection = <T>(left: ReadonlySet<T>, right: ReadonlySet<T>): Set<T> => {
  const next = new Set<T>();
  for (const value of left) {
    if (right.has(value)) {
      next.add(value);
    }
  }
  return next;
};

const setUnion = <T>(left: ReadonlySet<T>, right: ReadonlySet<T>): Set<T> => {
  const next = new Set(left);
  for (const value of right) {
    next.add(value);
  }
  return next;
};

const computeBlockedInstances = (
  allowSpendingCredits: boolean,
  providers: readonly ServerProvider[],
): Set<ProviderInstanceId> => {
  const blocked = new Set<ProviderInstanceId>();
  for (const entry of providers) {
    const reason = creditSpendBlockedReason({
      allowSpendingCredits,
      providers,
      instanceId: entry.instanceId,
    });
    if (reason !== null) {
      blocked.add(entry.instanceId);
    }
  }
  return blocked;
};

const announcedKey = (threadId: string, turnId: string): string => `${threadId}:${turnId}`;

export interface CreditSpendGuardTickDeps<R = never> {
  readonly getSettings: Effect.Effect<
    { readonly allowSpendingCredits: boolean },
    ServerSettingsError
  >;
  readonly getProviders: Effect.Effect<readonly ServerProvider[]>;
  readonly getShellSnapshot: Effect.Effect<
    { readonly threads: readonly OrchestrationThreadShell[] },
    ProjectionRepositoryError
  >;
  readonly dispatch: (command: {
    readonly type: string;
    readonly threadId: string;
    readonly turnId?: TurnId;
    readonly commandId?: CommandId;
    readonly createdAt?: string;
    readonly activity?: OrchestrationThreadActivity;
  }) => Effect.Effect<void, OrchestrationDispatchError>;
  readonly readCursorUsedPercent: Effect.Effect<number | null, never, R>;
  readonly reconcileAllBackends: Effect.Effect<void, never, R>;
  readonly memo: Ref.Ref<CreditSpendGuardMemo>;
}

export const runCreditSpendGuardTick = <R>(
  deps: CreditSpendGuardTickDeps<R>,
): Effect.Effect<void, never, R> =>
  Effect.gen(function* () {
    const settings = yield* deps.getSettings.pipe(
      Effect.catch((cause) =>
        Effect.logWarning("credit-spend-guard.tick-failed", { stage: "settings", cause }).pipe(
          Effect.as(undefined),
        ),
      ),
    );
    if (settings === undefined) {
      return;
    }

    const providers = yield* deps.getProviders;

    const memo = yield* Ref.get(deps.memo);
    const allowSpendingCredits = settings.allowSpendingCredits;
    const nextBlocked = computeBlockedInstances(allowSpendingCredits, providers);
    const becameBlocked = setDifference(nextBlocked, memo.blocked);
    const interruptPending = setIntersection(memo.interruptPending, nextBlocked);
    const toSweep = setUnion(becameBlocked, interruptPending);

    let nextAnnounced = new Set(memo.announced);
    let nextInterruptPending = new Set<ProviderInstanceId>();

    if (toSweep.size > 0) {
      const snapshot = yield* deps.getShellSnapshot.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("credit-spend-guard.interrupt-skipped", { cause }).pipe(
            Effect.as(undefined),
          ),
        ),
      );
      if (snapshot === undefined) {
        nextInterruptPending = new Set(toSweep);
      } else {
        const cryptoOption = yield* Effect.serviceOption(Crypto.Crypto);
        const nowIso = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
        const commandId = (tag: string, unique: string) =>
          cryptoOption._tag === "Some"
            ? cryptoOption.value.randomUUIDv4.pipe(
                Effect.map((uuid) => CommandId.make(`credit-spend-guard:${tag}:${uuid}`)),
              )
            : Effect.succeed(CommandId.make(`credit-spend-guard:${tag}:${unique}`));

        for (const thread of snapshot.threads) {
          const session = thread.session;
          if (
            !session ||
            session.providerInstanceId === undefined ||
            !toSweep.has(session.providerInstanceId) ||
            !LIVE_SESSION_STATUSES.has(session.status) ||
            session.activeTurnId === null
          ) {
            continue;
          }

          const threadId = String(thread.id);
          const turnId = session.activeTurnId;
          const blockReason = creditSpendBlockedReason({
            allowSpendingCredits,
            providers,
            instanceId: session.providerInstanceId,
          });
          const announceKey = announcedKey(threadId, turnId);

          if (!nextAnnounced.has(announceKey)) {
            const createdAt = nowIso;
            const eventSuffix =
              cryptoOption._tag === "Some" ? yield* cryptoOption.value.randomUUIDv4 : announceKey;
            const id = EventId.make(`credit-spend-guard:${eventSuffix}`);
            const activity: OrchestrationThreadActivity = {
              id,
              createdAt,
              tone: "info",
              kind: "runtime.warning",
              summary: "Credit limit reached — turn interrupted",
              payload: { message: blockReason ?? "Credit limit reached." },
              turnId,
            };
            yield* deps
              .dispatch({
                type: "thread.activity.append",
                commandId: yield* commandId("activity", announceKey),
                threadId,
                activity,
                createdAt,
              })
              .pipe(Effect.timeout(DISPATCH_TIMEOUT), Effect.ignoreCause);
            nextAnnounced.add(announceKey);
          }

          const interruptResult = yield* deps
            .dispatch({
              type: "thread.turn.interrupt",
              commandId: yield* commandId("interrupt", announceKey),
              threadId,
              turnId,
              createdAt: nowIso,
            })
            .pipe(Effect.result);
          if (Result.isFailure(interruptResult) && session.providerInstanceId !== undefined) {
            nextInterruptPending.add(session.providerInstanceId);
          }
        }

        const liveAnnounceKeys = new Set<string>();
        for (const thread of snapshot.threads) {
          const session = thread.session;
          if (session?.activeTurnId !== null && session?.activeTurnId !== undefined) {
            liveAnnounceKeys.add(announcedKey(String(thread.id), session.activeTurnId));
          }
        }
        nextAnnounced = new Set([...nextAnnounced].filter((key) => liveAnnounceKeys.has(key)));
      }
    }

    const cursorUsedPercent = yield* deps.readCursorUsedPercent;
    const nextCursorBlocked =
      cursorOffloadBlockedReason({ allowSpendingCredits, cursorUsedPercent }) !== null;

    if (nextCursorBlocked !== memo.cursorBlocked) {
      yield* deps.reconcileAllBackends.pipe(Effect.ignoreCause);
    }

    yield* Ref.set(deps.memo, {
      blocked: nextBlocked,
      interruptPending: nextInterruptPending,
      announced: nextAnnounced,
      cursorBlocked: nextCursorBlocked,
    });
  }).pipe(Effect.ignoreCause);

export const CreditSpendGuardLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const providerRegistry = yield* ProviderRegistry;
    const serverSettings = yield* ServerSettingsService;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;

    const memo = yield* Ref.make(emptyCreditSpendGuardMemo);

    yield* Stream.merge(providerRegistry.streamChanges, serverSettings.streamChanges).pipe(
      Stream.runForEach(() =>
        runCreditSpendGuardTick<CreditSpendGuardRuntime>({
          getSettings: serverSettings.getSettings.pipe(
            Effect.map((settings) => ({ allowSpendingCredits: settings.allowSpendingCredits })),
          ),
          getProviders: providerRegistry.getProviders,
          getShellSnapshot: projectionSnapshotQuery.getShellSnapshot(),
          dispatch: (command) => orchestrationEngine.dispatch(command as never).pipe(Effect.asVoid),
          readCursorUsedPercent: readCursorUsage().pipe(
            Effect.map((snapshot) => snapshot?.usedPercent ?? null),
          ),
          reconcileAllBackends: reconcileAllBackends().pipe(Effect.ignoreCause),
          memo,
        }).pipe(Effect.ignoreCause({ log: true })),
      ),
      Effect.forkScoped,
    );
  }),
);
