# Provider-session pending-input fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop losing the provider session while a turn is parked on an AskUserQuestion (or approval), and auto-recover the session when it is lost, so answering never dead-ends on "No active provider session is bound to this thread."

**Architecture:** Client-side prevention (don't auto-escalate a Stop/Cancel into a session-kill while input is pending; keep a double-press force-stop hatch; a dedicated cooperative "Cancel question"). Server-side resilience (reaper skips pending-input threads; the three request handlers relax their projection precheck and reuse the *existing* `resolveRoutableSession(allowRecovery:true)` recovery; a lost session's answer becomes one idempotent continuation turn; unrecoverable → an actionable error). See design: `docs/design/2026-07-07-provider-session-pending-input-design.md`.

**Tech Stack:** TypeScript, Effect, React; server tests via `bun`/vitest-style `it.effect`, web unit via the project's test runner, browser tests via the project's browser harness.

## Global Constraints

- Each change is TDD: failing test → minimal impl → green → commit.
- Do **not** modify `packages/shared/src/orchestrationTiming.ts::isLatestTurnSettled` (multiple external callers). The pending carve-out lives only in the escalation gate.
- Do **not** add a new orchestration command or contract for "Cancel" — reuse `thread.turn.interrupt`.
- Do **not** add a `resolveOrRecoverSessionForRequest` helper or change `ProviderService` — the recovery already exists via `resolveRoutableSession`; only the reactor prechecks block it.
- Preserve the stop-and-stall-recovery guarantee (commit 82f37451e): a genuinely wedged turn must stay force-stoppable (double-press).
- Reactor error copy for the unrecoverable case, verbatim: `"The provider session ended and couldn't be recovered — start a new turn to continue."`

---

### Task 1: Reaper skips threads with pending user-input / approvals (P2)

**Files:**
- Modify: `apps/server/src/provider/Layers/ProviderSessionReaper.ts` (sweep loop, ~lines 63–73)
- Test: `apps/server/src/provider/Layers/ProviderSessionReaper.test.ts`

**Interfaces:**
- Consumes: `projectionSnapshotQuery.getThreadShellById(threadId)` → shell with `session.activeTurnId`, `hasPendingUserInput`, `hasPendingApprovals`.
- Produces: no new exports; behavior change only.

- [ ] **Step 1: Write the failing test.** In `ProviderSessionReaper.test.ts`, add a case mirroring the existing "skips active turn" test but with `activeTurnId: null` and a shell whose `hasPendingUserInput: true` (idle past threshold). Assert `providerService.stopSession` is **not** called. Add a twin for `hasPendingApprovals: true`.

```ts
it.effect("does not reap a session with a pending user-input request", () =>
  Effect.gen(function* () {
    // binding idle > threshold, projection: activeTurnId null but a question is pending
    const shell = makeShell({ session: { activeTurnId: null }, hasPendingUserInput: true });
    // ...wire stubs as the existing tests do...
    yield* sweepOnce();
    expect(stopSessionCalls).toHaveLength(0);
  }),
);
```

- [ ] **Step 2: Run it, verify it fails** (reaper currently reaps because `activeTurnId` is null and it ignores the pending flags).
Run: the reaper test file. Expected: FAIL (stopSession called once).

- [ ] **Step 3: Implement the skip.** In `sweep`, in the same block that skips on `activeTurnId != null`, add:

