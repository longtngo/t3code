# Prevent losing the provider session on AskUserQuestion + auto-reattach — 2026-07-07

## Goal

Two asks, from the recurring failure "**No active provider session is bound to this thread.**"
seen right after answering an `AskUserQuestion` (3rd occurrence):

1. **Prevent** the provider session from being lost in the first place while a turn is
   parked waiting for the user to answer a question (or approve a tool).
2. **Auto-reattach** the provider session when it *is* gone, instead of dead-ending on a
   cryptic error, so the conversation can continue.

## Where the error comes from

`ProviderCommandReactor.ts` guards three handlers with one check on the **read-model
projection** (`thread.session`, read via `getThreadDetailById`):

```ts
const hasSession = thread.session && thread.session.status !== "stopped";
```

- interrupt — `processTurnInterruptRequested` (line 895)
- approval response — `processApprovalResponseRequested` (line 918)
- user-input response — `processUserInputResponseRequested` (line 962)

When that projection is `null` or `status === "stopped"`, the handler hard-fails with the
error and does **nothing else**. Contrast the **turn-start** path
(`ensureSessionForThread`, lines 388–408), which consults *both* the projection **and** the
live session and auto-starts/restarts when either is missing. The three request handlers are
simply not resilient the way turn-start is.

`thread.session` is a lagging projection. The authoritative, restart-durable state is the
**persisted binding + resume cursor** in the SQLite `provider_session_runtime` table
(migration 004), surfaced by `ProviderSessionDirectory`. That distinction is the backbone of
the fix.

## Root causes (why the session becomes `stopped` during a pending question)

Three paths drive `thread.session` to `stopped` while a question is outstanding. All three
are confirmed against the live code; RC-B is the dominant, AskUserQuestion-specific one.

### RC-B (dominant) — the client Stop/Cancel escalation hard-stops a waiting session

- `AskUserQuestion` is handled inside the Claude SDK's `canUseTool` callback
  (`ClaudeAdapter.handleAskUserQuestion`, line 3029). It emits `user-input.requested`,
  registers a `Deferred` in the in-memory `pendingUserInputs` map, and **blocks** on
  `Deferred.await` (line 3111). The subprocess stays alive; no `turn.completed` fires, so the
  turn legitimately stays `running` with `activeTurnId` set and `hasPendingUserInput === true`.
- The **question panel's "Cancel" button** (`ComposerPrimaryActions.tsx:145`, aria-label
  "Cancel question") **and the Stop button** (line 215) both call the *same* `onInterrupt`.
- `onInterrupt` (`ChatView.tsx`, added in commit `82f37451e`) dispatches a cooperative
  `thread.turn.interrupt` **and arms a 6-second timer** (`INTERRUPT_ESCALATION_MS = 6000`).
- After the grace period, `shouldHardStopAfterGrace` (`ChatView.logic.ts:446`) escalates to a
  **hard `thread.session.stop`** whenever `escalatedThreadId === threadId && !latestTurnSettled`.
- `isLatestTurnSettled` (`packages/shared/src/orchestrationTiming.ts:34`) returns **false** for
  a turn parked on a question (no `completedAt`, `orchestrationStatus === "running"`). **Neither
  gate consults `hasPendingUserInput`/`hasPendingApprovals`.**
- Result: **any Stop/Cancel press during a pending question guarantees a hard session-stop
  ~6 s later** → `processSessionStopRequested` sets the projection to `status:"stopped"` →
  the user's subsequent answer submit hits the guard → the error. This escalation was
  *intentional* for genuinely wedged tools (the stop-and-stall-recovery feature); it just
  lacks a "waiting on the user is not wedged" carve-out.

Aggravating UX: while the question is pending the composer still shows the agent as
"working" (spinner + Stop), inviting the very press that kills the session.

### RC-A (secondary) — server restart during the wait

A full server restart (e.g. `t3-rebuild`, crash) kills the subprocess and the in-memory
`Deferred`. On boot, `BootTurnReconciler` force-sets every live-status session to
`status:"stopped", activeTurnId:null`. The question UI survives (it's derived from persisted
activities), so the user answers post-restart → same guard → same error. Prevention is
impossible here (the subprocess is gone); this is the case **auto-reattach** must cover.

### RC-C (edge) — the idle reaper's missing guard

