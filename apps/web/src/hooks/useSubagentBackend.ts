import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import {
  SUBAGENT_BACKEND_CURSOR,
  type CursorUsageSnapshot,
  type EnvironmentId,
  type SubagentBackendSetInput,
  type SubagentBackendState,
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
  /** Cursor's usage snapshot. Fetched while the Cursor backend is selected. */
  readonly usage: CursorUsageSnapshot | null;
  /** True from the moment `set` is called until its response lands. */
  readonly pending: boolean;
  /** Why the last `set` changed nothing, until the next `set`, an applied `get`, or an
   *  environment change. Kept out of `state`, so the stored backend never reads as degraded. */
  readonly refusal: string | null;
  /** Whether this connection may `set` (it needs `orchestration:operate`). */
  readonly canSet: boolean;
  readonly set: (input: SubagentBackendSetInput) => void;
}

type CommitAction =
  | { readonly type: "reset" }
  | { readonly type: "setStart" }
  | {
      readonly type: "set";
      readonly value: SubagentBackendState;
      readonly refused: string | null;
    }
  | {
      readonly type: "get";
      readonly issuedGeneration: number;
      readonly value: SubagentBackendState;
    };

/** The committed state plus the last `set`'s refusal, which lasts until anything newer: the
 *  next `set` starting, an applied `get`, or an environment change. */
interface HookState {
  readonly commit: SubagentBackendCommit;
  readonly refusal: string | null;
}

const INITIAL_HOOK_STATE: HookState = {
  commit: INITIAL_SUBAGENT_BACKEND_COMMIT,
  refusal: null,
};

function commitReducer(state: HookState, action: CommitAction): HookState {
  switch (action.type) {
    case "reset":
      // The generation only rises, so a get stamped before the switch can never pass a set
      // made after it.
      return {
        ...INITIAL_HOOK_STATE,
        commit: { ...INITIAL_SUBAGENT_BACKEND_COMMIT, generation: state.commit.generation },
      };
    case "setStart":
      return state.refusal === null ? state : { ...state, refusal: null };
    case "set":
      return {
        ...state,
        commit: commitSubagentBackendSet(state.commit, action.value),
        refusal: action.refused,
      };
    case "get": {
      const commit = commitSubagentBackendGet(state.commit, action.issuedGeneration, action.value);
      // A dropped (stale) get leaves both alone; an applied one is newer than the refusal.
      return commit === state.commit ? state : { ...state, commit, refusal: null };
    }
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
 *
 * A switch to another environment restamps to the current generation, which the reset keeps:
 * the new environment's answer, cached or in flight, is not older than anything done there,
 * while a set made there afterwards still outranks it.
 */
function useQueryGeneration(
  environmentId: EnvironmentId | null,
  isPending: boolean,
  generation: number,
): number {
  const trackerRef = useRef({ environmentId, tracker: INITIAL_SUBAGENT_BACKEND_QUERY_TRACKER });
  const tracker =
    trackerRef.current.environmentId === environmentId
      ? observeSubagentBackendQuery(trackerRef.current.tracker, isPending, generation)
      : { wasPending: isPending, issuedGeneration: generation };
  trackerRef.current = { environmentId, tracker };
  return tracker.issuedGeneration;
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

  const [{ commit, refusal }, dispatch] = useReducer(commitReducer, INITIAL_HOOK_STATE);

  // Read while the Cursor backend is selected, panel open or not: the footer badge shows it.
  const usageAtom =
    environmentId == null || commit.state?.backend !== SUBAGENT_BACKEND_CURSOR
      ? null
      : subagentBackendEnvironment.usage({ environmentId, input: {} });
  const { data: usage } = useEnvironmentQuery(usageAtom);

  const baseIssuedGeneration = useQueryGeneration(environmentId, baseIsPending, commit.generation);
  const panelIssuedGeneration = useQueryGeneration(
    environmentId,
    panelIsPending,
    commit.generation,
  );

  // Each answer is applied once, when it arrives. A revalidation keeps the previous answer while
  // it is pending and restamps the generation; re-applying that answer under the new stamp would
  // revert a `set` committed since.
  const lastBaseState = useRef<SubagentBackendState | null>(null);
  const lastPanelState = useRef<SubagentBackendState | null>(null);

  // Before the get effects, so an environment's cached answer applies again after a switch back.
  useEffect(() => {
    lastBaseState.current = null;
    lastPanelState.current = null;
    dispatch({ type: "reset" });
  }, [environmentId]);

  useEffect(() => {
    if (baseState == null || baseState === lastBaseState.current) return;
    lastBaseState.current = baseState;
    dispatch({ type: "get", issuedGeneration: baseIssuedGeneration, value: baseState });
  }, [baseState, baseIssuedGeneration]);

  useEffect(() => {
    if (panelState == null || panelState === lastPanelState.current) return;
    lastPanelState.current = panelState;
    dispatch({ type: "get", issuedGeneration: panelIssuedGeneration, value: panelState });
  }, [panelState, panelIssuedGeneration]);

  // A `set` answer for an environment no longer shown is dropped. Written in a layout effect, so
  // it names the new environment as the switch commits, before the reset effect runs: an old
  // answer landing in that gap would otherwise bump the generation, which the reset carries over,
  // dropping the new environment's cached answer. Not during render: a render React throws away
  // would leave it naming an environment that never reached the screen.
  const renderedEnvironmentRef = useRef(environmentId);
  useLayoutEffect(() => {
    renderedEnvironmentRef.current = environmentId;
  }, [environmentId]);

  const [pending, setPending] = useState(false);
  const runSet = useAtomCommand(subagentBackendEnvironment.set, "subagent-backend:set");
  const canSet = useAtomValue(subagentBackendEnvironment.set.permissionAtom(environmentId));
  const set = useCallback(
    (input: SubagentBackendSetInput) => {
      if (environmentId == null || pending) return;
      setPending(true);
      dispatch({ type: "setStart" });
      void runSet({ environmentId, input })
        .then((result) => {
          if (result._tag !== "Success" || renderedEnvironmentRef.current !== environmentId) return;
          const { refused, ...value } = result.value;
          dispatch({ type: "set", value, refused: refused ?? null });
        })
        .finally(() => setPending(false));
    },
    [environmentId, pending, runSet],
  );

  return { state: commit.state, usage, pending, refusal, canSet, set };
}
