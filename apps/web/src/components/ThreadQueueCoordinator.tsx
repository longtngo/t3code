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
import {
  subscribeToCrossTabThreadQueueUpdates,
  threadQueueEntryKey,
  useThreadQueueStore,
  type ThreadQueueEntry,
} from "../threadQueueStore";
import { buildDraftThreadRouteParams, buildThreadRouteParams } from "../threadRoutes";
import { visibleQueueInstanceIds } from "./queueSlotSources";
import {
  claimAndSendQueueEntry,
  nextThreadQueueAction,
  QUEUE_EMPTY_DRAFT_MESSAGE,
} from "./threadQueue.logic";
import { stackedThreadToast, toastManager } from "./ui/toast";

/** How long a claiming tab waits for another tab's competing claim to land in storage. */
const CLAIM_SETTLE_MS = 300;
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
 * app root; every tab runs one, and a claim in shared storage picks the sender.
 */
export function ThreadQueueCoordinator() {
  const navigate = useNavigate();
  const { presentationById } = useEnvironments();
  const threads = useThreadShells();
  const { entries, paused, inFlight } = useThreadQueueStore(
    useShallow((state) => ({
      entries: state.entries,
      paused: state.paused,
      inFlight: state.inFlight,
    })),
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
    if (!shellsBootstrapped || entries.length === 0) return;
    const live = new Map(
      threads.map((thread) => [
        threadQueueEntryKey({ environmentId: thread.environmentId, threadId: thread.id }),
        thread,
      ]),
    );
    const store = useThreadQueueStore.getState();
    for (const entry of entries) {
      const key = threadQueueEntryKey(entry);
      const thread = live.get(key);
      if (thread !== undefined) {
        if (thread.archivedAt !== null) store.remove(key);
        continue;
      }
      const session = entry.draftId !== null ? draftSessions[entry.draftId] : undefined;
      if (session === undefined) store.remove(key);
    }
  }, [draftSessions, entries, shellsBootstrapped, threads]);

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
    (key: string) =>
      claimAndSendQueueEntry({
        key,
        claimId: randomUUID(),
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
        settle: async () => {
          await new Promise((resolve) => window.setTimeout(resolve, CLAIM_SETTLE_MS));
          await useThreadQueueStore.persist.rehydrate();
        },
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
    const action = nextThreadQueueAction({
      entries,
      paused,
      inFlight,
      threads,
      nowMs: Date.now(),
      slots,
      perProvider,
      providerSlots,
      visibleInstanceIds,
      targetInstanceOf,
    });
    if (action.kind === "clear-in-flight") {
      useThreadQueueStore.getState().clearInFlight(action.claimId);
      return;
    }
    if (action.kind !== "claim" || sendingRef.current) return;
    sendingRef.current = true;
    void runQueuedSend(action.key).then(
      () => {
        sendingRef.current = false;
        // Decide again at once: changes that arrived mid-send were skipped, and a claim that
        // is still held (sent, or taken over by a hand send) simply keeps waiting.
        setTick((value) => value + 1);
      },
      (error: unknown) => {
        // The claim step, or a refused storage write, threw (a held claim fails visibly):
        // retry at the next tick rather than spin.
        sendingRef.current = false;
        console.error("Queued send failed unexpectedly", error);
      },
    );
  }, [
    entries,
    inFlight,
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
