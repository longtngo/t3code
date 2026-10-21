import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  migratePersistedTerminalUiStateStoreState,
  selectThreadTerminalUiState,
  useTerminalUiStateStore,
} from "./terminalUiStateStore";
import { collectActiveTerminalUiThreadKeys } from "./lib/terminalUiStateCleanup";

const THREAD_ID = ThreadId.make("thread-1");
const THREAD_REF = scopeThreadRef("environment-a" as never, THREAD_ID);
const OTHER_THREAD_REF = scopeThreadRef("environment-b" as never, THREAD_ID);
const GHOST_THREAD_REF = scopeThreadRef("environment-a" as never, ThreadId.make("thread-ghost"));

describe("terminalUiStateStore actions", () => {
  beforeEach(() => {
    useTerminalUiStateStore.persist.clearStorage();
    useTerminalUiStateStore.setState({
      terminalUiStateByThreadKey: {},
      suppressedTerminalIdsByThreadKey: {},
    });
  });

  it("caps splits at four terminals per group", () => {
    const store = useTerminalUiStateStore.getState();
    store.splitTerminal(THREAD_REF, "terminal-2");
    store.splitTerminal(THREAD_REF, "terminal-3");
    store.splitTerminal(THREAD_REF, "terminal-4");
    store.splitTerminal(THREAD_REF, "terminal-5");
    store.splitTerminal(THREAD_REF, "terminal-6");

    const terminalUiState = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalUiState.terminalIds).toEqual([
      "terminal-2",
      "terminal-3",
      "terminal-4",
      "terminal-5",
    ]);
    expect(terminalUiState.terminalGroups).toEqual([
      {
        id: "group-terminal-2",
        terminalIds: ["terminal-2", "terminal-3", "terminal-4", "terminal-5"],
      },
    ]);
  });

  it("keeps state isolated per environment when raw thread ids collide", () => {
    const store = useTerminalUiStateStore.getState();
    store.setTerminalOpen(THREAD_REF, true);
    store.newTerminal(OTHER_THREAD_REF, "env-b-terminal");

    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        THREAD_REF,
      ).terminalOpen,
    ).toBe(true);
    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        OTHER_THREAD_REF,
      ).terminalIds,
    ).toEqual(["env-b-terminal"]);
  });

  it("drops persisted entries whose thread keys are not valid scoped keys", () => {
    const migrated = migratePersistedTerminalUiStateStoreState(
      {
        terminalStateByThreadKey: {
          [scopedThreadKey(THREAD_REF)]: {
            terminalOpen: true,
            terminalHeight: 320,
            terminalIds: ["term-1"],
            activeTerminalId: "term-1",
            terminalGroups: [{ id: "group-term-1", terminalIds: ["term-1"] }],
            activeTerminalGroupId: "group-term-1",
          },
          "legacy-thread-id": {
            terminalOpen: true,
            terminalHeight: 320,
            terminalIds: ["term-1"],
            activeTerminalId: "term-1",
            terminalGroups: [{ id: "group-term-1", terminalIds: ["term-1"] }],
            activeTerminalGroupId: "group-term-1",
          },
        },
      },
      2,
    );

    expect(migrated).toEqual({
      terminalUiStateByThreadKey: {
        [scopedThreadKey(THREAD_REF)]: {
          terminalOpen: true,
          terminalHeight: 320,
          terminalIds: ["term-1"],
          activeTerminalId: "term-1",
          terminalGroups: [{ id: "group-term-1", terminalIds: ["term-1"] }],
          activeTerminalGroupId: "group-term-1",
        },
      },
    });
  });

  it("resets to default and clears persisted entry when closing the last terminal", () => {
    const store = useTerminalUiStateStore.getState();
    store.newTerminal(THREAD_REF, "terminal-only");
    store.closeTerminal(THREAD_REF, "terminal-only");

    expect(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey[scopedThreadKey(THREAD_REF)],
    ).toBeUndefined();
    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        THREAD_REF,
      ).terminalIds,
    ).toEqual([]);
  });

  it("keeps a valid active terminal after closing an active split terminal", () => {
    const store = useTerminalUiStateStore.getState();
    store.splitTerminal(THREAD_REF, "terminal-2");
    store.splitTerminal(THREAD_REF, "terminal-3");
    store.closeTerminal(THREAD_REF, "terminal-3");

    const terminalUiState = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalUiState.activeTerminalId).toBe("terminal-2");
    expect(terminalUiState.terminalIds).toEqual(["terminal-2"]);
    expect(terminalUiState.terminalGroups).toEqual([
      { id: "group-terminal-2", terminalIds: ["terminal-2"] },
    ]);
  });

  it("does not import a closed panel terminal from stale metadata", () => {
    const store = useTerminalUiStateStore.getState();
    store.newTerminal(THREAD_REF, "term-2");
    store.closeTerminal(THREAD_REF, "term-1");

    store.reconcileTerminalIds(THREAD_REF, ["term-1", "term-2"]);

    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        THREAD_REF,
      ).terminalIds,
    ).toEqual(["term-2"]);

    store.newTerminal(THREAD_REF, "term-1");
    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        THREAD_REF,
      ).terminalIds,
    ).toEqual(["term-2", "term-1"]);
  });
});

