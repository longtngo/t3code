import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { useComposerDraftStore } from "../composerDraftStore";
import { readEnvironmentSettings } from "../hooks/useSettings";
import { executeQueuedSend } from "../lib/threadSend/executeQueuedSend";
import {
  planQueuedSend,
  queuedSendInstanceId,
  type QueuedSendSnapshot,
} from "../lib/threadSend/queuedSend";
import { newMessageId, newThreadId, randomHex, randomUUID } from "../lib/utils";
import { useImportLocalQueueSlots, useQueueSlotSettings } from "../queueSlotSettings";
import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  readEnvironmentSupportsLocalOnlyStatus,
  readProject,
  readThreadShell,
  useAllEnvironmentShellsBootstrapped,
  useThreadShells,
} from "../state/entities";
import { useEnvironments } from "../state/environments";
import { vcsEnvironment } from "../state/vcs";
import { environmentServerConfigsAtom } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import type { ThreadQueueEntry } from "../threadQueueRules";
import {
  queueDeviceId,
  subscribeToCrossTabThreadQueueUpdates,
  useThreadQueueStore,
} from "../threadQueueStore";
import { buildDraftThreadRouteParams, buildThreadRouteParams } from "../threadRoutes";
import { visibleQueueInstanceIds } from "./queueSlotSources";
import {
  claimAndSendQueueEntry,
  nextThreadQueueAction,
  QUEUE_EMPTY_DRAFT_MESSAGE,
  queueEntriesToPrune,
} from "./threadQueue.logic";
import { stackedThreadToast, toastManager } from "./ui/toast";

/** Re-evaluates the queue's time-based caps while it has work. */
const QUEUE_TICK_MS = 15_000;

/** A draft may have moved machine or rotated its thread id since it was queued. */
function resolveCurrentEntry(entry: ThreadQueueEntry): ThreadQueueEntry {
  if (entry.draftId === null) return entry;
  const session = useComposerDraftStore.getState().getDraftSession(entry.draftId);
  if (!session || session.promotedTo) return entry;
  return { ...entry, environmentId: session.environmentId, threadId: session.threadId };
}

function readQueuedSendSnapshot(
  entry: ThreadQueueEntry,
  isEnvironmentConnected: (environmentId: ThreadQueueEntry["environmentId"]) => boolean,
  currentGitBranch: string | null,
): QueuedSendSnapshot {
  const drafts = useComposerDraftStore.getState();
  const threadRef = scopeThreadRef(entry.environmentId, entry.threadId);
  const shell = readThreadShell(threadRef);
  const session = entry.draftId !== null ? drafts.getDraftSession(entry.draftId) : null;
  const draftSession = shell === null && session && !session.promotedTo ? session : null;
  const target = draftSession && entry.draftId !== null ? entry.draftId : threadRef;
  const projectId = shell?.projectId ?? draftSession?.projectId ?? null;
  const project = projectId ? readProject(scopeProjectRef(entry.environmentId, projectId)) : null;
  const serverConfig = appAtomRegistry.get(environmentServerConfigsAtom).get(entry.environmentId);
  const settings = readEnvironmentSettings(entry.environmentId);
  return {
    environmentId: entry.environmentId,
    threadId: entry.threadId,
    draftId: draftSession ? entry.draftId : null,
    draft: drafts.getComposerDraft(target),
    draftSession,
    shell,
    project: project
      ? {
          id: project.id,
          workspaceRoot: project.workspaceRoot,
          defaultModelSelection: project.defaultModelSelection ?? null,
        }
      : null,
    providers: serverConfig?.providers ?? null,
    settings,
    environmentConnected: isEnvironmentConnected(entry.environmentId),
    currentGitBranch,
    loadBalancingEnabled: settings.loadBalancingEnabled,
    randomHex,
  };
}

/** A queued local-checkout thread's checkout; send moves the thread to its current branch. */
function queuedCheckoutRoot(
  entry: ThreadQueueEntry,
): { environmentId: EnvironmentId; cwd: string } | null {
  const shell = readThreadShell(scopeThreadRef(entry.environmentId, entry.threadId));
  if (!shell || shell.worktreePath !== null || shell.branch === null) return null;
  const project = readProject(scopeProjectRef(entry.environmentId, shell.projectId));
  return project ? { environmentId: entry.environmentId, cwd: project.workspaceRoot } : null;
}

