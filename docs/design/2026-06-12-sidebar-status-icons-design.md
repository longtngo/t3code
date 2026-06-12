# Sidebar thread-status icons + background-aware status — 2026-06-12

## Goal

Rework the left-sidebar thread-status indicator:

1. **Drop the "Working"/"Completed" text labels** on thread rows — the status
   becomes icon-only (the label survives in the tooltip for accessibility).
2. **Replace the colored dot with a status icon**: an animated spinner for the
   _working_ state and a checkmark for the _completed_ state. The icon color is
   the **selected provider instance's accent color** (configured in settings),
   falling back to the current semantic color when no accent is configured.
3. **Make working/completed account for background workers.** Today the status
   reflects only the top-level turn: when the top-level agent spawns a
   background task and its turn settles, the thread reads "Completed" even
   though it is still waiting on that worker. It should read "Working" while a
   background task is pending.

## Background — current architecture (verified against code)

- The per-row indicator is `ThreadStatusLabel` (`ThreadStatusIndicators.tsx`),
  which renders a `<span>` dot + a `hidden md:inline` text label, both styled
  from a `ThreadStatusPill` (`Sidebar.logic.ts`).
- `resolveThreadStatusPill()` (`Sidebar.logic.ts:329`) derives the pill from a
  `ThreadStatusInput` (a subset of `SidebarThreadSummary`). Priority order:
  Pending Approval > Awaiting Input > Working (`session.status === "running"`)
  > Connecting > Plan Ready > Completed (`hasUnseenCompletion`).
- The same pill feeds three surfaces: the thread row (non-compact), the
  command-palette `ThreadRowLeadingStatus` (non-compact), and two aggregate
  indicators — the "Show more" compact dot and the collapsed project-header dot
  (`Sidebar.tsx:886`, `:2033`), both via `resolveProjectStatusIndicator`.
- **Provider accent color**: each provider _instance_ carries an optional
  `accentColor` (hex `#RRGGBB`) configured in settings. The wire type
  `ServerProvider` has `accentColor`; the web store exposes the provider list
  via `useServerProviders()`. A thread's instance is `session.providerInstanceId`.
- **Background tasks**: durably tracked server-side in the
  `pending_background_tasks` table (migration 033), one row per in-flight task
  keyed by `task_id` with a `thread_id` (+ index `idx_pending_background_tasks_thread`).
  Rows are upserted on `task.started`, touched on `task.progress`, deleted on
  `task.completed` / terminal `task.updated`
  (`ProviderRuntimeIngestion.ts:1412`). A background task's parent turn settles
  (`latestTurn.completedAt` set, `session.status === "ready"`) while its row
  survives — that gap is exactly the "shows Completed but really Working" bug.

### The reactive-update path (the load-bearing finding)

`task.*` runtime events are converted to `thread.activity.append` **orchestration
domain events** (`ProviderRuntimeIngestion.ts:1972`) with `aggregateKind ===
"thread"`. The sidebar shell subscription's `toShellStreamEvent`
(`ws.ts:459`) **default branch re-fetches the thread shell for any
thread-aggregate event** and emits `thread-upserted`. Therefore, if the thread
shell carries a `hasPendingBackgroundTask` boolean derived from the table, it
updates live on `task.started`/`task.completed` **with no new event type** — the
existing activity-append already drives a shell refetch.

(An earlier exploration claimed task events don't reach the shell stream and a
new orchestration event was needed. That was verified false by reading
`ProviderRuntimeIngestion.ts:1972` + `ws.ts:503`.)

## Approach

Three coordinated, mostly-mechanical changes.

### A. Surface `hasPendingBackgroundTask` to the sidebar (requirement 3)

End-to-end boolean plumbing, mirroring the existing `hasPendingApprovals`:

1. **Contract** `OrchestrationThreadShell` (`packages/contracts/src/orchestration.ts`):
   add `hasPendingBackgroundTask: Schema.Boolean`.