`ProviderSessionReaper` (30-min idle) is guarded **only** by `activeTurnId != null`
(line 66); it does **not** check `hasPendingUserInput`/`hasPendingApprovals` the way the stall
watchdog does (`ProviderTurnStallWatchdog.ts:234–235`). For Claude, `activeTurnId` stays set
during the wait, so the reaper normally spares it — but any provider/flow that clears
`activeTurnId` while a request is still open, or a projection race, is exposed. `lastSeenAt`
also freezes at `sendTurn` time, so the 30-min idle clock runs during the human wait.

**Verified premises (Hard Rule 8):**
- ✓ The guard fires on the *projection*, not the live session (`resolveThread` →
  `getThreadDetailById`).
- ✓ `provider_session_runtime` is SQLite-backed with `resume_cursor` + `runtime_payload`
  (migration 004) → binding + resume cursor **survive a restart**.
- ✓ `respondToUserInput` already calls `resolveRoutableSession(allowRecovery:true)` →
  `recoverSessionForThread`, which *adopts* a live session or *resumes* from the persisted
  cursor — but the reactor's projection pre-check bails **before** this runs.
- ✓ The "Cancel question" button is wired to the same escalating `onInterrupt` as Stop.
- ✗ **Dangling-`tool_use` resume — UNVERIFIABLE from source, so NOT depended upon.** Whether a
  resumed Claude session accepts a continuation after a **dangling `tool_use`** (subprocess
  SIGKILLed mid-question → transcript has a `tool_use` with no `tool_result`) is decided inside
  the compiled native `claude` binary; the JS SDK does **not** heal it, and t3code's persisted
  `resumeSessionAt` anchor points **at** the tool_use-bearing assistant message (inclusive), so
  fork-at-anchor as currently wired would **not** truncate it. Rather than settle this with an
  expensive crash-during-question experiment, the design **does not rely on it**: rung-2
  continuation is best-effort and catches a provider rejection, falling back to the reworded
  actionable error (see Part 2). A *graceful* stop's abort path returns a `deny` tool result, so
  graceful-stop resumes are clean **provided** the deny is flushed before subprocess teardown —
  the one ordering fix we do make (S6 below).

## Approach

Two independent, composable parts, revised per the design-review round (findings S1–S7 from the
correctness lens and F1–F5 from the simplicity lens are folded in below). Part 1 (prevention)
removes the dominant cause with low-risk client guards. Part 2 (auto-reattach) makes the request
handlers resilient by **removing the precheck that blocks the recovery that already exists** one
layer down — not by building a parallel recovery path.

### Part 1 — Prevention: don't kill a session that's waiting on the user

**P1. Guard the Stop hard-stop escalation with pending-input awareness — but keep a manual
escape hatch (client).** A turn parked on a pending user-input/approval request is *not* wedged;
it is waiting on the human. So when `hasPendingUserInput || hasPendingApprovals` **at the moment
Stop is pressed** (a *press-time* decision, per **S5** — the escalation gate reads state at fire
time via refs, so decide at press time to avoid the activity-lag flip), do **not** arm the 6 s
escalation timer. The cooperative `thread.turn.interrupt` still fires (it correctly declines the
question via the SDK abort → `deny`) but never auto-escalates to a session-killing
`thread.session.stop`. This is the core fix for RC-B and aligns the client with the server stall
watchdog, which already abstains on these same flags (**F4** — alignment, not regression).
- **Escape hatch (S2, resolves the earlier open question): a *second* Stop press still hard-stops
  unconditionally.** `onInterrupt` keeps recording `interruptEscalatedThreadRef = threadId` even
  when P1 declines to arm the timer, so `nextStopAction` returns `"hardStop"` on the next press
  regardless of pending flags. Without this, a *stuck-true* pending flag (a dropped
  `user-input.resolved`, a stale projection) would leave a genuinely wedged turn with **no**
  killer — the watchdog abstains and the client wouldn't escalate — regressing the
  stop-and-stall-recovery guarantee (82f37451e). One press = safe (no accidental kill); two
  presses = "I mean it," force-stop.
- Touch: `ChatView.logic.ts` (`shouldHardStopAfterGrace` gains the pending carve-out; `nextStopAction`
  unchanged), `ChatView.tsx` (`onInterrupt` passes press-time pending state; still sets the
  escalation ref). `orchestrationTiming.isLatestTurnSettled` stays untouched — it has multiple
  external callers (**F4**); the carve-out lives only in the escalation gate (one caller).

