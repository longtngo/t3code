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
}

export class CreditSpendGuard extends Context.Service<CreditSpendGuard, CreditSpendGuardShape>()(
  "t3/provider/Services/CreditSpendGuard",
) {}
