import { firstFreePort, providerPortRange } from "@t3tools/shared/localLlm";

const DEFAULT_BUDGET_FRACTION = 0.8;

/** Inclusive port range a managed provider's configs draw stable ports from. */
export { providerPortRange };

/** First free port in the provider's range not already taken, or null if full. */
export const assignPort = firstFreePort;

/** Effective RAM budget in bytes: explicit value when > 0, else 80% of total memory. */
export function budgetBytes(ramBudgetBytes: number, totalMem: number): number {
  return ramBudgetBytes > 0 ? ramBudgetBytes : Math.floor(totalMem * DEFAULT_BUDGET_FRACTION);
}

/** Does a new model fit: online RSS + in-flight estimates + this model's estimate ≤ budget. */
export function fits(
  estBytes: number,
  onlineRss: number,
  inflight: number,
  budget: number,
): boolean {
  return onlineRss + inflight + estBytes <= budget;
}
