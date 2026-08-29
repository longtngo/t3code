# Subagent-owned background tasks stop costing a turn — 2026-08-28

## Goal

A background task launched by one of a thread's own subagents currently starts a **new turn** on
the main thread. The user reports this as waste: the main agent is forced to answer something it
did not launch and is not blocked on.

Done means: the coordinator still learns what its subagents' background work did, and stops
spending a turn per completion to hear it.

## Baseline @ 69212ea7e (2026-08-28), window 2026-08-22T16:56Z → 2026-08-28T17:32Z

Since `b2e401df4` (the attribution fix) stamped `subagentOwned`, wake turns split like this:

```
                    turns   median reply   replies <=300 chars   turns running >=1 tool
subagent-owned      1258        49 ch        1063 (84.5%)            442 (35%)
main-agent-owned     312       671 ch          96 (30.8%)            295 (95%)

context re-sent by those turns (max usedTokens per turn, summed):
  subagent-owned  370,666,149 tokens   (p50 279,976 / turn)
  main-agent-owned 93,962,463 tokens   (p50 287,132 / turn)
```

80.1% of all wake turns are subagent-owned. A representative reply, verbatim:
`"Still the reviewer's internal step. Release held pending its report."`

Threads that saw a subagent-owned wake: 17. Threads with subagent wakes **and** main-agent wakes: 12. Threads with subagent wakes and **no** main-agent wake: **0**. So suppressing the turn never
leaves a thread with nothing that will wake it.

Regression floor: `pnpm verify` — RED at baseline (`packages/shared/src/Net.test.ts`), drained
first on `fix/net-test-port-race`.

## The mechanism today

`maybeWakeThreadForCompletedTask` (`ProviderRuntimeIngestion.ts:1912`) fires when the event
carries no turn id, the thread is unarchived, its session is `ready`, and `activeTurnId === null`.
It then dispatches `thread.turn.start` with a synthesized user message. Since `b2e401df4` the text
is _correctly attributed_ for a subagent-owned task — but it is still a turn.

## Approach: append to the provider transcript, do not start a turn

For `subagentOwned` completions, offer the note to the live Claude prompt queue as an
`SDKUserMessage` with **`shouldQuery: false`** instead of dispatching `thread.turn.start`.

### Why this is available, measured

Claude CLI `2.1.250`, two arms through the real binary in `--input-format stream-json`:

```
SILENT  {"shouldQuery":false}: assistant messages after msg 1 = 0; answer to the follow-up = "ZORBLAX"
CONTROL {}                   : assistant messages after msg 1 = 2; answer to the follow-up = "ZORBLAX"
```

The silent message produced **no assistant turn** and its content **still reached the model** on
the next querying message. The session transcript on disk carries it as an ordinary `user` row
ahead of the querying one. `shouldQuery` occurs 41 times in the CLI binary; the SDK's own
`SDKUserMessage` declares it.

### Shape

- New adapter capability `appendSessionNote(threadId, text)`. `ClaudeAdapter` offers
  `{type:"message", message}` to `context.promptQueue` with `shouldQuery: false` and emits **no**
  `turn.started`, leaves `turnState` untouched, and does not mutate session status.
- Every other adapter declares it unsupported. Nothing else produces `subagentOwned`, so no other
  adapter can reach this path — the declaration is for the shape, not for a reachable case.
- `maybeWakeThreadForCompletedTask` branches: `subagentOwned` → append the note; otherwise the
  existing `thread.turn.start`, unchanged.
- The note keeps today's attributed wording minus the closing sentence, which existed to tell the
  agent whether to act. It is not acting now.

### Accumulation: measured, and not a problem

A silent note costs nothing until a real turn runs, but it does occupy context then, so the first
draft capped the notes per thread. Two rounds of review killed the cap, in order.

The first draft **dropped** the overflow, which is wrong in the direction that matters: 442 of 1258
of these wakes ran at least one tool, so discarding the 21st note throws away exactly the
supervision signal this design claims to preserve, invisibly. The second draft **flushed** to a
turn instead of dropping.

Then the number the cap rested on turned out to be the wrong number. "825 subagent-owned wakes on
one thread" is that thread's **lifetime** total across the window — not what accumulates between
two real turns, which is what a context bound actually cares about. Replayed per-thread against the
measured turn timelines:

```
max burst between real turns    87 notes  (~12,849 tokens)
p50 burst                       13 notes  (~661 tokens)
threads with a burst over 20     5
cost of ONE avoided wake turn   ~280,000 tokens (p50)
worst burst as a share of that   4.6%
```

The worst case this cap exists to prevent costs less than one twentieth of a single turn the design
already removes. There is no cap, no counter, and no flush: notes accumulate and are delivered
whole on the next real turn.

If the burst distribution shifts — a coordinator that goes hundreds of subagent completions without
a turn of its own — the answer is a coalesced summary note, not a cap. Recorded as a follow-up,
unbuilt, because nothing in six days of real data asks for it.