**P1b. "Cancel question" = dedicated cooperative decline, reusing the existing interrupt (F3).**
Give the question panel's "Cancel" its own handler distinct from Stop: it dispatches the
*existing* `thread.turn.interrupt` (which already denies the tool cleanly via the abort path,
`ClaudeAdapter.ts:3139-3144`) and **never** arms escalation — no new `decline`/`cancel-user-input`
command, no `decider.ts`/contract change. This delivers the approved "dedicated cooperative
decline" mental model (Cancel always declines; Stop is the escalating control) at minimal cost.
- Touch: `chat/ComposerPrimaryActions.tsx` (separate `onCancelQuestion` prop for the "Cancel
  question" button vs. `onInterrupt` for "Stop generation"), `ChatView.tsx` (wire it).

**P2. Harden the idle reaper (server).** Add the `hasPendingUserInput`/`hasPendingApprovals`
skip to `ProviderSessionReaper.sweep`, mirroring `ProviderTurnStallWatchdog.shouldTrip`
(lines 234–235). Defense-in-depth for RC-C; `activeTurnId` is no longer the *only* guard.
- Touch: `ProviderSessionReaper.ts` (~lines 63–73). The shell it already loads exposes both flags
  (`ProjectionSnapshotQuery.ts:1911-1913`). Note (**S7**): these flags are projection-derived —
  fine as defense-in-depth, not claimed as authoritative.

*(Deliberately NOT doing: a server-side refusal to `thread.session.stop` when input is pending —
the escape hatch (S2) and explicit stop must keep working. The fix is to stop the client from
*auto*-escalating, not to forbid a deliberate stop.)*

### Part 2 — Auto-reattach: remove the precheck, reuse the recovery that already exists

**Key correction (F1):** the recovery ladder is **already implemented** at the ProviderService
layer — `resolveRoutableSession({ allowRecovery: true })` (`ProviderService.ts:422-467`) adopts a
live session, else `recoverSessionForThread` resumes from the persisted cursor, else errors — and
`interruptTurn` / `respondToRequest` / `respondToUserInput` already call it. The **only** thing
defeating it is the reactor's projection precheck (`hasSession`, lines 895/918/962) bailing
first. So the fix is to **relax those three prechecks and let the existing recovery run**, then
handle the outcomes — **no new `resolveOrRecoverSessionForRequest` helper, no `ProviderService`
change** (both cut per F1).

The branch that matters is **pending-request presence, not session liveness (S1)** — a *live*
session can have a *cleared* pending map (P1's own cooperative interrupt/Cancel deletes the
requestId from `pendingUserInputs`). So route the adapter's `Unknown pending … request` error
(already detectable via `isUnknownPendingUserInputRequestError` / the approval equivalent) into
continuation, not into a terminal error. Per handler:

1. **interrupt** (`processTurnInterruptRequested`) → drop the precheck. If a live session exists,
   interrupt it. If none exists, treat as a **benign success that settles the turn** so the
   spinner clears — and do **not** resume a subprocess just to no-op it (**S3**). (Interrupting a
   target that's already gone has achieved its goal.) This needs a turn-settling dispatch, not a
   silent return, because the spinner is driven by the still-`running` projection.
2. **user-input / approval answer** → drop the precheck; call the existing
   `respondToUserInput` / `respondToRequest` (which run `resolveRoutableSession(allowRecovery)`).
   - **Answer delivered** (live session still holds the `Deferred`) → done; fixes projection drift
     and any residual post-stop case with zero UX change.
   - **`Unknown pending … request`** (map cleared, or a resumed/fresh session) → **best-effort
     resume-and-continue**: start ONE continuation turn via the existing `thread.turn.start`
     machinery carrying the user's choice (e.g. *"Regarding the earlier question '…', I chose: ….
     Please continue."*), **idempotent per `requestId`** (**S4** — a "continued requestIds" set,
     since `handledTurnStartKeys` keys on turn-start events and won't dedup a redelivered/double-
     submitted answer). To avoid a wasteful resume-then-fail-then-resume double-spawn, check for a
     live session first and skip straight to the continuation turn when none exists.
   - **Provider rejects the continuation** (e.g. dangling `tool_use` after a real crash — the
     UNVERIFIED premise) → the turn-start failure path already appends a provider-failure
     activity; **reword it** to the actionable message below. This is the safe fallback that lets
     us ship the full ladder without depending on the unverifiable premise.
3. **Truly unrecoverable** (no binding / no resume cursor, or the continuation was rejected) →
   an actionable error, not the dead-end: *"The provider session ended and couldn't be recovered
   — start a new turn to continue."*

**S6 ordering fix (small, server):** when a graceful stop tears down the subprocess while a
question is pending, ensure the abort's `deny` tool result is flushed to the SDK transcript
**before** the subprocess is killed, so graceful-stop resumes are reliably clean (only true
SIGKILL then dangles). Touch: `ClaudeAdapter.ts` `stopSessionInternal` teardown ordering
(sequence the abort/deny drain before `query.close()`/fiber interrupt). *If this proves
intrusive it can drop to a follow-up, since the rung-2 fallback already covers a dangling
transcript — but it's cheap and removes the most common dangling source.*

Each rung is independently valuable and testable. P1+P1b remove the dominant trigger; P2 covers
the reaper edge; relaxing the precheck (rung 1) closes projection-drift; the continuation
(rung 2) covers double-press and restart, best-effort with a safe fallback.

## Files / modules touched (revised — leaner than the first draft)

- `apps/web/src/components/ChatView.logic.ts` — pending-input carve-out in `shouldHardStopAfterGrace`.
- `apps/web/src/components/ChatView.tsx` — press-time pending state into `onInterrupt`; keep the
  escalation-ref for the double-press hatch; wire the separate Cancel handler.
- `apps/web/src/components/chat/ComposerPrimaryActions.tsx` — distinct `onCancelQuestion` for the
  "Cancel question" button.
- `apps/server/src/provider/Layers/ProviderSessionReaper.ts` — pending-input skip.
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` — relax the 3 prechecks;
  interrupt-settles-turn; continuation-turn on `Unknown pending … request` (idempotent per
  requestId); reworded unrecoverable error. **No new helper.**
- `apps/server/src/provider/Layers/ClaudeAdapter.ts` — S6 teardown ordering (deny flush before kill).
- Tests alongside each: reaper unit (skip on pending), reactor handler units (drift → deliver;
  cleared-map → one continuation; unrecoverable → reworded), `ChatView.logic` unit (carve-out +
  double-press still hard-stops), browser test (Cancel/Stop during a question does not kill the
  session; answer still delivers).

**Cut from the first draft (per F1/F3/F5):** the `resolveOrRecoverSessionForRequest` helper, the
`ProviderService` "expose recoverSessionForThread" change (already reachable), and a new
decline command/contract.

## Tradeoffs & limitations

- **Restart mid-question can't be *prevented*** — only recovered, best-effort. The recovered turn
  is a *continuation carrying the answer*, not a byte-perfect resumption of the exact tool call;
  the model receives the answer as a new user message. Acceptable and honest.
- **The dangling-`tool_use` outcome is decided by the native binary, not us.** We attempt the
  continuation and fall back to the actionable error on rejection, so we neither depend on nor
  need to pre-verify that behavior. If it turns out the binary heals it (plausible — Claude Code
  continues such sessions in practice), users get seamless continuation for free.
- **P1 keeps force-stop working** via the double-press hatch (S2); a single press can no longer
  *accidentally* kill a waiting session, but a determined user still can.
- **Rung 2's continuation** changes conversation shape slightly vs. a native answer — preferable
  to a dead end, and only reached when the in-memory pending request is already gone.
- **Simplicity note (F5, acknowledged):** rung 2 covers double-press + restart, which were not
  among the three observed occurrences (all RC-B, fixed by P1). It is retained per the approved
  "full ladder now" decision, implemented leanly (no new helper, reuse existing recovery,
  best-effort + fallback) so its cost is bounded.

## Follow-ups deferred (candidates, not committed)

- **UX:** while a question is pending, the composer should present the question as the primary
  affordance and de-emphasize/relabel "working"/Stop, so users stop pressing Stop on a turn
  that is actually waiting on them. (Reduces RC-B at the source.)
- **Refresh `lastSeenAt` while a request is open** so the reaper's idle clock doesn't advance
  during a human wait (belt-and-suspenders with P2).
- **Verify/patch dangling-`tool_use` resume** (the ⚠ premise) as its own change if RC-A
  continuation proves flaky.

## Decisions (approved 2026-07-07)

1. **Cancel vs. Stop semantics → dedicated cooperative decline.** "Cancel question" becomes a
   dedicated action that declines/dismisses the pending question without ever touching the
   session-stop/escalation path. The escalating behavior stays only on the generic Stop button
   (still guarded by P1). Clearest mental model.
2. **Rung 2 scope → full ladder now.** Ship the complete recovery ladder, including
   resume-and-continue after a restart. Gate the dangling-`tool_use` sub-case on verifying the
   ⚠ premise **before** implementing that rung (Hard Rule 8); fork-at-anchor or synthesize the
   missing `tool_result` if a plain resume rejects it.
