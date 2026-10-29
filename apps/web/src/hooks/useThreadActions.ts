import {
  parseScopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  canSnooze,
  effectiveSnoozed,
  threadWokeAt,
} from "@t3tools/client-runtime/state/thread-settled";
import { threadRuntimeCanArchive } from "@t3tools/client-runtime/state/models";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  EnvironmentAuthorizationError,
  EnvironmentId,
  type ScopedThreadRef,
  ThreadId,
  sessionGrantsScope,
} from "@t3tools/contracts";
import { resolveWorktreeCleanup } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { useRouter } from "@tanstack/react-router";

import { getFallbackThreadIdAfterDelete, pinOrderKeyBetween } from "../components/Sidebar.logic";
import { useComposerDraftStore } from "../composerDraftStore";
import { environmentSession, readEnvironmentScope } from "../state/session";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom, primaryServerConfigAtom } from "../state/server";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { orchestrationEnvironment } from "../state/orchestration";
import { projectEnvironment } from "../state/projects";
import { threadEnvironment } from "../state/threads";
import { vcsEnvironment } from "../state/vcs";
import { useNewThreadHandler } from "./useHandleNewThread";
import { refreshArchivedThreadsForEnvironment } from "../lib/archivedThreadsState";
import { releaseComposerDraftUploads } from "../lib/composerDraftUploads";
import { readLocalApi } from "../localApi";
import {
  readEnvironmentServerConfigLoaded,
  readEnvironmentSupportsAutoSettleOptOut,
  readEnvironmentSupportsSidebarSections,
  readEnvironmentThreadRefs,
  readProject,
  readThreadShell,
  readThreadShells,
  waitForThreadUnarchived,
} from "../state/entities";
import { SLOW_RPC_ACK_THRESHOLD_MS } from "../rpc/requestLatencyState";
import {
  planSidebarSectionMove,
  resolveSidebarSections,
  runSidebarSectionMove,
  sidebarSectionGone,
  sidebarSectionMoveFailureTitle,
} from "../sidebarCustomSections.logic";
import { useUiStateStore } from "../uiStateStore";
import { clearThreadPreviewState } from "../previewStateStore";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";
import { formatWorktreePathForDisplay, getOrphanedWorktreePathForThread } from "../worktreeCleanup";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import {
  SNOOZE_QUEUE_READ_ONLY_MESSAGE,
  leaveQueueForRemoval,
  leaveQueueForUndo,
  queueRefusesSnooze,
} from "../threadQueueAdd";
import { useClientSettings } from "./useSettings";
import { whileLeavingThreadQueue } from "../threadQueueLeaving";
import * as ThreadUndo from "@t3tools/client-runtime/state/thread-undo";
import { showThreadUndoNotice } from "./showThreadUndoNotice";
import { useAtomCommand } from "../state/use-atom-command";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";

export class ThreadArchiveBlockedError extends Schema.TaggedError<ThreadArchiveBlockedError>()(
  "ThreadArchiveBlockedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return "Cannot archive while the provider is active.";
  }
}

export class ThreadSettlementUnsupportedError extends Schema.TaggedError<ThreadSettlementUnsupportedError>()(
  "ThreadSettlementUnsupportedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return "This environment's server does not support settling yet. Update the server to use Settle.";
  }
}

export class ThreadSnoozeUnsupportedError extends Schema.TaggedError<ThreadSnoozeUnsupportedError>()(
  "ThreadSnoozeUnsupportedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return "This environment's server does not support snoozing yet. Update the server to use Snooze.";
  }
}

export class ThreadSnoozeQueueReadOnlyError extends Schema.TaggedError<ThreadSnoozeQueueReadOnlyError>()(
  "ThreadSnoozeQueueReadOnlyError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return SNOOZE_QUEUE_READ_ONLY_MESSAGE;
  }
}

export class ThreadSnoozeBlockedError extends Schema.TaggedError<ThreadSnoozeBlockedError>()(
  "ThreadSnoozeBlockedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return "This thread is waiting on you. Respond to the pending request before snoozing it.";
  }
}

function topOfPinnedRunOrderKey(): string | undefined {
  let firstKey: string | null = null;
  for (const shell of readThreadShells()) {
    if (shell.pinnedAt == null || shell.pinOrderKey == null) continue;
    if (firstKey === null || shell.pinOrderKey < firstKey) firstKey = shell.pinOrderKey;
  }
  return pinOrderKeyBetween(null, firstKey) ?? undefined;
}

export class ThreadAutoSettleOptOutUnsupportedError extends Schema.TaggedError<ThreadAutoSettleOptOutUnsupportedError>()(
  "ThreadAutoSettleOptOutUnsupportedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return "This environment's server does not support turning auto-settle off per thread yet. Update the server to use it.";
  }
}

