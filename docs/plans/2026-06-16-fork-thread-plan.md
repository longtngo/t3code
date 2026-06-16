# Fork Thread — Implementation Plan

Design: `docs/design/2026-06-16-fork-thread-design.md`. Order is dependency-first (contracts compile
before server, server before client). Commit per task.

## T1 — Contracts (`packages/contracts/src/orchestration.ts`)
- Add optional `providerMessageId: Schema.optional(TrimmedNonEmptyString)` to `OrchestrationMessage`.
- Add optional `pendingForkResume: Schema.optional(Schema.Unknown)` to `OrchestrationThread`.
- Add `ThreadForkCommand` (type `"thread.fork"`): `commandId, createdAt, sourceThreadId, newThreadId,
  forkBeforeMessageId, title`.
- Add `ThreadForkedEvent` (type `"thread.forked"`) payload: cloned config + `messages[]` +
  `forkResume` (unknown) + `forkContextApproximate: boolean`.
- Add an internal `ThreadForkResumeConsumedEvent` (`"thread.fork-resume-consumed"`) to clear
  `pendingForkResume` once the first session starts. (Or fold the clear into session-set; pick the
  smaller diff while reading.)
- Register `ThreadForkCommand` in `DispatchableClientOrchestrationCommand`; register both events in
  the orchestration event union / event-type literals.
- `pnpm --filter @t3tools/contracts build` green.

## T2 — Decider (`apps/server/src/orchestration/decider.ts`)
- Handle `thread.fork`: `requireThread(sourceThreadId)`, `requireThreadAbsent(newThreadId)`.
- Compute fork slice = messages strictly before `forkBeforeMessageId`, applying the same retention
  rule revert uses (system messages always kept). Reject if the last in-slice message is `streaming`.
- Build `forkResume` from the parent's `session.resumeCursor` + the precise anchor: the
  `providerMessageId` of the last assistant message in the slice (when present) → `{ ...cursor,
  fork: true, resumeSessionAt: anchor }`; set `forkContextApproximate = true` when no anchor /
  no parent cursor.
- Emit `thread.forked` with cloned config (projectId, title, modelSelection, runtimeMode,
  interactionMode, branch, worktreePath), the slice, the directive, and the flag.
- Unit test: slice boundary, system-message retention, streaming rejection, approximate flag.

## T3 — Projector (`apps/server/src/orchestration/projector.ts`)
- Apply `thread.forked`: construct a fully-populated `OrchestrationThread` (messages from payload as a
  complete array — not the streaming path; activities/plans/checkpoints empty; session null;
  `pendingForkResume` = directive).
- Apply `thread.fork-resume-consumed`: clear `pendingForkResume`.
- Store `providerMessageId` on the assistant message when present on the message-complete event.
- Unit test: forked thread shape; pendingForkResume set then cleared.

## T4 — Provider message uuid capture (`ClaudeAdapter.ts`)
- On assistant message-complete, include `message.uuid` so it lands on the message event →
  `providerMessageId`. (Already read at `:2378`; thread it through the complete command/event.)

## T5 — Session start consumes the directive (`ProviderCommandReactor.ts`)
- At the fresh-thread seam (`:571`), if `thread.pendingForkResume` present, call
  `startProviderSession({ resumeCursor: thread.pendingForkResume })`, then dispatch
  `thread.fork-resume-consumed`.

## T6 — Claude fork honoring (`ClaudeAdapter.ts`)
- Extend `readClaudeResumeState` to read `fork: boolean`.
- When `fork`, set `forkSession: true` in queryOptions (`:3321-3351`) alongside `resume` +
  `resumeSessionAt`. Guard a stale/unknown `resumeSessionAt` → retry without it (full-session fork);
  surface via the approximate flag.

## T7 — Codex fork honoring (`CodexSessionRuntime.ts`)
- When the resume directive has `fork: true`, issue `thread/fork` (`V2ThreadForkParams`) against the
  parent `threadId`; adopt the returned new thread id as this session's cursor. Fallback to fresh
  start + approximate flag if unsupported.

## T8 — Fork button UI (`apps/web/src/components/chat/MessagesTimeline.tsx`)
- `ForkUserMessageButton` beside copy/revert (`:384`); `GitForkIcon`; tooltip "Fork thread from
  here"; disabled on `activity.isRevertingCheckpoint || activity.isWorking`; calls
  `ctx.onForkUserMessage(messageId)`.

## T9 — Fork handler (`apps/web/src/components/ChatView.tsx`)
- `onForkUserMessage(messageId)`: read the message; generate `newThreadId`; dispatch `thread.fork`;
  on success `navigate` to the new thread; `setComposerDraftPrompt` + attachments for the fork target;
  toast when `forkContextApproximate`. Wire into `TimelineRowCtx`.

## T10 — Verify
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:browser`. Manual smoke: fork early msg →
  new thread, original intact, composer pre-filled, switch back and forth.
