# Auto-compact an idle thread, then continue

**Status:** design
**Date:** 2026-08-18
**Surfaces:** web, desktop (inherits web), mobile

## The problem

A long thread fills its context window. The user types `/compact`, waits two to three
minutes for it to finish, then types `continue`. Nothing about that sequence needs a human:
the decision to compact is a threshold test, and the decision to continue is "the compaction
turn finished". It is repeated by hand many times a day.

## What ships

A **per-thread** switch, off by default, plus a **global threshold** in Settings (default 50%).
When a thread is armed, is idle, and its context is at or past the threshold, the client sends
`/compact`, waits for that turn to settle, then sends `continue` — the same two messages the
user would send, from the same client, through the same command path.

The switch is per thread because arming is a statement about _this piece of work_: "this is a
long job, keep it going". It is not a property of the user or the machine, and a global switch
would auto-continue threads that had genuinely finished.

## Why the client drives it

The obvious alternative is a server reactor. It was investigated and rejected on cost, not
taste — but the tradeoff is real and worth stating plainly.

**The server does not know how full a thread's context is.** `ThreadTokenUsageSnapshot` is a
contract and crosses the wire, but nothing persists or registers it server-side: there are no
usage columns on `projection_threads`, no migration adds any, and the percentage is derived in
the browser by `deriveLatestContextWindowSnapshot` scanning the activity list backwards. A
server-driven trigger therefore needs new persisted state and a new migration before it can
evaluate its own condition.

The client already has every input: the activity stream, the derived percentage, the thread
shell's idle flags, and a turn-start command path.

**The cost of this choice:** the feature only fires while a client is open on that thread. If
the laptop is closed, nothing happens. That is a deliberate v1 limit, and the natural upgrade
path (persist the usage snapshot at turn end, move the decision into a reactor) stays open
because the decision logic is a pure function with no client dependencies.

## Validated premises

Each was measured against the live system, not recalled.

| #   | Premise                                      | Verdict                                                                                           |
| --- | -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| P1  | Server knows context fullness                | **False** — not persisted; drives the client-side choice above                                    |
| P2  | Client can start turns programmatically      | **True** — `threadEnvironment.startTurn`; `OutboxFlushCoordinator` is the precedent               |
| P3  | There is a receipt for "compaction finished" | **True** — `/compact` runs as a turn, so _turn settlement_ is the signal                          |
| P4  | `/compact` is invokable as text              | **True** — provider slash commands insert `` `/${name} ` `` and send as an ordinary message       |
| P5  | Per-thread client state has a precedent      | **True** — `sidebarProjectGroupingOverrides` is a keyed `Schema.Record` in `ClientSettings`       |
| P6  | Mobile can derive context usage              | **True** — `apps/mobile/src/lib/threadActivity.ts` already consumes `OrchestrationThreadActivity` |
| P7  | Claude advertises a `compact` command        | **True** — probed the real binary: 97 commands, `hasCompact: true`                                |

P3 is the one that simplifies the design most. An earlier draft watched for Claude's
`compact_boundary` (`thread.state.changed{state:"compacted"}`) and Codex's `thread/compacted`.
Both exist, but neither is needed: waiting on turn settlement is provider-agnostic, already
observable on the client, and is literally what the user waits for.

P7 is what lets the feature gate itself. Rather than hardcoding a provider allowlist that goes
stale, the switch is offered only when the connected provider advertises a `compact` command.

## Shape

### 1. A pure decider

`packages/client-runtime/src/context/autoCompact.ts`

```ts
decideAutoCompact(input: AutoCompactInput): AutoCompactAction
```

No React, no I/O, no clock. Every rule below is expressed here and tested here, so the
coordinator holds only wiring.

```
AutoCompactInput  { armed, phase, usedPercentage, thresholdPercent,
                    threadBusy, hasPendingApprovals, hasPendingUserInput,
                    hasActionableProposedPlan, sessionReady, archived,
                    hasComposerDraft, providerSupportsCompact,
                    cyclesUsed, maxCycles, usedPercentageBeforeCompact }

AutoCompactAction { kind: "hold",     reason: AutoCompactHoldReason }
                  { kind: "compact"  }
                  { kind: "continue" }
                  { kind: "abandon",  reason: AutoCompactHoldReason }

`abandon` ends a sequence already in progress and returns the phase to idle; `hold` only
declines to start one. A mid-sequence blocker must abandon, or the phase parks forever.
```

