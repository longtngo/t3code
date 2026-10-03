import type { SubagentBackendState } from "@t3tools/contracts";

/**
 * What `useSubagentBackend` treats as the truth: the last committed state, plus the
 * generation that produced it. `generation` only ever advances on a successful `set` — a
 * `get` never bumps it, it can only be let through or dropped by comparing against it.
 */
export interface SubagentBackendCommit {
  readonly state: SubagentBackendState | null;
  readonly generation: number;
}

export const INITIAL_SUBAGENT_BACKEND_COMMIT: SubagentBackendCommit = {
  state: null,
  generation: 0,
};

/**
 * A `set` response is authoritative on its own — the flag-file write is atomic and completes
 * before the response returns — so it always commits, and always advances the generation
 * other resolutions get checked against.
 */
export function commitSubagentBackendSet(
  current: SubagentBackendCommit,
  value: SubagentBackendState,
): SubagentBackendCommit {
  return { state: value, generation: current.generation + 1 };
}

/**
 * A `get` commits only if it was issued at or after the generation currently committed.
 * `get` (with `refreshModels: true`) and `set` both spawn the same multi-second Cursor model
 * probe server-side, so a `get` issued before a `set` can resolve after it — applying that
 * response would silently revert the just-confirmed `set` back to the pre-flip backend. The
 * generation a `get` was issued at is fixed the moment its subscription starts, so it can
 * never retroactively catch up to a `set` that committed later; comparing against it is what
 * drops the stale response instead of applying it.
 */
export function commitSubagentBackendGet(
  current: SubagentBackendCommit,
  issuedGeneration: number,
  value: SubagentBackendState,
): SubagentBackendCommit {
  if (issuedGeneration < current.generation) return current;
  return { state: value, generation: current.generation };
}

/**
 * Tracks, across renders, the generation a `get` query's *current in-flight fetch* was
 * issued at — not the generation its atom object was created at. `subagentBackendEnvironment
 * .get` is `Atom.swr`-wrapped over a connection-state-derived source, so it can re-resolve on
 * its own (e.g. after a WebSocket reconnect) with no change to the atom object itself; a stamp
 * keyed on atom identity captures once at mount and then never updates, so every later
 * legitimate re-resolution reads as "issued before" a `set` that came after it and gets
 * dropped forever. `wasPending` makes the stamp track actual fetch-start events instead.
 */
export interface SubagentBackendQueryTracker {
  readonly wasPending: boolean;
  readonly issuedGeneration: number;
}

export const INITIAL_SUBAGENT_BACKEND_QUERY_TRACKER: SubagentBackendQueryTracker = {
  wasPending: false,
  issuedGeneration: 0,
};

/**
 * Call once per render with the query's current `isPending` flag and the commit generation in
 * effect at that render. A rising edge — not pending, now pending — is a genuinely new fetch
 * starting, whether that's the first mount or a background `Atom.swr` revalidation with no
 * change to the atom object; it (re)stamps the generation this fetch's eventual resolution
 * will be judged against. Anything else carries the existing stamp forward unchanged, so a
 * resolution that lands after the fetch already finished (isPending back to false) still
 * reads the generation captured when that fetch actually started.
 */
export function observeSubagentBackendQuery(
  tracker: SubagentBackendQueryTracker,
  isPending: boolean,
  generation: number,
): SubagentBackendQueryTracker {
  if (isPending && !tracker.wasPending) {
    return { wasPending: true, issuedGeneration: generation };
  }
  return { wasPending: isPending, issuedGeneration: tracker.issuedGeneration };
}
