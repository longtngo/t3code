# Revert puts the user message back in the composer

## Goal

Reverting to one of your own messages should behave like taking that message back: the turn it
started is discarded, the message leaves the thread, and its text lands in the composer so you can
edit it and send again.

Today neither half happens. The composer is never touched, and the message never leaves the thread.

### Baseline (Stage 1b, taken on `d941a5230`)

| Metric                             | Command                                                                                               | Before                     |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------- |
| `revert-client-sweep`              | `bun /tmp/revert-composer/client-sweep.mjs`                                                           | `leak=9826 / 9826` (100%)  |
| `revert-leak-sweep` (durable)      | `bun /tmp/revert-composer/sweep.mjs`                                                                  | `leak=3305 / 9826` (33.6%) |
| `revert-leftover-live`             | `bun /tmp/revert-composer/leftover-probe.mjs`                                                         | `leftover_user_messages=1` |
| `revert-projection-suites` (floor) | `vp test run src/orchestration/projector.test.ts src/orchestration/Layers/ProjectionPipeline.test.ts` | 53 passed                  |
| `composer-restore-on-revert`       | unmeasurable                                                                                          | no code path exists yet    |

Each sweep copies a retention function verbatim and replays every revert target the UI can produce
across all 508 threads in the developer's real database, read-only.

`revert-leftover-live` is a **defect measurement, not a before/after**: the durable projection is
incremental, so rows from past reverts are never recomputed and this number will not move.

## What the code does now

`RevertUserMessageButton` (`apps/web/src/components/chat/MessagesTimeline.tsx:1448`) calls
`onRevertUserMessage(messageId)`, which maps the message to `turnCount - 1` of the turn it started
(`buildRevertTurnCountByUserMessageId`, `apps/web/src/components/ChatView.logic.ts:449`) and hands it
to `onRevertToTurnCount` (`ChatView.tsx:6455`). That confirms, dispatches `thread.checkpoint.revert`,
and stops. Nothing touches the composer.

A `thread.reverted` event then truncates the thread in **three** independent read models:

| Model     | Where                                                            | Who reads it                                            |
| --------- | ---------------------------------------------------------------- | ------------------------------------------------------- |
| client    | `packages/client-runtime/src/state/threadReducer.ts:564`         | the running web and mobile clients — what the user sees |
| durable   | `apps/server/src/orchestration/Layers/ProjectionPipeline.ts:219` | what a cold load or reconnect serves                    |
| in-memory | `apps/server/src/orchestration/projector.ts:119`                 | the decider only; never reaches a client                |

### Why the message survives (root cause, confirmed on live data)

**The client keeps it unconditionally.** `retainMessagesAfterRevert`
(`threadReducer.ts:766`) keeps every message whose `turnId` is null, with the comment _"messages
without a turn binding (pre-turn-0 user messages)"_. That assumption is false: **11,570 of 11,570
live user messages have `turnId === null`**, because a user message is persisted before its turn
exists and nothing ever backfills the link. Swept over every reachable revert target, the message
being taken back survives **9,826 of 9,826 times — 100%**.

That is the reported symptom in full. The server models are a second, independent bug that only
shows on the next cold load:

**The server rescues it by miscounting.** The durable and in-memory functions keep messages whose
turn survived, then apply a count fallback — `missingUserCount = max(0, turnCount - retainedUserCount)`
— re-admitting that many otherwise-discarded user messages, oldest first. The fallback exists because
of the same null `turnId`: without it a revert would delete every user message. But the subtraction
treats `turnCount` as the number of user messages that must survive, and turns can start without one
(a provider or auto-started turn leaves `pendingMessageId` null). The deficit is a phantom, and the
fallback spends it re-admitting whatever it can find — including the message just discarded, because
that message is an orphan too.

Measured on thread `a69de772-e49c-4adc-81c9-715dae20eb06`, reverted to turn 119:

