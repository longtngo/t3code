import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { useComposerDraftStore } from "../composerDraftStore";
import { getClientSettingsSnapshot, mergeEnvironmentSettings } from "../hooks/useSettings";
import { executeQueuedSend } from "../lib/threadSend/executeQueuedSend";
import { planQueuedSend, type QueuedSendSnapshot } from "../lib/threadSend/queuedSend";
import { newMessageId, newThreadId, randomHex, randomUUID } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  readProject,
  readThreadShell,
  useAllEnvironmentShellsBootstrapped,
  useThreadShells,
} from "../state/entities";
import { useEnvironments } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { vcsEnvironment } from "../state/vcs";
import { environmentServerConfigsAtom, serverEnvironment } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import {
  subscribeToCrossTabThreadQueueUpdates,
  threadQueueEntryKey,
  useThreadQueueStore,
  type ThreadQueueEntry,
} from "../threadQueueStore";
import { buildDraftThreadRouteParams, buildThreadRouteParams } from "../threadRoutes";
import { claimAndSendQueueHead, nextThreadQueueAction } from "./threadQueue.logic";
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
  const serverSettings =
    appAtomRegistry.get(serverEnvironment.settingsValueAtom(entry.environmentId)) ??
    DEFAULT_SERVER_SETTINGS;
  const clientSettings = getClientSettingsSnapshot();
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
    settings: mergeEnvironmentSettings(serverSettings, clientSettings),
    environmentConnected: isEnvironmentConnected(entry.environmentId),
    currentGitBranch,
    loadBalancingEnabled: clientSettings.loadBalancingEnabled,
    randomHex,
  };
}

/**
 * Sends the Queue's head when every Active thread is done. Mounted once at the
 * app root; every tab runs one, and a claim in shared storage picks the sender.
 */
export function ThreadQueueCoordinator() {
  const navigate = useNavigate();
  const { presentationById } = useEnvironments();
  const threads = useThreadShells();
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const { entries, paused, inFlight } = useThreadQueueStore(
    useShallow((state) => ({
      entries: state.entries,
      paused: state.paused,
      inFlight: state.inFlight,
    })),
  );
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
  // Send moves a local-checkout thread to the branch actually checked out, so the
  // head's checkout status is watched the way the open thread watches its own.
  const head = entries[0] ?? null;
  const headShell = head
    ? readThreadShell(scopeThreadRef(head.environmentId, head.threadId))
    : null;
  const headProject =
    head && headShell && headShell.worktreePath === null && headShell.branch !== null
      ? readProject(scopeProjectRef(head.environmentId, headShell.projectId))
      : null;
  const headGitStatus = useEnvironmentQuery(
    head && headProject
      ? vcsEnvironment.status({
          environmentId: head.environmentId,
          input: { cwd: headProject.workspaceRoot },
        })
      : null,
  );
  // Keyed by the head it was read for, so a send never uses another thread's checkout.
  const headGitBranchRef = useRef<{ key: string; branch: string | null } | null>(null);
  headGitBranchRef.current = head
    ? {
        key: threadQueueEntryKey(head),
        branch: headProject ? (headGitStatus.data?.refName ?? null) : null,
      }
    : null;
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

  const reportFailure = useCallback(
    (entry: ThreadQueueEntry, title: string, message: string) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Queued send failed: ${title}`,
          description: `${message} The queue is paused.`,
          actionProps: {
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
          },
        }),
      );
    },
    [navigate],
  );

  const runQueuedSend = useCallback(
    () =>
      claimAndSendQueueHead({
        claimId: randomUUID(),
        headGitBranch: () => headGitBranchRef.current,
        resolveEntry: resolveCurrentEntry,
        priorUserMessageAt: (entry) =>
          readThreadShell(scopeThreadRef(entry.environmentId, entry.threadId))
            ?.latestUserMessageAt ?? null,
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
      }),
    [
      isEnvironmentConnected,
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
      capabilitiesFor: (environmentId) =>
        serverConfigs.get(environmentId)?.environment.capabilities,
      nowMs: Date.now(),
    });
    if (action.kind === "clear-in-flight") {
      useThreadQueueStore.getState().clearInFlight(action.claimId);
      return;
    }
    if (action.kind !== "claim" || sendingRef.current) return;
    sendingRef.current = true;
    void runQueuedSend().finally(() => {
      sendingRef.current = false;
    });
  }, [entries, inFlight, paused, runQueuedSend, serverConfigs, threads, tick]);

  return null;
}
