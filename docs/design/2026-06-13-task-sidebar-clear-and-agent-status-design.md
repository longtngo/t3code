# Task sidebar: clear controls + agent completion fix — 2026-06-13

## Goal

Follow-up to Feature C (task-sidebar sections):

1. **Clear controls** — panel-level "Clear completed" plus "Force clear all" for
   background processes, agents, and completed plan steps.
2. **Agent status fix** — subagents that finished via SDK `task_updated` (without
   `task_notification`) were stuck as "running" in the Agents section.

## Approach

### Clear controls (client-only)

- Split button in `PlanSidebar` header: **Clear** dismisses completed/failed
  background + agent rows and completed plan steps; dropdown **Force clear all**
  dismisses every visible row in all three sections and closes the detail panel.
- Reuse `sidebarViewStore.dismissedIds`; plan steps use prefixed keys
  (`plan:<step text>`) via `planStepDismissKey()`.
- Batch helper `dismissItems()` closes detail when the selected row is dismissed.

### Agent completion (server + client)

Root cause: `task.updated` with terminal status cleared the server's
`pending_background_tasks` row but was **never projected to thread activities**.
The sidebar only folded `task.started` / `task.progress` / `task.completed`, so
agents whose completion arrived only as `task_updated` stayed running.

Fix:

- **Server** — `runtimeEventToActivities` emits a `task.updated` activity for
  terminal patches (`completed` / `failed` / `killed`; `killed` → `stopped` in
  payload for parity with `task.completed`).
- **Client** — `deriveAgentItems` treats terminal `task.updated` like
  `task.completed`.

**Limitation:** Historical sessions that already ingested terminal `task.updated`
events without storing them cannot retroactively flip; users should **Force
clear** stuck rows once.

## Alternatives considered

- **Client-only heuristic** (infer completion from idle thread / stale progress) —
  rejected: fragile, wrong for parallel subagents.
- **Emit all `task.updated` patches as activities** — rejected: noisy; only
  terminal statuses matter for the sidebar.

## Files touched

- `apps/web/src/sidebarSections.ts` (+tests)
- `apps/web/src/sidebarViewStore.ts`
- `apps/web/src/components/PlanSidebar.tsx`
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` (+test)

## Follow-ups deferred

- Persist manual dismissals across reload (existing v1 gap).
- Disable Clear when there is nothing completed to remove (cosmetic).
