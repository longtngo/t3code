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
 * The generation a `get` query's current fetch was issued at. Driven by `isPending`, not atom
 * identity, because `Atom.swr` re-resolves (e.g. on reconnect) without a new atom; mutated
 * during render so a fast response compares against the right value. An environment switch
 * restamps to the current generation, which a later set there still outranks.
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
 * Drives the sidebar's subagent-backend row and panel. No optimistic flip: `state` updates only
 * from a resolved `get` or a `set`'s own (authoritative) response. A `get` racing a `set` can
 * resolve after it with pre-flip data, so `commitReducer` drops a `get` stamped before the last
 * committed set. `get` runs on mount without `refreshModels`, and again on panel open with it.
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resets the backend reducer and seen answers when the environment changes
  useEffect(() => {
    lastBaseState.current = null;
    lastPanelState.current = null;
    dispatch({ type: "reset" });
  }, [environmentId]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- feeds each new base query answer into the generation-tracking reducer
  useEffect(() => {
    if (baseState == null || baseState === lastBaseState.current) return;
    lastBaseState.current = baseState;
    dispatch({ type: "get", issuedGeneration: baseIssuedGeneration, value: baseState });
  }, [baseState, baseIssuedGeneration]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- feeds each new panel query answer into the generation-tracking reducer
  useEffect(() => {
    if (panelState == null || panelState === lastPanelState.current) return;
    lastPanelState.current = panelState;
    dispatch({ type: "get", issuedGeneration: panelIssuedGeneration, value: panelState });
  }, [panelState, panelIssuedGeneration]);

  // A `set` answer for an environment no longer shown is dropped. Tracked in a layout effect so
  // it names the new environment before the reset effect runs (an old answer in that gap would
  // bump the generation and drop the new environment's cached answer), and not during render,
  // where a discarded render could name an environment that never reached the screen.
  const renderedEnvironmentRef = useRef(environmentId);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- records the committed environment so stale set answers are dropped
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
