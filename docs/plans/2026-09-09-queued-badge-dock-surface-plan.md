# Plan: restore the queued-message strip

Design: `docs/design/2026-09-09-queued-badge-dock-surface-design.md`. Reviewed (6b, one round,
Correctness + Simplicity, built and run): no blockers; must-fix is formatting on the new test.

## Task 1 — badge on the banner primitives

- `apps/web/src/components/chat/ComposerQueuedMessages.tsx`: `ComposerQueuedBadge` returns
  `ComposerBanner.Root density="comfortable" data-composer-shoulder-tab` wrapping a
  `ComposerBanner.Row render={<button type="button" />}` with `Icon` (clock) and `Content`
  (count + "waiting"). Keep `aria-label`, `aria-expanded`, `onClick`, the pointerdown
  `preventDefault`. Drop the unused `cn` import and `String(count)`.
- Test: `ComposerQueuedMessages.dom.test.tsx` (already written) goes green; format it.
- Commit: `fix(web): queued-message badge renders on a banner surface so the dock shows it`

## Task 2 — transcript drops held messages again

- `apps/web/src/components/ChatView.tsx` `timelineEntries` memo: pass `heldPartition.transcript`
  instead of `timelineMessages`; update the dependency list.
- Commit: `fix(web): held messages leave the transcript while they wait`

## Gate

`pnpm verify` from the repo root (fmt → typecheck → lint → test), 14/14 packages.
