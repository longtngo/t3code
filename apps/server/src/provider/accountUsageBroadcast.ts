/**
 * accountUsageBroadcast — the poll/cache/fan-out step every account-usage
 * adapter runs, in one place.
 *
 * Claude, Codex and Cursor each carried a byte-identical copy of it, so the
 * one thing it got wrong was wrong three times: the fan-out reached only
 * threads with a live provider session, and a refresh pressed on an idle
 * thread updated nothing while the RPC still answered `ok`. That is not an
 * edge case — every Cursor session on a developer machine measured `stopped`,
 * and 451 of 458 Claude ones.
 *
 * @module accountUsageBroadcast
 */
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import type { AccountUsageUpdatedPayload, ThreadId } from "@t3tools/contracts";

export interface AccountUsageBroadcastDeps<TError> {
  /** Fetch a fresh snapshot, or `null` when auth is missing or the call fails. */
  readonly poll: Effect.Effect<AccountUsageUpdatedPayload | null>;
  /** Cache of the last good snapshot, re-broadcast when a session starts. */
  readonly lastUsageRef: Ref.Ref<AccountUsageUpdatedPayload | null>;
  /** Threads this adapter currently holds a live session for. */
  readonly liveThreadIds: () => Iterable<ThreadId>;
  /** Emit one `account.usage.updated` runtime event for a thread. */
  readonly emitForThread: (
    threadId: ThreadId,
    payload: AccountUsageUpdatedPayload,
  ) => Effect.Effect<void, TError>;
}

/**
 * Build the adapter's `refreshAccountUsage`: poll, cache, and emit one
 * `account.usage.updated` per target thread.
 *
 * `requestedThreadId` is the thread whose UI asked for the refresh. It is
 * added to the live sessions rather than replacing them, and the targets are a
 * `Set`, so a thread that is both live and requested is emitted for once.
 *
 * Resolves with the number of events emitted. Callers log it: a poll that
 * succeeds and reaches nobody is otherwise indistinguishable from one that
 * worked, which is the shape of the bug this module exists to fix.
 */
export const makeAccountUsageBroadcast =
  <TError>(deps: AccountUsageBroadcastDeps<TError>) =>
  (requestedThreadId?: ThreadId): Effect.Effect<number, TError> =>
    Effect.gen(function* () {
      const payload = yield* deps.poll;
      if (payload === null) return 0;
      yield* Ref.set(deps.lastUsageRef, payload);
      const targets = new Set(deps.liveThreadIds());
      if (requestedThreadId !== undefined && requestedThreadId.length > 0) {
        targets.add(requestedThreadId);
      }
      yield* Effect.forEach(targets, (threadId) => deps.emitForThread(threadId, payload), {
        discard: true,
      });
      return targets.size;
    });