```ts
if (thread?.session?.activeTurnId != null) { /* existing skip */ continue; }
if (thread?.hasPendingUserInput === true || thread?.hasPendingApprovals === true) {
  yield* Effect.logDebug("provider.session.reaper.skipped-pending-user-input", {
    threadId: binding.threadId,
    hasPendingUserInput: thread?.hasPendingUserInput ?? false,
    hasPendingApprovals: thread?.hasPendingApprovals ?? false,
    idleDurationMs,
  });
  continue;
}
```
(Confirm the shell field names against `getThreadShellById`'s return type before finalizing.)

- [ ] **Step 4: Run tests, verify green** (both new cases + existing reaper tests).

- [ ] **Step 5: Commit.**
```bash
git add apps/server/src/provider/Layers/ProviderSessionReaper.ts apps/server/src/provider/Layers/ProviderSessionReaper.test.ts
git commit -m "fix(reaper): never reap a session with a pending user-input/approval request"
```

---

### Task 2: Client Stop no longer auto-escalates while input is pending; double-press still force-stops (P1)

**Files:**
- Modify: `apps/web/src/components/ChatView.tsx` (`onInterrupt`, ~lines 3458–3496; add a `hasPendingInputRef`)
- Modify: `apps/web/src/components/ChatView.logic.ts` (`shouldHardStopAfterGrace`, ~line 446)
- Test: `apps/web/src/components/ChatView.logic.test.ts` (or the co-located logic test file)

**Interfaces:**
- Consumes: in `ChatView.tsx`, `activePendingUserInput` (~line 1617), `activePendingApproval` (~line 1746), `interruptEscalatedThreadRef`, `interruptEscalationTimerRef`, `nextStopAction`, `dispatchHardStop`, `clearInterruptEscalation`.
- Produces: `shouldHardStopAfterGrace` gains an optional `hasPendingInput` param (default false) that forces `false` when true.

- [ ] **Step 1: Write the failing logic test.** In the logic test file:

```ts
it("does not hard-stop after grace when input is pending", () => {
  expect(
    shouldHardStopAfterGrace({
      threadId: "t1", escalatedThreadId: "t1", latestTurnSettled: false, hasPendingInput: true,
    }),
  ).toBe(false);
});

it("still hard-stops after grace when no input is pending (wedged turn)", () => {
  expect(
    shouldHardStopAfterGrace({
      threadId: "t1", escalatedThreadId: "t1", latestTurnSettled: false, hasPendingInput: false,
    }),
  ).toBe(true);
});
```

- [ ] **Step 2: Run it, verify it fails** (param not accepted / ignored).

- [ ] **Step 3: Implement the carve-out** in `ChatView.logic.ts`:

```ts
export function shouldHardStopAfterGrace(input: {
  readonly threadId: string;
  readonly escalatedThreadId: string | null;
  readonly latestTurnSettled: boolean;
  readonly hasPendingInput?: boolean;
}): boolean {
  if (input.hasPendingInput === true) return false;
  return input.escalatedThreadId === input.threadId && !input.latestTurnSettled;
}
```

- [ ] **Step 4: Wire press-time gating in `ChatView.tsx` `onInterrupt`.** Add near the other refs a `hasPendingInputRef` updated each render (mirror `latestTurnSettledRef` at ~line 1185):

```ts
const hasPendingInputRef = useRef(false);
// near line 1185:
hasPendingInputRef.current = activePendingUserInput !== null || activePendingApproval !== null;
```
Then in `onInterrupt`, keep the double-press hatch but only arm the timer when NOT pending, and pass the flag into the gate:

```ts
// after the hardStop early-return block, keep setting the ref (enables double-press hardStop):
interruptEscalatedThreadRef.current = threadId;
const pendingAtPress = activePendingUserInput !== null || activePendingApproval !== null;
if (!pendingAtPress) {
  interruptEscalationTimerRef.current = setTimeout(() => {
    interruptEscalationTimerRef.current = null;
    const escalate = shouldHardStopAfterGrace({
      threadId,
      escalatedThreadId: interruptEscalatedThreadRef.current,
      latestTurnSettled: latestTurnSettledRef.current,
      hasPendingInput: hasPendingInputRef.current, // race: question arrives during grace
    });
    interruptEscalatedThreadRef.current = null;
    if (escalate) dispatchHardStop(threadId);
  }, INTERRUPT_ESCALATION_MS);
}
await api.orchestration.dispatchCommand({ type: "thread.turn.interrupt", /* …unchanged… */ });
```
(Note: the ref is still set when pending, so a *second* Stop press hits `nextStopAction → "hardStop"` — the S2 escape hatch.)

- [ ] **Step 5: Run logic tests + typecheck the web app.** Expected: PASS.

- [ ] **Step 6: Commit.**
```bash
git add apps/web/src/components/ChatView.logic.ts apps/web/src/components/ChatView.tsx apps/web/src/components/ChatView.logic.test.ts
git commit -m "fix(chat): don't auto-escalate Stop into a session-kill while input is pending; keep double-press force-stop"
```

---

### Task 3: Dedicated cooperative "Cancel question" (P1b)

**Files:**
- Modify: `apps/web/src/components/chat/ComposerPrimaryActions.tsx` (the "Cancel question" button, ~lines 143–158)
- Modify: `apps/web/src/components/ChatView.tsx` (add `onCancelQuestion`, pass to the composer)
- Test: `apps/web/src/components/chat/ComposerPendingUserInputPanel.test.tsx` or the ComposerPrimaryActions test (assert Cancel calls the cancel handler, not the escalating interrupt)

**Interfaces:**
- Consumes: `ComposerPrimaryActions` currently takes `onInterrupt`.
- Produces: `ComposerPrimaryActions` takes a new `onCancelQuestion: () => void`; the "Cancel question" button (aria-label "Cancel question") calls it; "Stop generation" keeps `onInterrupt`.

- [ ] **Step 1: Write the failing test.** Assert that clicking the "Cancel question" button invokes `onCancelQuestion` and NOT `onInterrupt`.

```tsx
const onInterrupt = vi.fn();
const onCancelQuestion = vi.fn();
render(<ComposerPrimaryActions {...baseProps} onInterrupt={onInterrupt} onCancelQuestion={onCancelQuestion} />);
await userEvent.click(screen.getByLabelText("Cancel question"));
expect(onCancelQuestion).toHaveBeenCalledTimes(1);
expect(onInterrupt).not.toHaveBeenCalled();
```

- [ ] **Step 2: Run it, verify it fails** (prop doesn't exist; Cancel still calls onInterrupt).

- [ ] **Step 3: Implement.** Add the `onCancelQuestion` prop to `ComposerPrimaryActionsProps`; point the "Cancel question" button's `onClick` at it (leave "Stop generation" on `onInterrupt`). In `ChatView.tsx`, add:

```ts
const onCancelQuestion = async () => {
  const api = readEnvironmentApi(environmentId);
  if (!api || !activeThread) return;
  // Cooperative decline only — never touch the escalation ref/timer.
  await api.orchestration.dispatchCommand({
    type: "thread.turn.interrupt",
    commandId: newCommandId(),
    threadId: activeThread.id,
    createdAt: new Date().toISOString(),
  });
};
```
Pass `onCancelQuestion` down to `ComposerPrimaryActions` wherever `onInterrupt` is currently passed.

- [ ] **Step 4: Run the component test + web typecheck.** Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add apps/web/src/components/chat/ComposerPrimaryActions.tsx apps/web/src/components/ChatView.tsx apps/web/src/components/chat/*.test.tsx
git commit -m "feat(chat): make 'Cancel question' a dedicated cooperative decline (no escalation)"
```

---

### Task 4: Reactor — relax the three prechecks; interrupt-with-no-session settles the turn (Rung 1 + S3)

**Files:**
- Modify: `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` (`processTurnInterruptRequested` ~888, `processApprovalResponseRequested` ~911, `processUserInputResponseRequested` ~954)
- Test: `apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts` (or the reactor's existing test file)

**Interfaces:**
- Consumes: `providerService.listSessions()` (live sessions), `providerService.interruptTurn`, `respondToRequest`, `respondToUserInput`; `setThreadSession` / a turn-settling dispatch.
- Produces: no new exports.

- [ ] **Step 1: Write failing tests.**
  - (a) *projection drift:* projection `session.status === "stopped"` but a **live** session exists (stub `listSessions` to return one) → `processUserInputResponseRequested` calls `providerService.respondToUserInput` (answer delivered) and does NOT append the "No active provider session" failure.
  - (b) *interrupt with no session:* no live session, projection stopped → `processTurnInterruptRequested` does NOT append the old error; instead it settles the turn (assert a `thread.session.set`/turn-settling dispatch clearing `activeTurnId` so the spinner clears) and does NOT call `startSession`/resume.

- [ ] **Step 2: Run, verify they fail** (current code appends the error via the `hasSession` gate).

- [ ] **Step 3: Implement.** In each of the three handlers, remove the early `hasSession` fail. For **interrupt**: if a live session exists (`listSessions().some(s => s.threadId === threadId)`) call `providerService.interruptTurn`; otherwise settle the turn (dispatch a `thread.session.set` with `status: thread.session?.status ?? "stopped"` and `activeTurnId: null`) — do not resume a subprocess. For **approval** and **user-input**: call the existing `respondToRequest` / `respondToUserInput` (they already run `resolveRoutableSession(allowRecovery:true)`), keeping the existing `catchCause` (Task 5 extends it).

- [ ] **Step 4: Run tests, verify green** (new + existing reactor tests).

- [ ] **Step 5: Commit.**
```bash
git add apps/server/src/orchestration/Layers/ProviderCommandReactor.ts apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts
git commit -m "fix(reactor): recover instead of hard-failing on a stale/stopped session projection; interrupt-with-no-session settles the turn"
```

---

### Task 5: Reactor — lost-session answer becomes one idempotent continuation turn; actionable unrecoverable error (Rung 2 + S1 + S4)

**Files:**
- Modify: `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` (`processUserInputResponseRequested`, `processApprovalResponseRequested`; add a `continuedRequestIds` guard near `handledTurnStartKeys` ~219)
- Test: same reactor test file

**Interfaces:**
- Consumes: `isUnknownPendingUserInputRequestError` (~line 168) and the approval equivalent; the existing turn-start dispatch path (`orchestrationEngine.dispatch({ type: "thread.turn.start", … })`); `thread.modelSelection`, `runtimeMode`, `interactionMode` from the resolved thread.
- Produces: `continuedRequestIds: Set<string>` (or a bounded `Cache`) — dedups continuation per pending `requestId`.

- [ ] **Step 1: Write failing tests.**
  - (a) *cleared map → continuation:* `respondToUserInput` rejects with `Unknown pending user-input request` → exactly ONE `thread.turn.start` is dispatched whose message text contains the user's chosen answer; a second identical `user-input-response-requested` for the same `requestId` dispatches NO further turn.
  - (b) *unrecoverable → reworded error:* `resolveRoutableSession` fails (no binding) → the appended failure activity's detail equals the verbatim constant, not the old string.

- [ ] **Step 2: Run, verify they fail.**

- [ ] **Step 3: Implement.** Extend the `catchCause` in `processUserInputResponseRequested`:
  - If `isUnknownPendingUserInputRequestError(cause)` and `!continuedRequestIds.has(requestId)`: add the id, then dispatch a continuation `thread.turn.start` with `message.text` = `Regarding the earlier question, I chose: ${formatAnswers(event.payload.answers)}. Please continue.` (use a stable synthetic `messageId` = `user:pending-input-continue:${requestId}`), carrying the thread's `modelSelection`/`runtimeMode`/`interactionMode`.
  - Else (unrecoverable / already-continued rejection): append the failure activity with the verbatim actionable detail.
  Apply the analogous branch to `processApprovalResponseRequested` (continuation text summarizing the decision). Keep the continuation dispatch itself inside a `catchCause` so a provider rejection (dangling `tool_use`) also lands on the reworded error rather than throwing.

- [ ] **Step 4: Run tests, verify green.**

- [ ] **Step 5: Commit.**
```bash
git add apps/server/src/orchestration/Layers/ProviderCommandReactor.ts apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts
git commit -m "fix(reactor): resume-and-continue a lost session's answer as one idempotent turn; actionable unrecoverable error"
```

---

### Task 6: ClaudeAdapter — flush the abort deny before subprocess teardown (S6)

**Files:**
- Modify: `apps/server/src/provider/Layers/ClaudeAdapter.ts` (`stopSessionInternal`, ~lines 2850–2915)
- Test: `apps/server/src/provider/Layers/ClaudeAdapter.test.ts` (if a unit seam exists) or cover via the reactor/integration test

**Interfaces:**
- Consumes: the pending-user-input abort path (`onAbort` at ~3098 resolves the deferred + returns `deny`); `context.query.close()`.
- Produces: no new exports; ordering change only.

- [ ] **Step 1: Write the failing/assertion test** if a seam exists: stopping a session with a pending user-input request emits the `deny`/`user-input.resolved` (or `request.resolved`) event BEFORE `session.exited`. If no clean unit seam, document that this is covered by the browser test in Task 7 and skip to Step 3.

- [ ] **Step 2: Run it, verify it fails / observe current ordering.**

- [ ] **Step 3: Implement.** In `stopSessionInternal`, before `Queue.shutdown`/`query.close()`, drain pending user-inputs the way pending approvals are drained (~line 2859): for each pending user-input, fire its abort/`deny` resolution so the SDK writes the tool_result, then proceed with `close()`. Keep it bounded (no unbounded await) to preserve the stop-can't-wedge guarantee.

- [ ] **Step 4: Run tests, verify green.**

- [ ] **Step 5: Commit.**
```bash
git add apps/server/src/provider/Layers/ClaudeAdapter.ts
git commit -m "fix(claude-adapter): flush pending user-input deny before subprocess teardown so graceful-stop resumes are clean"
```

---

### Task 7: Browser regression test — Cancel/Stop during a question doesn't kill the session

**Files:**
- Create/Modify: a browser test under `apps/web/src/components/` (follow the existing `ChatView.browser.tsx` patterns)

**Interfaces:**
- Consumes: the browser harness's ability to drive a thread with a pending user-input request.

- [ ] **Step 1: Write the test.** Drive a thread into a pending-user-input state; click "Cancel question" → assert NO `thread.session.stop` command is dispatched (only `thread.turn.interrupt`). Separately: click "Stop generation" once → assert no `thread.session.stop` within the escalation window; then submit an answer → assert it is dispatched and not rejected with the "No active provider session" activity.

- [ ] **Step 2: Run it, verify it fails on `main`/pre-fix behavior if run before the earlier tasks; PASS after.**

- [ ] **Step 3: Commit.**
```bash
git add apps/web/src/components/*.browser.tsx
git commit -m "test(chat): Cancel/Stop during a pending question must not kill the provider session"
```

---

## Self-Review

- **Spec coverage:** P1 → Task 2; P1b → Task 3; P2 → Task 1; Rung 1 + interrupt-settle → Task 4; Rung 2 continuation + idempotency + reworded error → Task 5; S6 → Task 6; regression → Task 7. Both user asks (prevent loss; auto-reattach) are covered.
- **Placeholders:** test bodies and key logic are concrete; where exact surrounding code must be matched (shell field names, composer prop plumbing), the step says to confirm against the file — appropriate for subagent-driven execution where each implementer reads the file.
- **Type consistency:** `shouldHardStopAfterGrace`'s new optional `hasPendingInput` is used consistently (logic + `onInterrupt` timer). `continuedRequestIds` keyed by `requestId` matches the idempotency intent. Reactor reuses existing `respondToUserInput`/`respondToRequest`/`interruptTurn` — no renamed symbols.
- **Constraints honored:** no `isLatestTurnSettled` change; no new command; no new reactor helper; no `ProviderService` change; double-press hatch preserved.
