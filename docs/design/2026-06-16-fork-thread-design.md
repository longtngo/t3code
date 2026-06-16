# Fork Thread — Design

**Date:** 2026-06-16
**Branch:** `feat/fork-thread`
**Status:** Design (pending review)

## Goal

Add a **fork** button to every user message in the chat transcript. Clicking it creates a
**new independent thread** that clones the conversation **up to that point**, switches the user to
the new thread, and leaves the original untouched. The user can continue the forked conversation
without affecting the original and switch back and forth between them freely.

The clone is a 1:1 carry-over of everything that defines a thread: project, title, model selection
(provider instance + model + options), runtime mode, interaction mode, git branch + worktree, and —
critically — the underlying agent **conversation context** ("context window").

## Product decisions (confirmed with user)

1. **Fork boundary = "pre-fill, don't send."** The forked thread contains every message *strictly
   before* the clicked user message. The clicked message's text + attachments are pre-loaded into
   the forked thread's composer **unsent**, so the user can tweak the prompt and send it themselves.
2. **Git = share parent's worktree & branch.** The fork copies the parent's `branch` and
   `worktreePath` verbatim. No new worktree/branch is created. (Accepted limitation: if both threads
   run turns that edit files, they operate on the same working tree and can collide. This is the
   user's explicit choice; documented under Limitations.)
3. **Provider session = best-effort + warn.** Always create the cloned thread. Carry the agent
   context over with full fidelity where the provider supports it; where it cannot (older threads
   missing a precise anchor, a provider that rejects a mid-conversation fork, or a parent that never
   ran a turn), fall back to the closest available context and surface a **non-blocking** notice.

## Background — how the relevant pieces work today

- **Threads are an event-sourced aggregate.** `OrchestrationThread`
  (`packages/contracts/src/orchestration.ts:333`) carries `id, projectId, title, modelSelection,
  runtimeMode, interactionMode, branch, worktreePath, latestTurn, messages[], proposedPlans[],
  activities[], checkpoints[], session, …`. Commands → `decider` → events → `projector` builds the
  in-memory read model. Creation today: `thread.create` command (`decider.ts:215`) →
  `thread.created` event → projector creates an empty thread (`projector.ts:243`).
- **Messages** (`OrchestrationMessage`, `orchestration.ts:213`) carry `id, role, text, attachments?,
  turnId, streaming, createdAt, updatedAt`. They live only in the read model (event-sourced, capped
  at 2000). There is **no per-message provider/SDK id** stored today.
- **Per-turn checkpoints** (`OrchestrationCheckpointSummary`, `orchestration.ts:283`) carry
  `turnId, checkpointTurnCount, checkpointRef (git), assistantMessageId, status, files`. The
  existing **revert** flow (`thread.checkpoint.revert`) prunes messages/activities/plans to a turn
  count and resets the git worktree — `projector.ts:60` (`retainThreadMessagesAfterRevert`) already
  knows how to slice a thread's history at a turn boundary. The client already maps each user
  message → its revert turn count (`revertTurnCountRef` in `ChatView.tsx`).
- **Session context is held by the agent backend, keyed by an opaque `resumeCursor`**
  (`ProviderSession.resumeCursor`, `provider.ts:34`):
  - **Claude** (`ClaudeAdapter.ts`): `resumeCursor = { threadId, resume: <sessionUUID>,
    resumeSessionAt: <last assistant message uuid>, turnCount }`. The Claude Agent SDK 0.3.159
    `query()` accepts `resume`, `resumeSessionAt`, and **`forkSession: true`** (`sdk.d.ts:1429`),
    which resumes from a session **into a new session id**, leaving the original transcript intact —
    exactly a fork. `resumeSessionAt` truncates the forked context to a specific message uuid. The
    SDK message uuid is observed per assistant message (`ClaudeAdapter.ts:2378`) but only the latest
    is persisted (in the cursor).
  - **Codex** (`CodexSessionRuntime.ts`): `resumeCursor = { threadId: <codex-app-server thread id> }`
    and the app-server exposes a native **`thread/fork`** (`V2ThreadForkParams`,
    `effect-codex-app-server`).
- **First turn of a fresh thread** starts a session with `resumeCursor: undefined`
  (`ProviderCommandReactor.ts:571`); a resume passes the parent cursor through
  `providerService.startSession`.
- **Composer pre-fill** is available client-side: `useComposerDraftStore().setPrompt(target, text)`
  (`ChatView.tsx:877`). Thread switching: `navigate({ to: "/$environmentId/$threadId", … })`.

## Approach

A fork is a **non-destructive branch** of a thread: like a revert that produces a *copy* instead of
mutating in place, and defers the provider session fork until the user actually sends the pre-filled
prompt.

### 1. New command + event: `thread.fork` → `thread.forked`

`ThreadForkCommand` (client-dispatchable):

```
type: "thread.fork"
commandId, createdAt
sourceThreadId: ThreadId      // parent
newThreadId: ThreadId         // client-generated id for the fork
forkBeforeMessageId: MessageId// the clicked user message; clone everything strictly before it
title: TrimmedNonEmptyString  // default `${parent.title} (fork)`
```

The **decider** (`decider.ts`):
1. `requireThread(sourceThreadId)`, `requireThreadAbsent(newThreadId)`.
2. Compute the fork slice: all messages with index `< indexOf(forkBeforeMessageId)`, reusing the
   same retention rule as revert (system messages always kept). Compute the corresponding
   `forkTurnCount` (the turn count *before* the clicked message's turn — identical to the value
   revert would use).
3. Build a **fork resume directive** from the parent's live session + the fork point (see §3).
4. Emit one `thread.forked` event carrying: cloned config (`projectId, title, modelSelection,
   runtimeMode, interactionMode, branch, worktreePath`), the cloned `messages[]` slice, and the
   `forkResume` directive.

The **projector** handles `thread.forked` by constructing a fully-populated `OrchestrationThread`
(like `thread.created` but with `messages` pre-filled and `session: null`, `activities/plans/
checkpoints: []`). The `forkResume` directive is stashed so the first `startSession` for this thread
uses it as its `resumeCursor`.

> One event carries the whole slice (≤2000 msgs) rather than replaying N `message-sent` events —
> atomic, ordering-safe, and avoids an event storm. Mirrors how `thread.created` is a single event.

### 2. Cloned config (the "1:1" carry-over)

Copied verbatim from the parent thread: `projectId, modelSelection (instanceId+model+options),
runtimeMode, interactionMode, branch, worktreePath`. `title` defaults to `"<parent> (fork)"`.
`session`, `latestTurn`, `activities`, `proposedPlans`, `checkpoints` start empty/null — they are
execution artifacts, not identity. Because the worktree is shared (decision #2), the git state the
fork sees is already correct with no git operations.

### 3. Deferred provider session fork (the "context window")

Because the prompt is pre-filled but **not sent**, no session is created at fork time. We instead
store an initial **fork resume directive** on the new thread, consumed by its first `startSession`:

```
forkResume = {
  ...parentResumeCursor,        // provider-specific opaque cursor (Claude sessionUUID / Codex threadId)
  fork: true,                   // NEW: tell the adapter to fork, not continue, the parent session
  forkAtTurnCount: forkTurnCount,
  forkAtAnchor?: <provider anchor at fork point, when known>,
}
```

Adapter behavior:
- **Claude**: pass `resume: parentSessionId`, `forkSession: true`, and `resumeSessionAt: forkAtAnchor`
  when an anchor is known. `forkSession` guarantees a **new** session id, so the original transcript
  is never appended to (original stays intact, satisfying decision-independence). When the fork point
  is the *end* of the parent conversation, the anchor is the parent's live `resumeSessionAt` →
  **precise**. For an *earlier* point, the precise anchor is the SDK uuid of the assistant message
  just before the clicked message.
- **Codex**: issue `thread/fork` against the parent `threadId`, adopting the returned new thread id
  as the fork's cursor.
- **Fallback (best-effort + warn)**: if no precise anchor is available for a mid-conversation fork
  (e.g. older thread), fork the whole parent session (provider keeps full context — may include a
  little more than the cloned messages show) and set a `forkContextApproximate: true` flag the client
  surfaces as a non-blocking notice. If the parent never ran a turn (no cursor), start fresh.

**Precise mid-conversation anchors (additive, going forward).** To make *every* fork point precise
for threads created after this ships, capture the provider's resume anchor per assistant turn:
the Claude adapter already sees `message.uuid` (`ClaudeAdapter.ts:2378`); plumb it onto the
assistant message-complete path and store it as an optional `resumeAnchor` on the per-turn
**checkpoint** record (which already pairs `turnId`↔`assistantMessageId`). The decider then looks up
the checkpoint at `forkTurnCount` to fill `forkAtAnchor`. Older threads without it fall back as
above. (This is the one piece the design review should pressure-test for scope; it can ship in the
same change or be deferred behind the fallback.)

### 4. Client UI

- **`ForkUserMessageButton`** (`MessagesTimeline.tsx`, alongside the existing copy/revert buttons at
  `MessagesTimeline.tsx:384`). Icon: `GitForkIcon` (lucide). Tooltip "Fork from here". Disabled while
  the thread is working/reverting, same gate as revert.
- **Handler** in `ChatView.tsx` (next to `onRevertUserMessage`): generate `newThreadId`, dispatch
  `thread.fork`, then on success:
  1. `navigate` to the new thread route.
  2. Pre-fill the new thread's composer via `setComposerDraftPrompt(target, clickedMessage.text)`
     (+ attachments / terminal contexts if present).
  3. If `forkContextApproximate`, show a non-blocking toast/banner.
- Switching back and forth is the existing sidebar thread selection — no new work; both threads are
  normal persisted threads.

## Files / modules touched

| Area | File | Change |
|---|---|---|
| Contract | `packages/contracts/src/orchestration.ts` | `ThreadForkCommand`, `thread.forked` event, add to `DispatchableClientOrchestrationCommand`; optional `resumeAnchor` on checkpoint summary |
| Decider | `apps/server/src/orchestration/decider.ts` | handle `thread.fork` → emit `thread.forked` |
| Projector | `apps/server/src/orchestration/projector.ts` | apply `thread.forked` (populate thread + stash fork resume); reuse retention slice |
| Session start | `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` / `ProviderService.ts` | feed the stashed fork directive as the first `resumeCursor` |
| Claude adapter | `apps/server/src/provider/Layers/ClaudeAdapter.ts` | honor `fork`/`resumeSessionAt` → `forkSession: true`; (opt.) capture per-turn `resumeAnchor` |
| Codex adapter | `apps/server/src/provider/Layers/CodexSessionRuntime.ts` | honor `fork` → `thread/fork` |
| Client UI | `apps/web/src/components/chat/MessagesTimeline.tsx` | `ForkUserMessageButton` |
| Client logic | `apps/web/src/components/ChatView.tsx` | `onForkUserMessage` handler, navigate + prefill + warn |

## Alternatives considered

- **Pure client-side clone.** Rejected: messages + config live authoritatively in the server read
  model; the client can't faithfully reconstruct the agent context or guarantee id uniqueness.
  Fork must be a server command.
- **Replay full history into a fresh session each fork.** Rejected: session start does not accept a
  history payload today, and replay loses tool-call/internal state fidelity — not a true context
  carry-over. The provider-native fork (Claude `forkSession`, Codex `thread/fork`) is higher fidelity
  and less new plumbing.
- **Reuse the parent's session id without `forkSession`** (the naive "copy resumeCursor"). **Rejected
  as unsafe**: Claude would append the fork's turns to the *same* transcript, corrupting the original.
  `forkSession: true` is mandatory.
- **Create a new worktree + branch (true filesystem isolation).** Rejected per decision #2 (user
  chose shared worktree). Noted as the natural future hardening if collisions become a problem.
- **N `message-sent` events instead of one `thread.forked`.** Rejected: event storm, non-atomic,
  ordering risk.

## Tradeoffs & limitations

- **Shared worktree (by design):** concurrent file-editing turns in the original and the fork race on
  the same working tree, and their per-turn git checkpoints interleave. Acceptable per user decision;
  most forks are conversational/exploratory. Future: opt-in isolated worktree.
- **Mid-conversation context fidelity** is precise only when a resume anchor is known (always for
  end-of-conversation forks and for threads created after the anchor-capture change ships); otherwise
  best-effort with a visible notice.
- **Cross-provider:** Claude and Codex both fork natively; any other/unknown driver falls back to
  fresh-start + warn.

## Design review — round 1 triage (2026-06-16)

Two adversarial reviews (correctness + simplicity) against the real code. Converged findings:

**Applied (blockers):**
- **`forkSession: true` must be explicitly set.** `ClaudeAdapter` queryOptions
  (`ClaudeAdapter.ts:3321-3351`) never sets `forkSession` today. When the resume directive carries
  `fork: true`, the adapter MUST add `forkSession: true` — otherwise the SDK appends to the parent
  session and corrupts the original. Mandatory.
- **Storage seam for the deferred directive.** There is no field to "stash" the fork directive.
  Add **`pendingForkResume: Schema.optional(Schema.Unknown)`** to `OrchestrationThread`; the projector
  sets it on `thread.forked`; `ProviderCommandReactor.ensureSessionForThread` consumes it at the
  fresh-thread seam (`ProviderCommandReactor.ts:571` — change `startProviderSession(undefined)` →
  pass `{ resumeCursor: thread.pendingForkResume }` when present) and a follow-on event clears it so
  it is consumed exactly once.
- **Register the new command/event.** Add `ThreadForkCommand` to
  `DispatchableClientOrchestrationCommand`, add `"thread.forked"` to the event-type literals, and add
  a dedicated projector handler (the cloned `messages[]` is applied as a complete array, NOT via the
  streaming-accumulation path).

**Applied (should-fix):**
- **Streaming / mid-turn guard.** Disable the fork button while the thread is working (reuse the
  revert gate `activity.isRevertingCheckpoint || activity.isWorking`), AND have the decider reject a
  fork whose last in-slice message is still `streaming` (avoids cloning a half-written message).
- **Stale anchor handling.** Wrap the Claude `query()` resume so a rejected/unknown `resumeSessionAt`
  falls back to a full-session fork + the `forkContextApproximate` warn flag rather than erroring.
- **Attachments carry-over.** Confirmed `composerDraftStore` supports per-target `setPrompt`
  (`:354`) and image attachments (`ComposerThreadDraftState.attachments`, batch setter `:392`). The
  handler copies the clicked message's text + image attachments into the fork's composer draft; text
  always carries, image attachments best-effort. Non-image attachments are referenced as paths in
  text (existing drop-file convention).

**Scope decision — precise anchor (divergence from reviewers, with rationale):** Both reviewers urged
cutting per-turn anchor capture entirely for v1 (they costed the *checkpoint-record* route at ~300
LOC). I keep a **slimmed** version: capture the provider message uuid as an optional
**`providerMessageId` on the assistant `OrchestrationMessage`** (the adapter already has
`message.uuid` at `ClaudeAdapter.ts:2378`; it equals the `resumeSessionAt` anchor). This is ~40–80
additive LOC on the assistant-complete path, not 300, and it is load-bearing for *correctness of the
primary use case*: forking mid-conversation to explore a **different** direction must NOT carry the
abandoned later turns into the agent's context. Without an anchor every fork over-includes context.
Old threads (no stored uuid) and Codex still fall back to best-effort + warn, honoring the user's
choice. The heavier checkpoint-backfill route stays a follow-up.

**Exit:** findings concrete and applied; a second round would repeat. Proceeding to plan.

## Follow-ups deferred

- Optional **isolated worktree/branch** mode for forks (toggle).
- Backfill resume anchors for pre-existing threads (read the on-disk transcript to locate the uuid).
- Fork from **assistant** messages too (v1 is user-message only, per the ask).
- Visual lineage ("forked from …") in the sidebar.
