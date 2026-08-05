import { useAtomValue } from "@effect/atom-react";
import {
  createThreadHistoryCommands,
  EMPTY_THREAD_HISTORY_BACKFILL_STATE,
  getThreadHistoryBackfillAtom,
  resolveThreadHistory,
} from "@t3tools/client-runtime/state/threads";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";
import { Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { useAtomCommand } from "./use-atom-command";
import { useEnvironmentThread } from "./threads";

export const threadHistory = createThreadHistoryCommands(connectionAtomRuntime);

const EMPTY_BACKFILL_ATOM = Atom.make(EMPTY_THREAD_HISTORY_BACKFILL_STATE).pipe(
  Atom.withLabel("thread-history-backfill:none"),
);

export interface ThreadOlderHistory {
  /** Whether a "load earlier messages" affordance should be shown. */
  readonly canLoadOlder: boolean;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly loadOlder: () => void;
}

const NOOP = () => {};

/**
 * Older-history paging for one thread.
 *
 * Thread snapshots are windowed to the most recent turns, so on a long thread the
 * transcript starts mid-conversation until the reader pages back. This exposes
 * whether more history exists and the action that fetches the next page.
 */
export function useThreadOlderHistory(ref: ScopedThreadRef | null): ThreadOlderHistory {
  const threadState = useEnvironmentThread(ref?.environmentId ?? null, ref?.threadId ?? null);
  const backfill = useAtomValue(
    ref === null ? EMPTY_BACKFILL_ATOM : getThreadHistoryBackfillAtom(ref),
  );
  const runLoadOlder = useAtomCommand(threadHistory.loadOlder, { reportFailure: false });
  const resolved = useMemo(
    () => resolveThreadHistory(threadState, backfill),
    [backfill, threadState],
  );

  const environmentId = ref?.environmentId ?? null;
  const threadId = ref?.threadId ?? null;
  const snapshotCursor = threadState.oldestLoaded;
  const snapshotHasMore = threadState.hasMoreHistory;
  const loadOlder = useCallback(() => {
    if (environmentId === null || threadId === null) {
      return;
    }
    void runLoadOlder({
      environmentId,
      input: { threadId, snapshotCursor, snapshotHasMore },
    });
  }, [environmentId, runLoadOlder, snapshotCursor, snapshotHasMore, threadId]);

  return {
    canLoadOlder: resolved.canLoadOlder,
    isLoading: resolved.isLoading,
    error: resolved.error,
    loadOlder: ref === null ? NOOP : loadOlder,
  };
}
