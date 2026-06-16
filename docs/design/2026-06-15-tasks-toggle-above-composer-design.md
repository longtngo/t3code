# Tasks-panel toggle: move above composer + aggregate activity — 2026-06-15

## Goal

Three related changes to the "Toggle tasks panel" control (currently a small
toggle in the chat header that opens the plan/task sidebar):

1. **Move** it from the header to a **permanent** row directly **above the main
   input textbox** (the composer).
2. Its **spinner** must show whenever there is *any* running work — not only an
   in-progress plan step, but also running **background processes** (terminals)
   or running **agents/subagents** (task-stream).
3. Its **count** must aggregate **plan steps + background processes + agents**,
   for **both** the active count and the total count, shown as
   `{active}/{total}`.

## Background — current state (verified in code)

- The toggle lives in `apps/web/src/components/chat/ChatHeader.tsx` (lines
  202–226), grouped with the terminal and diff toggles. It always renders; the
  count badge shows `{planStepsCompleted}/{planStepsTotal}` and the spinner
  shows when `planHasActiveStep` is true. All three derive only from
  `activePlan` (the TodoWrite plan steps).
- `ChatView.tsx` already derives the other two activity sources for the plan
  sidebar's sections:
  - `visibleAgentItems` — agents/subagents from `deriveAgentItems(threadActivities)`.
  - `visibleBackgroundItems` — terminals from `deriveBackgroundItems(activeThreadKnownSessions)`.
  Each item has a `status: "running" | "completed" | "failed"`.
- Clicking the toggle calls `togglePlanSidebar` → opens the plan sidebar, which
  contains the Tasks/Background/Agents sections. That wiring is unchanged.
- The composer is rendered in the "Input bar" div in `ChatView.tsx`
  (~line 4042), inside `<div className="relative isolate">`.

## Approach

1. **New presentational component** `apps/web/src/components/chat/TasksPanelToggle.tsx`
   — the same `Toggle` + `Tooltip` markup, but standalone, taking
   `{ open, onToggle, label, activeCount, totalCount, hasActive }`. Shows the
   `ListTodo` icon + label, a `{active}/{total}` badge when `totalCount > 0`,
   and a spinner when `hasActive`.
2. **Aggregate helper** `summarizeTaskActivity(...)` added to `sidebarSections.ts`
   (pure, unit-tested). Computes:
   - `activeCount = planStepsActive + agentsRunning + backgroundRunning`
   - `totalCount = planStepsTotal + agents.length + background.length`
   - `hasActive = activeCount > 0`
   It counts the **visible** agent/background lists (post dismissal + auto-clear)
   so the badge matches what the sidebar panel shows.
3. **Wire it in `ChatView.tsx`**: compute `planStepsActive`, call
   `summarizeTaskActivity`, render `<TasksPanelToggle>` in a permanent row just
   above the composer's `relative isolate` wrapper.
4. **Remove** the tasks toggle (and its now-unused props/icons) from
   `ChatHeader.tsx`; update its browser test render helper accordingly. The
   terminal and diff toggles stay in the header.

### Display semantics decision

The current badge shows **completed/total**; the request explicitly names
"active and total count", so the new badge shows **active/total**. As a
permanent, always-visible work indicator above the composer, "N running of M
tracked" is the more useful reading and directly drives the spinner
(`hasActive`). Documented here as the deliberate change from completed→active.

## Files touched

- `apps/web/src/sidebarSections.ts` — add `summarizeTaskActivity` + `TaskActivitySummary`.
- `apps/web/src/sidebarSections.test.ts` — unit tests for the new helper.
- `apps/web/src/components/chat/TasksPanelToggle.tsx` — new component.
- `apps/web/src/components/chat/ChatHeader.tsx` — remove tasks toggle + unused props/icons.
- `apps/web/src/components/chat/ChatHeader.browser.tsx` — drop removed props from render helper.
- `apps/web/src/components/ChatView.tsx` — compute counts, render new control above composer, drop the header's tasks-toggle props.

## Tradeoffs / limitations

- Plan steps are counted from `activePlan` (not the individually-dismissable
  sidebar plan rows), matching the existing badge's source — simplest and keeps
  parity with prior behavior; per-step dismissal of plan rows won't change the
  count, only agent/background dismissals will. Acceptable: plan steps are the
  primary signal and were never affected by dismissal before.
- Counting **visible** (not raw) agent/background items means a user-dismissed
  or 6h-auto-cleared finished item drops out of the total — intentional, keeps
  the badge consistent with the panel contents.

## Follow-ups deferred

- None anticipated; will capture any surfaced by sanitization.
