# Thread-load windowing: byte-size bound — 2026-07-10

## Goal

Add a **serialized-byte budget** as a third bound on thread-load windowing, alongside
the existing turn-count (`windowTurns`, default 15) and row-count (`maxRows`, default 2000) bounds. Today a thread with a handful of turns and few rows but heavy per-row
payloads escapes both existing bounds and ships as one multi-megabyte snapshot frame.

## Premise validation (Hard Rule 8) — DONE, live-measured

Probed the live `state.sqlite` (`~/.t3/userdata/state.sqlite`), summing per-turn UTF-8
byte size via `length(CAST(text|payload_json|plan_markdown AS BLOB))`:

| thread     | turns | rows | MB  | escapes 15-turn ∧ 2000-row? |
| ---------- | ----- | ---- | --- | --------------------------- |
| `d0c31878` | 4     | 901  | 5.0 | **yes** → full 5 MB frame   |
| `03615fd3` | 12    | 1684 | 6.2 | **yes** → full 6.2 MB frame |

`d0c31878` is the exact "loaded empty" thread from 2026-07-09. Per-turn byte
distribution (newest-first):

- `d0c31878`: 0.05 + 0.33 + 0.04 MB (3 newest) then **4.59 MB** (oldest). A byte
  budget accumulated newest-first stops before the oldest turn → initial frame
  **5.0 MB → 0.42 MB**; the 4.59 MB turn backfills lazily. Ideal case: the heavy
  weight is the oldest turn, exactly what windowing should defer.
- `03615fd3`: weight spread across turns → a 2 MiB budget keeps ~3 newest turns
  (~1.75 MB) vs 6.2 MB.

Conclusion: row/turn counts do **not** bound bytes; the byte-escape case is real and
is the dominant residual failure the first windowing pass left open.

## Approach (chosen)

Mirror the existing row-budget walk exactly, extended to also carry a byte budget.

1. **Measure per-turn bytes in the same aggregation query.** `listTurnRowCountsByThread`
   already computes per-turn `COUNT(*)` over a `UNION ALL` of the three per-turn tables.
   Add a `SUM(length(CAST(<col> AS BLOB)))` byte column to each `UNION ALL` branch, so
   one query returns `{ turnId, rowCount, byteCount }` — no extra round-trip.
   `length(CAST(x AS BLOB))` yields UTF-8 byte count (NULL for NULL columns; `SUM`
   ignores NULLs; `COALESCE(...,0)` guards the empty case).

2. **Extend the accumulate walk** from row-only to `(rows, bytes)`:
   `accumulateTurnsWithinRowBudget(turnRows, statsByTurnId, maxRows, maxBytes)` stops
   before a turn that would push **either** budget over, always keeping ≥1 turn. This
   preserves progress: even if a single turn exceeds `maxBytes`, the ≥1-turn rule
   includes it, so subscribe paints and backfill advances (no starvation).

3. **Thread `maxBytes` through both call sites** — `resolveWindowBoundary` (subscribe)
   and `getThreadHistoryPage` (backfill) — since both already share the accumulate
   function.

4. **`maxBytes` is server-internal — NOT on the wire** (revised per design review).
   No client sends it and none will (it's a server-side safety backstop, unlike
   `windowTurns`/`maxRows` which the web client sends). It rides only the internal
   service types — `getThreadDetailById` options and the `getThreadHistoryPage` input
   (widened to `OrchestrationThreadHistoryPageInput & { maxBytes? }`). `ws.ts` injects
   the constant directly at both handlers. This deletes the "clamp client value down"
   plumbing entirely (nothing to clamp) and sidesteps the `Math.min(undefined, ceil)=NaN`
   trap the required-field clamp pattern would create for an optional field.

5. **Single default** (revised per design review): one `WINDOW_MAX_BYTES = 4 MiB` for
   both the subscribe snapshot and each backfill page. The subscribe-vs-backfill page-size
   difference is already carried by the row/turn constants (2000 vs 5000 rows, 15 vs 100
   turns); the byte axis only needs "don't ship a multi-MB frame." 4 MiB keeps normal
   windows intact (the 15-turn / 2000-row bounds bite first for normal content — the byte
   bound is inert until a turn is genuinely heavy) while capping both probed escape threads
   (`d0c31878` → 0.42 MB, stopping before its 4.59 MB oldest turn; `03615fd3` → ~4 MB).
   The ≥1-turn floor guarantees backfill progress even for a single turn over budget, so a
   shared constant needs no per-path tuning.

