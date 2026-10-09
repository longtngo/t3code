/**
 * creditSpendGuard — whether a provider instance may spend right now.
 *
 * Pure by design, and called live at every gate rather than cached. A cached answer has
 * three ways to go stale in the fail-OPEN direction (a failed settings read, an empty map
 * during an outage, a dead maintainer fiber), and this guard exists precisely to stop
 * money being spent, so the unsafe direction is the one that must be impossible.
 *
 * @module provider/creditSpendGuard
 */
import type { ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import { exhaustedUsageWindows } from "@t3tools/shared/usageLimits";

const SWITCH_LABEL = `"Allow to spend credits"`;

/**
 * Why this instance may not spend, or `null` when it may.
 *
 * Only an affirmative reading of 100% blocks. An instance that reports no limits, one this
 * build cannot find, and an absent instance id all read as allowed: four of six drivers
 * never report usage at all, so treating "cannot tell" as "exhausted" would disable them
 * permanently.
 */
export function creditSpendBlockedReason(input: {
  readonly allowSpendingCredits: boolean;
  readonly providers: readonly ServerProvider[];
  readonly instanceId: ProviderInstanceId | undefined;
  /** Windows whose reset is at or before this instant no longer count. */
  readonly nowMs: number;
}): string | null {
  // First, so that turning the switch back on takes effect immediately and unconditionally.
  if (input.allowSpendingCredits) return null;
  if (input.instanceId === undefined) return null;
  const provider = input.providers.find((entry) => entry.instanceId === input.instanceId);
  if (!provider) return null;
  const windows = exhaustedUsageWindows(provider.usageLimits, input.nowMs);
  if (windows.length === 0) return null;
  const name = provider.displayName ?? provider.driver;
  const labels = windows.map((window) => window.label).join(", ");
  return `${name} has used 100% of ${labels} and ${SWITCH_LABEL} is off. Turn it on in Settings, or wait for the limit to reset.`;
}
