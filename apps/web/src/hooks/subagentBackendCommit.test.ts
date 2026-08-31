import { describe, expect, it } from "vite-plus/test";
import {
  SUBAGENT_BACKEND_CURSOR,
  SUBAGENT_BACKEND_DEFAULT,
  type SubagentBackendState,
} from "@t3tools/contracts";

import {
  commitSubagentBackendGet,
  commitSubagentBackendSet,
  INITIAL_SUBAGENT_BACKEND_COMMIT,
  INITIAL_SUBAGENT_BACKEND_QUERY_TRACKER,
  observeSubagentBackendQuery,
} from "./subagentBackendCommit";

function state(backend: string): SubagentBackendState {
  return {
    backend,
    instanceId: null,
    model: null,
    instances: [],
    models: [],
    degraded: null,
  };
}

describe("commitSubagentBackendSet", () => {
  it("commits the response and advances the generation", () => {
    const next = commitSubagentBackendSet(
      INITIAL_SUBAGENT_BACKEND_COMMIT,
      state(SUBAGENT_BACKEND_CURSOR),
    );
    expect(next).toEqual({ state: state(SUBAGENT_BACKEND_CURSOR), generation: 1 });
  });
});

describe("commitSubagentBackendGet", () => {
  it("commits a get issued at the current generation", () => {
    const next = commitSubagentBackendGet(
      INITIAL_SUBAGENT_BACKEND_COMMIT,
      0,
      state(SUBAGENT_BACKEND_DEFAULT),
    );
    expect(next).toEqual({ state: state(SUBAGENT_BACKEND_DEFAULT), generation: 0 });
  });

  // Reproduces the real race: the panel-open `get` (refreshModels: true) and `set` both spawn
  // the same multi-second Cursor model probe server-side, so a `get` issued BEFORE a `set` can
  // resolve AFTER it. Applying that response would silently revert the just-confirmed `set`
  // back to the pre-flip backend — the exact "UI shows one backend, the file says the other"
  // failure the no-optimistic-flip rule exists to prevent, reached from the other side.
  it("drops a get issued before a set that has since committed", () => {
    // t0: the panel-open get fires while backend is still "default"; its generation is
    // captured as 0.
    const issuedGeneration = 0;
    // t1: the user flips to Cursor. The set resolves first (it's a plain flag write; the get
    // is still waiting on the slower model probe) and commits, advancing the generation.
    const afterSet = commitSubagentBackendSet(
      INITIAL_SUBAGENT_BACKEND_COMMIT,
      state(SUBAGENT_BACKEND_CURSOR),
    );
    expect(afterSet.generation).toBe(1);

    // t2: the stale get finally resolves, carrying the pre-flip "default" backend.
    const afterStaleGet = commitSubagentBackendGet(
      afterSet,
      issuedGeneration,
      state(SUBAGENT_BACKEND_DEFAULT),
    );

    // The just-confirmed "cursor" must survive — the stale get must not un-commit it.
    expect(afterStaleGet.state?.backend).toBe(SUBAGENT_BACKEND_CURSOR);
    expect(afterStaleGet).toEqual(afterSet);
  });

  it("still commits a get issued at or after the last set's generation", () => {
    const afterSet = commitSubagentBackendSet(
      INITIAL_SUBAGENT_BACKEND_COMMIT,
      state(SUBAGENT_BACKEND_CURSOR),
    );
    // A fresh get, issued after the set (its generation matches what the set produced),
    // legitimately refines the committed value — for example the model list arriving.
    const refined = commitSubagentBackendGet(
      afterSet,
      afterSet.generation,
      state(SUBAGENT_BACKEND_CURSOR),
    );
    expect(refined.state?.backend).toBe(SUBAGENT_BACKEND_CURSOR);
  });
});

/**
 * These exercise the WIRING — `observeSubagentBackendQuery`'s stamping combined with the
 * commit reducer — the way `useSubagentBackend` actually drives them across a sequence of
 * renders, rather than the reducer alone. That distinction matters: the reducer was already
 * correct, and the real defect (an atom-identity-keyed stamp that a background SWR
 * re-resolution never revisits) lived entirely in how `issuedGeneration` gets captured.
 */
describe("observeSubagentBackendQuery + the commit reducer, driven as a render sequence", () => {
  it("still drops a get issued before a set (same as the reducer-only case)", () => {
    let commit = INITIAL_SUBAGENT_BACKEND_COMMIT;
    let tracker = INITIAL_SUBAGENT_BACKEND_QUERY_TRACKER;

    // Render: the query starts fetching (mount).
    tracker = observeSubagentBackendQuery(tracker, true, commit.generation);

    // Meanwhile, the user flips the toggle; its `set` resolves first and commits.
    commit = commitSubagentBackendSet(commit, state(SUBAGENT_BACKEND_CURSOR));
    expect(commit.generation).toBe(1);

    // Render: the original get finally resolves, carrying the pre-flip backend.
    tracker = observeSubagentBackendQuery(tracker, false, commit.generation);
    commit = commitSubagentBackendGet(
      commit,
      tracker.issuedGeneration,
      state(SUBAGENT_BACKEND_DEFAULT),
    );

    expect(commit.state?.backend).toBe(SUBAGENT_BACKEND_CURSOR);
  });

  // The case the atom-identity-keyed stamp got wrong: a query that resolved once already,
  // then re-resolves in the background (e.g. a reconnect-triggered `Atom.swr` revalidation)
  // with NO change to the atom object — only `isPending` toggling — after a `set` has already
  // committed. The fresh resolution must still reach the UI.
  it("still commits a get that resolves fresh after a set, with no atom identity change", () => {
    let commit = commitSubagentBackendSet(
      INITIAL_SUBAGENT_BACKEND_COMMIT,
      state(SUBAGENT_BACKEND_DEFAULT),
    );
    let tracker = INITIAL_SUBAGENT_BACKEND_QUERY_TRACKER;
    // The initial fetch already resolved before any of this (tracker last saw isPending=false).
    tracker = observeSubagentBackendQuery(tracker, false, commit.generation);

    // The user flips to Cursor; `set` resolves and commits.
    commit = commitSubagentBackendSet(commit, state(SUBAGENT_BACKEND_CURSOR));
    expect(commit.generation).toBe(2);

    // Later, on the SAME mount, the same query object re-resolves in the background (a
    // reconnect revalidation) — isPending rises then falls again — carrying fresh server
    // truth that happens to still read "cursor" but with a model now populated, proving it's
    // real new data and not the earlier stale value being replayed.
    tracker = observeSubagentBackendQuery(tracker, true, commit.generation);
    tracker = observeSubagentBackendQuery(tracker, false, commit.generation);
    const fresh: SubagentBackendState = {
      ...state(SUBAGENT_BACKEND_CURSOR),
      model: "composer-2.5",
    };
    commit = commitSubagentBackendGet(commit, tracker.issuedGeneration, fresh);

    expect(commit.state?.model).toBe("composer-2.5");
  });
});
