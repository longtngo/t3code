import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type {
  CursorUsageSnapshot,
  EnvironmentId,
  SubagentBackendSetInput,
  SubagentBackendState,
} from "@t3tools/contracts";

import { subagentBackendEnvironment } from "../state/subagentBackend";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import {
  commitSubagentBackendGet,
  commitSubagentBackendSet,
  INITIAL_SUBAGENT_BACKEND_COMMIT,
  INITIAL_SUBAGENT_BACKEND_QUERY_TRACKER,
  observeSubagentBackendQuery,
  type SubagentBackendCommit,
} from "./subagentBackendCommit";

export interface SubagentBackendController {
  /** Last committed state: from a `get` response, or directly from a `set` response. Never
   *  flipped ahead of either — see the module doc for why. */
  readonly state: SubagentBackendState | null;
  /** Cursor's usage snapshot. Only fetched while the panel is open. */
  readonly usage: CursorUsageSnapshot | null;
  /** True from the moment `set` is called until its response lands. */
  readonly pending: boolean;
  readonly set: (input: SubagentBackendSetInput) => void;
}

type CommitAction =
  | { readonly type: "reset" }
  | { readonly type: "set"; readonly value: SubagentBackendState }
  | {
      readonly type: "get";
      readonly issuedGeneration: number;
      readonly value: SubagentBackendState;
    };

function commitReducer(state: SubagentBackendCommit, action: CommitAction): SubagentBackendCommit {
  switch (action.type) {
    case "reset":
      return INITIAL_SUBAGENT_BACKEND_COMMIT;
    case "set":
      return commitSubagentBackendSet(state, action.value);
    case "get":
      return commitSubagentBackendGet(state, action.issuedGeneration, action.value);
  }
}

/**
 * Exposes the generation a `get` query's *current fetch* was issued at (see
 * `observeSubagentBackendQuery`). Driven by `isPending`, not atom identity: `Atom.swr` can
 * re-resolve a query on its own — e.g. after a WebSocket reconnect — with no change to the
 * atom object, so keying the stamp off the object would freeze it at whatever generation was
 * current when the atom first mounted and never update again. The tracker is mutated during
 * render (not in an effect) so a fast-resolving response landing on the very next render still
 * compares against the right value.
 */
function useQueryGeneration(isPending: boolean, generation: number): number {
  const trackerRef = useRef(INITIAL_SUBAGENT_BACKEND_QUERY_TRACKER);
  trackerRef.current = observeSubagentBackendQuery(trackerRef.current, isPending, generation);
  return trackerRef.current.issuedGeneration;
}

/**
 * Drives the sidebar's subagent-backend row and panel.
 *
 * No optimistic flip: `state` only ever updates from a resolved RPC response — either a
 * `get`, or a `set`'s own response. `set`'s response is authoritative on its own (the
 * flag-file write is atomic and completes before the response returns), so committing there
 * does not need, and must not wait for, a follow-up `get`.
 *
 * Both `get` (with `refreshModels: true`) and `set` spawn the same ~3.4s Cursor model probe
 * server-side, so a panel-open `get` and a `set` triggered by flipping the toggle mid-probe
 * are genuinely concurrent — the `get` can resolve *after* the `set` it raced, carrying data
 * from before the flip. Applying it would silently revert the just-confirmed `set`, which is
 * exactly the failure the no-optimistic-flip rule exists to prevent, reached from the other
 * side. `commitReducer` (see `subagentBackendCommit.ts`) guards against it with a generation
 * counter: every successful `set` bumps it, `useQueryGeneration` stamps each `get`'s current
 * fetch with the generation in effect when that fetch actually started, and a resolution whose
 * issued generation trails the last committed `set` is dropped instead of applied — while a
 * later, genuinely fresh resolution (e.g. a reconnect revalidation with no atom identity
 * change) still gets through, because its own rising edge restamps it.
 *
 * `get` runs twice, by design: once on mount with `refreshModels` omitted (cheap — the server
 * defaults it to false so mounting never spawns the Cursor model probe), and again whenever
 * `panelOpen` flips true with `refreshModels: true` (the panel opting into a fresh probe). The
 * two inputs key distinct query atoms, so opening the panel does not race the mount query.
 */
export function useSubagentBackend(
  environmentId: EnvironmentId | null,
  panelOpen: boolean,
): SubagentBackendController {
  const baseAtom =
    environmentId == null ? null : subagentBackendEnvironment.get({ environmentId, input: {} });
  const { data: baseState, isPending: baseIsPending } = useEnvironmentQuery(baseAtom);

  const panelAtom =
    environmentId == null || !panelOpen
      ? null
      : subagentBackendEnvironment.get({ environmentId, input: { refreshModels: true } });
  const { data: panelState, isPending: panelIsPending } = useEnvironmentQuery(panelAtom);

  const usageAtom =
    environmentId == null || !panelOpen
      ? null
      : subagentBackendEnvironment.usage({ environmentId, input: {} });
  const { data: usage } = useEnvironmentQuery(usageAtom);

  const [commit, dispatch] = useReducer(commitReducer, INITIAL_SUBAGENT_BACKEND_COMMIT);

  useEffect(() => {
    dispatch({ type: "reset" });
  }, [environmentId]);

  const baseIssuedGeneration = useQueryGeneration(baseIsPending, commit.generation);
  const panelIssuedGeneration = useQueryGeneration(panelIsPending, commit.generation);

  useEffect(() => {
    if (baseState == null) return;
    dispatch({ type: "get", issuedGeneration: baseIssuedGeneration, value: baseState });
  }, [baseState, baseIssuedGeneration]);

  useEffect(() => {
    if (panelState == null) return;
    dispatch({ type: "get", issuedGeneration: panelIssuedGeneration, value: panelState });
  }, [panelState, panelIssuedGeneration]);

  const [pending, setPending] = useState(false);
  const runSet = useAtomCommand(subagentBackendEnvironment.set, "subagent-backend:set");
  const set = useCallback(
    (input: SubagentBackendSetInput) => {
      if (environmentId == null || pending) return;
      setPending(true);
      void runSet({ environmentId, input })
        .then((result) => {
          if (result._tag === "Success") dispatch({ type: "set", value: result.value });
        })
        .finally(() => setPending(false));
    },
    [environmentId, pending, runSet],
  );

  return { state: commit.state, usage, pending, set };
}
