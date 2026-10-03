/**
 * cursorUsageRead — the Cursor account's overall usage window for the Subagents panel,
 * reduced to the wire-shaped `CursorUsageSnapshot`.
 *
 * Read from the provider registry's Cursor snapshot, whose `usageLimits` the Cursor
 * driver fills on every provider probe (`readCursorUsageLimits`). The panel therefore
 * shows the same numbers, at the same freshness, as the Vitals gauge, and opening it
 * makes no request of its own. Nothing to show — no Cursor instance, not signed in,
 * usage unavailable, or no "Overall" window — resolves to `null`, never an error.
 *
 * @module subagentBackend/cursorUsageRead
 */
import type {
  CursorUsageSnapshot,
  ServerProvider,
  ServerProviderUsageLimits,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";

/** The Cursor window that is the plan total, as `cursorUsageResponseToLimits` names it. */
const CURSOR_TOTAL_WINDOW_ID = "totalPercentUsed";

/** The first enabled Cursor instance's usage, narrowed to its overall window. */
export function cursorTotalUsageLimits(
  providers: ReadonlyArray<ServerProvider>,
): ServerProviderUsageLimits | undefined {
  for (const provider of providers) {
    if (provider.driver !== "cursor" || provider.enabled === false) continue;
    const limits = provider.usageLimits;
    const total = limits?.windows.find((window) => window.id === CURSOR_TOTAL_WINDOW_ID);
    if (limits === undefined || total === undefined) continue;
    return { ...limits, windows: [total] };
  }
  return undefined;
}

/**
 * The overall window of the first Cursor instance that publishes one. `startsAt` is the
 * cycle start, recovered from `resetsAt` and the window's length when both are known.
 */
export function cursorUsageFromProviders(
  providers: ReadonlyArray<ServerProvider>,
): CursorUsageSnapshot | null {
  const limits = cursorTotalUsageLimits(providers);
  const total = limits?.windows[0];
  if (limits === undefined || total === undefined) return null;
  const resetsAt = total.resetsAt === undefined ? Option.none() : DateTime.make(total.resetsAt);
  const startsAt =
    total.windowDurationMins !== undefined && Option.isSome(resetsAt)
      ? DateTime.formatIso(DateTime.subtract(resetsAt.value, { minutes: total.windowDurationMins }))
      : null;
  return {
    label: "Cursor",
    usedPercent: total.usedPercent,
    resetsAt: total.resetsAt ?? null,
    fetchedAt: limits.checkedAt,
    ...(startsAt === null ? {} : { startsAt }),
  };
}

/** Reads the Cursor account's overall usage window from the provider registry. */
export const readCursorUsage = Effect.fn("subagentBackend.cursorUsageRead")(function* () {
  const registry = yield* ProviderRegistry;
  const providers = yield* registry.getProviders;
  return cursorUsageFromProviders(providers);
});
