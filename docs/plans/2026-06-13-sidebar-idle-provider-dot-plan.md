# Sidebar Idle Provider Dot — Implementation Plan

Design: `docs/design/2026-06-13-sidebar-idle-provider-dot-design.md`
Branch: `feat/sidebar-idle-provider-dot`

## Task 1 — Extend status pill model

- `apps/web/src/components/Sidebar.logic.ts`:
  - Add `"dot"` to `ThreadStatusIcon` and `PROVIDER_ACCENT_STATUS_ICONS`.
  - Add `"Idle"` label + priority `0`.
  - Return Idle pill at resolver fallback with guards: `providerInstanceId`,
    not `error`/`closed`, settled turn (`latestTurn === null ||
    isLatestTurnSettled(...)`).
  - Skip `Idle` in `resolveProjectStatusIndicator`.
- Commit: `feat(sidebar): add idle provider dot status pill`

## Task 2 — Render dot glyph

- `apps/web/src/components/ThreadStatusIndicators.tsx`:
  - Branch `ThreadStatusGlyph` for `icon === "dot"`: `size-2 rounded-full` span,
    accent via `backgroundColor`, fallback `bg-muted-foreground/45`.
  - Type `STATUS_ICON_COMPONENTS` as `Exclude<ThreadStatusIcon, "dot">`.
- Commit: `feat(sidebar): render idle provider dot in thread status glyph`

## Task 3 — Tests

- `apps/web/src/components/Sidebar.logic.test.ts`:
  - Idle dot for visited settled thread with provider instance.
  - Null when no provider instance.
  - Null for error session.
  - Null for in-flight latest turn.
  - Aggregate ignores idle dots.
- Commit: `test(sidebar): cover idle provider dot status rules`

## Task 4 — Gates

- `vp run typecheck`, `vp test run --project unit` (web Sidebar.logic tests).
- Manual: idle dot shows provider accent; working → spinner; completed → check;
  aggregates unchanged.