/**
 * Sends queued entries while busy threads are below the slot count. Mounted once at the
 * app root; every tab runs one, and the claim the queue confirms picks the sender.
 */
export function ThreadQueueCoordinator() {
  const navigate = useNavigate();
  const { presentationById } = useEnvironments();
  const threads = useThreadShells();
  const { active, ownerId, entries, paused, inFlight } = useThreadQueueStore(
    useShallow((state) => {
      // Server mode judges from the adopted document, never this tab's unconfirmed changes.
      const view = state.mode === "server" && state.server !== null ? state.server : state;
      return {
        // Pending, or a session without operate scope: the coordinator issues nothing.
        active: !state.readOnly,
        ownerId: state.mode === "server" ? queueDeviceId() : null,
        entries: view.entries,
        paused: view.paused,
        inFlight: view.inFlight,
      };
    }),
  );
  const { slots, perProvider, providerSlots } = useQueueSlotSettings();
  useImportLocalQueueSlots();
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const setThreadRuntimeMode = useAtomCommand(threadEnvironment.setRuntimeMode, {
    reportFailure: false,
  });
  const setThreadInteractionMode = useAtomCommand(threadEnvironment.setInteractionMode, {
    reportFailure: false,
  });
  const sendingRef = useRef(false);
  /** The entry a decision picked while a send was running, and skipped. */
  const skippedClaimRef = useRef<string | null>(null);
  const refreshStatus = useAtomCommand(vcsEnvironment.refreshStatus, { reportFailure: false });
  const refreshLocalStatus = useAtomCommand(vcsEnvironment.refreshLocalStatus, {
    reportFailure: false,
  });
  // Read once at send time. A server that does not honour `includeRemote: false` gets a full status refresh
  // for this one checkout, not a remote poller.
  const readGitBranch = useCallback(
    async (entry: ThreadQueueEntry) => {
      const root = queuedCheckoutRoot(entry);
      if (root === null) return null;
      const target = { environmentId: root.environmentId, input: { cwd: root.cwd } };
      const result = readEnvironmentSupportsLocalOnlyStatus(root.environmentId)
        ? await refreshLocalStatus(target)
        : await refreshStatus(target);
      return result._tag === "Failure" ? null : (result.value.refName ?? null);
    },
    [refreshLocalStatus, refreshStatus],
  );
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const visibleInstanceIds = useMemo(
    () => visibleQueueInstanceIds(perProvider, serverConfigs),
    [perProvider, serverConfigs],
  );
  const [tick, setTick] = useState(0);

  useEffect(() => subscribeToCrossTabThreadQueueUpdates(), []);

  // An archived or deleted thread leaves the queue. Only once every environment's
  // shells have loaded: a thread missing from a half-loaded list is not gone.
  const shellsBootstrapped = useAllEnvironmentShellsBootstrapped();
  const draftSessions = useComposerDraftStore((state) => state.draftThreadsByThreadKey);
  useEffect(() => {
    if (!active || !shellsBootstrapped || entries.length === 0) return;
    useThreadQueueStore
      .getState()
      .prune(queueEntriesToPrune({ entries, threads, draftSessions, ownerId }));
  }, [active, draftSessions, entries, ownerId, shellsBootstrapped, threads]);

  const hasWork = entries.length > 0 || inFlight !== null;
  useEffect(() => {
    if (!hasWork) return;
    const id = window.setInterval(() => setTick((value) => value + 1), QUEUE_TICK_MS);
    return () => window.clearInterval(id);
  }, [hasWork]);

  const isEnvironmentConnected = useCallback(
    (environmentId: ThreadQueueEntry["environmentId"]) =>
      presentationById.get(environmentId)?.connection.phase === "connected",
    [presentationById],
  );

  const targetInstanceOf = useCallback(
    (entry: ThreadQueueEntry) =>
      queuedSendInstanceId(
        readQueuedSendSnapshot(resolveCurrentEntry(entry), isEnvironmentConnected, null),
      ),
    [isEnvironmentConnected],
  );

  const openEntry = useCallback(
    (entry: ThreadQueueEntry) => ({
      children: "Open",
      onClick: () => {
        if (
          entry.draftId !== null &&
          readThreadShell(scopeThreadRef(entry.environmentId, entry.threadId)) === null
        ) {
          void navigate({
            to: "/draft/$draftId",
            params: buildDraftThreadRouteParams(entry.draftId),
          });
          return;
        }
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(scopeThreadRef(entry.environmentId, entry.threadId)),
        });
      },
    }),
    [navigate],
  );
  const reportFailure = useCallback(
    (entry: ThreadQueueEntry, title: string, message: string) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Queued send failed: ${title}`,
          description: `${message} The queue is paused.`,
          actionProps: openEntry(entry),
        }),
      );
    },
    [openEntry],
  );
  const reportEmpty = useCallback(
    (entry: ThreadQueueEntry, title: string) => {
      toastManager.add(
        stackedThreadToast({
          type: "info",
          title: `Nothing to send: ${title}`,
          description: QUEUE_EMPTY_DRAFT_MESSAGE,
          actionProps: openEntry(entry),
        }),
      );
    },
    [openEntry],
  );

  const runQueuedSend = useCallback(
    (key: string, claimId: string) =>
      claimAndSendQueueEntry({
        key,
        claimId,
        readGitBranch,
        resolveEntry: resolveCurrentEntry,
        prior: (entry) => {
          const shell = readThreadShell(scopeThreadRef(entry.environmentId, entry.threadId));
          return {
            userMessageAt: shell?.latestUserMessageAt ?? null,
            turnId: shell?.latestRun?.runId ?? null,
            sessionUpdatedAt: shell?.runtime?.updatedAt ?? null,
          };
        },
        now: () => useThreadQueueStore.getState().serverNow(),
        confirm: (claimId) => useThreadQueueStore.getState().confirmClaim(claimId),
        readSnapshot: (entry, currentGitBranch) =>
          readQueuedSendSnapshot(entry, isEnvironmentConnected, currentGitBranch),
        send: (snapshot) =>
          executeQueuedSend(
            snapshot,
            planQueuedSend(snapshot),
            {
              startThreadTurn,
              updateThreadMetadata,
              setThreadRuntimeMode,
              setThreadInteractionMode,
            },
            { messageId: newMessageId(), now: () => new Date().toISOString(), newThreadId },
          ),
        reportFailure,
        reportEmpty,
      }),
    [
      isEnvironmentConnected,
      readGitBranch,
      reportEmpty,
      reportFailure,
      setThreadInteractionMode,
      setThreadRuntimeMode,
      startThreadTurn,
      updateThreadMetadata,
    ],
  );

  useEffect(() => {
    void tick;
    if (!active) return;
    const action = nextThreadQueueAction({
      entries,
      paused,
      inFlight,
      threads,
      // Claim and landing ages are server-stamped: measure them on the server's clock.
      nowMs: useThreadQueueStore.getState().serverNow(),
      ownerId,
      slots,
      perProvider,
      providerSlots,
      visibleInstanceIds,
      targetInstanceOf,
    });
    if (action.kind === "clear-in-flight") {
      useThreadQueueStore.getState().clearInFlight(action.claimId, action.ifUnsent);
      return;
    }
    if (action.kind !== "claim") return;
    if (sendingRef.current) {
      skippedClaimRef.current = action.key;
      return;
    }
    sendingRef.current = true;
    skippedClaimRef.current = null;
    const claimId = randomUUID();
    void runQueuedSend(action.key, claimId).then(
      (started) => {
        sendingRef.current = false;
        // After a send, decide again at once: changes that arrived mid-send were skipped. A claim
        // that never started (refused, unconfirmed, a server that cannot save it, or taken over)
        // decides again only if a change mid-send already called for a claim of another entry:
        // re-renders mid-send decide the same entry on an unchanged document, and deciding again
        // would claim it again and spin.
        const skipped = skippedClaimRef.current;
        if (started || (skipped !== null && skipped !== action.key)) {
          setTick((value) => value + 1);
        }
      },
      (error: unknown) => {
        // The claim step, or a refused storage write, threw (a held claim fails visibly):
        // retry at the next tick rather than spin.
        sendingRef.current = false;
        console.error("Queued send failed unexpectedly", error);
      },
    );
  }, [
    active,
    entries,
    inFlight,
    ownerId,
    paused,
    perProvider,
    providerSlots,
    runQueuedSend,
    slots,
    targetInstanceOf,
    threads,
    tick,
    visibleInstanceIds,
  ]);

  return null;
}