describe("pruning terminal UI state for threads that no longer exist", () => {
  beforeEach(() => {
    useTerminalUiStateStore.persist.clearStorage();
    useTerminalUiStateStore.setState({
      terminalUiStateByThreadKey: {},
      suppressedTerminalIdsByThreadKey: {},
    });
  });

  const openTerminalFor = (ref: typeof THREAD_REF) => {
    useTerminalUiStateStore.getState().setTerminalOpen(ref, true);
  };

  it("keeps live threads and drops ones the server no longer lists", () => {
    const active = collectActiveTerminalUiThreadKeys({
      snapshotThreads: [
        { key: scopedThreadKey(THREAD_REF), deletedAt: null, archivedAt: null },
        { key: scopedThreadKey(OTHER_THREAD_REF), deletedAt: null, archivedAt: null },
      ],
      draftThreadKeys: [],
    });

    openTerminalFor(THREAD_REF);
    openTerminalFor(OTHER_THREAD_REF);
    // A thread the snapshot does not mention at all: deleted server-side, or
    // never created there. This is the state that used to accumulate forever.
    openTerminalFor(GHOST_THREAD_REF);

    useTerminalUiStateStore.getState().removeOrphanedTerminalUiStates(active);

    const keys = Object.keys(useTerminalUiStateStore.getState().terminalUiStateByThreadKey);
    expect(keys).toContain(scopedThreadKey(THREAD_REF));
    expect(keys).toContain(scopedThreadKey(OTHER_THREAD_REF));
    expect(keys).not.toContain(scopedThreadKey(GHOST_THREAD_REF));
  });

  it("drops an archived thread, which the server answers for exactly like a missing one", () => {
    const active = collectActiveTerminalUiThreadKeys({
      snapshotThreads: [
        { key: scopedThreadKey(THREAD_REF), deletedAt: null, archivedAt: "2026-08-01T00:00:00Z" },
      ],
      draftThreadKeys: [],
    });

    openTerminalFor(THREAD_REF);
    useTerminalUiStateStore.getState().removeOrphanedTerminalUiStates(active);

    expect(Object.keys(useTerminalUiStateStore.getState().terminalUiStateByThreadKey)).toEqual([]);
  });

  it("keeps a draft thread the snapshot has never heard of", () => {
    // A draft exists only in the browser until its first send, so absence from
    // the snapshot is normal rather than evidence it is gone.
    const draftKey = scopedThreadKey(OTHER_THREAD_REF);
    const active = collectActiveTerminalUiThreadKeys({
      snapshotThreads: [{ key: scopedThreadKey(THREAD_REF), deletedAt: null, archivedAt: null }],
      draftThreadKeys: [draftKey],
    });

    openTerminalFor(OTHER_THREAD_REF);
    useTerminalUiStateStore.getState().removeOrphanedTerminalUiStates(active);

    expect(Object.keys(useTerminalUiStateStore.getState().terminalUiStateByThreadKey)).toContain(
      draftKey,
    );
  });

  it("wipes everything when told nothing is active, which is why the caller waits for bootstrap", () => {
    // Not a wish, a warning: this function is unconditional, so calling it
    // against the cached shell that loads before the live one would delete the
    // terminal layout of every thread the user has.
    openTerminalFor(THREAD_REF);
    openTerminalFor(OTHER_THREAD_REF);

    useTerminalUiStateStore.getState().removeOrphanedTerminalUiStates(new Set());

    expect(Object.keys(useTerminalUiStateStore.getState().terminalUiStateByThreadKey)).toEqual([]);
  });
});