| Quantity                                           | Value                                           |
| -------------------------------------------------- | ----------------------------------------------- |
| user messages in the thread                        | 113, all with `turnId = null`                   |
| kept turns                                         | 119, of which **10 have no `pendingMessageId`** |
| matched exactly (a kept turn's `pendingMessageId`) | 109                                             |
| `missingUserCount` = 119 − 109                     | 10                                              |
| unmatched user messages available to re-admit      | 4                                               |

10 ≥ 4, so all four came back, including `$reflect`. That is the leftover the probe reports.

Six independent subagents reproduced these decisions by extracting the functions verbatim,
rebuilding pre-revert state from the event log, and running them: the durable kept set came out
identical to the live rows on 7 of 8 ever-reverted threads, and ablating the fallback block alone
dropped `$reflect`.

## Approach

Two changes, one behavior.

### 1. One retention rule, applied where the user can see it

> **A message with no turn binding survives a revert only if it predates the newest checkpoint the
> revert kept.**

The comparison is `>=` against that checkpoint's `completedAt`, so a message created on the same
clock tick is discarded. That is not a detail: a turn's checkpoint is captured lazily, when the _next_
turn starts, so the next turn's user message and the previous checkpoint routinely carry the
identical timestamp — 44 live occurrences, plus 13 orphan background-task messages that `>` would
keep. The rule is safe because a turn's `completedAt` is later than its own starting message's
`createdAt` in 12,202 of 12,204 live turns.

Applied at two sites, with the same predicate:

- **The client reducer** — replaces the unconditional `turnId === null → keep`. Measured: leak
  9,826 → **6**, and **0** of the corpus's kept-turn starting messages are wrongly dropped. When the
  revert keeps no checkpoint at all (reverting the first message, `turnCount = 0`) there is no
  cutoff and nothing turnless survives, which is the correct empty thread.
- **The durable fallback pool** — a candidate at or after the cutoff is not a candidate. Measured:
  leak 3,305 → **2**.

**`projector.ts` is deliberately left alone.** It is the decider's model, it starts empty per thread
at boot, and no client reads it. Applying the cutoff there is not cosmetic — it changes the retained
set in 3,039 of 9,826 simulated reverts and forces `hasQueuedTurnStartForThread` (`decider.ts:86`)
from true to false in 3,320 of them, because the reverted `latestTurn` is stamped with the same
`completedAt` the cutoff uses. That predicate guards `thread.settle`, `thread.snooze` and the
settle-cleanup `session.stop`, so the change would silently alter three commands to fix a false
positive that `QUEUED_TURN_START_GRACE_MS` already expires after two minutes, and that only 3 of 14
real reverts were inside. Leaving it is the zero-regression choice.

#### Why this rule, measured

Five arms over the 9,826 reachable durable targets (`sweep.mjs`); _added_ means messages a rule
causes to be retained that the current rule drops.

| Arm                                   | leak  | added     | extra dropped |
| ------------------------------------- | ----- | --------- | ------------- |
| current                               | 3,305 | —         | —             |
| deny what discarded turns claimed     | 0     | **7,814** | 25,037        |
| **checkpoint cutoff (chosen)**        | **2** | **0**     | 31,083        |
| deny + cutoff                         | 0     | 0         | 31,083        |
| bound at the oldest discarded message | 0     | 0         | 30,904        |

The last two reach leak 0, and the last one also spares 179 messages the cutoff deletes. Both were
rejected for the same reason: **they need `pendingMessageId`, and only the durable model has it.**
The client's checkpoints carry `assistantMessageId` only, so a rule built on discarded messages
cannot run where the symptom is, and the two models would then disagree about what a revert kept —
the message would vanish on reload but not live. One rule everywhere is worth two residual leaks in
9,826.

The deny-list arm is recorded because its failure was not predicted by anyone: removing a candidate
frees a slot in `slice(0, missingUserCount)`, so the fallback reaches further down the pool and
rescues a _different_ message.

The probes are not vacuous: `>` instead of `>=` returns the client sweep to leak 3,305, and the
kept-turn safety counter that reads 0 sits in the same run as a leak counter that moved 9,826 → 6.

### 2. Restore the text when the message actually leaves the thread

`onRevertUserMessage(messageId, promptText, attachmentCount)` records those values plus the active
thread key, the target turn count and the request time in a ref, and dispatches the revert exactly as
today. An effect fires the restore when all of the following hold, then clears the entry:

1. there is an active thread and its key matches the pending key;
2. the pending message id is gone from the thread's messages;
3. the thread has no checkpoint newer than the target turn count.

Condition 3 is what makes this safe, and conditions 1-2 alone are not enough. A message leaves
`activeThread.messages` for at least four reasons besides a revert: a fresh snapshot re-windows the
thread and discards pages you had scrolled back to (`threads.ts:333`), a reconnect downgrades
pagination so `serverMessages` is undefined and `displayServerMessages` returns `[]`
(`ChatView.tsx:2969`), a cold subscribe or idle-TTL teardown yields `data: null` for a frame, and
`thread.message-withdrawn` removes the id outright. In every one of those the checkpoints still show
the discarded turn, so condition 3 blocks the restore; after a real revert they do not.

The entry is also cleared on a thread switch, on a new revert request, and on a
`checkpoint.revert.failed` activity newer than the request. The last one matters because **5 of 14
live revert requests never completed** — `CheckpointReactor.ts:816-900` has six silent exits, each
appending that activity long after the RPC returned Success — so without it an armed entry would wait
indefinitely. The thread-key guard is load-bearing _in addition to_ the thread-switch clear: on the
switch render both effects run and declaration order decides which sees the stale entry first.

Two honest caveats about those clears, both found while implementing:

- The entry is armed _before_ the confirmation dialog, so cancelling the dialog leaves it armed. It
  resolves to `"wait"` until a thread switch or the next revert overwrites it, and the only way the
  message could then disappear is another revert — which arms its own entry first. Harmless, but the
  clear list above is not the whole truth.
- `checkpoint.revert.failed` is **not a typed activity kind.** `OrchestrationThreadActivity.kind` is
  a free-form `TrimmedNonEmptyString` and the reactor appends that literal at
  `CheckpointReactor.ts:184`, so nothing type-checks the match and a server-side rename would
  silently disarm the clear. Comparing `activity.kind` against a string literal is the house pattern
  — `session-logic.ts` does it in eight places — so introducing a shared constant for this one call
  site would cut against the codebase rather than with it. Recorded, not worked around.

Keying on disappearance rather than on RPC acceptance is what the measurements demand. Acceptance
would put the text in the composer while the message was still above it — the exact duplicate this
design rejects the composer-only alternative to avoid — at a 36% rate. One live thread shows three
revert clicks in 18 seconds, all accepted, none completing; since `appendRecalledPrompt` appends and
does not dedupe, an acceptance-keyed restore would have tripled the text. Disappearance is idempotent
by construction. The success path is fast enough to wait for: 8 of 9 live completions landed in
≤18 ms, covered by the existing `isRevertingCheckpoint` spinner.

**The write is the one this file already does.** `ChatView.tsx:7331-7347` restores a prompt into the
composer on the send-failure path — `promptRef.current = …`, `setComposerDraftPrompt(…)`, then
`composerRef.current?.resetCursorState({ cursor, prompt, detectTrigger })`. The restore reuses that
shape, with `appendRecalledPrompt` (`packages/client-runtime/src/state/heldMessages.ts:37`) supplying
the join: appended after a blank line, never replacing, so anything typed since is not discarded.
`promptRef` is created in ChatView and passed _into_ the composer as a prop, so this is not a
divergent copy of composer state, and the join rule keeps its single owner.

An earlier draft added a `restoreRecalledPrompt` handle method and refactored `recallQueuedMessage`
to share it. Prototyped against the real code, that arm and this one produce identical drafts on 10
of 10 shapes — empty, whitespace-only, empty recall, a `<terminal_context>` block, a 495-character
prompt, astral-plane emoji — so the new API bought nothing.

**The text comes from the timeline row.** `UserTimelineRow` already computes the string it renders,
`elementContextState.promptText` (`MessagesTimeline.tsx:1263`), and the revert button renders from
the same function body at `:1437` with that variable in scope. Passing it through costs two prop-type
widenings and one test mock. It also keeps `onRevertUserMessage` at `useCallback(..., [])`, which
matters: that callback is a dependency of the `TimelineRowCtx` memo (`MessagesTimeline.tsx:670`),
whose comment warns a fresh object _"remounts every rendered markdown node whenever this memo
recomputes"_.

Attachments are not restored, matching queued-message recall, and the same warning toast says so. It
fires on 179 of 11,570 live user messages.

## Alternatives considered

- **Composer prefill only, leave retention alone.** Rejected on measurement: the message survives
  100% of live reverts, so the restored draft would always read as a duplicate.
- **Restore on RPC acceptance.** Rejected: 36% of live revert requests never complete, silently.
- **Fixing only the server models.** Rejected: `thread.reverted` carries `{ threadId, turnCount }`
  only and no snapshot is pushed on revert, so the client keeps its own answer until the next cold
  load. This is why the client reducer is the primary site.
- **A rule built on the discarded turns' messages** (deny list, or bounding at the oldest discarded
  message). Rejected: better on the durable numbers, but unavailable to the client, which would leave
  the two models disagreeing about the same revert.
