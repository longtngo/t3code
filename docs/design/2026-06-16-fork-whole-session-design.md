# Fork Whole Session (toolbar) — Design

**Date:** 2026-06-16
**Branch:** `feat/fork-whole-session`
**Status:** Design

## Goal

Add a **second** fork affordance — a button on the chat's **top toolbar** (`ChatHeader`) — that forks
the **entire** current thread: clone *every* message (all user + assistant, first to last) into a new
independent thread and switch to it, carrying the full agent context. Complements the existing
per-message fork (clones *before* a clicked user message + pre-fills the composer).

## Background (reuses the merged fork feature)

The `thread.fork` command → `thread.forked` event already exists
(`docs/design/2026-06-16-fork-thread-design.md`, merged `757292173`). It clones messages with index
`< indexOf(forkBeforeMessageId)`, sets up a deferred `pendingForkResume` directive consumed at the
fork's first session start, and `ProviderService` forks the parent's live session
(Claude `forkSession` / Codex `thread/fork`). The per-message UI lives in `MessagesTimeline`
(`ForkUserMessageButton`) + `ChatView.onForkUserMessage`.

## Approach

A whole-session fork is the **same command with the fork point at the end** of the conversation.

### Backend — make `forkBeforeMessageId` optional

`ThreadForkCommand.forkBeforeMessageId` becomes `Schema.optional`. In the decider:
- **Undefined** (whole session): `slice = sourceThread.messages` (everything); fork point is the end.
- **Defined** (per-message, unchanged): `slice = messages.slice(0, indexOf(id))`; reject if the id is
  absent.
- The existing **streaming guard** still applies to the last in-slice message (for whole-session that
  is the very last message — so you can't fork mid-turn; the toolbar button is also disabled while
  working).
- **`forkContextApproximate`**: a whole-session fork carries the parent's *complete* session
  (forkSession at the parent's latest cursor) and the displayed messages are the *complete* list — so
  there is **no** display/context mismatch → `approximate = false`. The flag stays `true` only for the
  per-message case lacking a precise anchor:
  `approximate = forkBeforeMessageId !== undefined && slice.length > 0 && anchor === undefined`.
- `forkResume = slice.length > 0 ? { fork: true, sourceThreadId } : undefined` (unchanged). With no
  `resumeSessionAt`, ProviderService forks the full parent session = exactly the end-of-conversation
  state. **This is why whole-session fork is precise even before the deferred per-message
  anchor-capture follow-up lands.**

No projector / ProviderService / adapter changes — they already handle the directive.

### Frontend — toolbar button

- **`ChatHeader`** gains `onForkThread: () => void` + `forkThreadDisabled: boolean` and renders a
  `Button` (not a Toggle — it's an action) with `GitForkIcon` in the right-side cluster beside the
  terminal/diff toggles. Tooltip: "Fork entire conversation into a new thread".
- **`ChatView`** adds `onForkThread`: dispatch `thread.fork` with `sourceThreadId = activeThread.id`,
  a new `newThreadId`, **no** `forkBeforeMessageId`, `title = "<parent> (fork)"`; on success
  `navigate` to the new thread. **No composer pre-fill** (continue from the end). `forkThreadDisabled
  = !isServerThread || activeThread.messages.length === 0 || phase === "running" || isSendBusy ||
  isConnecting`.
- Shared internals (`readEnvironmentApi`, `newThreadId`, `newCommandId`, `navigate`, toast) mirror
  `onForkUserMessage`; the only differences are the omitted `forkBeforeMessageId` and the absence of
  prefill. Factor the common dispatch into a small helper to avoid duplication.

## Files touched

| Area | File | Change |
|---|---|---|
| Contract | `packages/contracts/src/orchestration.ts` | `forkBeforeMessageId` → optional |
| Decider | `apps/server/src/orchestration/decider.ts` | undefined ⇒ slice = all; approximate only for the per-message no-anchor case |
| Client UI | `apps/web/src/components/chat/ChatHeader.tsx` | `onForkThread` + `forkThreadDisabled` + button |
| Client logic | `apps/web/src/components/ChatView.tsx` | `onForkThread` handler; pass props to ChatHeader |

## Alternatives considered

- **A distinct `thread.fork-all` command / event.** Rejected — needless duplication; the existing
  command generalizes by making one field optional, and the whole-session case is the natural
  end-of-conversation fork point.
- **Reuse the per-message path with `forkBeforeMessageId = <last message>`.** Rejected — that clones
  everything *before* the last message (drops the final turn) and would pre-fill; semantics differ
  from "clone the entire session, continue from the end".
- **Fork from a fresh fresh session vs. native session fork.** N/A — reuses the merged native-fork
  path; whole-session is the precise case.

## Tradeoffs & limitations

- Shares the parent's worktree/branch (same as the per-message fork, per the prior decision).
- If the parent never ran a turn (no provider cursor), the fork starts fresh — but a whole-session
  fork of an unstarted thread is disabled anyway (no messages).

## Follow-ups deferred

- None new. (The per-message precise-anchor capture and image-attachment prefill remain from the
  parent feature; whole-session fork does not need them.)
