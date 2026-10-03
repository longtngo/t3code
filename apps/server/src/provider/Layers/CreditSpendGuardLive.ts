/**
 * CreditSpendGuardLive - the "Allow to spend credits" switch on orchestrator v2.
 *
 * `layer` answers the turn-start gate (`ProviderTurnStartService`, the one place every
 * provider turn starts, and the client intake in `ThreadMessageIntake`). It reads the
 * switch and the instance's published usage live on every call; nothing is cached, so a
 * dead fiber or a failed read can never leave a stale "allowed" behind.
 *
 * `interruptSweeperLive` stops turns already running on an instance at the moment it
 * becomes blocked, which no turn-start gate can see.
 *
 * @module provider/Layers/CreditSpendGuardLive
 */
import {
  CommandId,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { creditSpendBlockedReason } from "../creditSpendGuard.ts";
import { CreditSpendGuard } from "../Services/CreditSpendGuard.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";

/** A window at or above this share is close enough to 100% that a stale reading matters. */
export const NEAR_LIMIT_PERCENT = 90;
/** Usage read longer ago than this is re-read before a near-limit turn start. */
export const FRESH_READ_MAX_AGE_MS = 60_000;
/**
 * How long a turn start waits for that re-read. Measured on a real Claude account
 * (2026-10-03): a fresh read takes 0.40-0.55 s warm and 1.8 s cold, so 5 s is ~3x the
 * slowest observed read. The clock starts when the read is issued, at turn start.
 */
export const FRESH_READ_TIMEOUT = Duration.seconds(5);

/**
 * Whether a turn start should re-read this instance's usage before deciding.
 *
 * Published usage only moves while a client watches the provider or a turn reports rate
 * limits, so with no client focused it can be hours old when an MCP, scheduled or
 * other-device turn starts. Re-read only when that age could hide a 100%: an old reading
 * already at or near the cap.
 */
export function needsFreshUsageRead(
  limits: ServerProviderUsageLimits | undefined,
  nowMs: number,
): boolean {
  if (limits === undefined || limits.unavailable !== undefined) return false;
  const ageMs = nowMs - Date.parse(limits.checkedAt);
  // An unparseable checkedAt yields NaN and counts as stale.
  if (ageMs <= FRESH_READ_MAX_AGE_MS) return false;
  return limits.windows.some((window) => window.usedPercent >= NEAR_LIMIT_PERCENT);
}

export const makeCreditSpendGuard = (options?: { readonly freshReadTimeout?: Duration.Input }) =>
  Effect.gen(function* () {
    const providerRegistry = yield* ProviderRegistry;
    const serverSettings = yield* ServerSettingsService;
    const freshReadTimeout = options?.freshReadTimeout ?? FRESH_READ_TIMEOUT;

    const refusalFor = Effect.fn("CreditSpendGuard.refusalFor")(function* (
      instanceId: ProviderInstanceId,
    ) {
      const allowSpendingCredits = yield* serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.allowSpendingCredits),
        Effect.catch((cause) =>
          Effect.logWarning("credit-spend-guard.gate-unavailable", {
            stage: "settings",
            cause,
          }).pipe(Effect.as(true)),
        ),
      );
      // First, so turning the switch back on takes effect without touching any provider.
      if (allowSpendingCredits) return null;

      let providers: ReadonlyArray<ServerProvider> = yield* providerRegistry.getProviders;
      const limits = providers.find((entry) => entry.instanceId === instanceId)?.usageLimits;
      if (needsFreshUsageRead(limits, yield* Clock.currentTimeMillis)) {
        // Fail-open by choice: a read that fails or outlasts the timeout keeps the
        // reading we already had, which still blocks if it already says 100%.
        const fresh = yield* providerRegistry.refreshInstance(instanceId, { fresh: true }).pipe(
          Effect.timeoutOption(freshReadTimeout),
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) =>
              Effect.logWarning("credit-spend-guard.fresh-read-failed", {
                instanceId,
                cause: Cause.pretty(cause),
              }).pipe(Effect.as(Option.none<ReadonlyArray<ServerProvider>>())),
          ),
        );
        if (Option.isSome(fresh)) {
          providers = fresh.value;
        } else {
          yield* Effect.logWarning("credit-spend-guard.fresh-read-skipped", { instanceId });
        }
      }

      const reason = creditSpendBlockedReason({
        allowSpendingCredits: false,
        providers,
        instanceId,
      });
      if (reason !== null) {
        yield* Effect.logInfo("credit-spend-guard.turn-refused", { instanceId, reason });
      }
      return reason;
    });

    return CreditSpendGuard.of({ refusalFor });
  });

