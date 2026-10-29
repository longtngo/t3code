import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useComposerDraftStore } from "../../composerDraftStore";
import type { TerminalContextSelection } from "../../lib/terminalContext";
import { collectActiveTerminalUiThreadKeys } from "../../lib/terminalUiStateCleanup";
import { usePanelAnimationSettings, usePanelPresence } from "../../panelAnimations";
import {
  useAllEnvironmentShellsBootstrapped,
  useThreadRefs,
  useThreadShells,
} from "../../state/entities";
import { useTerminalUiStateStore } from "../../terminalUiStateStore";
import {
  MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  reconcileMountedTerminalThreadIds,
} from "../ChatView.logic";
import {
  PersistentThreadTerminalDrawer,
  type PersistentTerminalLaunchContext,
} from "../PersistentThreadTerminals";

interface ChatTerminalDrawersProps {
  readonly activeThreadKey: string | null;
  readonly activeTerminalOpen: boolean;
  readonly composerHeight: number;
  readonly launchContext: PersistentTerminalLaunchContext | null;
  readonly splitShortcutLabel: string | undefined;
  readonly splitVerticalShortcutLabel: string | undefined;
  readonly newShortcutLabel: string | undefined;
  readonly closeShortcutLabel: string | undefined;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly onAddTerminalContext: (selection: TerminalContextSelection) => void;
}

/**
 * Keeps terminal drawers mounted for recently open threads, so switching back
 * to one finds its sessions as they were. Every thread's terminal and draft
 * state feeds the reconcile, so it subscribes here instead of in ChatView.
 */
export function ChatTerminalDrawers(props: ChatTerminalDrawersProps) {
  const { activeThreadKey } = props;
  const openTerminalThreadKeys = useTerminalUiStateStore(
    useShallow((state) =>
      Object.entries(state.terminalUiStateByThreadKey).flatMap(
        ([nextThreadKey, nextTerminalUiState]) =>
          nextTerminalUiState.terminalOpen ? [nextThreadKey] : [],
      ),
    ),
  );
  const serverThreadRefs = useThreadRefs();
  const serverThreadKeys = serverThreadRefs.map(scopedThreadKey);
  const draftThreadsByThreadKey = useComposerDraftStore((store) => store.draftThreadsByThreadKey);
  const draftThreadKeys = Object.values(draftThreadsByThreadKey).map((draftThread) =>
    scopedThreadKey(scopeThreadRef(draftThread.environmentId, draftThread.threadId)),
  );
  // FORK: the filter below only hides a dead thread's terminal state, so the persisted map keeps
  // every thread ever opened and a stale cached shell can re-mount it. Pruning waits for every
  // environment's shell to bootstrap: the first cached shell cannot be trusted to say a thread
  // is gone, and pruning against it would delete live state.
  const shellsBootstrapped = useAllEnvironmentShellsBootstrapped();
  const threadShells = useThreadShells();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- prunes persisted terminal UI state for threads gone from the loaded shell list
  useEffect(() => {
    if (!shellsBootstrapped) return;
    useTerminalUiStateStore.getState().removeOrphanedTerminalUiStates(
      collectActiveTerminalUiThreadKeys({
        snapshotThreads: threadShells.map((shell) => ({
          key: scopedThreadKey(scopeThreadRef(shell.environmentId, shell.id)),
          deletedAt: null,
          archivedAt: shell.archivedAt,
        })),
        draftThreadKeys,
      }),
    );
  }, [draftThreadKeys, shellsBootstrapped, threadShells]);
  const { active: panelAnimationsActive, durationMs: panelAnimationDurationMs } =
    usePanelAnimationSettings();
  const activeTerminalDrawerPresence = usePanelPresence(
    Boolean(activeThreadKey && props.activeTerminalOpen),
    true,
    panelAnimationsActive,
    activeThreadKey,
    panelAnimationDurationMs,
  );
  const [mountedTerminalThreadKeys, setMountedTerminalThreadKeys] = useState<string[]>([]);
  const existingOpenTerminalThreadKeys = (() => {
    const existingThreadKeys = new Set<string>([...serverThreadKeys, ...draftThreadKeys]);
    return openTerminalThreadKeys.filter((nextThreadKey) => existingThreadKeys.has(nextThreadKey));
  })();
  const reconciledMountedTerminalThreadKeys = reconcileMountedTerminalThreadIds({
    currentThreadIds: mountedTerminalThreadKeys,
    openThreadIds: existingOpenTerminalThreadKeys,
    activeThreadId: activeThreadKey,
    activeThreadTerminalOpen: activeTerminalDrawerPresence.present,
    maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  });
  if (
    reconciledMountedTerminalThreadKeys.length !== mountedTerminalThreadKeys.length ||
    reconciledMountedTerminalThreadKeys.some(
      (threadKey, index) => threadKey !== mountedTerminalThreadKeys[index],
    )
  ) {
    setMountedTerminalThreadKeys(reconciledMountedTerminalThreadKeys);
  }
  const mountedTerminalThreadRefs = mountedTerminalThreadKeys.flatMap((mountedThreadKey) => {
    const mountedThreadRef = parseScopedThreadKey(mountedThreadKey);
    return mountedThreadRef ? [{ key: mountedThreadKey, threadRef: mountedThreadRef }] : [];
  });

  return mountedTerminalThreadRefs.map(({ key: mountedThreadKey, threadRef: mountedThreadRef }) => (
    <PersistentThreadTerminalDrawer
      key={mountedThreadKey}
      threadRef={mountedThreadRef}
      threadId={mountedThreadRef.threadId}
      active={mountedThreadKey === activeThreadKey}
      composerHeight={mountedThreadKey === activeThreadKey ? props.composerHeight : 0}
      launchContext={mountedThreadKey === activeThreadKey ? props.launchContext : null}
      splitShortcutLabel={props.splitShortcutLabel}
      splitVerticalShortcutLabel={props.splitVerticalShortcutLabel}
      newShortcutLabel={props.newShortcutLabel}
      closeShortcutLabel={props.closeShortcutLabel}
      keybindings={props.keybindings}
      onAddTerminalContext={props.onAddTerminalContext}
    />
  ));
}
