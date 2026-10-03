import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface CreditSpendGuardShape {
  /**
   * Why a turn on this provider instance may not start now, or `null` when it may.
   *
   * Never fails. Unreadable settings, an unknown instance, no reported limits and a
   * failed or slow usage re-read all read as allowed: only an affirmative 100% blocks
   * (`creditSpendBlockedReason`).
   */
  readonly refusalFor: (instanceId: ProviderInstanceId) => Effect.Effect<string | null>;
  /**
   * The same rule on the reading already published: no fresh read and no log. For
   * pollers that ask every few seconds (limit recovery); the turn-start gate stays
   * the authority that re-reads.
   */
  readonly cachedRefusalFor: (instanceId: ProviderInstanceId) => Effect.Effect<string | null>;
  /**
   * `refusalFor`, plus whether its answer rests on a reading it wanted to refresh and
   * could not: a near-limit reading too old to trust whose fresh read failed or timed
   * out. For callers that can wait and ask again (limit recovery) instead of sending a
   * turn the start gate may refuse once the read lands.
   */
  readonly resumeCheck: (instanceId: ProviderInstanceId) => Effect.Effect<CreditSpendCheck>;
}

export interface CreditSpendCheck {
  readonly refusal: string | null;
  readonly inconclusive: boolean;
}

export class CreditSpendGuard extends Context.Service<CreditSpendGuard, CreditSpendGuardShape>()(
  "t3/provider/Services/CreditSpendGuard",
) {}
