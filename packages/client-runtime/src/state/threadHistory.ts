import type {
  EnvironmentId as EnvironmentIdType,
  OrchestrationHistoryCursor,
  OrchestrationThreadHistoryPageResult,
  ScopedThreadRef,
  ThreadId as ThreadIdType,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { threadKey } from "./entities.ts";
import { createEnvironmentCommand } from "./runtime.ts";
import { loadOlderThreadHistory } from "./threadHistoryBackfill.ts";
import { THREAD_STATE_IDLE_TTL_MS } from "./threadRetention.ts";
import type { EnvironmentThreadState } from "./threadState.ts";

/**
 * Older-history backfill store (the client half of ITEM 2's windowed thread load).
 *
 * A thread snapshot only ever carries the most recent turns; everything older is
 * reachable only through the `getThreadHistoryPage` RPC. This module holds the
 * pages a thread has paged back so far, keyed per thread, so
 * {@link ../state/threadDetail.ts} can fold them into the rendered thread and the
 * UI can offer a "load earlier" affordance.
 *
 * Deliberately NOT part of `EnvironmentThreadState`: backfilled pages are a local
 * view concern, must not be written back into the persisted thread cache (which
 * would grow without bound), and are cheap to re-fetch. Keeping them beside the
 * thread state means a reconnect/resync replaces the live window without
 * discarding what the reader already paged back.
 */

/** Page size requested per "load earlier" step. The server clamps both DOWN. */
export const THREAD_HISTORY_PAGE_TURNS = 15;
export const THREAD_HISTORY_PAGE_ROWS = 2_000;

export interface ThreadHistoryBackfillState {
  /** Every older row paged back so far, merged and deduped. `null` before the first page. */
  readonly pages: OrchestrationThreadHistoryPageResult | null;
  /** Cursor reached by the last fetched page; `null` while no page has been fetched. */
  readonly oldestLoaded: OrchestrationHistoryCursor | null;
  /**
   * Whether still-older turns remain, per the last fetched page. `null` means "no
   * page fetched yet" — the answer then comes from the snapshot's own
   * `hasMoreHistory`, not from this store.
   */
  readonly hasMore: boolean | null;
  readonly isLoading: boolean;
  readonly error: string | null;
}

export const EMPTY_THREAD_HISTORY_BACKFILL_STATE: ThreadHistoryBackfillState = Object.freeze({
  pages: null,
  oldestLoaded: null,
  hasMore: null,
  isLoading: false,
  error: null,
});

/**
 * Per-thread backfill state. Module-level (not built from a runtime) so both the
 * detail atoms and the load command address the same instance without threading
 * an accessor through every construction site.
 */
export const threadHistoryBackfillAtom = Atom.family((key: string) =>
  Atom.make(EMPTY_THREAD_HISTORY_BACKFILL_STATE).pipe(
    Atom.setIdleTTL(THREAD_STATE_IDLE_TTL_MS),
    Atom.withLabel(`thread-history-backfill:${key}`),
  ),
);

export function getThreadHistoryBackfillAtom(ref: ScopedThreadRef) {
  return threadHistoryBackfillAtom(threadKey(ref));
}

function concatUnique<A>(
  existing: ReadonlyArray<A>,
  incoming: ReadonlyArray<A>,
  keyOf: (item: A) => string,
): ReadonlyArray<A> {
  if (incoming.length === 0) {
    return existing;
  }
  const seen = new Set(existing.map(keyOf));
  const added = incoming.filter((item) => !seen.has(keyOf(item)));
  return added.length === 0 ? existing : [...existing, ...added];
}

/**
 * Accumulate a freshly fetched older page onto the pages already held. Deduped by
 * row identity so re-fetching a page (a retry, or a resubscribe that re-issues the
 * same cursor) cannot double-insert rows. Ordering is not established here — the
 * fold into the thread sorts the combined history.
 */
export function mergeOlderHistoryPages(
  existing: OrchestrationThreadHistoryPageResult | null,
  page: OrchestrationThreadHistoryPageResult,
): OrchestrationThreadHistoryPageResult {
  if (existing === null) {
    return page;
  }
  return {
    messages: concatUnique(existing.messages, page.messages, (row) => row.id),
    activities: concatUnique(existing.activities, page.activities, (row) => row.id),
    proposedPlans: concatUnique(existing.proposedPlans, page.proposedPlans, (row) => row.id),
    checkpoints: concatUnique(existing.checkpoints, page.checkpoints, (row) => row.turnId),
    ...(page.oldestLoaded === undefined ? {} : { oldestLoaded: page.oldestLoaded }),
    hasMoreHistory: page.hasMoreHistory,
  };
}

export interface ResolvedThreadHistory {
  /** Where the next page should start from; `null` when paging is not possible. */
  readonly cursor: OrchestrationHistoryCursor | null;
  /** Whether a "load earlier" affordance should be offered. */
  readonly canLoadOlder: boolean;
  readonly isLoading: boolean;
  readonly error: string | null;
}

/**
 * Combine what the snapshot said about the window with what paging has since
 * learned. The backfill store wins once it holds a page, because it has paged
 * strictly further back than the snapshot did.
 */
export function resolveThreadHistory(
  threadState: Pick<EnvironmentThreadState, "oldestLoaded" | "hasMoreHistory">,
  backfill: ThreadHistoryBackfillState,
): ResolvedThreadHistory {
  const cursor = backfill.oldestLoaded ?? threadState.oldestLoaded ?? null;
  const hasMore = backfill.hasMore ?? threadState.hasMoreHistory;
  return {
    cursor,
    // A `hasMore` with no cursor to page from is unusable; treat it as done so
    // the UI never offers a button that cannot do anything.
    canLoadOlder: hasMore && cursor !== null,
    isLoading: backfill.isLoading,
    error: backfill.error,
  };
}

export interface LoadOlderHistoryInput {
  readonly threadId: ThreadIdType;
  /** The window cursor from the thread snapshot, used until a page has been fetched. */
  readonly snapshotCursor: OrchestrationHistoryCursor | undefined;
  readonly snapshotHasMore: boolean;
}

function backfillErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Could not load earlier messages.";
}

