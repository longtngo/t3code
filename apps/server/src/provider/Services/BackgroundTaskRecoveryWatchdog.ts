import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface BackgroundTaskRecoveryWatchdogShape {
  /**
   * Start the background-task recovery heartbeat in the provided scope. At startup and per
   * sweep, rows owned by a dead process, a dead session, or silent past the stale threshold
   * are recovered by auto-resuming their idle thread.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class BackgroundTaskRecoveryWatchdog extends Context.Service<
  BackgroundTaskRecoveryWatchdog,
  BackgroundTaskRecoveryWatchdogShape
>()("t3/provider/Services/BackgroundTaskRecoveryWatchdog") {}
