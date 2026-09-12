import { WS_METHODS, type ThreadId, type TurnId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { request } from "../rpc/client.ts";
import { createEnvironmentQueryAtomFamily } from "./runtime.ts";

/** Matches the thread snapshot HTTP read: there is no generic per-call WS RPC timeout. */
const THREAD_PLAN_HISTORY_TIMEOUT = "6 seconds";

/**
 * Query-atom family for the Task list panel's history read, a one-shot RPC on the
 * `resourceQueue.get` precedent.
 *
 * Keyed on `(threadId, latestTurnId)` although the payload carries only `threadId`: a turn
 * transition changes the key and refetches, so a just-finished list reappears as history, and
 * a revert (which rewrites the thread's turns) invalidates the read the same way.
 */
export function createThreadPlanHistoryEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    list: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:thread-plan-history:list",
      execute: (input: { readonly threadId: ThreadId; readonly latestTurnId: TurnId | null }) =>
        request(WS_METHODS.threadPlanHistoryList, { threadId: input.threadId }).pipe(
          Effect.timeout(THREAD_PLAN_HISTORY_TIMEOUT),
        ),
    }),
  };
}
