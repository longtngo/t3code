# Show the selected model in the Vitals context block — design

**Date:** 2026-08-15
**Branch:** `feat/vitals-model-name`

## Goal

Name the model the context window belongs to. The Vitals popover's Context block shows
`Context … 1m window` and `18% · 182k / 1m`, but never says _which model_ that window is for. On a
fork where the active model changes per thread, a window size with no model attached is ambiguous.

## Why now: the reconcile owes it

Upstream #4772 ("show selected model in context window tooltip") put the model name in
`ContextWindowMeter`'s tooltip. Today's 101-commit reconcile kept the fork's deletion of that
component — the Vitals gauge replaced it — and removed the orphaned
`ContextWindowMeter.logic.ts`, which is where upstream's `resolveContextWindowModelDisplayName`
lived. That was recorded as a deliberate, named follow-up rather than a silent drop. This is it.

## Premises validated (Hard Rule 8)

| Premise                                | Probe                                                                                                                                                                                                                                                     | Result |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| The gauge has no model name today      | `ContextBlock` takes only `providerDisplayName`, used solely in the compaction sentence                                                                                                                                                                   | ✅     |
| A display-name helper still exists     | `getTriggerDisplayModelName(model)` in `chat/providerIconUtils.ts:54`                                                                                                                                                                                     | ✅     |
| The composer can resolve the selection | `modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>` is already built there (`ChatComposer.tsx:920`), and `activeThreadModelSelection` is already in scope beside the existing `activeThreadProviderDisplayName` memo | ✅     |

## Approach

**Resolve the model name where the provider name is already resolved, and render it beside the
window size.**

1. In `ChatComposer`, add an `activeThreadModelDisplayName` memo next to the existing
   `activeThreadProviderDisplayName`. It reproduces upstream's logic — look the selected slug up in
   that instance's option list, fall back to the raw slug — using the surviving
   `getTriggerDisplayModelName`.
2. Thread it as `modelDisplayName` through `VitalsGaugeConnected → VitalsGauge → VitalsDetail →
ContextBlock`, the same path `providerDisplayName` already takes.
3. Render it in the Context block's header row, joined to the existing window size:
   `Opus 5 · 1m window`. When the name is unknown, the row degrades to exactly what it shows today.

The header's right-hand slot already exists and is short, so this costs no vertical space and no
new row.

## Alternatives rejected

| Alternative                                          | Why not                                                                                                                                                                                                          |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Restore `ContextWindowMeter.logic.ts` and import it  | The component it served is deleted; reviving a module whose only consumer is gone re-creates the orphan the reconcile just removed. The one function worth keeping is ~6 lines.                                  |
| Put the model name in a tooltip, as upstream did     | Upstream needed a tooltip because its meter was a bare bar in the composer. The Vitals popover **is** the disclosure surface — a tooltip on a popover is a second hover layer for information that fits in view. |
| Replace the provider name in the compaction sentence | Different sentence, different meaning ("Claude automatically compacts…" is about the provider's behaviour). Swapping in a model name makes that line read oddly and loses the provider.                          |
| Give it its own row under the header                 | The header slot is empty and adjacent; a new row costs height in a popover that already carries three blocks.                                                                                                    |

## Tradeoffs and limitations

- The name comes from the **selection**, so a thread whose model is unset shows only the window
  size, as today.
- If the selected slug is not in the instance's option list (a custom or since-removed model), the
  raw slug is shown. That matches upstream's fallback and is more useful than showing nothing.
- The window size and the model can briefly disagree while a model switch is in flight; both are
  read from the same render, so this is bounded to one frame.

## Files touched

- `apps/web/src/components/chat/ChatComposer.tsx` — resolve + pass.
- `apps/web/src/components/chat/VitalsGauge.tsx` — thread + render.
- `apps/web/src/components/chat/VitalsGauge.test.tsx` — coverage.

## Design review

**6a (pillar sweep): skipped.** No trigger — no boundary, API or event contract, no data model or
migration, no new dependency, no deployment change, no personal data / money / bulk mutation. This
renders a string the client already holds.

**6b lenses: correctness + simplicity.** No conditional lens fires (no new entry point, query
pattern, hot-path loop, config key, or failure-capable path). Round 1, both findings applied:

| #   | Lens        | Finding                                                                                                                                                                                                    | Resolution                                                                                                                                                                                                       |
| --- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Correctness | `ContextBlock` renders the header's right slot only when `hasMax`. A model name hung off that slot disappears for a provider that reports no window size — the case where naming the model matters _most_. | Render the slot when there is **either** a max or a model name, joining with `·` only when both are present.                                                                                                     |
| 2   | Simplicity  | Does this need a separate memo, or can it be computed inside the gauge?                                                                                                                                    | The gauge has no access to `modelOptionsByInstance`; passing that whole map down to derive one string would be a wider prop than the string itself. Memo stays in the composer, mirroring `providerDisplayName`. |

Round 2: only repeats — the sole edit was finding 1, inside correctness's own dimension, and
re-running it produced nothing new. Exit: quiescence.

## Follow-ups deferred

None.