2. **Server SQL** (`ProjectionSnapshotQuery.ts`): add to _both_ row queries
   (`listActiveThreadRows` and `getActiveThreadRowById`) and the row schema:
   ```sql
   EXISTS (SELECT 1 FROM pending_background_tasks
           WHERE thread_id = projection_threads.thread_id)
     AS "hasPendingBackgroundTask"
   ```
   SQLite `EXISTS` yields `0`/`1`, so add `hasPendingBackgroundTask:
NonNegativeInt` to `ProjectionThreadDbRowSchema` (matching
   `hasActionableProposedPlan`) and map with `row.hasPendingBackgroundTask > 0`
   in **every** `OrchestrationThreadShell` builder in the file (there are three:
   `getShellSnapshot`, `getThreadShellById`, and the third builder ~line 1893 —
   grep all `satisfies OrchestrationThreadShell` sites so none are missed).
   The EXISTS hits the existing thread index; both queries already run on every
   thread activity, so the marginal cost is negligible.
3. **Web type** `SidebarThreadSummary` (`types.ts`): add
   `hasPendingBackgroundTask: boolean`.
4. **Web mapping** `mapThreadShell` (`store.ts`): carry it through.
5. **Status logic** `resolveThreadStatusPill` (`Sidebar.logic.ts`): add
   `hasPendingBackgroundTask` to `ThreadStatusInput`; when true (and the thread
   is not already in a higher-priority state and session is not already
   running), return the **Working** pill. Placement: after the
   `session.status === "connecting"` check, before Plan Ready / Completed. This
   yields priority: Pending Approval > Awaiting Input > Working(running) >
   Connecting > Working(background) > Plan Ready > Completed.

**Ordering fix (race elimination).** Today `recordPendingBackgroundTask`
(table upsert/delete) runs _after_ the `thread.activity.append` dispatch
(`ProviderRuntimeIngestion.ts:1972` then `:1993`). The shell refetch is driven
by that append, so on `task.completed` the refetch could observe the not-yet-
deleted row (stale "Working" that may not self-correct if the thread isn't
woken). Fix: **move the `recordPendingBackgroundTask` call to immediately
before the activity-append dispatch**, so the table reflects the new state
before the event that triggers the refetch is emitted. Add a code comment
explaining the ordering requirement. `maybeWakeThreadForCompletedTask` stays
after the append (unchanged). With this ordering the signal is deterministic:
`task.started` → row present before append → Working; `task.completed` → row
gone before append → Completed (or Working if the completion wakes a new turn).

### B. Icon-ize the indicator + provider accent color (requirements 1 & 2)

1. Extend `ThreadStatusPill` with an `icon` discriminator:
   `"spinner" | "check" | "approval" | "input" | "plan"`. Assign in
   `resolveThreadStatusPill`: Working/Connecting → `spinner`, Completed →
   `check`, Pending Approval → `approval`, Awaiting Input → `input`, Plan Ready
   → `plan`. Keep `colorClass`/`dotClass`/`pulse` for fallback + back-compat.
2. New shared `ThreadStatusIcon` glyph component: maps `icon` → a lucide glyph
   (`spinner` → `Loader2Icon` with `animate-spin`; `check` → `CheckIcon`;
   `approval` → `CircleAlertIcon`; `input` → `CircleHelpIcon`; `plan` →
   `ListTodoIcon`). (Exact lucide names verified at implementation.)
3. Rework `ThreadStatusLabel` to render the **icon only** (no text label;
   tooltip retains the label). Add an optional `accentColor?: string` prop.
   **Accent applies only to the provider-tinted kinds** (`spinner`/`check`):
   when `accentColor` is set and the icon is spinner/check, color via inline
   `style={{ color: accentColor }}`; otherwise use the semantic `colorClass`.
   The action-required kinds (approval/input/plan) always keep their semantic
   colors — those colors carry meaning and must not be overridden by the brand
   accent.
4. **Thread row** (`Sidebar.tsx`) and **command-palette**
   `ThreadRowLeadingStatus` (`ThreadStatusIndicators.tsx`): resolve the row's
   accent from `session.providerInstanceId` via a small
   `useProviderAccentColor(instanceId)` hook (wraps `useServerProviders()` +
   `normalizeProviderAccentColor`) and pass it to `ThreadStatusLabel`.
5. **Aggregate surfaces** (collapsed project-header dot `Sidebar.tsx:2033`, and
   the "Show more" compact `ThreadStatusLabel compact`): switch dot → icon for
   visual consistency but **without** a provider accent — they aggregate
   potentially many threads/providers, so a single brand color is ambiguous;
   they keep the highest-priority status's semantic color.

