# Bound null-turn content in thread-load windowing — 2026-07-10

## Goal

Make **null-turn thread-level content** count toward the thread-load window's row
(`maxRows`) and byte (`maxBytes`) budgets, so it can no longer escape windowing.

Thread content rows (messages / activities / proposed-plans) carry a `turn_id`, but
some rows have `turn_id IS NULL` — thread-level content not attached to any turn. The
windowed content queries deliberately include null-turn rows within the window's time
span (`turn_id IS NULL AND created_at >= boundary`), but the per-turn stats query that
feeds the budget walk scopes to non-null `turn_id`s only. Result: null-turn content
ships in the frame while counting toward **neither** budget.

## Premise validation (Hard Rule 8) — live-measured

Read from source (`ProjectionSnapshotQuery.ts`), not memory:
- `windowTurnPredicate` (subscribe) / `historyTurnPredicate` (backfill) include
  `turn_id IS NULL AND created_at >= boundary` rows in the frame.
- `toStatsByTurnId` explicitly drops the null-turn bucket ("counts against neither
  budget"), and `accumulateTurnsWithinBudget` treats a row with `turnId === null` as
  `(0 rows, 0 bytes)`.

Probed `~/.t3/userdata/state.sqlite` for the real magnitude — the earlier report's
"low risk in practice" assumption is **refuted**:

| thread     | thread-total null-turn | null-turn **in a 15-turn window** |
|------------|------------------------|-----------------------------------|
| `50267f76` | 33,426 rows / 13.29 MB | **1,184 rows / 0.48 MB**          |
| `bf98d038` | 5,739 rows / 2.32 MB   | **1,193 rows / 0.48 MB**          |
| `310e0e3a` | 5,513 rows / 2.21 MB   | 18 rows / 0.002 MB                |

314 threads carry null-turn content; the worst single thread holds 13.3 MB of it.
Within a realistic 15-turn window the escape is dominated by the **row axis** (≈1.2k
null-turn rows against the 2000-row cap), with bytes secondary (sub-MB here). A thread
dominated by thread-level activity could ship thousands of unbudgeted null-turn rows —
the exact unbounded-frame case windowing exists to prevent.

## Approach (chosen) — per-interval attribution, walk unchanged

The included null-turn content is a function of the final boundary `B`: subscribe
includes null-turn `created_at >= B`; a history page includes `created_at ∈ [B, cursor)`.
`B` is the oldest **included** turn's `requestedAt`, chosen by the newest-first budget
walk. So the included null-turn content grows monotonically as the walk extends the
window older — which means it can be attributed to the turn interval it falls in and
folded into that turn's budget cost, with **no change to the walk itself**.

Given candidate turns newest-first with `requestedAt` r[0] > r[1] > … > r[n-1]:
- Define bucket[j] = null-turn `(rows, bytes)` with `created_at ∈ [r[j], r[j-1])` for
  j ≥ 1, and bucket[0] = null-turn `created_at >= r[0]` (capped `< cursor` for a
  history page). Then Σ bucket[0..k] = null-turn `created_at >= r[k]` = exactly what
  the content predicate ships when the walk stops at turn k. The attribution is exact,
  not conservative.
- Fold bucket[j] into turn j's `TurnBudgetStats` (`rows += nullRows`,
  `bytes += nullBytes`) before the walk. `accumulateTurnsWithinBudget` then counts
  null-turn content for free, and the ≥1-turn floor still guarantees progress.

Concretely:
1. **New query `listNullTurnStatRows`** — returns `(createdAt, isRow, bytes)` for
   null-turn rows in the candidate span, over the same UNION of
   messages(`text`+`attachments_json`) / activities(`payload_json`+`summary`) /
   plans(`plan_markdown`) as the turn-stats query. `is_row = 1` (all null-turn content
   is a content row; there is no null-turn checkpoint analog — `projection_turns` rows
   always have a `turn_id`). Scoped `created_at >= lowerInclusive`
   (`AND created_at < upperExclusive` for a history page).