export const layer = Layer.effect(CreditSpendGuard, makeCreditSpendGuard());

/**
 * Interrupts the runs active on an instance when it becomes blocked, with the reason
 * as the visible interrupt message. Upstream's interrupt already holds the thread's
 * queued runs, so nothing queued behind it is sent into the limit.
 *
 * Edge-triggered: an instance is swept once per blocked spell. A sweep that could not
 * reach every run is retried on the next provider or settings change.
 */
export const runCreditSpendSweep = Effect.fn("CreditSpendGuard.sweep")(function* (input: {
  readonly allowSpendingCredits: boolean;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly swept: Ref.Ref<ReadonlySet<ProviderInstanceId>>;
}) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const blocked = new Map<ProviderInstanceId, string>();
  for (const provider of input.providers) {
    const reason = creditSpendBlockedReason({
      allowSpendingCredits: input.allowSpendingCredits,
      providers: input.providers,
      instanceId: provider.instanceId,
    });
    if (reason !== null) blocked.set(provider.instanceId, reason);
  }
  const alreadySwept = yield* Ref.get(input.swept);
  const toSweep = new Set([...blocked.keys()].filter((id) => !alreadySwept.has(id)));
  const failed = new Set<ProviderInstanceId>();

  if (toSweep.size > 0) {
    const snapshot = yield* threads.getShellSnapshot({ location: "active" }).pipe(Effect.option);
    if (Option.isNone(snapshot)) {
      for (const id of toSweep) failed.add(id);
    } else {
      for (const thread of snapshot.value.threads) {
        if (thread.activeRunId === null) continue;
        const records = yield* threads
          .getThreadRecords(thread.id, ["runs"], { runIds: [thread.activeRunId] })
          .pipe(Effect.option);
        if (Option.isNone(records)) {
          // Cannot tell which instance it runs on; retry every instance in this sweep.
          for (const id of toSweep) failed.add(id);
          continue;
        }
        const run = records.value.runs.find((candidate) => candidate.id === thread.activeRunId);
        if (run === undefined || !ThreadManagement.isActiveRun(run)) continue;
        const reason = toSweep.has(run.providerInstanceId)
          ? blocked.get(run.providerInstanceId)
          : undefined;
        if (reason === undefined) continue;
        yield* threads
          .interruptThread({
            projectId: thread.projectId,
            // One id per run: a retried sweep replays the receipt instead of interrupting twice.
            commandId: CommandId.make(`credit-spend-guard:interrupt:${run.id}`),
            threadId: thread.id,
            runId: run.id,
            reason,
          })
          .pipe(
            Effect.tap(() =>
              Effect.logInfo("credit-spend-guard.turn-interrupted", {
                threadId: thread.id,
                runId: run.id,
                instanceId: run.providerInstanceId,
              }),
            ),
            Effect.catch((cause) =>
              Effect.logWarning("credit-spend-guard.interrupt-failed", {
                threadId: thread.id,
                runId: run.id,
                cause,
              }).pipe(Effect.andThen(Effect.sync(() => failed.add(run.providerInstanceId)))),
            ),
          );
      }
    }
  }

  yield* Ref.set(
    input.swept,
    new Set([...blocked.keys()].filter((id) => !failed.has(id))) as ReadonlySet<ProviderInstanceId>,
  );
});

export const interruptSweeperLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const providerRegistry = yield* ProviderRegistry;
    const serverSettings = yield* ServerSettingsService;
    const threadsContext = yield* Effect.context<ThreadManagement.ThreadManagementService>();
    const swept = yield* Ref.make<ReadonlySet<ProviderInstanceId>>(new Set());

    const tick = Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings.pipe(Effect.option);
      // Unreadable settings: keep the last sweep state and wait for the next change.
      if (Option.isNone(settings)) return;
      yield* runCreditSpendSweep({
        allowSpendingCredits: settings.value.allowSpendingCredits,
        providers: yield* providerRegistry.getProviders,
        swept,
      });
    }).pipe(Effect.provide(threadsContext), Effect.ignoreCause({ log: true }));

    yield* Stream.merge(providerRegistry.streamChanges, serverSettings.streamChanges).pipe(
      Stream.runForEach(() => tick),
      Effect.forkScoped,
    );
  }),
);