### Fallback color rule

`useProviderAccentColor` returns `undefined` when the thread has no session, no
`providerInstanceId`, or the instance has no configured `accentColor`. In every
such case the icon falls back to today's semantic color (sky for working,
emerald for completed), so the default experience is unchanged except dot→icon
and label removal.

## Alternatives considered

- **Emit a new `thread.background-task-changed` orchestration event** to drive
  the shell refresh (the first exploration's recommendation). _Rejected_:
  verified unnecessary — `task.*` already produces a `thread.activity.append`
  that refetches the shell. Adding an event would be dead weight and a second
  source of truth.
- **Derive `hasPendingBackgroundTask` on the client from activities** (scan the
  thread's `task.started`/`task.completed` activity stream). _Rejected_: the
  sidebar summary deliberately does not carry the full activity log; the server
  table is the durable source of truth (survives restart, already drives the
  recovery watchdog), and an EXISTS column is O(1) on the existing index.
- **Make the server keep `session.orchestrationStatus === "running"` while a
  background task is pending.** _Rejected_: too invasive and semantically wrong
  — the provider session genuinely is idle/ready; many code paths
  (wake-on-completion, reaper, recovery) key off "ready". A presentational
  boolean is the smaller, safer blast radius.
- **Apply provider accent to the aggregate/project indicators too.**
  _Rejected_: those aggregate multiple threads (and providers); one accent
  colour would misrepresent. Semantic color is correct there.
- **Give every status the provider accent (incl. approval/input).** _Rejected_:
  amber/indigo/violet encode "action required" / "plan ready"; recoloring them
  to the brand accent destroys that signal. Only the neutral working/completed
  states adopt the accent.

## Files touched

- `packages/contracts/src/orchestration.ts` — add field to `OrchestrationThreadShell`.
- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` — EXISTS
  column in both row queries + row schema + both shell builders.
- `apps/web/src/types.ts` — `SidebarThreadSummary.hasPendingBackgroundTask`.
- `apps/web/src/store.ts` — carry through in `mapThreadShell`.
- `apps/web/src/components/Sidebar.logic.ts` — `icon` field, `hasPendingBackgroundTask`
  input + Working rule.
- `apps/web/src/components/ThreadStatusIndicators.tsx` — `ThreadStatusIcon`
  glyph, icon-only `ThreadStatusLabel` w/ `accentColor`, accent in
  `ThreadRowLeadingStatus`.
- `apps/web/src/providerInstances.ts` (or a hooks file) — `useProviderAccentColor`.
- `apps/web/src/components/Sidebar.tsx` — pass accent on the row, icon-ize the
  collapsed project-header indicator.
- Tests (required field forces these test-data builders to add the field):
  - `apps/server/src/server.test.ts` — `makeDefaultOrchestrationThreadShell`
    helper: add `hasPendingBackgroundTask: false`.
  - `apps/web/src/environmentGrouping.test.ts` — `makeSidebarThreadSummary`
    helper: add `hasPendingBackgroundTask: false`.
  - `apps/web/src/components/Sidebar.logic.test.ts` — add `icon` assertions and
    2-3 cases for the background-task Working rule (notably: session `ready` +
    `hasPendingBackgroundTask: true` ⇒ Working; and that Pending Approval /
    Awaiting Input still outrank it).
  - Grep `satisfies OrchestrationThreadShell` and `SidebarThreadSummary` literal
    builders across the repo (typecheck will flag any missed required field).

## Tradeoffs & known limitations

- `getThreadShellById` runs on every thread activity; the added EXISTS is a
  cheap indexed lookup but it is on a hot path — acceptable, noted.
- Removing the inline text label slightly reduces at-a-glance scannability on
  wide screens; mitigated by the icon vocabulary + tooltip.
- Transient "still shows Working for a moment" after a background task completes
  but before a wake-up turn starts; benign and self-correcting.

## Follow-ups deferred

- Per-status accent treatment for action-required states (none planned).
- Surfacing a count when multiple background tasks are pending (boolean is
  sufficient for the status indicator).
