# Task sidebar: background-process + agent sections — 2026-06-13

## Goal

Extend the per-thread task sidebar (`PlanSidebar`) into three collapsible
sections and add a click-through detail panel:

1. **Tasks** — the existing TodoWrite plan steps (unchanged data).
2. **Background processes** — the active thread's **terminal sessions** (user
   decision: background = terminal/PTY sessions).
3. **Agents / subagents** — the active thread's **task-stream subagents**
   (derived from `task.*` activities).

Cross-cutting requirements:

- Every section is collapsible (reuse the `Collapsible` primitive).
- Within every section, **completed items sink to the bottom** (tasks too).
- Each item is marked **pending / running / completed** with the same status
  glyphs the plan steps use (`stepStatusIcon`).
- Clicking a **background** or **agent** item toggles a **right-hand detail
  panel** (mirrors the diff panel) showing that item's detail + running log.
- Completed background/agent items **auto-clear 6 h** after finishing; a manual
  **remove (×)** button is always available. (Tasks are LLM-managed, so they are
  NOT auto-cleared/removable — only background/agent items are.)

Scope: the **active thread only** (matches how the task sidebar already works).

## Background (verified against code)

- `PlanSidebar.tsx` is the per-thread task sidebar (mounted in `ChatView`, right
  side, `planSidebarOpen`). Plan steps come from
  `deriveActivePlanState(activeThread.activities, latestTurnId)` →
  `ActivePlanState.steps[{ step, status: pending|inProgress|completed }]`.
  Status glyphs/row/text helpers are exported: `stepStatusIcon`, `stepRowClass`,
  `stepTextClass`. Steps render in plan order (no completed-to-bottom today).
- `Collapsible` / `CollapsibleTrigger` / `CollapsiblePanel`
  (`components/ui/collapsible.tsx`, base-ui) is the disclosure primitive, with a
  chevron-rotate pattern already used in `ChatMarkdown`.
- **Terminal sessions** (background): `useKnownTerminalSessions({environmentId,
threadId})` → `KnownTerminalSession[]` (`{ target:{...,terminalId},
state }`). `TerminalSessionState` carries `summary` (`label`, `cwd`, `status`,
  `exitCode`, `pid`), `status` (`running|idle|exited|closed|…`), and `buffer`
  (the terminal output = the log). `TerminalViewport` (exported from
  `ThreadTerminalDrawer.tsx`) renders the live xterm; the existing terminal
  drawer is the interactive surface.
- **Agents/subagents**: the thread's `activities[]` contain `task.started` /
  `task.progress` / `task.completed` (payloads: `taskId`, `taskType?`,
  `detail`/`summary`, `lastToolName?`, `status`, `outputFile?`, `usage?`). These
  are already streamed to the client (`activeThread.activities`) — no new server
  RPC needed. Grouped by `taskId` they yield an item + an ordered progress log.
  Full subagent transcripts are NOT available — only these discrete progress
  summaries (acceptable: spec says "running log … if available").
- **Right-panel pattern**: `fileViewerStore` (Zustand: `open`, `request`,
  `openFileViewer`, `closeFileViewer`) + `RightPanelSheet` (mobile sheet) + a
  resizable inline `Sidebar` (`side="right"`, `storageKey` width persistence),
  selected by `RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY`. Diff + file-viewer are
  mutually-exclusive right panels wired in
  `routes/_chat.$environmentId.$threadId.tsx`.

## Approach

### Data derivation (client-only, pure + unit-tested)

New module `apps/web/src/sidebarSections.ts`. The activity payload is
`Schema.Unknown`, so every field is narrowed defensively (`asRecord` /
`asTrimmedString`, like `session-logic.ts`).

- `SidebarItemStatus = "pending" | "running" | "completed" | "failed"`.
  (`failed` is its own status so the glyph can tint red — `stepStatusIcon`
  has no failed variant, so a small `sidebarStatusIcon` wrapper adds it and
  otherwise delegates.)
