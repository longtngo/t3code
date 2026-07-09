# Thread-load windowing + bounded backfill — design

**Date:** 2026-07-08 · **Status:** approved + design-reviewed (2 adversarial rounds), pre-implementation
**Problem report:** `~/reports/t3code/2026-07/2026-07-08/2026-07-08-wire-and-snapshot-investigation.md`
**Research backing:** `~/reports/t3code/2026-07/2026-07-08/2026-07-08-message-sync-platform-research.md`

## Problem

Opening a thread streams the **entire** materialized thread history in one snapshot frame. `orchestration.subscribeThread`'s first frame is built by `getThreadDetailById` (`ProjectionSnapshotQuery.ts:1919`) via four **unbounded** per-thread queries (messages/activities/plans/checkpoints — no `LIMIT`). For the `sparse-attn-lab` thread that is **77,631 activities (~57 MB raw) → ~99 MB on the wire** (measured; 13% of every activity row in the DB). The large single frame is wasteful and a latency/desync trigger.

## Key constraint discovered in design review (load-bearing)

The web client **already caps in-memory thread state per thread**: `MAX_THREAD_MESSAGES = 2000`, `MAX_THREAD_ACTIVITIES = 500`, `MAX_THREAD_CHECKPOINTS = 500`, `MAX_THREAD_PROPOSED_PLANS = 200` (`store.ts:129-132`), re-applied via `.slice(-N)` on **every live event** (`store.ts:1446,1587,1622,1667`). There is **no scrollback / "load older" UI**. Consequences:
- On an **active** thread, live events trim to these caps, so "backfill until FE == BE" is unreachable (the next event discards backfilled rows).
- On an **idle** thread, the unbounded snapshot loads the *full* history into the store (nothing trims it) — so the 99 MB is real **and** full scrollback exists today.

**Decision:** windowed initial load + **bounded backfill up to a ceiling** (not FE == BE). The ceiling *is* the (raised) client cap, so the live-event trim and the backfill target are the same number and never fight.

## Goal

Cap the initial thread-open payload for fast first paint (kills the 99 MB single frame), then backfill older history in the background up to a bounded ceiling, so the focused thread shows the most-recent window immediately and fills in older turns incrementally (much more scrollback than the current 500-activity active-thread cap, but bounded). Windowing is **opt-in per client** so non-updated clients (mobile) keep full-snapshot behavior.

