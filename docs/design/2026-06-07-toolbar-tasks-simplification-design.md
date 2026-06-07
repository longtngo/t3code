# Toolbar & Tasks Simplification — Design

**Date:** 2026-06-07
**Branch:** `worktree-feat+toolbar-tasks-simplification` (off local `main` 6b761117)
**Status:** Approved (HTML prototype signed off)

## Goal

Simplify the chat input toolbar and the tasks/plan surfaces. Six changes, all driven by an approved
HTML prototype (`~/reports/t3code/2026-06/2026-06-07-toolbar-tasks-simplification-prototype.html`).

## Changes

1. **Remove `AccountSwitcher`** from the composer footer. The model picker already selects
   the account (each model option is instance-scoped), so the switcher is redundant.
2. **Promote the Tasks/plan toggle to the top header**, next to "Toggle diff panel", and make it
   permanent (always visible & enabled — confirmed with user). Keep the `ListTodo` icon. Tooltip:
   `Toggle tasks panel (x/y)` where `x/y` = completed/total steps. Show a spinner next to the icon
   when any step is `inProgress`.
3. **Tasks panel title** keeps just the `Tasks`/`Plan` badge + a spinner when a step is in progress.
   (Count is intentionally NOT duplicated in the title — it lives on the toggle.)
4. **Remove `ComposerTodoList`** (the in-input "TO DO LIST x/y" collapsible). The permanent toggle
   replaces it.
5. **Move the context-window indicator into the Usage meter.** Remove `ContextWindowMeter` from the
   composer footer. Add a `ctx` data point as the FIRST segment of the Usage meter trigger (desktop
   inline bar + mobile pill), separated by a hairline divider from the account-usage windows, and a
   `Context window` row as the FIRST row in the popover.
6. **Force-refresh button** in the Usage-limits popover header that triggers an immediate
   account-usage poll.

## Approach

### Frontend (apps/web)

- **#1** Delete `AccountSwitcher.tsx` (+ its `.browser.tsx` story if present) and remove its usage +
  import from `ChatComposer.tsx`. `recallAccountModel` (in `accountModelMemory.ts`) is only used by
  the switcher; remove it and any now-orphaned writer if dead. Keep `onProviderModelSelect` (still
  used by the model picker).
- **#2 / #3** `activePlan`, `planSidebarOpen`, `togglePlanSidebar`, `planSidebarLabel` already live in
  `ChatView`, which renders `ChatHeader` and `ChatComposer` as siblings. Thread the four into
  `ChatHeader`; add a `Toggle` next to the diff toggle. Compute `completed/total` and
  `anyInProgress` from `activePlan.steps`. Remove the plan toggle block from
  `ComposerFooterModeControls` and its now-unused props. Add the spinner to `PlanSidebar`'s header.
- **#4** Delete `ComposerTodoList.tsx`; remove its usage + the `showTodoListSection` gate in
  `ChatComposer.tsx`.
- **#5** Remove `ContextWindowMeter` from the composer footer (`ComposerFooterPrimaryActions`,
  `activeContextWindow` prop). In `BranchToolbar`, derive the context-window snapshot
  (`deriveLatestContextWindowSnapshot`, same activities source as usage) and pass it to `UsageMeter`.
  Extend `UsageMeter` to render the `ctx` segment/row. Because context exists even when there are no
  Claude usage windows, change the meter's early-return so it renders when EITHER usage segments OR a
  context snapshot is present. Keep `ContextWindowMeter.tsx` file (reused for the popover row styling)
  or inline the row — decided: inline a `PopoverRow`-style context row to keep one styling source.

### Backend (#6 force refresh — the only server-touching change)

No on-demand usage refresh exists today; usage is emitted by a 60s poller
(`ClaudeAdapter.refreshAccountUsage` → `makeAccountUsagePoll` in `OAuthUsage.ts`). Wire a new RPC:

- **contracts**: add `account.usage.refresh` method (no/idempotent input, returns `{ ok }`).
- **server**: expose the existing `refreshAccountUsage` effect as a callable provider-service method
  and add the RPC handler that invokes it for the active provider. Re-uses the existing emit path so
  the refreshed snapshot flows back through `account.usage.updated` activities — the UI updates
  reactively, the button just needs to fire-and-forget + show a brief spinner.
- **web**: add `accountUsage.refresh` to `environmentApi`; call it from the popover button.

If exposing the effect cleanly proves large, fallback: the button still triggers the RPC; server-side
it calls the same poll-and-emit used by the timer. No new fetch logic is introduced.

## Alternatives considered

- **Keep AccountSwitcher but hide when 1 account** — rejected: it's already conditional on ≥2
  accounts; the redundancy with the model picker is the actual complaint, not the count.
- **Context window stays in footer, just restyled** — rejected: user explicitly wants it relocated
  into the usage component to reclaim footer space.
- **Client-side "refresh" that just re-derives from existing activities** — rejected: that doesn't
  fetch new data; the user wants fresh numbers, which requires a server poll.

## Files touched

- web: `ChatView.tsx`, `chat/ChatHeader.tsx`, `chat/ChatComposer.tsx`, `chat/UsageMeter.tsx`,
  `components/BranchToolbar.tsx`, `PlanSidebar.tsx`, `environmentApi.ts`; delete
  `chat/AccountSwitcher.tsx`, `chat/ComposerTodoList.tsx`, `accountModelMemory.ts` (if dead).
- contracts: `rpc.ts` (+ schemas).
- server: `provider/Layers/ClaudeAdapter.ts`, `OAuthUsage.ts` (expose effect), RPC handler wiring.

## Tradeoffs / limitations

- Permanent toggle shows even with no plan (`0/0`) — accepted by user for discoverability.
- Moving context into the usage meter means non-Claude threads (no usage windows) now show a
  single-segment meter (`ctx` only) where before the footer meter was always present. Handled by the
  EITHER-present render condition.

## Follow-ups deferred

- None known up front; drain any surfaced during sanitize per build-task Rule 6.