This lives in `client-runtime` rather than `apps/web` so mobile shares one copy of the rules.
`contextWindow.ts` moves there with it for the same reason — mobile cannot evaluate a
threshold it has no way to compute.

### 2. A headless coordinator

`AutoCompactCoordinator`, modelled on `OutboxFlushCoordinator`: no UI, holds the phase, calls
the decider when its inputs change, and issues turns.

It acts on **the thread currently open in this client**. Context usage is derived from loaded
activities, and the fork's thread-load windowing means a background thread's activities are
not resident — so a thread armed and then navigated away from resumes when reopened. This is a
limit of the client-driven choice, not an oversight.

### 3. The sequence

```
        armed · idle · used% >= threshold · provider supports compact
                              │
             ┌────────────────▼────────────────┐
   phase:    │  idle → compacting → continuing → idle
   sends:    │  "/compact"        "continue"           (cyclesUsed++)
   waits on: │  turn settles      turn settles
             └─────────────────────────────────┘
```

### 4. Guards

Each exists because of a specific failure, not for symmetry.

- **Runaway spend.** Continue refills the context, which re-crosses the threshold, which
  compacts, which continues. Unbounded, this burns tokens all night. Capped at
  `DEFAULT_AUTO_COMPACT_MAX_CYCLES = 3` consecutive cycles with no message from the user.
  Reaching the cap holds, and says so.

  **The reset condition cannot be "`latestUserMessageAt` changed".** The projector computes
  that column as the max `createdAt` over messages with `role === "user"`, with no filter for
  synthetic ones (`ProjectionPipeline.ts:574-582`), and the auto-sent turns are `role: "user"`
  — so every auto-compact would reset its own cap and the guard would be inert. The
  coordinator therefore records the `latestUserMessageAt` value its own send produced, and
  resets only when the column advances **past** that value.

- **Compaction that does not compact.** If a `/compact` turn settles without reducing usage
  (it failed, or the window was already minimal), the decider would immediately see
  armed · idle · over-threshold and compact again — a loop the cap merely bounds rather than
  prevents. So the coordinator compares `usedPercentage` after settlement against the value
  before: no meaningful drop means hold with `compaction-ineffective` and do **not** send
  `continue`. This also protects against P3 being subtly wrong — if `/compact` ever settles
  before compaction is really finished, the drop check catches it rather than continuing early.

- **An unsent draft.** Holds while the composer has draft text. The user is mid-sentence;
  starting a turn under them is the kind of interruption this feature is supposed to remove.
- **Two clients, one thread.** Web and mobile can both be open and armed. Turns carry a
  deterministic `commandId` — `auto-compact:<threadId>:<cycle>` — and the server returns the
  original result for an already-accepted command, so a double fire starts one turn.
  (Same mechanism the outbox relies on for replay safety.)
- **Re-entrancy.** A ref latch, as in `OutboxFlushCoordinator`; renders must not re-issue an
  in-flight turn.
- **Work that needs a human.** Holds on `hasPendingApprovals`, `hasPendingUserInput`, and
  `hasActionableProposedPlan`. Compacting under a pending approval would discard the context
  the user is being asked about.
- **Send failure.** Disarms the thread and surfaces a toast rather than retrying — a silent
  retry loop against a wedged session is the failure this codebase keeps rediscovering.
- **Unsupported provider.** Holds when the provider advertises no `compact` command.

## UI — "quiet until it matters"

Chosen from three prototyped directions. The other two: a setpoint drawn on the vitals gauge
(loses its central idea on mobile, which has no gauge), and a permanent armed pill in the
composer footer (costs width in a footer that already collapses at 620px).

**Arming** lives in the thread menu, next to the other per-thread actions.

**Status** is a single row above the composer, shown only when the thread is armed _and_
either within 15 points of the threshold or mid-sequence:

| State                     | Copy                                               |
| ------------------------- | -------------------------------------------------- |
| approaching               | `Will compact at 50%`                              |
| at threshold, thread busy | `At 50% — compacting when the thread goes idle`    |
| compacting                | `Compacting this thread…`                          |
| continuing                | `Compacted. Continuing where it left off.`         |
| cap reached               | `Paused after 3 rounds — send a message to resume` |