Non-goals: FE == BE / unbounded scrollback (requires unbounded memory — that's a separate feature); reducing total bytes on a cold open (backfill still transfers up to the ceiling, chunked); `haveNewest` in-session delta (deferred — see below).

## Design

### Window = newest turns, bounded by a row cap, opt-in

The initial snapshot loads the most recent slice bounded by **whichever hits first**:
- **latest ~15 turns** (coherent unit — matches how the chat renders; from `projection_turns` ordered by `requested_at`), AND
- **a hard cap of ~2000 rows** total across the collections.

Windowing is requested via **new optional `subscribeThread` input fields** (`windowTurns`, `maxRows`). **When absent, the snapshot is the full thread** (backward-compatible; mobile and any not-yet-updated client are unchanged — BLOCKER guard C1). The three existing server callers of `getThreadDetailById` (checkpoint/provider reactors) pass nothing → full behavior.

The hard row cap is load-bearing: activities are wildly skewed (a single mega-turn can carry thousands of `task.progress` events), so a pure turn count does not bound the payload.

### Cursor = turn boundary, per-collection selection (NOT a uniform keyset)

The four collections do **not** share a `(created_at, id)` axis: messages sort `(created_at, message_id)`, plans `(created_at, plan_id)`, activities `(sequence, created_at, activity_id)` with **nullable `sequence`**, checkpoints are `projection_turns` rows with **no `created_at`/row id**, ordered by `checkpoint_turn_count`. So:

- The window/backfill cursor is a **turn boundary** — resolve the set of newest N `turn_id`s (bounded by `maxRows`), take the **oldest turn's `requested_at` + `turn_id`** as the boundary. Precedent: `getFullThreadDiffContext(threadId, toTurnCount)` (`ProjectionSnapshotQuery.ts:1835`).
- Each collection selects its rows for the in-window turns by its **own** predicate: messages/activities/plans by `turn_id ∈ window` (falling back to `created_at >= boundary.requested_at` for **null-`turn_id`** rows so ambient activities aren't lost), checkpoints by `checkpoint_turn_count >= boundaryTurnCount`.
- This boundary is **independent** of the forward high-water mark (`fromSequenceExclusive`, the global event `sequence`) — the live tail appends forward, backfill pulls older turns backward. No conflict.

### Server changes

1. **`getThreadDetailById` gains optional `windowTurns` + `maxRows`.** When set, resolve the boundary turn (latest N turns capped at `maxRows`), select each collection by the per-collection predicate above, and return the boundary as `oldestLoaded` ({requested_at, turn_id, checkpointTurnCount}) plus `hasMoreHistory`. When unset → unchanged full behavior.
   - `hasMoreHistory` = a real **EXISTS-before-boundary** check (any turn older than the boundary), not "did the page fill its limit" (F5).
   - File: `ProjectionSnapshotQuery.ts`.
2. **`subscribeThread` input gains optional `windowTurns`/`maxRows`; snapshot frame gains `oldestLoaded`/`hasMoreHistory`.** New snapshot fields are `Schema.optional` (additive both directions — a new client reading an old server, and vice-versa). Live-tail (`liveStreamAfter`, `ws.ts:1014`) and `fromSequenceExclusive` replay unchanged.
   - Files: `apps/server/src/ws.ts` (snapshot branch ~`:1061`), `packages/contracts/src/orchestration.ts`.
3. **New unary RPC `orchestration.getThreadHistoryPage`.** Input `{ threadId, beforeTurn: <boundary cursor>, maxTurns, maxRows }`. Returns the next older turn-page's **four collections only** (no thread head — F7) + fresh `oldestLoaded` + `hasMoreHistory`. Read-only request/response, off the streaming path (KEEP — S3; mirrors existing unary `replayEvents`/`getFullThreadDiff`).
   - Files: `orchestration.ts` (add to `OrchestrationRpcSchemas`), `ws.ts` handler, `ProjectionSnapshotQuery.ts` query.

### Client changes (web only; mobile keeps full-snapshot via opt-in)

1. **Raise the activity cap to the scrollback ceiling.** `MAX_THREAD_ACTIVITIES` 500 → **~3000** (tunable); messages/checkpoints/plans caps unchanged (2000/500/200). This ceiling is simultaneously the backfill target and the live-event trim, so they're consistent (resolves F1). Bounded memory; virtualized, so no DOM cost. (Tradeoff: an active mega-thread now re-sorts up to ~3000 activities per event instead of 500 — still sub-ms; noted.)
2. **`syncServerThreadDetail` becomes merge/upsert, not wholesale replace.** The four collections upsert by id, re-sorted with **per-collection comparators** (activities via the existing `compareActivities` sequence-first; messages/plans by `(created_at,id)`; checkpoints by `checkpoint_turn_count`) — F3. **Scalar/head fields (title/session/latestTurn) still replace** from the snapshot (F7). Deletion pruning is now **event-only** (`thread.reverted`, thread-removal) since replace no longer prunes — verified no code path deletes projection rows without a client-visible event (C2 — add a guard test).
3. **Backfill loop.** After a windowed snapshot, if `hasMoreHistory` and the ceiling isn't reached, a background loop calls `getThreadHistoryPage(beforeTurn: oldestLoaded)` → upsert older rows → advance `oldestLoaded` → repeat until **`hasMoreHistory === false` OR the ceiling is reached**. Single page in flight, paced, and **paused when the tab/thread is hidden** (`document.hidden`) — C4. State `{ oldestLoaded, hasMoreHistory }` lives on the existing `ThreadDetailSubscriptionEntry` (`service.ts:107`), whose dispose/evict path already cancels on thread-switch/unmount (S5 — no separate generation token needed).
4. **Scroll anchoring: nothing to build.** LegendList already sets `maintainVisibleContentPosition` (`MessagesTimeline.tsx:296`) with id-keyed rows, which holds position across a prepend. (CUT the manual scrollHeight approach — S1; add a prepend-doesn't-jump test.)

### Deferred: `haveNewest` in-session delta

Cut for v1 (S2). Its only benefit is in-session, but an in-session switch-away-and-back **does not re-subscribe** — the subscription stays warm for a 15-min TTL (`service.ts:409`, `THREAD_DETAIL_SUBSCRIPTION_IDLE_EVICTION_MS:177`), so no snapshot is re-sent and `haveNewest` never fires. The only re-subscribes are post-eviction / large-gap reconnect (rare), where the merge-upsert already prevents data loss. Revisit only if re-sending the *already-capped* window is measured to matter.

## Edge cases
- **Empty/short thread** → `hasMoreHistory:false`; no backfill.
- **Mega-turn exceeding the row cap** → partial turn in the initial window, completed by the next backfill page (brief top seam — Matrix's model).
- **Null-`turn_id` rows** → selected by `created_at >= boundary.requested_at` so ambient activities aren't dropped.
- **Live event mid-backfill** → id-dedup idempotent; the ceiling trim keeps the newest, so backfilled-then-trimmed is bounded by design (not a bug).
- **Reconnect mid-backfill** → forward `fromSequenceExclusive` path handles the live stream; backfill resumes from `oldestLoaded` on the retained entry.
- **Older-than-ceiling history** → never loaded (bounded by design); consumers reading the loaded collection (plan cards, checkpoint/revert affordances, work-log) show only within-ceiling turns. Nothing critical breaks — no in-thread search, export, or message-count badge exists (C3); checkpoint-revert + fork are server-side by turnCount/id.

## Testing
- **Server unit:** windowed `getThreadDetailById` returns exactly the newest-N-turns∩maxRows window; `oldestLoaded`/`hasMoreHistory` accurate (EXISTS-before-boundary, incl. an empty-turn gap); `getThreadHistoryPage` returns the correct older turn-page (collections only, no head); **no window params → full snapshot unchanged** (C1 guard); null-`turn_id` rows included; checkpoints selected by `checkpoint_turn_count`.
- **Client unit:** merge/upsert dedups by id with per-collection comparators and preserves scalar/head replace (F7); backfill stops on `hasMoreHistory===false` OR ceiling; backfill cancels on dispose and pauses when hidden; deletion-pruning still works via `thread.reverted` after the replace→merge change (C2); prepend doesn't jump scroll.
- **Integration:** open the large thread → small initial snapshot (bounded, no 99 MB frame) → backfill converges to the **ceiling** window; live tail still delivers new turns; mobile/no-window subscribe still gets the full thread.

## Rollout / revert
Fully backward compatible: windowing is opt-in per subscribe input (absent ⇒ full snapshot); new contract fields are optional; the new RPC is additive; the client merge is a superset of replace (with event-only pruning verified). No wire-format change. Independent of the disabled stream codec (Issue 1).

## Design-review triage (2 adversarial rounds)
Correctness: F1 (caps make FE==BE unreachable) → **resolved by bounded-ceiling scope**; F2/F3/F6 (non-uniform keyset, activity re-sort, turn/created_at mismatch) → **per-collection turn-id window + comparators**; F4 (haveNewest clobbers cursor) → **moot, haveNewest cut**; F5 (real hasMoreHistory) → **EXISTS check**; F7 (head fields) → **scalars replace, page returns collections only**. Simplicity/compat: S1 scroll-anchoring **cut**; S2 haveNewest **deferred**; S3 separate RPC **kept**; S4 turn-id window **adopted**; S5 state on existing entry **adopted**; C1 opt-in cap **BLOCKER, adopted**; C2 event-only pruning **guard + test**; C3 consumer degradation **bounded/noted**; C4 pause-when-hidden + single-in-flight **adopted**.
