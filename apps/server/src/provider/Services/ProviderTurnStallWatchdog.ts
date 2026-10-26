import type { ThreadId, TurnId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface ProviderTurnStallWatchdogShape {
  /**
   * Start the turn-stall watchdog in the provided scope. It recovers (stop, then resume) an
   * active turn whose SDK went silent past a threshold after accepting tool results, so the
   * thread does not hang on a wedged subprocess.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Adopt a user's force-stop so the normal stop->resume recovery runs: `shouldTrip` abstains
   * while a tool is open, so a turn wedged inside a tool never trips on its own. Respects the
   * attempt cap and given-up threads, so it cannot re-arm a loop on a wedged provider.
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
