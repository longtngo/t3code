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
 * A `get` commits only if issued at or after the committed generation: `get` and `set` share a
 * multi-second Cursor probe, so a `get` issued before a `set` can resolve after it and would
 * revert it. The issued generation is fixed at subscription start, so it never catches up.
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
 * Tracks the generation a `get` query's current in-flight fetch was issued at, not when its
 * atom was created: the `Atom.swr` query re-resolves (e.g. on reconnect) without a new atom, so
 * an identity-keyed stamp would drop every later re-resolution. `wasPending` tracks fetch starts.
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
 * Call once per render with `isPending` and the current commit generation. A rising edge is a
 * new fetch (first mount or a background `Atom.swr` revalidation) and restamps; anything else
 * carries the stamp forward, so a late resolution reads the generation its fetch started at.
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