- **Cap the deficit instead of bounding the pool.** Fails by construction on the motivating case:
  deficit 10, candidates 4.
- **A new `restoreRecalledPrompt` composer handle method** — identical output to the existing
  send-failure restore on 10 of 10 draft shapes.
- **`insertTextAtEnd(text, { ensureLeadingBoundary: true })`** — differs in 3 of 5 draft shapes, and
  glues a real 495-character, 7-line prompt onto the draft with one space.
- **Replace rather than append the draft.** Rejected for the reason `appendRecalledPrompt` documents:
  the composer clears its draft before the send RPC, so a non-empty draft is the common case.
- **Restore attachments too.** Deferred; the toast makes the loss visible, which is what recall
  already decided.

## Invariant introduced (Hard Rule 12)

_A revert keeps no turnless message created at or after the checkpoint it reverted to._

- **Sites** — the client reducer and the durable projection. `projector.ts` is **knowingly left
  alone** for the measured decider reason above; it is the one place the invariant is not enforced,
  and no client reads it.
- **Direction** — the user side. The assistant fallback is **not touched**: its candidate pool is
  empty on all 9,826 targets before any rule is added, because assistant messages always carry a
  `turnId` (0 of 78,172 do not). Adding rules to a block that never executes would double the server
  diff and imply it can rescue orphans.