export class ThreadPinningUnsupportedError extends Schema.TaggedError<ThreadPinningUnsupportedError>()(
  "ThreadPinningUnsupportedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return "This environment's server does not support pinning yet. Update the server to use Pin.";
  }
}

export class ThreadPinReorderUnsupportedError extends Schema.TaggedError<ThreadPinReorderUnsupportedError>()(
  "ThreadPinReorderUnsupportedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return "This environment's server does not support reordering pinned threads yet. Update the server to reorder pins.";
  }
}

export class ThreadActiveReorderUnsupportedError extends Schema.TaggedError<ThreadActiveReorderUnsupportedError>()(
  "ThreadActiveReorderUnsupportedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return "Update this environment's server to reorder active threads.";
  }
}

export class ThreadSidebarSectionsUnsupportedError extends Schema.TaggedError<ThreadSidebarSectionsUnsupportedError>()(
  "ThreadSidebarSectionsUnsupportedError",
  { environmentId: EnvironmentId, threadId: ThreadId },
) {
  override get message(): string {
    return "Update this environment's server to move threads into sections.";
  }
}

async function requestThreadUnpinConfirmation(input: {
  enabled: boolean;
  title: string;
  confirm: ((message: string) => Promise<boolean>) | null;
}) {
  const { confirm } = input;
  if (!input.enabled || confirm === null) {
    return AsyncResult.success(true);
  }

  return settlePromise(() =>
    confirm(
      [
        `Unpin thread "${input.title}"?`,
        "This will move the thread out of your pinned section.",
      ].join("\n"),
    ),
  );
}

export async function navigateAfterThreadDeletion(navigate: () => Promise<void>) {
  const result = await settlePromise(navigate);
  if (result._tag === "Failure") {
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Thread deleted, but navigation failed",
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  }
}

function useMarkThreadUnread() {
  const markThreadUnreadMutation = useAtomCommand(threadEnvironment.markUnread, {
    reportFailure: false,
  });
  const markThreadUnreadLocal = useUiStateStore((state) => state.markThreadUnread);
  return (target: ScopedThreadRef) => {
    if (readEnvironmentServerConfigLoaded(target.environmentId)) {
      void markThreadUnreadMutation({
        environmentId: target.environmentId,
        input: { threadId: target.threadId },
      });
      return;
    }
    const thread = readThreadShell(target);
    markThreadUnreadLocal(scopedThreadKey(target), thread?.latestRun?.completedAt);
  };
}

export function useAcknowledgeThreadWoke() {
  const visitThreadMutation = useAtomCommand(threadEnvironment.visit, { reportFailure: false });
  const markThreadVisited = useUiStateStore((state) => state.markThreadVisited);
  return (target: ScopedThreadRef, wokeAt: string) => {
    if (readEnvironmentServerConfigLoaded(target.environmentId)) {
      void visitThreadMutation({
        environmentId: target.environmentId,
        input: { threadId: target.threadId, visitedAt: wokeAt },
      });
      return;
    }
    markThreadVisited(scopedThreadKey(target), wokeAt);
  };
}

/** A No project thread that already has its own folder, on a server that can promote it. */
export function canTurnThreadIntoProject(threadRef: ScopedThreadRef): boolean {
  const thread = readThreadShell(threadRef);
  const config = appAtomRegistry.get(environmentServerConfigsAtom).get(threadRef.environmentId);
  if (!thread?.worktreePath || config?.environment.capabilities.threadProjectFromScratch !== true) {
    return false;
  }
  const project = readProject({
    environmentId: threadRef.environmentId,
    projectId: thread.projectId,
  });
  return project !== null && isScratchProject(project, config.scratchWorkspaceRoot);
}

function threadOperationFailure(target: ScopedThreadRef) {
  return readEnvironmentScope(target.environmentId, AuthOrchestrationOperateScope)
    ? null
    : AsyncResult.failure(
        Cause.fail(
          new EnvironmentAuthorizationError({
            message: "This connection cannot change threads.",
            requiredScope: AuthOrchestrationOperateScope,
          }),
        ),
      );
}