**A note is not a one-time cost.** Once in the transcript it is re-sent on every subsequent turn
until compaction, which the first draft of this section missed by saying the note "rides along"
with a turn that would have re-sent the context anyway. Measured on the heaviest thread — 825
subagent wakes, 188 real turns — that re-read tax is **~2.1M tokens**, against **219.5M**
eliminated on the same thread. Roughly a hundred to one, so the conclusion does not move, but the
number belongs here rather than being waved at. Measured note size is ~121 chars / ~30 tokens, not
the 40 estimated above.

### When the append cannot happen

`appendSessionNote` fails if the session is gone, the queue is shut down, or the adapter does not
support it. Any failure falls back to today's `thread.turn.start`, so the coordinator is never
worse informed than it is now. In-flight notes lost to a session restart or a reboot are **not**
persisted and not replayed: a note is a progress ping whose durable record is the work-log
activity, and a migration to persist one would cost more than the signal is worth. The loss is
logged rather than silent.

### Kill switch

`T3CODE_SUBAGENT_SILENT_NOTES=0` restores the turn-start path without a redeploy, matching the
existing switches in this very file (`STRICT_PROVIDER_LIFECYCLE_GUARD`,
`ProviderRuntimeIngestion.ts:133`) and in `serverRuntimeStartup.ts`.

### Observability

Today's `{ok:true}`-style blindness is what let this cost accumulate unnoticed for six days, so the
new path reports itself:

- `Effect.logDebug("provider.subagent-note.appended", { threadId, taskId })` on each append
- `Effect.logWarning("provider.subagent-note.append-failed", { threadId, taskId, cause })` on the
  fallback, which is also the signal that a CLI upgrade stopped honouring `shouldQuery`

### What the user still sees

Unchanged. `task.completed` already projects its own `tool`-tone activity, which is the "Work Log"
row in the screenshot; that row is produced independently of the wake and is untouched.

## Alternatives rejected

- **Send the message to the subagent that launched the task** (the user's first suggestion). The
  launching subagent is already served: a background task it started returns to it through its own
  tool result inside the CLI, a channel t3code neither sees nor can inject into. There is no
  ACP-style address for a live subagent on the input stream, and `parent_tool_use_id` on an inbound
  `SDKUserMessage` is not documented to route into one. But routing there would not meet the goal
  even if it worked: the party that needs to hear about delegated progress is the **coordinator**,
  not the subagent that already knows. That is what the silent append gives it.
- **Drop the wake entirely** (the user's second suggestion, in its strongest form). Cheapest, and
  the reply lengths make it tempting. Rejected on the cost side: **442 of 1258** subagent-owned
  wake turns ran at least one tool, so a plain suppression deletes real supervision work — one
  sampled turn caught a leaked daemon. Appending keeps that information and pays for it once.
- **Coalesce N completions into one wake turn** (debounce). Still spends turns, still interrupts,
  and adds a timer whose window is a guess. Strictly worse than a free append.
- **Keep the turn but shorten the prompt.** Does not touch the cost: the 370M tokens are the
  re-sent conversation, not the wake text.

## Test plan

- `subagentOwned` completion with a live session appends a note and starts **no** turn.
- The appended `SDKUserMessage` carries `shouldQuery: false`. Mutation to guard against: dropping
  the field, which turns every note back into a turn.
- Main-agent-owned completion still starts a turn, unchanged wording.
- An append failure falls back to `thread.turn.start` rather than swallowing the completion.
- `T3CODE_SUBAGENT_SILENT_NOTES=0` restores today's behaviour end to end.

## Files touched

- `apps/server/src/provider/Services/ClaudeAdapter.ts` (+ peer adapter shapes) — new capability
- `apps/server/src/provider/Layers/ClaudeAdapter.ts` — the silent offer
- `apps/server/src/provider/Layers/ProviderService.ts` — passthrough
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` — the branch and the cap

## Tradeoffs and limitations

- The coordinator learns about subagent progress **later** — at its next real turn instead of
  immediately. That is the trade being made deliberately; the data says the immediate turn is
  mostly a 49-character acknowledgement.
- Claude-only. Correct today because `subagentOwned` is Claude-only, and it will need revisiting if
  another adapter starts reporting subagent-launched tasks.
- `shouldQuery` is an SDK field with no stability guarantee. If a future CLI ignores it the note
  becomes a normal message and starts a turn — i.e. it degrades to today's behaviour, not to
  something worse. Worth a probe on CLI upgrades.
- Notes pending at a session restart or reboot are lost, deliberately. The work-log row survives.
- A completion that lands while a main turn IS running gets neither a wake (today) nor a note. That
  is pre-existing — the gate requires `activeTurnId === null` — and this design does not change it.
  Recorded as a follow-up.

## Follow-ups deferred

- The same silent-append channel would let checkpoint and hook notices reach the agent without a
  turn. Not built here.
