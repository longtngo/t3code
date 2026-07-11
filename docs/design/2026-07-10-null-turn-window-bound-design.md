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

Probed `~/.t3/userdata/state.sqlite` — the earlier report's "low risk in practice"
assumption is **refuted**:

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

## Approach (chosen) — lump reservation, walk unchanged

Reserve the window's null-turn content against the budget **up front**, then run the
existing turn walk with the reduced budget. Because the null-turn actually shipped at
any stopping point is a *subset* of the reserved lump, the frame is provably bounded.

The content predicate ships null-turn rows by `created_at` range: subscribe includes
`created_at >= B`; a history page includes `created_at ∈ [B, cursor)`, where `B` is the
oldest **included** turn's `requestedAt`. The most null-turn any window over a given
candidate set can ship is the full candidate span `[oldest-candidate.requestedAt, ∞)`
(subscribe) or `[oldest-candidate.requestedAt, cursor)` (history page). Reserve exactly
that lump `(nullRows, nullBytes)`:

1. **Extend the existing per-turn stats query** (`listTurnStatsByTurnIds`): each of the
   three content arms (messages `text`+`attachments_json`, activities
   `payload_json`+`summary`, plans `plan_markdown`) widens its predicate to
   `turn_id IN (candidates) OR (turn_id IS NULL AND created_at >= lower
   [AND created_at < upper])` — the same shape `windowTurnPredicate` /
   `historyTurnPredicate` already use. The two branches are mutually exclusive, so the
   existing `GROUP BY turn_id` yields the per-turn buckets **and** a single
   `turn_id IS NULL` group — the lump — from one scan per table (no new arms, no raw-row
   fetch, one round-trip). The checkpoint arm stays turn-only (`is_row = 0`).

2. **`loadTurnStats` returns `{ statsByTurnId, nullLump }`** — `toStatsByTurnId` already
   skips the null group for the per-turn map; now it also reads that group's
   `(rowCount, byteCount)` as `nullLump` (defaulting to `{rows:0, bytes:0}` when absent).
   The query gains `nullTurnLowerInclusive` (oldest candidate `requestedAt`, derived
   from the last of the desc-ordered `turnRows`) and optional `nullTurnUpperExclusive`.

3. **Subtract the lump before the walk.** Both callers reduce the budget:
   `accumulateTurnsWithinBudget(turnRows, statsByTurnId, reduce(maxRows, nullLump.rows),
   reduce(maxBytes, nullLump.bytes))`, where `reduce(undefined, _) = undefined` (no
   bound → stays unbounded, lump not subtracted) and `reduce(n, x) = Math.max(0, n − x)`.
   Subscribe passes no upper; `getThreadHistoryPage` passes `beforeTurn.requestedAt` as
   `nullTurnUpperExclusive`.

`accumulateTurnsWithinBudget`, `resolveWindowBoundary`, the boundary/`turnIds`
selection, and the content queries are **unchanged** — only the budget the walk starts
with, and the one extra UNION arm, change. No wire/contract change.

### Correctness (the lump is provably safe)

- **Subscribe.** Reserve `N = nullTurn(created_at >= r[n-1])` over the candidate span.
  Walk stops at turn k (boundary `r[k]`, `r[k] >= r[n-1]`), shipping
  `nullTurn(>= r[k]) <= N` and `turnContent[0..k] <= maxRows − N`. Total
  `= turnContent + nullShipped <= (max − N) + N = max`. Bounded. ∎
- **History page seam — counted once.** `windowTurnPredicate` ships `>= B` (inclusive);
  `historyTurnPredicate` ships `< upperRequestedAt` (exclusive). Reserving the page lump
  with `created_at < cursor` mirrors that exclusive upper, so a null-turn row at exactly
  `created_at == cursor` is shipped and reserved by the newer frame **only** — never
  double-reserved, never dropped.
- **≥1-turn floor.** If `N > max`, `reduce` clamps the reduced budget to 0, so the walk
  keeps exactly the newest turn (the floor). Its boundary is the newest `requestedAt`,
  so the frame actually ships only the tiny head bucket (`>= r[0]`), not the whole lump —
  the reservation was conservative but the frame is still `<= max`. (Same shape as the
  pre-existing rule that a single turn exceeding the budget still ships whole.)
