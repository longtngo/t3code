import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface ProviderTurnStallWatchdogShape {
  /**
   * Start the background turn-stall watchdog within the provided scope.
   *
   * The watchdog detects an active turn whose provider (SDK) has gone silent
   * past a threshold — i.e. the SDK accepted tool/subagent results but never
   * issued the follow-up inference and never closed the turn — and forcefully
   * recovers it (stop session, then resume) so the thread does not hang
   * indefinitely waiting on a wedged subprocess.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class ProviderTurnStallWatchdog extends Context.Service<
  ProviderTurnStallWatchdog,
  ProviderTurnStallWatchdogShape
>()("t3/provider/Services/ProviderTurnStallWatchdog") {}
