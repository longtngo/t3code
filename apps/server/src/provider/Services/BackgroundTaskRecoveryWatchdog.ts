import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface BackgroundTaskRecoveryWatchdogShape {
  /**
   * Start the background-task recovery heartbeat within the provided scope.
   *
   * On startup and on a periodic sweep it reconciles persisted
   * `pending_background_tasks` rows: any row owned by a dead process (boot-id
   * mismatch), a dead session, or silent past the stale threshold is recovered
   * by auto-resuming its idle thread.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class BackgroundTaskRecoveryWatchdog extends Context.Service<
  BackgroundTaskRecoveryWatchdog,
  BackgroundTaskRecoveryWatchdogShape
>()("t3/provider/Services/BackgroundTaskRecoveryWatchdog") {}
