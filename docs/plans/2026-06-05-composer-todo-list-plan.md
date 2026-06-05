# Composer To-do List Section — Implementation Plan

Design: `docs/design/2026-06-05-composer-todo-list-design.md`
Branch: `feat/composer-todo-list`

## Task 1 — Export shared status icon

- `apps/web/src/components/PlanSidebar.tsx`: `function stepStatusIcon` → `export function stepStatusIcon`.
- Commit: `refactor(web): export stepStatusIcon from PlanSidebar for reuse`

## Task 2 — ComposerTodoList component

- New `apps/web/src/components/chat/ComposerTodoList.tsx`:
  - Props: `{ activePlan: ActivePlanState | null; hasComposerHeader: boolean }`.
  - Null render when `!activePlan || activePlan.steps.length === 0`.
  - Controlled `Collapsible` with `useLocalStorage("composer-todo-list-open", true, Schema.Boolean)` (`effect/Schema`).
  - Trigger: chevron (right/down) + `To do list <completed>/<total>`.
  - Panel: `max-h-48 overflow-y-auto`; rows keyed by index: `<n>.`, text, `stepStatusIcon(status)`; completed rows line-through/muted, inProgress highlighted (PlanSidebar palette).
  - Chrome: `border-b border-border/65 bg-muted/20`, `rounded-t-[19px]` only when `!hasComposerHeader`.
- Commit: `feat(composer): collapsible to-do list section component`

## Task 3 — Wire into ChatComposer + ChatView

- `ChatComposer.tsx`:
  - Prop `activePlan: ActivePlanState | null` (type import from `~/session-logic`).
  - `showTodoListSection = !isComposerCollapsedMobile && activePlan != null && activePlan.steps.length > 0`.
  - Render `<ComposerTodoList>` between the conditional header block and the input-area div.
  - Input-area `pt` condition: `hasComposerHeader || showTodoListSection`.
  - `CompactComposerControlsMenu` keeps `activePlan={showPlanSidebarToggle}` (boolean) untouched.
- `ChatView.tsx`: remove `as { turnId?: TurnId } | null` cast on `activePlan` (keep `sidebarProposedPlan` cast).
- Commit: `feat(composer): render to-do list section above the prompt editor`

## Task 4 — Gates

- `vp check`, `vp run typecheck`, `vp test` (web at minimum) must pass.
- Manual verification in running app (TodoWrite turn → section renders, counts update, collapse persists across reload).