- **Consumers** — client: the timeline, `buildRevertTurnCountByUserMessageId`, thread-window paging,
  `threadDetailCursor`. Paging keysets on `projection_turns.requested_at` and counts turns joined to
  `pending_message_id`; dropped messages are turnless and are by construction not a kept turn's
  pending message, so page boundaries do not move. `threadDetailCursor` keys on `(anchor, turnId)`
  from event content and survives the delete-and-re-upsert. `CheckpointReactor`'s `rolledBackTurns`
  reads checkpoints, never messages.

## Surfaces

- **Client runtime** — `threadReducer` is shared, so the retention fix lands on web, desktop and
  mobile together.
- **Web** — the only surface with a revert control; desktop wraps it. The composer restore is
  web-only because the control is.
- **Mobile** — gets the retention fix, has no revert entry point to restore from.
- **Providers** — provider-independent; the control is already gated on
  `supportsConversationRollback`.
- **Contracts** — unchanged.
- **Docs** — `docs/user/composer.md` gains a short note; no user doc covers the revert control today.
- **Reverse state** — the restored draft is ordinary composer text: editable, clearable, sendable.

## Files touched

| File                                                         | Change                                                                |
| ------------------------------------------------------------ | --------------------------------------------------------------------- |
| `packages/client-runtime/src/state/threadReducer.ts`         | bound turnless messages at the kept checkpoint                        |
| `apps/server/src/orchestration/Layers/ProjectionPipeline.ts` | same bound on the fallback pool                                       |
| `apps/web/src/components/chat/MessagesTimeline.tsx`          | pass the row's prompt text and attachment count to the revert handler |
| `apps/web/src/components/ChatView.tsx`                       | pending-restore ref, the effect that fires it, the draft write        |
| `docs/user/composer.md`                                      | taking a message back                                                 |
| tests alongside each                                         | the live 119/113/109 shape, the tie, the restore decision             |

## Tradeoffs and known limitations

- **179 corpus messages are deleted that a `pendingMessageId`-based rule would spare** — typed after
  the kept checkpoint but before the discarded turn was requested, usually a queued prompt the agent
  never picked up. Accepted so that the client and the server apply the same rule; the confirm dialog
  already promises to "discard newer messages". The follow-up below removes the tradeoff.
- **The in-memory decider model keeps the old behavior**, as above.
- **A revert forfeits its restore if you switch threads while it runs.** Restoring into whatever
  thread you switched to is worse, and the stash-restore flow guards its own await the same way
  (`ChatComposer.tsx:3211`).
- **6 client and 2 durable residual leaks** in 9,826, from mid-turn sends that beat the previous
  checkpoint's lazy capture by 148 ms to 33.5 s.
- **A revert that never completes is invisible** — no metric, no log, no client signal.
- **Attachments are not restored**, as above.
- **A revert from another device can blank the timeline until it reloads.** Checkpoints are complete
  client-side but messages are windowed, so a `thread.reverted` whose `turnCount` is below this
  client's loaded window fails both retention tests for every loaded message. Before this change the
  same case rendered user-messages-only, which was also wrong.

## Sanitize round (post-implementation)

An adversarial pass over the real diff found two blockers that the design's prose had asserted away,
both now fixed:

- **The loading placeholder defeats the checkpoint guard.** `buildLoadingThreadFromShell`
  (`ChatView.logic.ts:300`) spreads the shell, so during a detail reload the thread keeps its key
  while reporting no messages and no checkpoints — indistinguishable from a completed revert. A
  reconnect with an armed entry would have appended the text with the message still in the thread,
  the exact failure this design rejects the composer-only alternative to avoid. The decision now
  takes `isThreadLoading`, and treats "no checkpoint loaded" with a non-zero target as `wait`.
  Its mirror is fixed too: a teardown frame where no thread is active is `wait`, not `discard`,
  which previously killed a restore that was about to land.
