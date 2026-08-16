# Stop escalation ladder + watchdog adoption of a user force-stop — design

**Date:** 2026-08-15
**Branch:** `feat/stop-escalation-ladder`

## Goal

Two halves of one behaviour:

1. **Restore the two-press Stop.** First press = cooperative `thread.turn.interrupt`. A deliberate
   second press = hard `thread.session.stop`, which force-kills a turn wedged inside a tool.
2. **Make that force-stop _recover_ the thread.** Today a manual session stop leaves the thread
   dead. Mark the user's force-stop so the turn-stall watchdog **adopts** it and drives its normal
   stop→resume recovery, instead of the thread simply sitting stopped.

## Why the second half is the interesting one

The watchdog (`ProviderTurnStallWatchdog`) already recovers wedged turns: it trips, dispatches a
stop, records `awaitingStopForTurnId`, sees the session go down on a later tick, and dispatches a
**resume**. That record is the whole recovery mechanism.

Two facts make the manual path a dead end today:

- **A manual stop sets no record**, so no resume ever follows. Verified: `awaitingStopForTurnId` is
  written in exactly one place — the watchdog's own trip path
  (`ProviderTurnStallWatchdog.ts:363`).
- **The watchdog is structurally blind to the case the user is force-stopping.** `shouldTrip`
  abstains when `entry.openToolItemIds.size !== 0`, on the reasoning that an open tool means the
  turn is _legitimately_ blocked rather than wedged. A turn wedged **inside** a tool therefore never
  trips the watchdog — and that is precisely the situation where a human hits Stop twice.

So the human is the sensor the watchdog lacks. The signal carries that judgement across.

## Premises validated (Hard Rule 8)

| Premise                                                  | Probe                                                                                                                 | Result                                                                                    |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| The old ladder existed and its semantics are recoverable | `git show 2b7193648~1:…/ChatView.logic.ts` — `nextStopAction`, `shouldHardStopAfterGrace` with full doc comments      | ✅                                                                                        |
| A manual `thread.session.stop` produces no resume        | `awaitingStopForTurnId` written only at `ProviderTurnStallWatchdog.ts:363` (the trip path)                            | ✅                                                                                        |
| The watchdog cannot see a tool-wedged turn               | `shouldTrip` requires `entry.openToolItemIds.size === 0`                                                              | ✅                                                                                        |
| Not every session-stop should resume                     | the same command is issued for settle/archive cleanup (`ws.ts:1185`) and by the reaper; resuming those would be wrong | ✅ — this is why a **marker** is required rather than the watchdog simply observing stops |
| The command can carry a marker                           | `thread.session.stop` already has an optional `onlyIfSettled` flag                                                    | ✅ precedent                                                                              |
| The watchdog is reachable from the command path          | `ProviderTurnStallWatchdogLive` is in the layer graph (`server.ts:273`)                                               | ✅                                                                                        |

## Approach

