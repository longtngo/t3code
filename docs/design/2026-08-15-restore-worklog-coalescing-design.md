# Restore work-log entry coalescing — design

**Date:** 2026-08-15
**Branch:** `feat/restore-worklog-coalescing`

## Goal

Collapse runs of consecutive, visually-identical work-log entries into one row carrying a count
(`Runtime warning ×3`) instead of rendering N identical rows.

## Provenance

Lost in merge `2b7193648` (the connection-rewrite reconcile, 2026-07-25) — the same merge that ate
the ask-question Cancel button. Surfaced by the FORK-LOSS sweep direction added to
`reconcile-upstream-drift` after that audit; the two pre-existing sweep directions were
structurally blind to it.

Restored from the pre-merge blob at `2b7193648~1`, not rewritten from scratch.

## Approach

Three pieces, mirroring the original:

1. `workLogEntryRenderSignature(entry)` — joins **everything that affects how a row renders**
   (normalised label, tone, itemType, requestKind, detail, command, rawCommand, changedFiles).
   Two entries with the same signature are visually indistinguishable.
2. `coalesceRepeatedWorkLogEntries(entries)` — a single pass collapsing **adjacent** equal
   signatures into `{ entry, count }`.
3. The row renders `heading ×N` when `count > 1`, folded into `displayText` so the count reaches
   the **accessible name** too — a row standing for five occurrences must not announce as one.

**Changed from the original:** the logic is typed **structurally** (`CoalescibleWorkEntry`) and
generic over the entry type, rather than importing the timeline's `WorkLogEntry`. Today
`TimelineWorkEntry` is derived inside the component module (`MessagesTimeline.tsx:922`), so a
nominal import would drag the component into the logic module and make it untestable standalone.

## Why adjacency matters

Only *consecutive* runs collapse. A repeat separated by another entry is a genuinely separate
occurrence in the timeline, and merging it behind a count would hide information rather than tidy
it. A test asserts `A A B A → [A×2, B, A]`.

## Reachability — narrower than when the feature was written

`MAX_VISIBLE_WORK_LOG_ENTRIES` is **1** today, so a group of more than one entry already collapses
to a tail row plus a `+N previous log entries` toggle. The `×N` badge is therefore only visible
**after the user expands that group**.

This is a real reduction in the feature's value since it was written, and it is worth stating rather
than glossing: the burst-spam case the original targeted is now partly handled by the toggle. The
coalescing still earns its place in the expanded view, where a burst would otherwise be N identical
rows — but it is no longer the primary defence against work-log spam.

## Testing

Seven logic tests cover the arithmetic and the edges: a run, a singleton, differing entries,
non-adjacent repeats, a differing `detail`, differing `changedFiles`, the `complete`-suffix
normalisation, and the empty input.

The render test asserts what a static render *can* honestly observe — that a burst collapses behind
the group toggle — and says in a comment why the badge itself is not asserted there (expansion is
internal component state `renderToStaticMarkup` cannot set). Asserting the badge would have required
either exporting internals or a fixture that lies about the collapse behaviour.

## Design review

**6a: skipped** — no trigger (pure presentational logic over data already in the client; no
boundary, contract, data model, dependency, deployment, or sensitive-data surface).

**6b: correctness + simplicity.** Findings, both applied:

| # | Lens | Finding | Resolution |
|---|---|---|---|
| 1 | Correctness | A count in the visible text but not the accessible name would under-report to screen readers | Count folded into `heading` before `displayText`, which is the row's `aria-label` |
| 2 | Simplicity | Import `WorkLogEntry` for the signature? | No — it lives in the component module; structural typing keeps the logic unit-testable |

Exit: round 2 produced only repeats.

## Files touched

- `apps/web/src/components/chat/MessagesTimeline.logic.ts` — signature + coalescing.
- `apps/web/src/components/chat/MessagesTimeline.logic.test.ts` — 7 tests.
- `apps/web/src/components/chat/MessagesTimeline.tsx` — coalesce at the mapping site, thread
  `count` through both row components, render the badge.
- `apps/web/src/components/chat/MessagesTimeline.test.tsx` — 2 render tests.

## Follow-ups deferred

- **Revisit `MAX_VISIBLE_WORK_LOG_ENTRIES = 1`.** With coalescing back, a slightly larger visible
  window would show a coalesced burst inline instead of hiding it behind a toggle — which is closer
  to what both features were originally for. A product call, not merge work.