- **The failure clear compared two different clocks.** `requestedAt` is the client's clock and
  `activity.createdAt` the server's, so a stalled revert's late failure could discard a _later_
  revert's successful restore, and a client running behind the server discarded every restore in
  the thread. The activity's payload already carries `turnCount`, so the match is now on the
  target turn count as well as the time.

**Mutation results.** Every property named above now has a test that fails when it is removed:
the client cutoff (drop it → 4 failures), the client max-`completedAt` scan (take the min → 1), the
server tie strictness (`<` → `<=` → 1), the loading gate, the no-checkpoint guard, the
teardown-frame rule, and the failure clear (1 each). **One mutant survives by choice:** taking the
_minimum_ `completedAt` in the server's kept-turn scan leaves all 35 server tests green. Killing it
needs a second turnless message inside the kept range, which would give the fallback pool a second
candidate and let the primary "the discarded message does not come back" assertion pass even with
the bound removed. The equivalent scan is pinned on the client instead, and `completedAt` is
monotone in `checkpointTurnCount` across all 12,210 live checkpointed turns, 0 inversions.

**Measured after the change**, client and durable models still disagree on 18,051 user-message
decisions across 9,641 reachable reverts — down from 1,226,460, so "one rule everywhere" is about
72% realised. The residual is the server's `slice(0, missingUserCount)` cap, which has no client
counterpart: those messages still vanish on reload but not live.

## Follow-ups deferred

- **The revert button can target the wrong turn.** 596 of 12,204 checkpointed turns have an
  `assistantMessageId` with no message row, and `buildRevertTurnCountByUserMessageId` scans forward
  to the first assistant message _with_ a checkpoint summary — so it lands one turn late and reverts
  to a checkpoint that keeps the clicked message's own turn. Measured on the truly reachable target
  set, this leaves the message in the thread in 116 of 9,635 reverts (1.2%) regardless of any
  retention rule, and the restore correctly does not fire. Separate defect, worth its own item.
- **Projector bootstrap ordering is a latent data-loss hazard.** On the replay-from-zero path
  (`projection_state` absent → `readFromSequence(0)`), `bootstrap` runs projectors in array order and
  `projection.thread-messages` (index 1) replays the whole log while `projection_turns` (index 5) is
  still empty, so every `thread.reverted` is applied against an empty turn table. Measured: the 8
  ever-reverted threads would end with 1,095 messages instead of 1,766, a 38% loss.
- Carry `pendingMessageId` into the checkpoint summary so all three models can bound on the discarded
  message instead of a timestamp. Not a five-line change: `CheckpointReactor` finds
  `assistantMessageId` by scanning for `turnId === input.turnId`, and a pending message has
  `turnId = null`, so it must be threaded in from turn start.
- Emit a signal for an accepted-but-uncompleted revert; 36% of live requests are in that state.
- Show the number of messages a revert will discard in its confirm dialog.
- `setIsRevertingCheckpoint(true)` runs _after_ the confirm await, so a second click during the
  dialog passes the guard (`ChatView.tsx:6458`). Harmless for the restore, which is idempotent.
- Re-hydrate image and file attachments on both recall and revert restore.

## Review exit note

Stage 6a returned **CONDITIONAL GO**; its three must-fixes are applied. Stage 6b ran two rounds —
Correctness, Simplicity and Compatibility, then Correctness and Simplicity again — with every lens
building the retention functions and running them against live data rather than reading the document.

The review did not polish this design, it replaced it three times, and the last replacement was the
one that mattered: round 2's correctness lens found a **third read model**, the client's own reducer,
which keeps the reverted message 100% of the time. Every earlier version of this design fixed only
the server and would have shipped a feature that never fired on the live client — the restore trigger
waits for a message that never disappears. That finding also inverted round 2's simplicity
recommendation, because the rule it preferred cannot run on the client.

Round 1 deleted a new helper, a boolean return and a rule; round 2 deleted a second rule, a new
composer API, and a code site. Two findings came from the author's own harness rather than any
reviewer: the deny list _adding_ 7,814 messages when applied to the candidate pool, and
`displayServerMessages` returning `[]` for an unloaded thread.

Exiting the loop here. The remaining round-2 findings are applied above, and the next adversarial
pass is more valuable against the real diff than against more prose — it runs at Stage 9 sanitize.