**1. Client ladder** — restore `nextStopAction` / `shouldHardStopAfterGrace` to `ChatView.logic.ts`
with their original semantics, including the carve-out that a turn parked on a pending
user-input/approval request is **waiting on a human, not wedged**, and must never auto-escalate.
(That carve-out exists because auto-escalating it once stranded the answer with "No active provider
session…".) A deliberate second press still force-stops such a turn, so a genuinely wedged turn
whose flag is stuck remains killable.

**2. Command marker** — add an optional `recoverAfterStop?: boolean` to `thread.session.stop`.
Set only by the user's force-stop. Absent on settle/archive/reaper stops, which must stay
terminal. Optional keeps every existing producer and older client valid.

**3. Watchdog adoption** — when a stop carrying the marker is decided, the watchdog records
`awaitingStopForTurnId` for that thread's active turn, exactly as if it had tripped itself. Its
existing tick then drives the resume. Nothing about the recovery path is new; only its _entry
point_ is.

This deliberately **bypasses `shouldTrip`** — not by weakening the guard, but by never consulting
it. The guards (threshold, open-tool set, pending-input) exist to decide _whether the machine
should suspect a stall_. A human pressing Stop twice has already made that judgement, and the
open-tool guard would otherwise veto the exact case they are reporting.

## The Cancel tripwire (superseded — see the correction below)

`ComposerPrimaryActions.tsx` carries a comment added earlier today saying that Cancel shares the
non-escalating `onInterrupt` **only because** no escalation exists on this path, and that if Stop
regains escalation, Cancel must split back out.

That condition is now met, so this change discharges it: Cancel keeps dispatching the plain
cooperative interrupt and must **not** be routed through `nextStopAction`. Concretely, the
escalation ledger is keyed by thread and advanced only by the Stop control — a Cancel press neither
reads nor arms it, so a user who cancels a question and later presses Stop still gets a _first_
press that is cooperative. The tripwire comment is replaced by a statement of the settled design
plus a test.

## Correction found during implementation — the tripwire fired for real

The design above said Cancel could keep sharing `onInterrupt` because "escalation is armed only by
the Stop control". **That was wrong**, and the first implementation shipped the bug it was warning
about: `ComposerPrimaryActions` renders Cancel with `onClick={onInterrupt}` — the _same handler_
that is now the ladder's entry point. Pressing Cancel would have armed escalation, and the next
Stop press would have force-stopped the session. That is exactly the `f4af9398e` bug.

So `onCancelQuestion` is **restored**, as the original design had it, threaded
ChatView → ChatComposer → ComposerPrimaryActions. It dispatches the cooperative interrupt without
touching the ledger. The prop is **required**, not optional, so removing it breaks typecheck rather
than silently re-merging the two paths, and a test documents why.

The lesson worth keeping: a tripwire comment is only as good as the check that it is still true.
This one had a stated firing condition, the condition was met by this very change, and reasoning
about it in prose still produced the wrong answer — reading the call site is what caught it.

## Alternatives rejected

| Alternative                                                                     | Why not                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Watchdog observes **all** `thread.session-stop-requested` events and resumes    | Settle, archive and reaper stops are terminal by intent; resuming them would resurrect threads the system just parked. This is the reason a marker is needed at all.                                             |
| Relax `shouldTrip`'s open-tool guard so wedged-in-tool turns trip automatically | That guard is load-bearing: a foreground Bash/Edit legitimately holds an open tool for a long time, and tripping on it would kill healthy long-running work. The human signal is the safe way to cover the case. |
| Reuse the interrupt command with an `escalate` flag instead of `session.stop`   | Two different server behaviours behind one command type; the decider already models them as distinct commands, and `session.stop` carries the existing settle-race guard.                                        |
| Client-side force-stop with no watchdog involvement (restore the ladder only)   | Restores the kill but leaves the thread dead — the "and then what?" the user specifically asked about.                                                                                                           |
| Have the client dispatch stop **and** a resume itself                           | Duplicates recovery logic that already exists server-side, and races the session teardown the watchdog waits for.                                                                                                |

## Tradeoffs and limitations

- **A force-stop now resumes the conversation.** That is the intent, but it is a behaviour change
  from "stop means stopped": a user who wants the thread to stay down has archive/settle.
- The marker is a **hint, not a command** — if the watchdog has given up on a thread
  (`record.gaveUp`), adoption must not override that, or a wedge loop could be re-armed
  indefinitely.
- Recovery attempts remain bounded by the watchdog's existing `attempts` cap; an adopted stop
  should count against it rather than resetting it.

## Design review

**6a — pillar sweep: REQUIRED and run inline.** This changes a **command contract**
(`thread.session.stop` gains a field) and a recovery/rollout path, so the trigger fires. Standing
instruction in this session is not to dispatch subagents, so the sweep was run inline rather than
via `review-technical-design`; recording that deviation rather than silently skipping the stage.

| Pillar               | Finding                                                                                                                                                     | Verdict                                                                                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Reliability          | Adoption must not reset or bypass the `attempts` cap, and must respect `gaveUp` — otherwise a permanently wedged provider becomes a stop/resume loop        | **must-fix** → carried into the plan                                                                                                                                     |
| Safety               | Force-stop is destructive and now also _resumes_. Must stay behind the deliberate second press, never a first press or a timer                              | **must-fix** → the auto-escalation path (`shouldHardStopAfterGrace`) keeps its pending-input carve-out and must not set the recover marker; only the explicit press does |
| Compatibility        | Optional field; older clients omit it and behave exactly as today; older servers ignore an unknown optional                                                 | GO                                                                                                                                                                       |
| Observability        | The watchdog already appends a "Stalled turn — recovering" activity and records analytics. An adopted stop must be distinguishable from a self-trip in both | **must-fix** → distinct summary + analytics tag                                                                                                                          |
| Security/privacy     | No new entry point (existing authenticated command), no new data                                                                                            | N/A                                                                                                                                                                      |
| Performance          | No new polling or query pattern                                                                                                                             | N/A                                                                                                                                                                      |
| Delivery/testability | Ladder logic and adoption are both pure-ish and unit-testable                                                                                               | GO                                                                                                                                                                       |

**Verdict: CONDITIONAL GO** — three must-fixes, all carried into the plan below, none of them
design-invalidating.

**6b lenses: correctness, simplicity, safety** (safety triggered by a destructive action).
Applied findings:

1. **Correctness** — "second press" needs a definition of _when the ledger resets_. If it never
   resets, a Stop pressed once today makes tomorrow's first press a force-stop. Ledger entry is
   cleared when the turn settles or the thread changes, so escalation is scoped to one wedge.
2. **Simplicity** — do we need `shouldHardStopAfterGrace` (the timed auto-escalation) at all, or
   just the two-press ladder? Kept, because it is the half that helps a user who pressed Stop once
   and walked away — but it is the _conservative_ half: it never sets the recover marker, and it
   keeps the pending-input carve-out.
3. **Safety** — an adopted stop must not resurrect an archived or settled thread. Adoption is
   gated on the same shell conditions the watchdog's resume path already checks.

Exit: round 2 produced only repeats.

## Files touched (planned)

- `packages/contracts/src/orchestration.ts` — optional `recoverAfterStop` on the stop command.
- `apps/server/src/provider/Services|Layers/ProviderTurnStallWatchdog.ts` — adoption entry point,
  attempts/gaveUp respected, distinct activity + analytics.
- `apps/web/src/components/ChatView.logic.ts` — `nextStopAction`, `shouldHardStopAfterGrace`.
- `apps/web/src/components/ChatView.tsx` — ledger state + escalating Stop handler.
- `apps/web/src/components/chat/ComposerPrimaryActions.tsx` — replace the Cancel tripwire comment
  with the settled design.
- Tests alongside each.

## Follow-ups deferred

None identified yet; the drain runs after implementation.