export function useThreadActions() {
  const archiveThreadMutation = useOrchestrationCommand(threadEnvironment.archive, {
    reportFailure: false,
  });
  const unarchiveThreadMutation = useOrchestrationCommand(threadEnvironment.unarchive, {
    reportFailure: false,
  });
  const deleteThreadMutation = useOrchestrationCommand(threadEnvironment.delete, {
    reportFailure: false,
  });
  const settleThreadMutation = useOrchestrationCommand(threadEnvironment.settle, {
    reportFailure: false,
  });
  const unsettleThreadMutation = useOrchestrationCommand(threadEnvironment.unsettle, {
    reportFailure: false,
  });
  const pinThreadMutation = useOrchestrationCommand(threadEnvironment.pin, {
    reportFailure: false,
  });
  const unpinThreadMutation = useOrchestrationCommand(threadEnvironment.unpin, {
    reportFailure: false,
  });
  const setThreadAutoSettleMutation = useOrchestrationCommand(threadEnvironment.setAutoSettle, {
    reportFailure: false,
  });
  const reorderPinnedThreadMutation = useOrchestrationCommand(threadEnvironment.reorderPin, {
    reportFailure: false,
  });
  const reorderActiveThreadMutation = useOrchestrationCommand(threadEnvironment.reorderActive, {
    reportFailure: false,
  });
  const setThreadSidebarSectionMutation = useOrchestrationCommand(threadEnvironment.setSection, {
    reportFailure: false,
  });
  const snoozeThreadMutation = useOrchestrationCommand(threadEnvironment.snooze, {
    reportFailure: false,
  });
  const unsnoozeThreadMutation = useOrchestrationCommand(threadEnvironment.unsnooze, {
    reportFailure: false,
  });
  const markThreadUnread = useMarkThreadUnread();
  const createProjectFromThread = useAtomCommand(projectEnvironment.createFromThread, {
    reportFailure: false,
  });
  const stopThreadSession = useOrchestrationCommand(threadEnvironment.stopSession);
  const removeWorktree = useAtomCommand(vcsEnvironment.removeWorktree, {
    reportFailure: false,
  });
  const loadSessionState = useAtomQueryRunner(environmentSession.sessionStateAtom, {
    reportFailure: false,
  });
  const loadWorktreeThreadIds = useAtomQueryRunner(orchestrationEnvironment.worktreeThreadIds, {
    reportFailure: false,
    refresh: true,
  });
  const refreshVcsStatus = useAtomCommand(vcsEnvironment.refreshStatus, {
    reportFailure: false,
  });
  const sidebarThreadSortOrder = useClientSettings((settings) => settings.sidebarThreadSortOrder);
  const confirmThreadDelete = useClientSettings((settings) => settings.confirmThreadDelete);
  const confirmThreadUnpin = useClientSettings((settings) => settings.confirmThreadUnpin);
  const clearComposerDraftForThread = useComposerDraftStore((store) => store.clearDraftThread);
  const clearProjectDraftThreadById = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadById,
  );
  const clearTerminalUiState = useTerminalUiStateStore((state) => state.clearTerminalUiState);
  const markThreadVisited = useUiStateStore((state) => state.markThreadVisited);
  const router = useRouter();
  const handleNewThread = useNewThreadHandler();

  const resolveThreadTarget = (target: ScopedThreadRef) => {
    const thread = readThreadShell(target);
    if (!thread) {
      return null;
    }
    return {
      thread,
      threadRef: target,
    };
  };
  const getCurrentRouteThreadRef = () => {
    const currentRouteParams = router.state.matches[router.state.matches.length - 1]?.params ?? {};
    return resolveThreadRouteRef(currentRouteParams);
  };

  const unarchiveThread = async (target: ScopedThreadRef, opts: { navigate?: boolean } = {}) => {
    ThreadUndo.invalidate("archive", scopedThreadKey(target));
    const result = await unarchiveThreadMutation({
      environmentId: target.environmentId,
      input: { threadId: target.threadId },
    });
    if (result._tag === "Failure") {
      return result;
    }
    refreshArchivedThreadsForEnvironment(target.environmentId);
    if (opts.navigate) {
      return settlePromise(() =>
        router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(target),
        }),
      );
    }
    return result;
  };

  const archiveThread = async (target: ScopedThreadRef, opts: { onArchived?: () => void } = {}) => {
    const resolved = resolveThreadTarget(target);
    if (!resolved) return AsyncResult.success(undefined);
    const { thread, threadRef } = resolved;
    if (!threadRuntimeCanArchive(thread.runtime)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadArchiveBlockedError({
            environmentId: threadRef.environmentId,
            threadId: threadRef.threadId,
          }),
        ),
      );
    }

    const currentRouteThreadRef = getCurrentRouteThreadRef();
    const shouldNavigateToDraft =
      currentRouteThreadRef?.threadId === threadRef.threadId &&
      currentRouteThreadRef.environmentId === threadRef.environmentId;
    const threadKey = scopedThreadKey(threadRef);
    const action = ThreadUndo.begin("archive", threadKey);
    // A queued thread is not sent while it is being archived, and leaves the Queue once it is;
    // Undo puts it back.
    let requeue: (() => void) | undefined;
    const archiveResult = await whileLeavingThreadQueue(threadKey, async () => {
      const archived = await archiveThreadMutation({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId },
      });
      if (archived._tag === "Success") requeue = leaveQueueForUndo(threadKey);
      return archived;
    });
    if (archiveResult._tag === "Failure") {
      action.finish();
      return archiveResult;
    }
    const wokeAt = threadWokeAt(thread, { now: new Date().toISOString() });
    if (wokeAt !== null) {
      markThreadVisited(scopedThreadKey(threadRef), wokeAt);
    }
    refreshArchivedThreadsForEnvironment(threadRef.environmentId);
    opts.onArchived?.();
    showThreadUndoNotice({
      action: "Archived",
      claim: action,
      undo: async () => {
        const restored = await unarchiveThread(threadRef, { navigate: shouldNavigateToDraft });
        // The Queue prunes a thread this client still reads as archived, and the reply can come
        // before that state does: re-queue once it reads unarchived, or never (said nothing).
        const back = requeue;
        if (restored._tag === "Success" && back !== undefined) {
          void waitForThreadUnarchived(threadRef, SLOW_RPC_ACK_THRESHOLD_MS).then(
            (unarchived) => unarchived && back(),
          );
        }
        return restored;
      },
      failureTitle: "Failed to undo archive",
    });

    if (shouldNavigateToDraft) {
      const navigationResult = await settlePromise(() =>
        handleNewThread(scopeProjectRef(thread.environmentId, thread.projectId)),
      );
      if (navigationResult._tag === "Failure") {
        return navigationResult;
      }
      return archiveResult;
    }

    return archiveResult;
  };

  const deleteThread = async (
    target: ScopedThreadRef,
    opts: { deletedThreadKeys?: ReadonlySet<string> } = {},
  ) => {
    const permissionFailure = threadOperationFailure(target);
    if (permissionFailure) return permissionFailure;
    const resolved = resolveThreadTarget(target);
    if (!resolved) {
      const result = await deleteThreadMutation({
        environmentId: target.environmentId,
        input: { threadId: target.threadId },
      });
      if (result._tag === "Success") {
        refreshArchivedThreadsForEnvironment(target.environmentId);
        clearThreadPreviewState(target);
      }
      return result;
    }
    const { thread, threadRef } = resolved;
    const threads = readEnvironmentThreadRefs(threadRef.environmentId).flatMap((ref) => {
      const shell = readThreadShell(ref);
      return shell === null ? [] : [shell];
    });
    const threadProject = readProject({
      environmentId: threadRef.environmentId,
      projectId: thread.projectId,
    });
    const deletedIds =
      opts.deletedThreadKeys && opts.deletedThreadKeys.size > 0
        ? new Set<ThreadId>(
            [...opts.deletedThreadKeys].flatMap((threadKey) => {
              const ref = parseScopedThreadKey(threadKey);
              return ref && ref.environmentId === threadRef.environmentId ? [ref.threadId] : [];
            }),
          )
        : undefined;
    const survivingThreads =
      deletedIds && deletedIds.size > 0
        ? threads.filter((entry) => entry.id === threadRef.threadId || !deletedIds.has(entry.id))
        : threads;
    const environmentConfig = appAtomRegistry
      .get(environmentServerConfigsAtom)
      .get(threadRef.environmentId);
    let orphanedWorktreePath = getOrphanedWorktreePathForThread(
      survivingThreads,
      threadRef.threadId,
    );
    // A shell that leaves idle subagent children out cannot prove nobody else uses the worktree,
    // so the server's list decides. A failed read keeps the worktree.
    if (orphanedWorktreePath !== null && environmentConfig?.shellThreadFamilies === true) {
      const occupants = await loadWorktreeThreadIds({
        environmentId: threadRef.environmentId,
        input: { worktreePath: orphanedWorktreePath },
      });
      if (
        occupants._tag !== "Success" ||
        occupants.value.threadIds.some(
          (threadId) => threadId !== threadRef.threadId && deletedIds?.has(threadId) !== true,
        )
      ) {
        orphanedWorktreePath = null;
      }
    }
    const displayWorktreePath = orphanedWorktreePath
      ? formatWorktreePathForDisplay(orphanedWorktreePath)
      : null;
    const localApi = readLocalApi();
    let canDeleteWorktree = false;
    if (
      orphanedWorktreePath !== null &&
      threadProject !== null &&
      !isScratchProject(threadProject, environmentConfig?.scratchWorkspaceRoot) &&
      localApi
    ) {
      const sessionResult = await loadSessionState(threadRef.environmentId);
      const permissionFailure = threadOperationFailure(threadRef);
      if (permissionFailure) return permissionFailure;
      canDeleteWorktree =
        sessionResult._tag === "Success" &&
        sessionGrantsScope(sessionResult.value, AuthSourceControlWriteScope);
    }
    let shouldDeleteWorktree = false;
    const environmentSettings = environmentConfig?.settings;
    const automaticWorktreeCleanup = environmentSettings
      ? resolveWorktreeCleanup(environmentSettings, thread.projectId).worktreeOnDelete
      : false;
    if (canDeleteWorktree && localApi && !automaticWorktreeCleanup) {
      const confirmationResult = await settlePromise(() =>
        localApi.dialogs.confirm(
          [
            "This thread is the only one linked to this worktree:",
            displayWorktreePath ?? orphanedWorktreePath,
            "",
            "Delete the worktree too?",
          ].join("\n"),
          { variant: "destructive" },
        ),
      );
      if (confirmationResult._tag === "Failure") {
        return confirmationResult;
      }
      shouldDeleteWorktree = confirmationResult.value;
    }

    // A queued thread is not sent while it is stopped and deleted, and leaves the Queue once
    // it is gone.
    const threadKey = scopedThreadKey(threadRef);
    const { deleteResult, shouldNavigateToFallback, fallbackThreadId } =
      await whileLeavingThreadQueue(threadKey, async () => {
        if (thread.runtime !== null) {
          await stopThreadSession({
            environmentId: threadRef.environmentId,
            input: { threadId: threadRef.threadId },
          });
        }

        const deletedThreadIds = deletedIds ?? new Set<ThreadId>();
        const currentRouteThreadRef = getCurrentRouteThreadRef();
        const shouldNavigateToFallback =
          currentRouteThreadRef?.threadId === threadRef.threadId &&
          currentRouteThreadRef.environmentId === threadRef.environmentId;
        const fallbackThreadId = getFallbackThreadIdAfterDelete({
          threads,
          deletedThreadId: threadRef.threadId,
          deletedThreadIds,
          sortOrder: sidebarThreadSortOrder,
        });
        const deleteResult = await deleteThreadMutation({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        });
        if (deleteResult._tag === "Success") leaveQueueForRemoval(threadKey);
        return { deleteResult, shouldNavigateToFallback, fallbackThreadId };
      });
    if (deleteResult._tag === "Failure") {
      return deleteResult;
    }
    refreshArchivedThreadsForEnvironment(threadRef.environmentId);
    releaseComposerDraftUploads(threadRef);
    clearComposerDraftForThread(threadRef);
    clearProjectDraftThreadById(
      scopeProjectRef(threadRef.environmentId, thread.projectId),
      threadRef,
    );
    clearTerminalUiState(threadRef);
    clearThreadPreviewState(threadRef);

    if (shouldNavigateToFallback) {
      const fallbackThread = fallbackThreadId
        ? readThreadShell(scopeThreadRef(threadRef.environmentId, fallbackThreadId))
        : null;
      await navigateAfterThreadDeletion(() =>
        fallbackThread
          ? router.navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(
                scopeThreadRef(fallbackThread.environmentId, fallbackThread.id),
              ),
              replace: true,
            })
          : router.navigate({ to: "/", replace: true }),
      );
    }

    if (!shouldDeleteWorktree || !orphanedWorktreePath || !threadProject) {
      return deleteResult;
    }

    const removeResult = readEnvironmentScope(threadRef.environmentId, AuthSourceControlWriteScope)
      ? await removeWorktree({
          environmentId: threadRef.environmentId,
          input: {
            cwd: threadProject.workspaceRoot,
            path: orphanedWorktreePath,
            force: true,
          },
        })
      : AsyncResult.failure(
          Cause.fail(
            new EnvironmentAuthorizationError({
              message: "This connection can no longer remove worktrees.",
              requiredScope: AuthSourceControlWriteScope,
            }),
          ),
        );
    const refreshResult =
      removeResult._tag === "Success"
        ? await refreshVcsStatus({
            environmentId: threadRef.environmentId,
            input: { cwd: threadProject.workspaceRoot },
          })
        : null;
    const cleanupFailure =
      removeResult._tag === "Failure"
        ? removeResult
        : refreshResult?._tag === "Failure"
          ? refreshResult
          : null;
    if (cleanupFailure) {
      const removalFailed = removeResult._tag === "Failure";
      const error = squashAtomCommandFailure(cleanupFailure);
      const message = error instanceof Error ? error.message : "An error occurred.";
      console.error("Worktree cleanup failed after thread deletion", {
        threadId: threadRef.threadId,
        projectCwd: threadProject.workspaceRoot,
        worktreePath: orphanedWorktreePath,
        error,
      });
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: removalFailed
            ? "Failed to delete worktree"
            : "Worktree deleted, but Git status refresh failed",
          description: removalFailed
            ? `Could not remove ${displayWorktreePath ?? orphanedWorktreePath}. ${message}`
            : message,
        }),
      );
      // Cleanup has its own toast; reporting its failure would falsely imply deletion failed.
    }
    return deleteResult;
  };

  const unsettleThread = async (target: ScopedThreadRef) => {
    if (!readEnvironmentServerConfigLoaded(target.environmentId)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadSettlementUnsupportedError({
            environmentId: target.environmentId,
            threadId: target.threadId,
          }),
        ),
      );
    }
    ThreadUndo.invalidate("settle", scopedThreadKey(target));
    // reason "user" pins active until real activity, suppressing auto-settle.
    return unsettleThreadMutation({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, reason: "user" },
    });
  };

  const setThreadAutoSettle = async (target: ScopedThreadRef, enabled: boolean) => {
    if (!readEnvironmentSupportsAutoSettleOptOut(target.environmentId)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadAutoSettleOptOutUnsupportedError({
            environmentId: target.environmentId,
            threadId: target.threadId,
          }),
        ),
      );
    }
    return setThreadAutoSettleMutation({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, enabled },
    });
  };

  const pinThread = async (target: ScopedThreadRef, opts: { orderKey?: string } = {}) => {
    if (!readEnvironmentServerConfigLoaded(target.environmentId)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadPinningUnsupportedError({
            environmentId: target.environmentId,
            threadId: target.threadId,
          }),
        ),
      );
    }
    const orderKey = opts.orderKey ?? topOfPinnedRunOrderKey();
    ThreadUndo.invalidate("pin", scopedThreadKey(target));
    // Pinning clears snooze, so older Settled or Snoozed undos would fight this pin.
    ThreadUndo.invalidate("settle", scopedThreadKey(target));
    ThreadUndo.invalidate("snooze", scopedThreadKey(target));
    return pinThreadMutation({
      environmentId: target.environmentId,
      input: {
        threadId: target.threadId,
        ...(orderKey !== undefined ? { orderKey } : {}),
      },
    });
  };

  const unpinThread = async (target: ScopedThreadRef) => {
    if (!readEnvironmentServerConfigLoaded(target.environmentId)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadPinningUnsupportedError({
            environmentId: target.environmentId,
            threadId: target.threadId,
          }),
        ),
      );
    }
    const thread = readThreadShell(target);
    const undoPlan = ThreadUndo.planThreadUndo("unpin", thread);
    const action = ThreadUndo.begin("pin", scopedThreadKey(target));
    const result = await unpinThreadMutation({
      environmentId: target.environmentId,
      input: { threadId: target.threadId },
    });
    if (result._tag === "Success" && action.isCurrent()) {
      showThreadUndoNotice({
        action: "Unpinned",
        claim: action,
        undo: () => runUndoPlan(target, undoPlan),
        failureTitle: "Failed to undo unpin",
      });
    } else {
      action.finish();
    }
    return result;
  };

  const unsnoozeThread = async (target: ScopedThreadRef) => {
    if (!readEnvironmentServerConfigLoaded(target.environmentId)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadSnoozeUnsupportedError({
            environmentId: target.environmentId,
            threadId: target.threadId,
          }),
        ),
      );
    }
    ThreadUndo.invalidate("snooze", scopedThreadKey(target));
    return unsnoozeThreadMutation({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, reason: "user" },
    });
  };

  const settleThread = async (target: ScopedThreadRef) => {
    if (!readEnvironmentServerConfigLoaded(target.environmentId)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadSettlementUnsupportedError({
            environmentId: target.environmentId,
            threadId: target.threadId,
          }),
        ),
      );
    }
    const resolved = resolveThreadTarget(target);
    // oxlint-disable-next-line react/purity -- runs in an event handler (oxc#27309)
    const now = new Date().toISOString();
    const wokeAt = resolved ? threadWokeAt(resolved.thread, { now }) : null;
    // The server's settle drops the pin but keeps the snooze, so a snoozed thread would stay
    // on the Snoozed shelf: it is woken below once the settle landed, as a drop from Snoozed
    // to Settled does. Undo puts both back.
    const undoPlan = ThreadUndo.planThreadUndo("settle", resolved?.thread);
    const wakeAfterSettle = resolved !== null && effectiveSnoozed(resolved.thread, { now });
    // An older unpin/snooze Undo would re-pin or re-snooze, and the server
    // treats either as a promotion that un-settles; settling supersedes them.
    ThreadUndo.invalidate("pin", scopedThreadKey(target));
    ThreadUndo.invalidate("snooze", scopedThreadKey(target));
    const action = ThreadUndo.begin("settle", scopedThreadKey(target));
    const result = await settleThreadMutation({
      environmentId: target.environmentId,
      input: { threadId: target.threadId },
    });
    if (result._tag !== "Success") {
      action.finish();
      return result;
    }
    if (wokeAt !== null) {
      markThreadVisited(scopedThreadKey(target), wokeAt);
    }
    showThreadUndoNotice({
      action: "Settled",
      claim: action,
      undo: () => runUndoPlan(target, undoPlan),
      failureTitle: "Failed to undo settle",
    });
    // Not awaited: the caller navigates on the settle alone, as the drop always did. The wake is
    // sent before Undo can be clicked, so the server still applies it first.
    if (wakeAfterSettle) {
      void unsnoozeThread(target).then((woke) => {
        if (woke._tag === "Success" || isAtomCommandInterrupted(woke)) return;
        const error = squashAtomCommandFailure(woke);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to wake thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      });
    }
    return result;
  };

  const confirmAndUnpinThread = async (target: ScopedThreadRef) => {
    const permissionFailure = threadOperationFailure(target);
    if (permissionFailure) return permissionFailure;
    const localApi = readLocalApi();
    const resolved = resolveThreadTarget(target);
    const confirmationResult = await requestThreadUnpinConfirmation({
      enabled: confirmThreadUnpin,
      title: resolved?.thread.title ?? "this thread",
      confirm: localApi ? (message) => localApi.dialogs.confirm(message) : null,
    });
    if (confirmationResult._tag === "Failure") {
      return confirmationResult;
    }
    if (!confirmationResult.value) {
      return AsyncResult.success(undefined);
    }
    return unpinThread(target);
  };

  const reorderPinnedThread = async (target: ScopedThreadRef, orderKey: string) => {
    if (!readEnvironmentServerConfigLoaded(target.environmentId)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadPinReorderUnsupportedError({
            environmentId: target.environmentId,
            threadId: target.threadId,
          }),
        ),
      );
    }
    ThreadUndo.invalidate("pin", scopedThreadKey(target));
    return reorderPinnedThreadMutation({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, orderKey },
    });
  };

  const reorderActiveThread = async (target: ScopedThreadRef, orderKey: string) => {
    if (!readEnvironmentServerConfigLoaded(target.environmentId)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadActiveReorderUnsupportedError({
            environmentId: target.environmentId,
            threadId: target.threadId,
          }),
        ),
      );
    }
    return reorderActiveThreadMutation({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, orderKey },
    });
  };

  const setThreadSidebarSection = async (target: ScopedThreadRef, sectionId: string | null) => {
    if (!readEnvironmentSupportsSidebarSections(target.environmentId)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadSidebarSectionsUnsupportedError({
            environmentId: target.environmentId,
            threadId: target.threadId,
          }),
        ),
      );
    }
    return setThreadSidebarSectionMutation({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, sectionId },
    });
  };

  /**
   * Move to section (`sectionName` null is Active): membership first, then clear what outranks it,
   * toasting the failed step; the unpin has no Undo (re-pinning would undo the move). True when the
   * membership landed or was already there; false for a deleted section, unknown thread or failed write.
   */
  const moveThreadToSidebarSection = async (
    target: ScopedThreadRef,
    sectionId: string | null,
    sectionName: string | null,
  ): Promise<boolean> => {
    // The menu or palette may have been built before a peer deleted the section: moving into
    // it would strip the pin, settle and snooze and leave the thread in plain Active.
    const live = resolveSidebarSections(appAtomRegistry.get(primaryServerConfigAtom));
    if (sidebarSectionGone(live, sectionId)) {
      toastManager.add(
        stackedThreadToast({
          type: "info",
          title: "Section was deleted",
          description: "The thread was not moved.",
        }),
      );
      return false;
    }
    const thread = readThreadShell(target);
    if (thread === null) return false;
    const plan = planSidebarSectionMove(thread, sectionId, new Date().toISOString());
    if (plan === null) return true;
    const failure = await runSidebarSectionMove(plan, {
      section: () => setThreadSidebarSection(target, plan.sectionId),
      unpin: () => {
        ThreadUndo.invalidate("pin", scopedThreadKey(target));
        return unpinThreadMutation({
          environmentId: target.environmentId,
          input: { threadId: target.threadId },
        });
      },
      unsettle: () => unsettleThread(target),
      unsnooze: () => unsnoozeThread(target),
    });
    if (failure === null) return true;
    if (!isAtomCommandInterrupted(failure.result)) {
      const error = squashAtomCommandFailure(failure.result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: sidebarSectionMoveFailureTitle(failure.step, sectionName),
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
    // Every step after the membership write leaves the membership set; a failed unpin,
    // unsettle or unsnooze still outranks it, and was toasted above.
    return failure.step !== "section";
  };

  const snoozeThread = async (target: ScopedThreadRef, snoozedUntil: string) => {
    if (!readEnvironmentServerConfigLoaded(target.environmentId)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadSnoozeUnsupportedError({
            environmentId: target.environmentId,
            threadId: target.threadId,
          }),
        ),
      );
    }
    const resolved = resolveThreadTarget(target);
    // oxlint-disable-next-line react/purity -- runs in an event handler (oxc#27309)
    if (resolved && !canSnooze(resolved.thread, { now: new Date().toISOString() })) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadSnoozeBlockedError({
            environmentId: resolved.threadRef.environmentId,
            threadId: resolved.threadRef.threadId,
          }),
        ),
      );
    }
    // A queued thread leaves the Queue when it snoozes; a read-only Queue cannot let it go,
    // and its send would wake it. The drag never offers this drop.
    if (queueRefusesSnooze(scopedThreadKey(target))) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadSnoozeQueueReadOnlyError({
            environmentId: target.environmentId,
            threadId: target.threadId,
          }),
        ),
      );
    }
    const threadKey = scopedThreadKey(target);
    const action = ThreadUndo.begin("snooze", threadKey);
    // Every snooze, menu or drop, takes the thread out of the Queue once it landed; Undo puts
    // it back. Until then the Queue does not send it; a failed snooze leaves it sendable.
    let requeue: (() => void) | undefined;
    const result = await whileLeavingThreadQueue(threadKey, async () => {
      const snoozed = await snoozeThreadMutation({
        environmentId: target.environmentId,
        input: { threadId: target.threadId, snoozedUntil },
      });
      if (snoozed._tag === "Success") requeue = leaveQueueForUndo(threadKey);
      return snoozed;
    });
    if (result._tag !== "Success") {
      action.finish();
      return result;
    }
    showThreadUndoNotice({
      action: "Snoozed",
      claim: action,
      undo: async () => {
        const woke = await runUndoPlan(target, ThreadUndo.planThreadUndo("snooze"));
        if (woke._tag === "Success") requeue?.();
        return woke;
      },
      failureTitle: "Failed to wake thread",
    });
    return result;
  };

  const runUndoPlan = (target: ScopedThreadRef, plan: ThreadUndo.ThreadUndoPlan) =>
    ThreadUndo.executeThreadUndo(
      plan,
      async (step) => {
        switch (step.action) {
          case "unsettle":
            return unsettleThread(target);
          case "unsnooze":
            return unsnoozeThread(target);
          case "pin":
            return pinThread(
              target,
              step.orderKey === undefined ? {} : { orderKey: step.orderKey },
            );
          case "snooze":
            return snoozeThreadMutation({
              environmentId: target.environmentId,
              input: { threadId: target.threadId, snoozedUntil: step.snoozedUntil },
            });
        }
      },
      (result) => result._tag === "Success",
    );

  const confirmAndDeleteThread = async (target: ScopedThreadRef) => {
    const permissionFailure = threadOperationFailure(target);
    if (permissionFailure) return permissionFailure;
    const localApi = readLocalApi();
    const resolved = resolveThreadTarget(target);

    if (confirmThreadDelete && localApi) {
      const title = resolved?.thread.title ?? "this thread";
      const confirmationResult = await settlePromise(() =>
        localApi.dialogs.confirm(
          [
            `Delete thread "${title}"?`,
            "This permanently clears conversation history for this thread.",
          ].join("\n"),
          { variant: "destructive" },
        ),
      );
      if (confirmationResult._tag === "Failure") {
        return confirmationResult;
      }
      if (!confirmationResult.value) {
        return AsyncResult.success(undefined);
      }
    }

    return deleteThread(target);
  };

  return {
    archiveThread,
    unarchiveThread,
    deleteThread,
    confirmAndDeleteThread,
    settleThread,
    unsettleThread,
    snoozeThread,
    unsnoozeThread,
    pinThread,
    unpinThread,
    confirmAndUnpinThread,
    reorderPinnedThread,
    reorderActiveThread,
    setThreadSidebarSection,
    moveThreadToSidebarSection,
    markThreadUnread,
    setThreadAutoSettle,
    turnThreadIntoProject: (target: ScopedThreadRef) =>
      createProjectFromThread({
        environmentId: target.environmentId,
        input: { threadId: target.threadId },
      }),
  };
}