6. **Null-boundary guard** (must-fix per design review): `getThreadDetailById`'s
   short-circuit `windowTurns === undefined && maxRows === undefined ? null : resolve(...)`
   MUST become `... && maxBytes === undefined`, and `resolveWindowBoundary` must receive and
   apply `maxBytes` — otherwise a caller passing only `maxBytes` short-circuits to the
   unbounded full-thread queries (the exact large-frame case the bound exists to prevent).

7. **Byte columns** (corrected per design review + live probe): sum every text column that
   actually enters the serialized frame — messages(`text`, `attachments_json`),
   activities(`payload_json`, `summary`), plans(`plan_markdown`). A live probe confirmed
   `attachments_json` currently holds only tiny reference metadata (`{type,id,name,mime}`,
   max ~1.3 KB/row — image bytes live in a separate blob store, not inline), so it is
   negligible today; it is summed anyway so the proxy stays accurate to the shipped frame
   and can't be silently defeated if attachments ever go inline.

## Alternatives considered

- **Bound by decoded/serialized frame bytes after building the snapshot, then re-trim.**
  Rejected: requires materializing the full snapshot first (the exact OOM/large-frame
  cost we're avoiding), then discarding — backwards. The per-turn SQL sum bounds
  _before_ materialization.
- **Split an oversized single turn across frames.** Rejected: a turn is the atomic
  windowing unit throughout the design; sub-turn splitting would fracture turn-coherent
  rendering and the cursor model. A single pathological turn (e.g. one 30 MB tool
  result) is a different problem, already backstopped by the 64 MB `MAX_FRAME_BYTES`
  ceiling and out of scope here.
- **Keep `maxBytes` server-internal (off the wire).** Rejected for asymmetry: the other
  two bounds are on the wire, server-clamped; putting the third there completes the set,
  costs one optional field, and leaves mobile free to tune smaller frames later.
- **Character length instead of byte length.** Rejected: `length(text)` counts UTF-8
  characters, undercounting multibyte content; `length(CAST(x AS BLOB))` is the true
  byte count and the closest cheap proxy to pre-compression wire size.

## Files touched (revised — no wire/contract change)

- `apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts` — `maxBytes?` on
  `getThreadDetailById` options; `getThreadHistoryPage` param widened to
  `OrchestrationThreadHistoryPageInput & { readonly maxBytes?: number }`.
- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` — byte column in the
  per-turn aggregate query + schema (`byteCount`); `accumulateTurnsWithinRowBudget` →
  carries a `statsByTurnId` map with a byte budget; `resolveWindowBoundary` gains
  `maxBytes`; both call sites pass it; the `getThreadDetailById` null-boundary guard gains
  `&& maxBytes === undefined`.
- `apps/server/src/ws.ts` — single `WINDOW_MAX_BYTES` constant injected at the subscribe
  and history-page handlers (literal pass-through, no clamp).
- `packages/contracts/src/orchestration.ts` — **unchanged** (byte bound is server-internal).

## Tradeoffs & limitations

- The byte proxy is DB UTF-8 text bytes, not post-msgpack/post-deflate wire bytes. It's a
  conservative upper bound on meaningful content and cheap to compute in SQL; exact wire
  size would require serializing first (rejected above). Good enough to bound frames.
- A single turn larger than `maxBytes` still ships whole (the ≥1-turn floor). Acceptable:
  turns are atomic and the 64 MB frame ceiling remains the hard backstop.

## Sanitize-round findings (applied)

- **Checkpoint-file bytes were uncounted.** The byte sum originally omitted
  `projection_turns.checkpoint_files_json`, which is serialized into the frame and a
  live probe showed reaching ~421 KB in a single turn. A checkpoint-heavy turn could
  therefore score ~0 bytes and escape the bound. Fixed: the aggregate query gained a
  fourth `UNION ALL` branch for `checkpoint_files_json`, carrying `is_row = 0` (its
  bytes count but it is not a content row) so `rowCount` — now `SUM(is_row)` — stays the
  messages+activities+plans total the `maxRows` budget expects.
- **The per-turn stats query scanned the whole thread's blob content on every call.**
  Switching from `COUNT(*)` to `SUM(length(CAST(... AS BLOB)))` turned a cheap index
  count into a full-thread blob read — on the latency-critical subscribe path AND once
  per backfill page (O(pages × threadBytes)). Fixed: the query is now scoped to the
  candidate window's `turn_id`s (`sql.in`, empty-guarded), so subscribe reads only its
  ~15 turns and each page reads only its ~25 — directly serving the feature's
  heavy-thread latency goal instead of undercutting it.

## Follow-ups deferred

- None anticipated beyond tuning the default constant if wire telemetry later shows a
  better knee. The `WireByteMeter` already exists to measure this if wanted.
