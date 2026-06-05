# Composer To-do List Section — Design

**Date:** 2026-06-05
**Status:** Approved (post design review)

## Goal

Show the agent's live to-do list (task-tool state; formerly TodoWrite) in a collapsible section rendered
directly above the composer input textbox. Section title: `To do list <completed>/<total>`.
Each row: task number, task text, status icon (pending / in-progress / completed).

## Feasibility (verified)

The Claude Agent SDK has no dedicated todo message type, but TodoWrite tool calls are
observable in the SDK stream — and t3code **already consumes them**:

- `apps/server/src/provider/Layers/ClaudeAdapter.ts:599` — `isTodoTool()` matches
  `TodoWrite`; `extractPlanStepsFromTodoInput()` (:607) maps
  `{todos: [{content, status: pending|in_progress|completed}]}` →
  `PlanStep[] {step, status: pending|inProgress|completed}`.
- `ClaudeAdapter.ts:1876` — emits canonical `turn.plan.updated` runtime events.
  Codex (`CodexAdapter.ts`) and ACP (`AcpCoreRuntimeEvents.ts`) adapters emit the same
  event kind, so the feature is **provider-agnostic** at the event level.
- `apps/web/src/session-logic.ts:363` — `deriveActivePlanState()` reduces thread
  activities to `ActivePlanState {steps, turnId, createdAt, explanation?}`, preferring
  the current turn and falling back to the most recent plan (todos persist across
  follow-ups).
- `apps/web/src/components/ChatView.tsx:1564` — `activePlan` is computed and already
  passed to `ChatComposer` (narrowed to `{turnId?}`); `PlanSidebar.tsx` renders the same
  data in a side panel.

**Correction discovered during runtime verification:** current Claude Code builds
(CLI v2.1.x) **removed TodoWrite** — the agent's todo list is now the task tools
(`TaskCreate`/`TaskUpdate`/`TaskList`/`TaskGet`), and the existing TodoWrite plumbing
was silently dead for Claude turns. The branch therefore ALSO adds server plumbing
(see "Server: task-tool plan tracking" below). The Codex/ACP `turn.plan.updated`
emitters were already live and are untouched.

## Server: task-tool plan tracking

`ClaudeAdapter` keeps a session-scoped `taskPlan: Map<taskId, {subject, status}>`
and re-emits the full plan (one coalesced `turn.plan.updated` per SDK user message)
when task-tool results land. State is read from the **structured
`tool_use_result`** field the SDK attaches to tool-result user messages — verified
populated at runtime with the typed schemas from `sdk-tools.d.ts` — never from the
prose result text (an earlier regex-on-prose draft was replaced during sanitize):

- `TaskCreate` — `TaskCreateOutput { task: { id, subject } }` adds a pending entry
  (the id is not present in the tool input; subjects come from the structured
  result, so creates whose streamed input JSON never parsed still land).
- `TaskUpdate` — `TaskUpdateOutput { success, taskId, statusChange? }` applied only
  when `success` is true; a failed update is **not** an `is_error` result, so
  trusting input alone would desync. `statusChange.to === "deleted"` removes the
  entry; subject edits come from the tool input.
- `TaskList` — `TaskListOutput { tasks: [{ id, subject, status }] }` **reseeds the
  entire map** (order authoritative). This is the self-heal path: it recovers from
  missed/failed updates and from sessions resumed after a server restart (the map
  starts empty on resume). A missing/malformed structured result keeps the current
  plan rather than wiping it; an empty `tasks` array legitimately clears it.
- Subagent task mutations are intentionally **not** filtered out: the SDK task store
  is session-shared across the main agent and subagents (tasks carry an `owner`
  attribution), and the CLI's own task panel shows all tasks; filtering would
  diverge from `TaskList` ground truth.
- TodoWrite support is kept for older CLIs; both paths emit through one shared
  `offerPlanUpdated` helper. They derive from independent state, but a single CLI
  session uses one system or the other.

## Approach

1. **Share the status icon.** Export `stepStatusIcon()` from `PlanSidebar.tsx:32`
   (smallest diff; repo precedent is exporting helpers from peer modules). No new file.
2. **New component `ComposerTodoList`** (`apps/web/src/components/chat/ComposerTodoList.tsx`):
   - Props: `activePlan: ActivePlanState | null`.
   - Returns `null` when no plan / empty steps.
   - Uses `Collapsible` / `CollapsibleTrigger` / `CollapsiblePanel` from
     `~/components/ui/collapsible` (base-ui; controlled `open`/`onOpenChange` —
     precedent `ProviderInstanceCard.tsx:803`).
   - Trigger row: chevron + title `To do list <completed>/<total>` where
     `completed = steps.filter(s => s.status === "completed").length`,
     `total = steps.length`. (Title is the user's explicit spec; the PlanSidebar
     "Tasks" label intentionally differs.)
   - Panel rows: `<index + 1>.` number, step text, `stepStatusIcon(status)`, keyed
     **by index** (PlanSidebar's `${status}:${step}` composite key collides on
     duplicate text; the numbered list is net-new markup, not a copy of PlanSidebar
     rows — only the icon function is shared).
   - Open state: `useLocalStorage("t3code:composer-todo-list-open", true, Schema.Boolean)`
     with `Schema` imported from **`effect/Schema`** (must match the hook's own
     `Schema.Codec` — multiple Schema namespaces exist in the monorepo). Global
     preference, default expanded. `uiStateStore` was considered and rejected: it is
     per-thread structured persistence with migration machinery; a single global
     boolean matches the `editorPreferences` `useLocalStorage` precedent. Note the
     hook syncs across tabs/instances via a CustomEvent — collapse state is
     intentionally global across all mounted composers.
   - Scroll containment: panel content capped (`max-h-48 overflow-y-auto`) so a long
     todo list can't crowd out the editor.
