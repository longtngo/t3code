import {
  ORCHESTRATION_WS_METHODS,
  type OrchestrationCheckpointSummary,
  type OrchestrationHistoryCursor,
  type OrchestrationMessage,
  type OrchestrationProposedPlan,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type OrchestrationThreadHistoryPageResult,
  type ThreadId as ThreadIdType,
} from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as O from "effect/Order";

import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { request } from "../rpc/client.ts";

/**
 * Client-side backfill of older thread history (ITEM 2 companion).
 *
 * The live `subscribeThread` snapshot (and the HTTP snapshot) is now WINDOWED to
 * the most recent turns so a huge thread can never materialize as one giant frame
 * (the server OOM). Older turns are therefore not in the initial snapshot; they are
 * paged back on demand via the `getThreadHistoryPage` RPC. Without this backfill a
 * long thread's older turns would be unreachable in the UI — this module makes them
 * reachable again ("no turns permanently lost").
 *
 * Two pieces:
 *  - {@link loadOlderThreadHistory} — the RPC call (the "load older history" action).
 *  - {@link prependThreadHistoryPage} — a pure merge that folds a fetched older page
 *    into a thread's collections (dedup + stable sort), so a consumer can render the
 *    combined history. Kept pure so it is unit-testable and free of the reactive store.
 */

// Combined-history ordering. The windowed snapshot holds the newest turns; a page
// holds older ones. Merging both and sorting ascending (oldest first) reconstructs
// the natural transcript order, deduped by identity so an overlapping row appears once.
const messageOrder = O.combine<OrchestrationMessage>(
  O.mapInput(O.String, (m) => m.createdAt),
  O.mapInput(O.String, (m) => m.id),
);

const activityOrder = O.combineAll<OrchestrationThreadActivity>([
  O.mapInput(O.Number, (a) => a.sequence ?? Number.MAX_SAFE_INTEGER),
  O.mapInput(O.String, (a) => a.createdAt),
  O.mapInput(O.String, (a) => a.id),
]);

const proposedPlanOrder = O.combine<OrchestrationProposedPlan>(
  O.mapInput(O.String, (p) => p.createdAt),
  O.mapInput(O.String, (p) => p.id),
);

const checkpointOrder = O.mapInput(
  O.Number,
  (cp: OrchestrationCheckpointSummary) => cp.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER,
);

function mergeById<A>(
  existing: ReadonlyArray<A>,
  older: ReadonlyArray<A>,
  keyOf: (item: A) => string | number,
  order: O.Order<A>,
): ReadonlyArray<A> {
  const byKey = new Map<string | number, A>();
  // Existing (newer, live) rows win on a key collision — they may carry live edits
  // the historical page does not; the page only supplies rows the window omitted.
  for (const item of older) byKey.set(keyOf(item), item);
  for (const item of existing) byKey.set(keyOf(item), item);
  return Arr.sort(Array.from(byKey.values()), order);
}

/**
 * Fold an older history page into a thread, returning a new thread whose four
 * per-turn collections include the page's older rows (deduped, stably ordered). The
 * thread head (title, session, latestTurn, …) is untouched — a history page carries
 * no head. Pure; safe to call on every fetched page.
 */
export function prependThreadHistoryPage(
  thread: OrchestrationThread,
  page: OrchestrationThreadHistoryPageResult,
): OrchestrationThread {
  return {
    ...thread,
    messages: mergeById(thread.messages, page.messages, (m) => m.id, messageOrder),
    activities: mergeById(thread.activities, page.activities, (a) => a.id, activityOrder),
    proposedPlans: mergeById(
      thread.proposedPlans,
      page.proposedPlans,
      (p) => p.id,
      proposedPlanOrder,
    ),
    checkpoints: mergeById(
      thread.checkpoints,
      page.checkpoints,
      (cp) => cp.turnId,
      checkpointOrder,
    ),
  };
}

export interface LoadOlderThreadHistoryInput {
  readonly threadId: ThreadIdType;
  /** Page strictly older than this cursor (the current snapshot's `oldestLoaded`). */
  readonly beforeTurn: OrchestrationHistoryCursor;
  /** Client-requested page size; the server clamps both DOWN to a safe ceiling. */
  readonly maxTurns: number;
  readonly maxRows: number;
}

/**
 * Fetch the next OLDER page of a thread's history via the `getThreadHistoryPage`
 * RPC. One-shot query (not a subscription). Requires an {@link EnvironmentSupervisor}
 * in context (the RPC is scoped to a connected environment), exactly like the other
 * unary environment RPCs. The returned page carries its own `oldestLoaded`/
 * `hasMoreHistory`, so a caller advances its cursor and knows when paging is done.
 */
export const loadOlderThreadHistory = Effect.fn("EnvironmentThreadHistory.loadOlder")(function* (
  input: LoadOlderThreadHistoryInput,
) {
  const supervisor = yield* EnvironmentSupervisor;
  return yield* request(ORCHESTRATION_WS_METHODS.getThreadHistoryPage, {
    threadId: input.threadId,
    beforeTurn: input.beforeTurn,
    maxTurns: input.maxTurns,
    maxRows: input.maxRows,
  }).pipe(Effect.provideService(EnvironmentSupervisor, supervisor));
});
