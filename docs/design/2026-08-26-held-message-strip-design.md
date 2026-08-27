# Held messages — a strip above the composer, and recall

Date: 2026-08-26
Branch: `feat/held-message-strip`
Status: v2. v1 proposed a server-side held-message queue and was killed by review; see _What v1 got wrong_.

## What the user asked for

1. A message sent while the thread is busy must not appear in the transcript. It waits in its own
   UI above the composer, "similar to how the Tasks or Agents expansion show up".
2. It is still sent when the thread goes idle, as it is now.
3. It can be recalled back into the composer for editing before it is sent.

## The population already exists and is already correct

`waitingUserMessageIds` (`packages/client-runtime/src/state/threadSettled.ts:233-247`) returns every
user message created after the running turn advanced — exactly the set this feature calls "held".
Replayed against the live log it returns **230 of 231** real holds, with **zero** false positives in
8,785 controls. The 231st is a `cursor` thread; there is no grok or opencode traffic in this
environment at all.

It is already rendered, inline, on both clients:

- web — `MessagesTimeline.tsx:1088-1096`, "Waiting for the current turn to finish"
- mobile — `ThreadFeed.tsx:1109-1113`, the same string

**So requirement 1 is a rendering move, not a new mechanism.** The message keeps its
`projection_thread_messages` row, keeps its place in `activeThread.messages`, and is simply drawn
somewhere else.

Mobile already renders no optimistic user bubbles at all (`use-thread-composer-state.ts:114-127`
passes only Codex feedback as `localMessages`), so "held is not in the transcript" is already
mobile's behaviour.

## Design

### 1. The strip lives in the Tasks tier

The space above the composer is a saturated exclusivity lattice: `ComposerBannerStack` renders
`items[0]` only with hover-only overflow that touch cannot reach (`ChatView.tsx:5300-5306` says so
itself), and the composer top drawer is a single mutually-exclusive slot with three claimants
(approval, user input, plan follow-up). A fourth banner or a fourth top-drawer claimant displaces
something that matters more.

The Tasks drawer tier is the right home, and it is the one the user named: a shoulder tab with a
count badge (`ComposerTasksBadge`) opening a drawer (`ComposerTasksDrawer`), which already yields
correctly to the top drawer via `hasBlockingComposerTopDrawer`.

### 2. Held messages move out of the transcript render

Filter them out of `timelineMessages` (`ChatView.tsx:2790`) and render them in the strip.
**`activeThread.messages` is not touched**, which is what keeps the optimistic-bubble contract
intact: `ChatView.tsx:4488-4519` retires an optimistic bubble when its id appears in
`activeThread.messages`, and that still happens on schedule. An optimistic bubble whose id is in the
held set renders in the strip too, so there is no window where the message is in neither place.

Mobile filters the same set out of `buildThreadFeed`.

### 3. Recall

Recall removes the message from the provider's pending queue and returns its text to the composer.

- **Server:** one adapter method, `withdrawQueuedTurn({ threadId, messageId })`. Claude implements
  it against `pendingTurns` (`ClaudeAdapter.ts:150-153`). Adapters that cannot withdraw answer
  `false` and advertise `supportsQueuedMessageRecall: false`, which is what hides recall for those
  threads — the per-adapter decision AGENTS.md asks for.
- **Ordering is the safety property.** The RPC releases the adapter's queued turn FIRST and only
  then dispatches `thread.message.withdraw`. That command is server-only (not in
  `ClientOrchestrationCommand`), so no client can delete a message row without the adapter having
  actually given the turn up. Reversed, losing the race would delete a message already running.
- **Draft collision:** the composer clears its draft _before_ the RPC
  (`ChatView.tsx:6217-6219`), so the user is free to type immediately and a non-empty draft at
  recall time is the common case, not the edge. Recall therefore **appends**, exactly as the prompt
  stash already does (`ChatComposer.tsx:2246-2251`), rather than overwriting via `setPrompt`, which
  is a blind replace.
- **Losing the race:** if the message has already been dispatched, recall fails and says so. The
  message is a normal message from then on.

### 4. Attachments

**Recall returns the text, not the files.** This is the one place the shipped behaviour is narrower
than the ticket implies, and it is stated in the UI rather than hidden: recalling a message that had
attachments raises a toast saying they need attaching again.

The message row is deleted on withdraw, so its attachment files would otherwise be referenced by
nothing. The withdraw reuses revert's existing sweep — hand the surviving rows' paths to
`prunedThreadRelativePaths` and let the rest go — so nothing leaks into the thread's attachment
directory. Re-hydrating those files into the composer's image model is separate work.

## What v1 got wrong

Recorded so it is not re-proposed. All of these were reproduced by execution against the real
decider, the real projector, or a replay of 2,286,314 live events.

| v1 rule                                              | What actually happens                                                                                                                                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "Stop drops all held messages"                       | Silent, irreversible deletion of typed text: **33 messages** in the real log, median 35 chars, max 550, 2 with attachments. 12% of them ran as real turns in reality.                            |
| "Drain when the running turn completes"              | **There is no turn-completed event.** The nearest signal fires 1.22x per turn, up to 40 times consecutively, and 22.5% of the time is not a turn end.                                            |
| "The drain also runs at boot"                        | `BootTurnReconciler` dispatches `thread.turn.interrupt` _before_ reactors start, so the Stop rule deletes the queue first.                                                                       |
| "Settle/snooze still refuse while a message is held" | False. Both are ACCEPTED once the blocking turn stamps `completedAt`; `threadHasQueuedTurnStart` stops blocking. The settle-driven session stop then kills the session under the queued message. |
| "`held` on the message payload"                      | Nothing clears it on drain — a drained message would be permanently invisible in the transcript.                                                                                                 |
| Holding at orchestration is provider-independent     | Worth **1 message in 9,031** measured. Not nothing, but not a reason to build a queue.                                                                                                           |
| Not stated at all                                    | Today's handoff is **p50 24ms**; v1 routed it through two globally-FIFO reactors and a new command.                                                                                              |

The one thing v1 buys that this does not: a held message surviving a server restart. v1 got that
backwards anyway (the boot interrupt deletes it), and today's behaviour is that a restart loses the
adapter's in-memory queue regardless. Making the queue durable is a separate feature with its own
design, and it must start from "there is no turn-completed event."

## Surfaces

- **Contracts** — `thread.withdrawQueuedMessage` RPC, the server-only `thread.message.withdraw`
  command and its `thread.message-withdrawn` event, `ProviderAdapter.withdrawQueuedTurn`, and
  `ServerProvider.supportsQueuedMessageRecall`.
- **Server** — Claude adapter withdraw; other adapters answer unsupported.
- **Web** — strip in the Tasks tier, transcript filter, recall-appends-to-draft.
- **Mobile** — same strip; it already has recall-into-composer for its offline outbox
  (`new-task-flow-provider.tsx:800-827`) whose hydrate-only-when-empty policy is the precedent.
- **Docs** — `docs/user/composer.md`, `docs/internals/glossary.md` ("held message").

## Testing

- A message sent mid-turn renders in the strip and not in the transcript, on both clients.
- Its optimistic bubble does not appear in the transcript either, and does not linger after the echo.
- It still dispatches when the turn ends, unchanged.
- Recall returns the text to the composer, appending to a non-empty draft rather than replacing it.
- Recall after dispatch fails and says so.
- An adapter that cannot withdraw does not offer recall.
- The strip is empty and absent when nothing is held.

No sleeps; receipts and worker drains are the wait primitives.