export function createThreadHistoryCommands<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const loadOlder = createEnvironmentCommand(runtime, {
    label: "thread-history:load-older",
    // Serial per thread: two overlapping fetches would page from the same cursor
    // and return the same rows, and the second would clobber the first's cursor.
    concurrency: {
      mode: "serial",
      key: (target: {
        readonly environmentId: EnvironmentIdType;
        readonly input: LoadOlderHistoryInput;
      }) => `${target.environmentId}:${target.input.threadId}`,
    },
    execute: (input: LoadOlderHistoryInput, registry, environmentId) =>
      Effect.suspend(() => {
        const stateAtom = threadHistoryBackfillAtom(
          threadKey({ environmentId, threadId: input.threadId }),
        );
        const current = registry.get(stateAtom);
        const resolved = resolveThreadHistory(
          { oldestLoaded: input.snapshotCursor, hasMoreHistory: input.snapshotHasMore },
          current,
        );
        if (current.isLoading || !resolved.canLoadOlder || resolved.cursor === null) {
          return Effect.void;
        }
        const cursor = resolved.cursor;
        registry.set(stateAtom, { ...current, isLoading: true, error: null });
        return loadOlderThreadHistory({
          threadId: input.threadId,
          beforeTurn: cursor,
          maxTurns: THREAD_HISTORY_PAGE_TURNS,
          maxRows: THREAD_HISTORY_PAGE_ROWS,
        }).pipe(
          Effect.tap((page) =>
            Effect.sync(() => {
              const latest = registry.get(stateAtom);
              registry.set(stateAtom, {
                pages: mergeOlderHistoryPages(latest.pages, page),
                oldestLoaded: page.oldestLoaded ?? latest.oldestLoaded,
                hasMore: page.hasMoreHistory,
                isLoading: false,
                error: null,
              });
            }),
          ),
          Effect.tapError((error) =>
            Effect.sync(() => {
              registry.set(stateAtom, {
                ...registry.get(stateAtom),
                isLoading: false,
                error: backfillErrorMessage(error),
              });
            }),
          ),
          // A defect (or an interrupt) must not strand the spinner on forever.
          Effect.onExit((exit) =>
            Effect.sync(() => {
              const latest = registry.get(stateAtom);
              if (exit._tag === "Failure" && latest.isLoading) {
                registry.set(stateAtom, { ...latest, isLoading: false });
              }
            }),
          ),
          Effect.asVoid,
        );
      }),
  });

  return {
    backfillAtom: (environmentId: EnvironmentIdType, threadId: ThreadIdType) =>
      threadHistoryBackfillAtom(threadKey({ environmentId, threadId })),
    loadOlder,
  };
}