- `deriveAgentItems(activities): AgentSidebarItem[]` — fold `task.*` by `taskId`:
  `{ taskId, label (started.detail/description), status, startedAt,
completedAt?, outputFile?, finalSummary?, log: { at, text, lastToolName? }[] }`.
  `task.started` ⇒ running; `task.completed` ⇒ completed, or `failed` when
  `payload.status ∈ {failed, stopped}`. **Final summary = the completed
  activity's `payload.detail`** (the server maps `message.summary` → `detail`
  on completion); each progress log entry's text = `payload.summary ??
payload.detail`. `completedAt` = the completed activity's `createdAt`.
  Agents are **Claude-only** today (only `ClaudeAdapter` emits `task.*`).
- `deriveBackgroundItems(terminals): BackgroundSidebarItem[]` from
  `useKnownTerminalSessions`. Terminal status enum is
  `starting | running | exited | error | closed` (no `idle`); `summary` may be
  null. Map: `running` ⇐ `{starting, running}`; `completed` ⇐ `{exited, closed}`;
  `failed` ⇐ `error` **or** (`exited` with `exitCode` not 0). `label/cwd/exitCode`
  read defensively from `summary` with fallbacks (`label ?? "Terminal"`). There
  is no exit timestamp, so `completedAt` is approximated by `summary.updatedAt`
  (stable once a terminal stops emitting). Item id = `terminalId`.
- `sortSidebarItems(items)` — a **total order**: active (running/pending) before
  terminal (completed/failed); active sorted by `startedAt` asc, terminal by
  `completedAt` desc; missing/`NaN` timestamps sort last within their group with
  a stable id tiebreak (mirrors the `Number.isNaN` guards in `session-logic`).
  Applied to all three sections (tasks reuse the comparator on step statuses).

### Dismissal + auto-clear (client-only, no new store, no timer)

Reuse the existing **`uiStateStore`** (already persisted, already holds per-UI
prefs): add a `dismissedSidebarItemsById: Record<itemKey, dismissedAtIso>` slice

- `dismissSidebarItem(key)` / a section-collapse slice. Pure
  `isAutoCleared(item, nowMs, ttlHours)` hides a _completed/failed_ item when
  `now - completedAt > ttl` (`AUTO_CLEAR_TTL_HOURS = 6`). A terminal/agent item is
  hidden when dismissed OR auto-cleared. **No interval** — the filter runs at
  render time against `Date.now()`; the sidebar already re-renders as
  activities/terminals stream, and a coarse delay for a fully-idle thread is
  cosmetic. Manual remove (`×`) sets `dismissedAt = now`; offered on
  completed/failed rows (the common case) — running items aren't dismissable.

### UI

- Refactor `PlanSidebar` into a section host rendering up to three
  `<SidebarSection>` (base-ui `Collapsible`) blocks: **Tasks**, **Background
  processes**, **Agents**. Header = label + count + chevron; collapse state
  persisted per section in `uiStateStore`. **Empty sections are hidden** (so a
  non-Claude thread shows no empty Agents section, and a thread with no
  terminals shows no Background section). If all three are empty, fall back to
  today's empty-plan state.
- Background/agent rows: status glyph (`sidebarStatusIcon`) + label; the row is a
  button that selects the item for the detail panel; completed/failed rows show a
  hover `×` remove.

### Detail panel (master/detail inside ChatView, presents like the diff panel)

The plan sidebar is mounted inside `ChatView` (`planSidebarOpen` is ChatView
local state) and is **uncoordinated** with the route-level diff/file-viewer
panels — so the detail panel is mounted as a **sibling of `PlanSidebar` within
`ChatView`'s flex row**, driven by ChatView-local `selectedSidebarDetail`
state, NOT a route-level peer and NOT a global store. This keeps the
launching-item ↔ detail lifecycle local (closing the plan sidebar closes the
detail; the existing composer-crush guard still applies to one region), shares
the right-region column budget, and still presents as a right-side panel
(resizable on desktop, `RightPanelSheet` on mobile via the inline media query).

- `SidebarDetailPanel.tsx` renders from a `{ kind: "agent" | "background", id }`
  selection, **re-derived live** from `activeThread.activities` /
  `useKnownTerminalSessions` by id each render (the selection holds only the id,
  never a snapshot — so progress/buffer update live):
  - **agent**: header (label + status + times) + ordered progress log + final
    summary + an `outputFile` chip (opens the existing file viewer).
  - **background**: header (label/cwd/status/exitCode) + terminal log via a
    read-only render of `state.buffer` (xterm `TerminalViewport` reuse is a
    deferred enhancement; a `<pre>` with ANSI stripped is the v1).
- Selecting an item that's been dismissed/cleared still opens its detail (the
  selection is by id, independent of the visible-list filter).

## Alternatives considered

- **Background = backgrounded `task.*` shells (split task stream).** Rejected by
  user decision — background = terminal sessions; agents = task stream. Cleaner
  data sources (terminals carry a reliable status + output buffer; no fragile
  `taskType` heuristic needed).
- **New server RPC to list pending background tasks / subagents.** Rejected: the
  thread `activities[]` already carry the task lifecycle client-side, and
  terminals already have a client store. Per-active-thread scope needs no new
  server surface. (A cross-thread/global view _would_ need server work — out of
  scope per the active-thread decision.)
- **Server-side dismissal/auto-clear state.** Rejected: dismissal is a per-user
  view preference; the client persistence store is the right home and avoids
  server plumbing. Auto-clear is a pure time filter over `completedAt`.
- **Route-level peer detail panel + global `sidebarDetailStore` (mirroring
  diff/file-viewer mounting).** Rejected after design review: the plan sidebar is
  mounted inside `ChatView` and is uncoordinated with the route panels, and the
  detail panel must coexist with the plan sidebar (you click an item _in_ it) —
  a route-level peer would create an uncoordinated 4th/5th column and need a
  global store only to bridge that self-inflicted gap. Mounting the detail panel
  as a ChatView-local master/detail sibling removes the store, the extra host
  plumbing, and the composer-crush blindness, and still presents as a right
  panel.
- **Separate persisted `sidebarDismissalStore` + 60 s auto-clear interval.**
  Rejected: dismissal + section-collapse fold into the existing `uiStateStore`
  (one persistence surface), and auto-clear is a render-time pure filter — a
  blanket 60 s interval per mounted sidebar buys nothing for a 6 h TTL.
- **Reuse the existing terminal drawer instead of a right detail panel.**
  Rejected: spec wants a uniform right panel for both background and agent
  items, behaving like the diff panel.

## Files touched (planned)

New: `sidebarSections.ts` (+test) — pure derivation/sort/auto-clear;
`components/SidebarSection.tsx` — collapsible section + row;
`components/SidebarDetailPanel.tsx` — agent/background detail+log.
Modified: `components/PlanSidebar.tsx` (three-section host + completed-to-bottom
ordering + remove), `components/ChatView.tsx` (mount the detail panel as a
sibling of PlanSidebar, `selectedSidebarDetail` local state, sheet on mobile),
`uiStateStore.ts` (dismissal map + per-section collapse slices, persisted).
No new global store; no route-file changes.

## Tradeoffs & known limitations

- Agent items derived from activities can show a stale "running" if a server
  restart drops a task's `task.completed`; the recovery watchdog eventually
  emits completion. Acceptable for v1.
- Agent "log" is the discrete progress summaries, not a full transcript (server
  limitation).
- Empty sections: render a muted placeholder rather than hide, so the user can
  see the section exists (revisit if noisy).
- Adding a third/fourth right region risks crowding on mid-width screens; the
  detail panel is mutually exclusive with diff/file-viewer to limit columns, and
  collapses to a sheet under the inline media query.

## Follow-ups deferred

- Cross-thread / global background+agent view (needs server list RPC).
- Full subagent transcript capture (server plumbing).
- User-configurable auto-clear TTL (ship the 6 h constant first).