2. **Pure `foldNullTurnStats(statsByTurnId, turnRows, nullRows)`** — for each null row,
   find the candidate turn with the greatest `requestedAt <= createdAt` (binary search
   over the desc-sorted `turnRows`) and add its `(is_row, bytes)` into that turn's
   entry. Rows older than the oldest candidate (unassignable) are ignored — they are
   older than any reachable boundary and never ship.
3. **`loadTurnStats` gains an optional `nullTurnUpperExclusive`** — when set (history
   page cursor) the null-turn fetch is capped `< cursor`; when omitted (subscribe) all
   null-turn newer than the oldest candidate is in scope. It fetches null rows for the
   candidate span (lower = oldest candidate `requestedAt`), folds them, and returns the
   combined map. Both existing callers (`resolveWindowBoundary`,
   `getThreadHistoryPage`) already pass `turnRows` with `requestedAt` — subscribe passes
   no upper, history passes `beforeTurn.requestedAt`.

Nothing in `accumulateTurnsWithinBudget`, `resolveWindowBoundary`, the boundary/`turnIds`
selection, or the content queries changes — only the stats map the walk consumes.

## Alternatives considered

- **Lump: reserve total candidate-span null-turn from the budget up front.** Rejected:
  a client may pass a large `windowTurns` (the web client sends 15, but it is
  overridable), making the candidate span the whole thread and the lump ≈ 13 MB, which
  would over-reserve and collapse the window to the ≥1-turn floor even though the
  actually-shipped null-turn (at the final boundary) is tiny. Safe (never exceeds
  budget) but badly over-conservative on the axis that matters.
- **Fold all candidate-span null-turn into the newest (or oldest) turn's bucket.**
  Newest → same over-count as the lump on early stops; oldest → *under*-counts on early
  stops (null-turn folded into a turn the walk never reaches), leaving the escape open
  for exactly the truncated-window case. Per-interval is the only attribution that is
  neither over- nor under-counting.
- **SQL-side bucketing (json_each over the candidate boundaries).** Would return ≤ n
  aggregate rows instead of up to ~1.2k raw rows, but needs the candidate list
  materialized in SQL (a correlated MAX over `json_each` per null row) — more complex
  and not clearly faster at these sizes. The raw rows are tiny (timestamp + two ints;
  ≈40 KB at the 1.2k worst case) and the JS bucketing is a pure, unit-testable
  function. Deferred as an optimization if perf review flags the row count.

## Files touched

- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` — new
  `NullTurnStatsInput` schema + `listNullTurnStatRows` query; pure `foldNullTurnStats`;
  `loadTurnStats` gains `nullTurnUpperExclusive?` and folds null-turn stats;
  `getThreadHistoryPage` passes the cursor as the upper bound. `resolveWindowBoundary`
  needs no signature change (subscribe = no upper).
- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.test.ts` — seed knob
  for null-turn content; tests for row-budget and byte-budget precedence driven by
  null-turn content, per-interval attribution (early-stop excludes older null-turn),
  and the history-page upper-bound cap.

No wire/contract change — this is entirely inside the existing server-side budget walk.

## Tradeoffs & limitations

- The byte proxy remains DB UTF-8 text bytes (same as the turn-stats query), a
  conservative pre-compression proxy — good enough to bound frames.
- Two turns with an identical-millisecond `requestedAt` split by the boundary could
  misattribute null-turn between them; the cumulative sum at any boundary that does not
  fall between them is still exact, and the byte proxy is already approximate. Negligible
  and noted.
- The null-turn stat fetch reads the same null-turn rows the content query will later
  read (with full payloads) when they fall in the final window — a strictly lighter
  superset read (length only, no payload), so no new asymptotic cost on the path.

## Follow-ups deferred

- SQL-side bucketing (`json_each`) if the ~1.2k-row worst-case fetch shows up in wire
  telemetry as a latency contributor.
