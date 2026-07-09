# Thread-load windowing + automatic backfill — design

**Date:** 2026-07-08 · **Status:** approved, pre-implementation
**Problem owner report:** `~/reports/t3code/2026-07/2026-07-08/2026-07-08-wire-and-snapshot-investigation.md`
**Research backing:** `~/reports/t3code/2026-07/2026-07-08/2026-07-08-message-sync-platform-research.md`

## Problem

Opening a thread streams the **entire** materialized thread history in one snapshot frame. `orchestration.subscribeThread`'s first frame is built by `getThreadDetailById` (`apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts:1919`), which runs four **unbounded** per-thread queries (messages, activities, proposed plans, checkpoints — none with a `LIMIT`). For the `sparse-attn-lab` thread this is **77,631 activities (~57 MB raw) → ~99 MB on the wire** (measured; the thread holds 13% of every activity row in the database). A large single frame is also the leading trigger for the wire-stream desync and adds latency.

## Goal

Cap the initial thread-open payload for fast first paint, then **automatically backfill older history in the background until the client's loaded set is identical to the server's** (FE == BE). No user action. This is the industry-standard pattern (Slack, Zulip, Matrix, Linear all cap the initial load + backfill via an independent backward cursor — see the research report).

Non-goals: reducing *total* bytes transferred (backfill still transfers everything, chunked); on-demand/lazy loading (we do automatic full backfill); changing the live-tail / forward reconnect machinery.

## Design

### Window definition (bounded two ways)

The initial snapshot loads the most recent slice bounded by **whichever limit hits first**:
- **latest ~15 turns** (coherent unit — matches how the chat renders, from `projection_turns` ordered by `requested_at`), AND
- **a hard cap of ~2000 rows** total across messages+activities+plans+checkpoints.

The hard row cap is load-bearing: activities are wildly skewed (a single mega-turn can carry thousands of `task.progress` events), so a pure turn count does not bound the payload. This mirrors Matrix's model — return the most-recent slice *up to my cap* and signal that more exists.

### Cursor — tie-safe keyset

The backward history cursor is a keyset on **`(created_at, id)`** (using the monotonic `sequence` on `projection_thread_activities` / `orchestration_events` where available), **not** a bare `created_at` — timestamps collide (many activities per millisecond) and a bare-timestamp boundary would drop or duplicate rows at the seam.

This backward axis is **independent** of the existing forward high-water mark (`fromSequenceExclusive`, the global event `sequence`). The live tail keeps appending new events forward; backfill only pulls already-projected, stable *old* rows backward. No conflict — exactly Matrix's `next_batch` (forward) vs `prev_batch` (backward) split.

### Server changes

1. **`getThreadDetailById` gains an optional window bound.** New optional params: `windowTurns` (latest N turns) and `maxRows`. The query resolves a lower-bound keyset boundary = the newer of (start of the Nth-newest turn) and (the row that leaves `maxRows` rows), then each per-thread query adds `WHERE (created_at, id) >= :boundary ORDER BY created_at ASC, id ASC`. Existing callers pass neither → **unchanged full behavior** (backward compatible). The resolved boundary is returned as `oldestLoaded`.
   - File: `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`.

2. **`subscribeThread` snapshot branch returns a capped snapshot + pagination metadata.** New snapshot fields: **`oldestLoaded`** (the keyset cursor of the oldest row in the window) and **`hasMoreHistory`** (does any row exist before it). The live-tail path (`liveStreamAfter`, `ws.ts:1014`) is unchanged.
   - Files: `apps/server/src/ws.ts` (snapshot branch ~`:1061`), contract `packages/contracts/src/orchestration.ts`.

3. **New unary RPC `orchestration.getThreadHistoryPage`.** Input `{ threadId, before: <keyset cursor>, limitTurns: 25, maxRows: 3000 }`. Returns the next older page (messages/activities/plans/checkpoints in that older window) + a fresh `oldestLoaded` + `hasMoreHistory`. Read-only request/response — deliberately **not** part of the streaming subscription, so the ordered-send / stream-window path is untouched.
   - Files: contract `packages/contracts/src/orchestration.ts`, handler in `apps/server/src/ws.ts` (or the RPC group it lives in), query in `ProjectionSnapshotQuery.ts`.

### Client changes

1. **`syncServerThreadDetail` becomes merge/upsert, not wholesale replace.** Today it replaces the thread detail (`apps/web/src/environments/runtime/service.ts:429`). It becomes an **upsert by id** into the existing per-thread collections (union, re-sorted by `(created_at, id)`), so a re-open or a live event never wipes already-backfilled history. All merges dedup by stable id — Slack's "may receive twice, dedup by ID."

2. **Per-thread client state** gains `{ oldestLoaded, hasMoreHistory, backfillGeneration }`.

3. **Backfill loop.** After the snapshot applies, if `hasMoreHistory`, a background loop calls `getThreadHistoryPage(before: oldestLoaded)` → prepend (upsert) → advance `oldestLoaded` → repeat **until `hasMoreHistory === false`** (the explicit stop — never a zero-row page, which could be a transient empty window). Paced with a small delay between pages. Cancellable via `backfillGeneration`, bumped on thread-switch/unmount, so a stale loop cannot write into the wrong thread.
   - File: `apps/web/src/environments/runtime/service.ts` (alongside `retainThreadDetailSubscription`).

4. **Scroll anchoring on prepend.** When prepending older rows above the viewport, preserve scroll position (measure `scrollHeight` before/after, restore the delta) so backfilled history does not yank the view. The only new UI-correctness detail.
   - File: the messages timeline component (`MessagesTimeline` / `ChatView`).

### Interaction with the forward live tail

Live events continue to append and advance `lastAppliedSequence` (forward axis) while backfill prepends old rows (backward axis). Both dedup by id; the two axes never touch. Reconnect mid-backfill: the existing forward reconnect path handles the live stream; backfill resumes from the current `oldestLoaded`.

## Edge cases

- **Empty / short thread** (fewer than a window's worth) → `hasMoreHistory: false` in the snapshot; no backfill runs.
- **Mega-turn exceeding the row cap** → the window returns a partial turn; backfill completes it on the next page (brief seam at the top, acceptable — Matrix's model).
- **Live event for a turn currently being backfilled** → id-dedup makes the merge idempotent.
- **Thread switch mid-backfill** → `backfillGeneration` bump cancels the stale loop.
- **Two rows with identical `created_at`** → the `(created_at, id)` keyset makes the boundary exact (no drop/dup).

## Testing

- **Server unit:** `getThreadDetailById` with boundary + `maxRows` returns exactly the window; boundary resolves correctly when the row cap bites before the turn cap; `getThreadHistoryPage` returns the correct older page with accurate `oldestLoaded`/`hasMoreHistory`; **tie-safety** — two rows sharing a `created_at` are neither dropped nor duplicated across a page boundary.
- **Client unit:** merge/upsert dedups by id and re-sorts; backfill loop terminates on `hasMoreHistory === false`; `backfillGeneration` cancellation on thread-switch; scroll position preserved across a prepend.
- **Integration:** open a large thread → snapshot is small (bounded) → backfill converges to a loaded set **identical to the server's full set** (FE == BE), and the live tail still delivers new turns during/after backfill.

## Rollout / revert

Backward compatible: default (no cursor) callers of `getThreadDetailById` keep full behavior; the new RPC is additive; the client merge is a superset of the old replace. No wire-format changes. Independent of the stream-codec work (Issue 1), which stays disabled.