3. **Wire into ChatComposer** (`apps/web/src/components/chat/ChatComposer.tsx`):
   - Widen prop `activePlan: { turnId?: TurnId } | null` → `ActivePlanState | null`
     (import type from `~/session-logic`). The one in-file use is the truthiness check
     feeding `showPlanSidebarToggle` (:920) — unaffected. **Important:**
     `CompactComposerControlsMenu` receives `activePlan={showPlanSidebarToggle}`
     (:2342) which is a _boolean_ prop on that child — leave it as-is; do not pass the
     widened object through.
   - Drop the now-redundant `activePlan` cast at the `ChatView.tsx:3911` call site
     (the adjacent `sidebarProposedPlan` cast and `TurnId` import remain).
   - Render **below the conditional header block** (pending approval / user-input /
     plan-follow-up) and **above the input area div** — literally right above the
     textbox. Chrome: `border-b border-border/65 bg-muted/20`, plus
     `rounded-t-[19px]` **only when `!hasComposerHeader`** (the existing header
     branches each own the top radius when present; unconditional radius would notch
     mid-card). Input-area top padding (:2128) treats the strip as a header:
     `hasComposerHeader || todo strip visible` → `pt-2.5`.
   - Hidden when `isComposerCollapsedMobile` (the collapsed-mobile branches render
     their own topmost chrome and are untouched).
   - Focus: the trigger button sits inside `composerSurfaceRef`, so clicking it fires
     `onFocusCapture` → `setIsComposerFocused(true)`. That is desired; do **not** add
     a `data-chat-composer-collapsed-controls` exemption or stopPropagation.

## Alternatives considered

| Alternative                                                    | Rejected because                                                                                                                                             |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| New SDK-side TodoWrite tracking (PostToolUse hook / new event) | Duplicates the existing `turn.plan.updated` pipeline; Claude-only; violates the shared-logic maintainability rule.                                           |
| Detached panel in `ChatView` above the composer                | More layout work; ChatView is ~4000 lines already; doesn't read as part of the input area; composer card precedent fits "right above the textbox" literally. |
| `ComposerBannerStack` item                                     | Banner stack semantics are dismissible alerts, not persistent live state.                                                                                    |
| Per-thread collapse state                                      | No precedent; global UI preference matches `editorPreferences` pattern and is what users expect from a layout toggle.                                        |

## Files touched

- `apps/web/src/components/chat/ComposerTodoList.tsx` (new)
- `apps/web/src/components/chat/ChatComposer.tsx` (prop widen + render)
- `apps/web/src/components/PlanSidebar.tsx` (export `stepStatusIcon`)
- `apps/web/src/components/ChatView.tsx` (remove cast)
- `apps/server/src/provider/Layers/ClaudeAdapter.ts` (task-tool plan tracking —
  `taskPlan` map, `applyTaskToolResult`, TaskList reseed, shared `offerPlanUpdated`)
- `apps/server/src/provider/Layers/ClaudeAdapter.test.ts` (accumulation, failed
  updates, coalescing, TaskList reseed coverage)

## Tradeoffs / limitations

- **`tool_use_result` is typed but `unknown`.** The structured field matches the
  SDK's `ToolOutputSchemas` (verified at runtime); shape checks degrade unknown or
  missing payloads to no-ops, never mis-parses.
- **Plan resets on session resume** until the model next calls TaskList (reseed) or
  creates a task; status-only updates to pre-resume tasks are unrenderable before
  that point. The client keeps showing the last persisted plan meanwhile.
- **Stale-plan persistence is accepted.** `deriveActivePlanState` deliberately falls
  back to the most recent plan from any turn ("so that TodoWrite tasks persist across
  follow-up messages", session-logic.ts:370). So at the start of a new turn — before
  its first TodoWrite — the strip shows the _previous_ turn's (typically fully
  completed) list. PlanSidebar shows the same content when open, but suppresses
  _auto-open_ for stale-turn plans (ChatView.tsx:2549); the strip has no auto-open
  concept, so the surfaces' _visibility_ can differ even though their _content_ never
  does. Accepted: matches Claude Code's own CLI behavior (todo list persists until
  replaced) and the codebase's stated intent.
- **No hide-when-all-completed.** A finished list stays visible as `N/N` until the
  next plan replaces it; the user can collapse it. Decided over auto-hide because the
  completed state is informative and the collapse preference persists.
- **Composer resizes on todo updates.** The strip lives inside `composerFormRef`,
  which a ResizeObserver watches to stick the timeline to bottom (ChatComposer.ts:1211).
  Growth on TodoWrite ticks is an intentional auto-scroll input — same mechanism as
  the image-attachment row. The 200ms Collapsible height animation may emit sub-0.5px
  frames swallowed by the observer's guard; transient one-frame lag is accepted, and
  `max-h-48` bounds steady-state height.
- Providers that never emit `turn.plan.updated` (cursor/opencode today) simply never
  show the section.
- Duplication of information with PlanSidebar is intentional (user-requested surface);
  both render from one derived state.

## Follow-ups deferred

- None identified.
