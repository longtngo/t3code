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

### Window definition (bounded three ways)

The initial snapshot loads the most recent slice bounded by **whichever limit hits first**:
- **latest ~15 turns** (coherent unit — matches how the chat renders, from `projection_turns` ordered by `requested_at`), AND
- **a hard cap of ~2000 rows** total across messages+activities+plans+checkpoints, AND
- **the FE's "what I already have" cursor** (below) — the snapshot excludes rows the client already holds, so a re-open re-sends nothing it already has.

The hard row cap is load-bearing: activities are wildly skewed (a single mega-turn can carry thousands of `task.progress` events), so a pure turn count does not bound the payload. This mirrors Matrix's model — return the most-recent slice *up to my cap* and signal that more exists.

### The FE "what I already have" cursor (in-session delta)

On (re)subscribe, the client sends its **newest-known keyset cursor** for the thread (`haveNewest: (created_at, id)`, optional). When present, the snapshot branch returns **only rows newer than it** (the forward catch-up), still capped by the window — so an in-session re-open (switch away and back) re-sends only what changed while away, often nothing. When absent (cold client / after a page refresh), the full capped window is returned.

This is deliberately scoped to **in-session** benefit: the web client does **not** persist thread history across a page refresh (only composer drafts + editor prefs are in `localStorage`), so after a refresh the FE has no cursor and gets the full capped window — which is already bounded. The cross-refresh version (persist history in IndexedDB → fetch only the delta on every load, Linear-style) is a **deferred follow-up**, not in this feature.

Relationship to the existing mechanism: `subscribeThread` already takes `fromSequenceExclusive` (the forward high-water mark on the global event `sequence`) and, for a small gap (`< RESUME_MAX_MISSED_EVENTS = 500`), replays missed live events instead of a snapshot (`ws.ts:1030-1059`). `haveNewest` extends the same "send only what I lack" principle to the **snapshot path** (large gap / snapshot fallback), so a warm re-open never re-sends the recent window. `fromSequenceExclusive` continues to drive the live tail unchanged; `haveNewest` only trims the snapshot.

### Cursor — tie-safe keyset

The backward history cursor is a keyset on **`(created_at, id)`** (using the monotonic `sequence` on `projection_thread_activities` / `orchestration_events` where available), **not** a bare `created_at` — timestamps collide (many activities per millisecond) and a bare-timestamp boundary would drop or duplicate rows at the seam.

This backward axis is **independent** of the existing forward high-water mark (`fromSequenceExclusive`, the global event `sequence`). The live tail keeps appending new events forward; backfill only pulls already-projected, stable *old* rows backward. No conflict — exactly Matrix's `next_batch` (forward) vs `prev_batch` (backward) split.

### Server changes

1. **`getThreadDetailById` gains an optional window bound.** New optional params: `windowTurns` (latest N turns) and `maxRows`. The query resolves a lower-bound keyset boundary = the newer of (start of the Nth-newest turn) and (the row that leaves `maxRows` rows), then each per-thread query adds `WHERE (created_at, id) >= :boundary ORDER BY created_at ASC, id ASC`. Existing callers pass neither → **unchanged full behavior** (backward compatible). The resolved boundary is returned as `oldestLoaded`.
   - File: `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`.

2. **`subscribeThread` snapshot branch returns a capped snapshot + pagination metadata, trimmed by the FE cursor.** New input field **`haveNewest`** (optional `(created_at, id)`); new snapshot fields **`oldestLoaded`** (keyset cursor of the oldest row in the window) and **`hasMoreHistory`** (does any row exist before it). When `haveNewest` is present, the window query adds `WHERE (created_at, id) > :haveNewest` so only rows the FE lacks are returned. The live-tail path (`liveStreamAfter`, `ws.ts:1014`) and `fromSequenceExclusive` replay are unchanged.
   - Files: `apps/server/src/ws.ts` (snapshot branch ~`:1061`), contract `packages/contracts/src/orchestration.ts`.

3. **New unary RPC `orchestration.getThreadHistoryPage`.** Input `{ threadId, before: <keyset cursor>, limitTurns: 25, maxRows: 3000 }`. Returns the next older page (messages/activities/plans/checkpoints in that older window) + a fresh `oldestLoaded` + `hasMoreHistory`. Read-only request/response — deliberately **not** part of the streaming subscription, so the ordered-send / stream-window path is untouched.
   - Files: contract `packages/contracts/src/orchestration.ts`, handler in `apps/server/src/ws.ts` (or the RPC group it lives in), query in `ProjectionSnapshotQuery.ts`.

### Client changes

1. **`syncServerThreadDetail` becomes merge/upsert, not wholesale replace.** Today it replaces the thread detail (`apps/web/src/environments/runtime/service.ts:429`). It becomes an **upsert by id** into the existing per-thread collections (union, re-sorted by `(created_at, id)`), so a re-open or a live event never wipes already-backfilled history. All merges dedup by stable id — Slack's "may receive twice, dedup by ID."

2. **Per-thread client state** gains `{ oldestLoaded, hasMoreHistory, backfillGeneration }`. On (re)subscribe, the client passes `haveNewest` = the newest `(created_at, id)` it currently holds for the thread (from the in-memory merged store), or omits it when it holds nothing (cold / post-refresh). This is what makes an in-session re-open re-fetch only the delta.

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

- **Server unit:** `getThreadDetailById` with boundary + `maxRows` returns exactly the window; boundary resolves correctly when the row cap bites before the turn cap; `haveNewest` trims the snapshot to only newer rows (warm re-subscribe → delta, often empty; cold → full window); `getThreadHistoryPage` returns the correct older page with accurate `oldestLoaded`/`hasMoreHistory`; **tie-safety** — two rows sharing a `created_at` are neither dropped nor duplicated across a page boundary or the `haveNewest` trim.
- **Client unit:** merge/upsert dedups by id and re-sorts; backfill loop terminates on `hasMoreHistory === false`; `backfillGeneration` cancellation on thread-switch; scroll position preserved across a prepend.
- **Integration:** open a large thread → snapshot is small (bounded) → backfill converges to a loaded set **identical to the server's full set** (FE == BE), and the live tail still delivers new turns during/after backfill.

## Rollout / revert

Backward compatible: default (no cursor) callers of `getThreadDetailById` keep full behavior; the new RPC is additive; the client merge is a superset of the old replace. No wire-format changes. Independent of the stream-codec work (Issue 1), which stays disabled.