- **Whole-thread short-circuit.** When the walk fits every candidate turn under the
  reduced budget and isn't turn-limited, `resolveWindowBoundary` still returns `null`
  (unbounded queries). That path is only reached for a small thread whose entire content
  — turns **and** all its null-turn — already fit `max` (verified by the walk fitting
  `max − N`), so shipping it whole is safe.
- **Undefined budget.** `reduce(undefined, _) = undefined` leaves that axis unbounded
  exactly as before; the lump is inert when its axis has no budget.

## Alternatives considered

- **Per-interval attribution** (bucket each null-turn row to the candidate-turn interval
  its `created_at` falls in; fold into that turn's stats so the walk counts it exactly).
  Correct and maximizes initial-window fullness (no over-reserve), but it is an
  *optimization*, not a correctness requirement — and it costs a new raw-row query
  (returning up to ~33k rows under an adversarial large `windowTurns`, which it does not
  bound), a JS bucketing pass, a binary search with a `requestedAt`-tie-break subtlety,
  and an upsert edge for content-less turns that own null-turn rows. Its sole advantage
  over the lump is avoiding over-reserve, and **live measurement shows the over-reserve
  is negligible**: on the two heaviest real threads the lump still leaves 807–816 of the
  2000-row budget for turns (no initial-window collapse); typical threads reserve ~18
  rows. Rejected as complexity unjustified by the data. (Re-openable as a follow-up if
  wire telemetry ever shows initial-window collapse on a heavy-null thread — see below.)
- **Fold all candidate-span null-turn into a single turn's bucket** (newest or oldest).
  Newest → same over-reserve as the lump but more code; oldest → *under*-counts on early
  stops (folded into a turn the walk never reaches), leaving the escape open. The lump is
  the simplest form with the newest-fold's safety.
- **Character length instead of byte length.** Rejected earlier for the turn-stats query
  (undercounts multibyte); the null arm reuses `length(CAST(x AS BLOB))` for consistency.

## Files touched

- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` — one `UNION ALL`
  arm + `nullTurnLowerInclusive`/`nullTurnUpperExclusive?` on the stats query's Request;
  `toStatsByTurnId` also returns the null lump; `loadTurnStats` returns
  `{ statsByTurnId, nullLump }` and derives the lower bound from `turnRows`;
  `resolveWindowBoundary` and `getThreadHistoryPage` subtract the lump via a `reduce`
  helper before the walk (history passes the cursor as the upper bound).
- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.test.ts` — seed knob for
  null-turn content; tests for row-budget precedence driven by null-turn, byte-budget
  precedence driven by null-turn, the ≥1-turn floor when the lump alone exceeds the
  budget, and the history-page upper-bound cap (no double-reserve across the seam).

## Tradeoffs & limitations

- **Over-reserve on early stops.** When the walk stops before the oldest candidate turn,
  the lump reserved slightly more null-turn than the frame ships, so the initial window
  is marginally smaller than optimal. Live-measured worst case ≤ a few turns, on the two
  heaviest threads only, and refilled by the existing `getThreadHistoryPage` backfill —
  user-invisible on web/desktop. (Mobile lacks a backfill loop; that pre-existing gap is
  tracked separately and is not worsened materially by a slightly smaller initial
  window.)
- **Byte proxy** remains DB UTF-8 text bytes (same as the turn-stats query) — a
  conservative pre-compression proxy, good enough to bound frames.
- **≥1-turn floor** still ships the newest turn (and null-turn newer than it) in full
  regardless of budget — consistent with the existing single-oversized-turn rule.
  Empirically the head bucket is 1–2 rows.
- **Whole-thread short-circuit (pre-existing, unchanged).** When the walk fits every
  candidate turn under the reduced budget, `resolveWindowBoundary` returns `null` and
  the caller runs the *unbounded* whole-thread queries, which ship every null-turn row —
  including any stamped *before* the thread's first turn, which the lump (spanning
  `[oldest-candidate.requestedAt, …)`) never reserved. This is the same
  "the thread fits → ship it whole" behavior that predates this change (null-turn was
  wholly unbounded there before too); the change only makes that path fire *less* often
  by reserving the lump on the windowed path. Empirically pre-first-turn null-turn is 0
  across the heaviest live threads. Deferred, not fixed in-branch (out of scope, no
  regression).

## Follow-ups deferred

- **Upgrade the lump to per-interval attribution** if wire telemetry ever shows a
  heavy-null thread collapsing its initial window (lump ≈ or > `maxRows`). Not indicated
  by current data (worst real reserve is 1,193 of 2,000 rows).
