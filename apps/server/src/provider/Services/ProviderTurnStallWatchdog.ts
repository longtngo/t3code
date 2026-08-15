import type { ThreadId, TurnId } from "@t3tools/contracts";
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

  /**
   * Adopt a stop this watchdog did not issue, so its normal stop->resume
   * recovery runs for it.
   *
   * Called for a user's deliberate force-stop (`recoverAfterStop` on
   * `thread.session.stop`). The human is the sensor the watchdog lacks here:
   * `shouldTrip` abstains whenever the open-tool set is non-empty, so a turn
   * wedged INSIDE a tool never trips automatically — which is exactly when
   * someone presses Stop a second time.
   *
   * Adoption is a hint, not an override: it respects the existing attempt cap
   * and a thread the watchdog has already given up on, so it cannot re-arm a
   * stop/resume loop against a permanently wedged provider.
   */
  readonly adoptExternalStop: (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
  }) => Effect.Effect<void>;
}

export class ProviderTurnStallWatchdog extends Context.Service<
  ProviderTurnStallWatchdog,
  ProviderTurnStallWatchdogShape
>()("t3/provider/Services/ProviderTurnStallWatchdog") {}