Nothing is shown for an armed thread at 20% of its window. The feature stays silent until it
is about to act, and it never acts silently.

**Settings** carries the threshold only: a percentage between `MIN_AUTO_COMPACT_THRESHOLD` and
`MAX_AUTO_COMPACT_THRESHOLD`, default 50.

### Naming

The vitals popover already says _"Claude automatically compacts its context when needed"_
(`compactsAutomatically`). Calling this "auto-compact" gives one name to two behaviours. The
user-facing copy therefore says **compact early**: this feature's value is not that compaction
happens, but that it happens _before_ the user is blocked, while the thread is idle.

## Surfaces

"Mobile" here means **the web app in a mobile viewport**, which is the surface this ships on.
The React Native app is a separate codebase and is out of scope.

| Surface              | Arming                        | Status row     | Acts |
| -------------------- | ----------------------------- | -------------- | ---- |
| Web, wide            | thread menu                   | above composer | yes  |
| Web, mobile viewport | thread menu, by tapping title | above composer | yes  |
| Desktop              | inherits web                  | inherits web   | yes  |
| React Native app     | out of scope                  | —              | —    |

Nothing in this feature is desktop-only by construction: direction C was chosen partly because
it adds no composer-footer chrome, and the footer already collapses at 620px. The arm control
lives in the thread action menu, which is reachable **by tap** — `ChatHeader` opens the same
menu from a title button (`openMenuFromTitle`), and the browser gets a rendered menu through
`showContextMenuFallback` rather than a native one. The sidebar row's right-click path is
additional, not the only way in.

Two real limits in a narrow viewport, both worth knowing:

- **The banner stack shows only `items[0]`.** The rest expand on `group-hover` /
  `group-focus-within` and are `pointer-events-none` until they do, so a touch user cannot
  reach them. The status row is ordered directly after the contested/urgent banners, so it is
  `items[0]` whenever none of those are present — but while an urgent banner is up, the
  auto-compact status is not visible on touch. The sequence still runs; only its narration is
  hidden.
- **The menu's own affordance is hover-gated.** The chevron beside the thread title is
  `opacity-0` until `group-hover`, so on touch the title does not advertise that it opens a
  menu. Pre-existing, and not changed here, but it is how a phone user discovers arming.

Status text wraps rather than truncates (`AlertTitle` sets no truncation), so the longest
string stays readable when narrow.

`ClientSettings` are localStorage-only, so arming is **per device**: a thread armed on a
desktop browser is not armed in a phone browser. This is coherent for a client-driven actor —
the client that is open is the one that acts.

## Testing

- **Decider:** table-driven over every hold reason, both threshold edges (`used == threshold`
  fires, `used == threshold - 0.1` holds), cap boundary, and each human-needed flag.
- **Coordinator:** phase advance on turn settlement; no second send while in flight; disarm on
  send failure; counter reset on a new user message.
- **No timing tests.** The sequence advances on turn settlement, never on a timer, so no test
  needs a sleep.

## Design review

Two rounds. Round 2 re-ran correctness and safety because round 1's fixes touched both, and
produced only repeats — that is the exit condition.

What the review changed:

| Finding                                                        | Severity                                                | Outcome                                                                                                                                           |
| -------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cap reset defeated by the feature's own `role:"user"` messages | **critical** — the runaway guard was inert              | reset now compares against the value our own send produced                                                                                        |
| Nothing verified that compaction reduced usage                 | **important** — repeated compaction on a failed compact | drop check before `continue`; new `compaction-ineffective` hold                                                                                   |
| Firing while the user has an unsent draft                      | moderate                                                | holds on a non-empty composer draft                                                                                                               |
| Armed thread on a provider with no `compact`                   | moderate                                                | switch not offered; armed-but-unsupported states the reason                                                                                       |
| `ClientSettingsPatch` omission                                 | trap                                                    | both keys must be added to the patch as well as the struct — a fork bug of exactly this shape once made Local Models settings silently unsaveable |

The critical finding is the one worth remembering: a guard whose reset condition the guarded
action can itself trigger is not a guard. It was found by asking what writes
`latestUserMessageAt`, and the answer was a projector that cannot tell a synthetic user
message from a human one.

## Out of scope

- Server-side firing while every client is closed (needs persisted usage; path left open).
- Per-project or per-provider thresholds.
- Compacting a thread that is not open in this client.
