# Composer: always-mounted Send, Stop beside it, always-visible context glyph — 2026-08-09

**Branch:** `fix/composer-send-stop-and-context-glyph` (off `personal` @ `1318f62eb`)
**Status:** design, revised after two adversarial review rounds. Item 3 review outstanding.

Three items requested together. Items 1 and 2 touch the same two files; item 3 is server-side.

Review round 1 (simplicity) and round 2 (correctness) each falsified a load-bearing premise of
the original design. Both corrections are kept in place below rather than quietly edited out,
because the *reason* the first version was wrong is the useful part.

## Item 1 — Send stays mounted; Stop appears beside it while running

### Current behaviour (verified)

`ComposerPrimaryActions.tsx:157-159` early-returns **only** Stop while running, so Send is
unmounted entirely and the action row changes width.

### Provenance (corrected twice)

The feature was `58b3389e7` (2026-06-05, fork): an `allowSendWhileRunning` prop rendering Send
beside Stop, plus a FIFO queue in the Claude adapter.

- I first blamed upstream `4ad961da2` — wrong, that is upstream work by another author, ported
  from #2451, and only restyled the buttons.
- I then blamed upstream `a4757c265` (#3018) — **also wrong.** That diff never mentions
  `allowSendWhileRunning`; the prop never existed upstream. The UI half was dropped in the
  fork's **own** merge `2b7193648` (2026-07-25). The loss was a conflict resolution this fork
  owns, in the very merge that adopted upstream's replacement for the other half.

**The backend survived.** `ClaudeAdapter.ts` still carries the queue — the queue-vs-start
decision at `:4637`, `drainNextPendingTurn` at `:4597`, the interrupt drop at `:3068` — and so do
its tests (`ClaudeAdapter.test.ts:4409, :4472`).

### FALSIFIED premise 1 — "the `isQueuedSend` busy-skip must come back"

`58b3389e7` also patched `ChatView` to skip `beginLocalDispatch` for queued sends, or Send would
pin to a spinner. I planned to restore it. **Both reviewers independently showed it is stale.**

Upstream `d8b12ae80` ("Fix sending messages during active turns", #3919) added
`ChatView.logic.ts:554-560`: in the running phase, `if (latestUserMessageChanged) return true`.
A queued send emits `message-sent` immediately (`decider.ts:1035-1054`, unconditional for every
`thread.turn.start`), so the dispatch is acknowledged at once.

Restoring the skip would be a regression dressed as a restoration: sends while running would get
no "Sending" feedback, and the failure path's `resetLocalDispatch()` would become a no-op.

**Decision: do not restore it. `ChatView.tsx` drops out of the change set entirely.**

### FALSIFIED premise 2 — "only Claude can accept a send while running"

My original table grepped the other adapters for `pendingTurns` / `drainNextPendingTurn` /
"queued follow-up". Those are **Claude-private identifiers**; zero hits was guaranteed and proved
nothing. It was a tautological measurement, and I built the whole provider gate on it.

What the adapters actually do with a concurrent send (verified):

| adapter | behaviour |
|---|---|
| `ClaudeAdapter.ts:4637` | queues FIFO, drains on completion |
| `CursorAdapter.ts:1004-1008` | **steers** — folds the prompt into the running turn, reuses the turn id (tested: `CursorAdapter.test.ts:253`) |
| `GrokAdapter.ts:925-939` | **steers**, under `withThreadLock` |
| `OpenCodeAdapter.ts:1425-1429` | **steers** — OpenCode queues into the busy session |
| `CodexAdapter.ts` | no `activeTurnId` at all (0 hits); forwards to the session runtime |

Every provider has a defined concurrent-send path. There is nothing to protect against.

Independently, hiding the button never protected anything anyway: `ChatComposer.tsx:1913-1919`
sends on Enter with no phase check, and `submitComposer` (`:1829`) bails only on
`noProviderAvailable || isSendDisabled`. The keyboard path has always been open.

### Chosen approach (final — simpler than either earlier version)

1. Extract the Send `<button>` into a `sendButton` element instead of the tail `return`.
2. The `isRunning` branch returns `[stopButton, sendButton]`, reusing the wrapper class from the
   `pendingAction` branch at `:103` — an existing in-file precedent.
3. **Send is enabled while running, for every provider.** No new prop, no `sendDisabledReason`
   widening, no provider gate. This is exactly what was asked for, and it is what the adapters
   already support.
4. **Equalise the two button sizes.** Stop is `size-8` (32px always, `:89`); the default Send is
   `h-9 w-9 … sm:h-8 sm:w-8` (36px below `sm`). Side by side on a phone they would visibly
   mismatch — on a change whose entire point is layout stability. Align Stop to Send's sizing.
5. Leave the `aria-label` chain alone. Send sends; "queue" vs "steer" is a provider detail, and
   adding a label would collide with the `isEnvironmentUnavailable` precedence at `:246-258`.

**Order: Stop left, Send right**, so Send never moves between idle and running.

### Known limitation, now stated (was missing): queued messages are dropped silently

`decider.ts:1035-1054` projects the user message at command time; `ClaudeAdapter.ts:3068` drops
`pendingTurns` on interrupt with no event and no error. So: queue two follow-ups, press Stop —
both stay in the transcript, rendered identically to messages that ran, and neither ever runs.

This is **not introduced** by this change (Enter already reaches it today), but the change makes
it far more discoverable. It is also a more likely explanation for the stale `pending` turn rows
in follow-up 2 than "crash debris". Follow-up 7.

### Branches where "always mounted" does not hold (accepted)

`pendingAction` (`:101-155`) renders Previous/Submit and wins over `isRunning`;
`showPlanFollowUpPrompt` (`:161-232`) renders Refine/Implement and is unreachable while running.
The invariant holds in the default branch only. Do **not** "simplify" by deleting the running
branch and falling through — that would start rendering Implement/Refine during a run.

## Item 2 — context glyph visible when the composer is unfocused

### Current behaviour (verified, and my earlier claim corrected)

`isComposerCollapsedMobile = isMobileViewport && !forceExpandedOnMobile && !isComposerFocused`
(`:973`). Collapsed swaps the whole footer for a prompt row (`:2910-2951`) with a hardcoded send
arrow — no glyph, no Stop.

I wrote "on desktop it is always present". **False.** `:3201` is
`isComposerCollapsedMobile ? null : activePendingApproval ? (approval actions) : (footer)` — an
active approval replaces the footer, and the glyph with it, on desktop too.

### Why this is not scope creep

`onInterrupt` has exactly one consumer chain: `ChatView.tsx:6598` → `ChatComposer` →
`ComposerPrimaryActions.tsx:92`. There is no Stop anywhere else in the app. With the footer
unrendered while collapsed, **there is currently no way to stop a run from a phone without first
tapping to expand the composer.**

### FALSIFIED premise 3 — the glyph cannot simply be dropped into that row

`onFocusCapture` (`:2787-2796`) sets `isComposerFocused = true` — expanding the composer — unless
the focused element is inside `[data-chat-composer-collapsed-controls="true"]`. That attribute
exists only on the approval (`:2837`) and pending-input (`:2854`) containers. The prompt row
survives today only because both its buttons carry `onPointerDown → preventDefault` (`:2920`,
`:2935`), suppressing focus.

`VitalsGaugeConnected` renders its own button via `PopoverTrigger` and accepts no className or
pointer-handler passthrough. Dropped in as-is, tapping the glyph focuses it → composer expands →
the row unmounts mid-tap while the popover is opening. The one thing the user asked for would
hijack the composer.

### Chosen approach

1. Add `data-chat-composer-collapsed-controls="true"` to the collapsed prompt row's container,
   matching what the other two collapsed containers already do. This is what makes the glyph
   tappable without expanding, and it needs no change to `VitalsGauge`.
2. Render `VitalsGaugeConnected` in that row, left of the action button.
3. While running, render Stop beside Send in that row.
4. Drop `phase === "running"` from `collapsedComposerPrimaryActionDisabled` (`:1253-1254`).
   Without this the collapsed Send is hard-disabled during a run and item 1's queueing is
   unreachable from a phone — the surface where it matters most.

### Deliberate deviation from the original commit

`58b3389e7` **swapped** the collapsed arrow for Stop while running, commenting that queueing
belongs in the expanded composer. Round 1 recommended keeping that swap as smaller and safer.

Not taking it: the request was explicitly "Send always shows, Stop next to it", and the phone is
where the reporter works. If verification shows the row crowds, the fallback is the swap — a
one-line change. Recorded as a decision point, not a settled fact.

### Space budget (estimate, NOT measured)

Glyph ~32 + Send ~32 + Stop ~32 + gaps ≈ 120px of a ~338px row, leaving ~218px for prompt text.
The 338px is carried from the 2026-08-08 banner work. **Estimate only** — see Deferred
verification.

### Gaps and side effects this leaves (stated, not discovered later)

- **Glyph still absent in three states**: collapsed approval (`:2834`), collapsed pending-user-
  input (`:2851`), and the desktop approval footer (`:3201`). Those rows are dense and are
  answering a question rather than composing. Deliberate.
- **Continuous host-metrics sampling on phones.** `useHostMetrics` subscribes while visible and
  its family uses `idleTtlMs: 0`, which also drives *server-side* sampling. Today that stops when
  a phone's composer collapses; after this it does not. Opt-in behind `useHostMetricsEnabled`,
  but a real battery/bandwidth change on the targeted device class.
- `:2889` and `:3180` hardcode `isRunning={false}`, so those two pending-answer rows never show
  Stop even during a real run. Pre-existing and unreachable today; noted because this change
  makes the `isRunning` branch the place Stop lives. Not fixed here.

## Item 3 — Stop must actually stop the turn

Root cause from an independent RCA on the symptom alone, then re-verified claim-by-claim against
source. **Its own review round is still outstanding; treat this section as provisional.**

### The mechanism (confirmed)

**1. Two concurrent sends both start a turn; the first is orphaned.** `sendTurn` decides
queue-vs-start by reading `context.turnState` (`ClaudeAdapter.ts:4637`), but `startTurnNow` does
not assign it until `:4563` — after `setPermissionMode()` and `nowIso`, i.e. after several
yields. Two fibers in that window both see `undefined`, both call `startTurnNow`, and the second
overwrites the first. `completeTurn` reads `turnState.turnId`, so the orphan's `turn.completed`
can never be emitted.

Trigger: `BackgroundTaskRecoveryWatchdog` resumed **two** stale tasks on one thread 35 ms apart
at boot, dispatched concurrently (`ProviderCommandReactor.ts:1304-1314`).

**2. The projection latches onto the orphan, permanently.** In
`ProviderRuntimeIngestion.ts`'s `shouldApplyThreadLifecycle`, `turn.completed` returns false
whenever it conflicts with `activeTurnId`, and `turn.started` returns false unless it does not
conflict. With `activeTurnId` pinned to a turn that can never complete, every later lifecycle
event is rejected. No timeout, no escape. The row stayed `running` ~27 hours across ~60 turns.

**3. Stop then cannot do anything.** The reactor's repair (`:1415-1434`) is gated on
`hasLiveSessionForThread` — **session** liveness — but the session was alive; only the turn was
gone, so the repair is skipped. `:1436` interrupts by session, discarding the payload turn id.
`interruptTurn` (`:4653-4721`) never consults `context.turnState`, so `query.interrupt()` is a
no-op, wrapped in `timeoutOption + asVoid` — success, no-op and timeout are indistinguishable.

33 interrupt events produced zero downstream events.

**4. Why a new message fixed it — my explanation was FALSE.** I claimed the user message makes
the server write the session row directly, bypassing the guard. Review disproved it:
`ProviderCommandReactor.ts:635` gates that write on `thread.session?.status !== "running"`, i.e.
it is skipped precisely in the latched state. The other direct write (`bindSessionToThread`,
`:724`) only runs when a session is actually (re)started, and this session was alive.

The only mechanism consistent with the evidence is *inside* the guard:
`ProviderRuntimeIngestion.ts:1927-1931` accepts a conflicting `turn.started` when a pending
turn-start row exists **and** the adapter's live `activeTurnId` equals the event's turn id. That
branch is **racy** — `getExpectedProviderTurnIdForThread` (`:1693-1698`) reads the adapter's
*current* session at ingest time, so a short turn or a lagging ingestion worker fails `sameId`
and no heal occurs. That is the only explanation I have for "60 turns did not heal, the 61st
did", and it points at a cheaper, deterministic fix considered below.

### Unresolved tension, stated rather than hidden

I also wrote "there is no timeout and no escape hatch". That is **too strong**.
`shouldApplyThreadLifecycle` accepts `session.exited` (`:1938`), `session.started`/`thread.started`
(`:1940-1942`), and everything not enumerated via `default: return true` (`:1955`) — including
`session.state.changed`, which nulls `activeTurnId` (`:1998-2003`, `:413-417`). `runtime.error`
has its own accepted write (`:2281-2307`), and `BootTurnReconciler.ts:55-94` settles every live
session at boot.

So several escape paths exist, yet the row empirically stayed latched for ~27 hours across two
server boots. **I cannot currently reconcile the source with the observation.** Until that is
reconciled, any fix justified by "nothing else can clear it" is resting on an unproven premise.
This is a blocker for item 3's design, not a footnote — see status below.

### Corrections to my own earlier analysis

- I reported a mismatch in `provider_session_runtime.activeTurnId`. The latch is in
  `projection_thread_sessions` — different table, different turn id. My snapshot was taken ~30s
  **after** the "asdasd" message had repaired it; I was reading the healed state.
- Memory said "Stop escalates interrupt → session.stop". **Not true in this tree.** No escalation
  exists; `stopSession` is reachable only from thread actions and the branch selector.

### Approach — REVISED after review; both original fixes were unsafe as specified

**Fix A (root): claim the turn slot atomically — with a release path.**

Corrections forced by review:

- The claim can only live in `sendTurn`, adjacent to the read at `:4637`. Preemption in Effect
  happens at `yield*` boundaries, so statements between two yields are atomic — but crossing into
  `startTurnNow` is itself a yield, and `:4508-4549` yields before `:4563` whenever a model or
  permission-mode change fires. "Make `startTurnNow` claim first" cannot work.
- **A claim without a release is worse than the bug.** `startTurnNow` can fail at `setModel`,
  `setPermissionMode`, `buildUserMessageEffect` (file IO) or `Queue.offer`, and the fiber is
  `forkScoped` so it can also be *interrupted*. An unreleased claim makes `sendTurn` queue every
  later message forever while `drainNextPendingTurn`'s `if (context.turnState) return` never
  fires: thread permanently unsendable, nothing running, nothing to interrupt.
- The release must be `Effect.ensuring` (runs on interruption); `Effect.tapError` is insufficient.
  **In-repo precedent:** `CursorAdapter.ts:1012` claims synchronously in the same generator step
  as its read at `:1007` and releases at `:1144-1146` via `ensuring`. That is the pattern to
  mirror — not Grok's turn-id binding, which I cited first and which solves a different problem.
- The claim must be a **separate field**. Reusing `turnState` corrupts every consumer that reads
  it as "the running turn" (`:1845`, `:2743`, `:2928`) and breaks the synthetic auto-close at
  `:4642-4646`. Pushing to `pendingTurns` instead reintroduces the stranding that the comment at
  `:4619-4621` exists to prevent.
- `drainNextPendingTurn:4609-4612` **already implements a different claim** (peek-don't-shift)
  and its comment describes this very race. A third mechanism is where the next defect comes
  from; Fix A must unify with it, not sit beside it.

**Fix B (containment): settle a session that has no turn in flight — but never instead of the
interrupt.**

Corrections forced by review:

- **Do both.** As originally specified ("settle *instead of* interrupting"), Fix B would skip
  `handleResultMessage`'s non-completed branch, so `pendingTurns` is never cleared (`:3068`) and
  **queued follow-ups would fire after a Stop** — directly breaking
  `ClaudeAdapter.test.ts:4409`. It would also skip `interruptTurn`'s stop-everything sweep
  (`:4661-4707`), leaving subagents burning tokens, which is the primary reason users press Stop.
- **Settle to `ready`, not `stopped`,** when the provider session is alive. Writing `stopped`
  makes `existingSessionThreadId` null at `:744-746`, so the next send takes the start path and
  `startSession:3880-3899` calls `stopSessionInternal(..., emitExitEvent: false)` — silently
  killing a live subprocess with no `session.exited`.
- **No interface change is needed.** I rejected a turn-liveness probe as "changes the interface
  for all five adapters" — false. `activeTurnId` is already on `ProviderSession`
  (`packages/contracts/src/provider.ts:55`), written by every adapter, and
  `hasLiveSessionForThread` (`:1317-1320`) already calls `listSessions()`. Fix B is a
  one-predicate change that works uniformly.
- Fix A's claim **must be visible to Fix B's probe**, or Fix A converts a rare race into a
  reproducible false negative during exactly the window it creates.
- `activeTurnId` alone is a false positive for stale *synthetic* turns (`:2941-2946`), the case
  `sendTurn:4642-4646` treats as garbage. The stall watchdog excludes them
  (`ProviderTurnStallWatchdog.ts:232`) but the snapshot carries no synthetic flag. This sub-case
  is the only part that genuinely needs more than the existing snapshot.

**Cheaper candidate now in play.** Making the heal branch at `:1927-1931` match the pending
turn-start row's **message id** instead of a live, racing adapter read would be deterministic and
much smaller than either fix. It was not considered in round 1 and must be evaluated before
committing to A+B.

### Alternatives considered

- **Client escalation to `thread.session.stop` after a grace.** Rejected as primary: a timer
  heuristic that force-kills a subprocess. Follow-up 5.
- **An escape hatch in the lifecycle guard.** Weakens the invariant it exists to enforce.

### Known limitations and gaps

- A latched thread that never receives a Stop stays wrong until its next message. The stall
  watchdog cannot catch it: `ProviderTurnStallWatchdog.ts:230` requires
  `sameTurn(activeTurnId, entry.turnId)` while `recordTurnActivity` keeps one entry per
  **thread**. Follow-up 3.
- **Session replacement is a real gap I missed:** `startSession:3880-3899` tears down with
  `emitExitEvent: false`, so no `session.exited` reaches ingestion.
- Server restart is **not** a gap — `BootTurnReconciler.ts:55-94` settles live sessions at boot.
  (Which deepens the unresolved tension above: two boots occurred during the 27 hours.)
- The other four adapters were not analysed for the same race. Cursor demonstrably has the right
  discipline; Codex and OpenCode are unexamined.
- **Test strategy.** The existing queue tests (`ClaudeAdapter.test.ts:4409`, `:4472`) are strictly
  sequential and cannot observe the race. Fix A needs a genuinely concurrent test (two forked
  `sendTurn`s) plus a claim-release test where `startTurnNow` fails *and* is interrupted.

### Status: item 3 is NOT ready to implement

Two independent blockers: the source/observation tension above is unreconciled, and the cheaper
deterministic candidate has not been evaluated. Items 1 and 2 are unblocked and proceed now.

## Files expected to change

```
apps/web/src/components/chat/ComposerPrimaryActions.tsx     — sendButton extraction, running row, size parity
apps/web/src/components/chat/ComposerPrimaryActions.test.ts — running-branch coverage (see test note)
apps/web/src/components/chat/ChatComposer.tsx               — collapsed row: glyph, Stop, data attribute, :1254
apps/server/src/provider/Layers/ClaudeAdapter.ts            — Fix A
apps/server/src/provider/Layers/ClaudeAdapter.test.ts       — concurrent sendTurn regression
apps/server/src/orchestration/Layers/ProviderCommandReactor.ts — Fix B
```

`ChatView.tsx` is **not** in this list — see falsified premise 1.

## Test note — avoiding vacuous assertions

`ComposerPrimaryActions.test.ts` renders with `renderToStaticMarkup` and its fixtures pass
`hasSendableContent: false`. Since the Send's `disabled` already includes `!hasSendableContent`
(`:245`), any assertion about Send being enabled/disabled while running is **vacuous** under the
current fixtures. Real coverage must flip `hasSendableContent: true` and assert on the `disabled`
attribute specifically.

Static rendering also cannot fire `onFocusCapture`, so no unit test can catch the collapsed-row
focus hijack. That risk is carried by the code change (the data attribute) and by live
verification, not by the suite.

## Deferred verification (explicit)

This run does **not** build the package or deploy, by instruction. Therefore:

- The collapsed-row layout at 390px is **unverified**.
- The collapsed-row tap-the-glyph behaviour is **unverified**.
- Queue-a-follow-up end to end against a live Claude turn is **unverified**.
- Item 3's fixes are **unverified against a live recurrence**.

None of these may be reported as confirmed until the package is built and exercised.

## Follow-ups deferred

1. Per-adapter queue/steer semantics differ; a shared contract would let the composer describe
   what a send-while-running will actually do.
2. 70 `running` and 15 `pending` turns with no `completed_at` in the live DB — sweep needed.
   Follow-up 7 may be the real cause.
3. **The stall watchdog is structurally blind** to the latch it exists to heal.
4. **Interrupt is unobservable** — a no-op and a success are indistinguishable. Emitting a
   failure activity would have turned a 27-hour investigation into a log line.
5. Last-resort Stop escalation to `thread.session.stop`.
6. `BackgroundTaskRecoveryWatchdog` dispatches concurrent resumes for the *same thread*;
   serialising per-thread would remove item 3's trigger even without Fix A.
7. **Queued messages are dropped silently on Stop**, leaving orphaned user messages in the
   transcript. Needs either a distinct rendering or an event.
8. Disabled-send reasons are unreachable — no tooltip, `disabled:pointer-events-none`, and
   disabled buttons are not focusable.
