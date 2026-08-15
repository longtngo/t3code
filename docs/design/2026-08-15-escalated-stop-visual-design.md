# Make the escalated (second-press) Stop visually distinct — design

**Date:** 2026-08-15
**Branch:** `feat/escalated-stop-visual`

## Goal

When the Stop escalation ladder is armed — a first cooperative interrupt has been sent and the
turn is still running — the Stop button must *look* like a different action, because the next
press is a destructive force-stop that also resumes the thread.

Today the two rungs render identically: same square icon, same `aria-label="Stop generation"`,
same styling. Two consequences, and the second is the one that matters:

1. **Undiscoverable.** Nothing suggests a second press does more, so the escape hatch only helps
   someone who already knows it exists.
2. **Triggerable by accident.** The natural reaction to a button that appears to do nothing is to
   click it again. That second click kills the provider session and asks the watchdog to resume —
   a much heavier action than the user asked for, and for a merely *slow* turn it preempts the
   cooperative interrupt that was about to land.

## Premises validated (Hard Rule 8)

| Premise | Probe | Result |
|---|---|---|
| The armed state is not reactive | `ChatView.tsx:1317` — `useRef<string \| null>(null)` | ✅ a ref; writing it re-renders nothing |
| The button cannot see the state today | full read of `ComposerPrimaryActionsProps` | ✅ no escalation prop exists; the component *could not* reflect it |
| The clear-on-settle site can call `setState` | `ChatView.tsx:1570-1576` — inside a `useEffect` | ✅ not a render-body write |
| Both Stop render paths share one handler | `renderStopGenerationButton(true)` in the pending row, `(false)` beside Send; both `onClick={onInterrupt}` | ✅ one flag covers both |
| Cancel is already off the ladder | `onClick={onCancelQuestion}`, a separate required prop | ✅ unchanged by this work |

## Approach

**1. Make the armed state renderable without changing the decision's timing.**

Keep `escalatedStopThreadIdRef` as the **authority the handler reads**, and add a `useState`
mirror that exists only to drive rendering. Both are written through a single helper, so they
cannot drift:

```ts
const armStopEscalation = (threadId: string | null) => {
  escalatedStopThreadIdRef.current = threadId;
  setEscalatedStopThreadId(threadId);
};
```

The ref is retained deliberately rather than replaced. The scenario this feature exists for is an
impatient **double-click**, and a ref is updated synchronously within the first click's handler
while a state value is only visible to the second click if React has re-rendered in between.
Reading state would make a tested, timing-independent decision depend on render scheduling. One
writer keeps the two in step; a comment says so at the declaration.

**2. Derive the flag and thread it to the button.**

`isStopEscalated = activeThread !== null && escalatedStopThreadId === activeThread.id`, passed
ChatView → ChatComposer → ComposerPrimaryActions. Thread-keyed rather than boolean so switching
threads cannot carry an armed state across (the same property `nextStopAction` already relies on).

**3. Render the escalated rung as a different control.**

| | First press (unarmed) | Second press (armed) |
|---|---|---|
| Icon | rounded square | octagon + X (`OctagonXIcon`) |
| Fill | `bg-destructive/90` | `bg-destructive` solid |
| Halo | none | `ring-2 ring-destructive/40 ring-offset-1` |
| `aria-label` | `Stop generation` | `Force stop — press stops the session` |
| `title` | none | `Press again to force-stop the session and recover the thread` |

The octagon is the load-bearing signal: at a 32px button a fill-opacity shift alone does not read,
and the stop-sign shape is understood without a legend. The halo carries it at a glance.

**No animation.** The house rule against continuously repainting animation applies directly — a
pulsing "armed" indicator is exactly the GPU-pegging pattern the repo bans. The distinction is
static.

**4. Test on an attribute, not a class.** The button gets `data-stop-escalated="true" | "false"`.
Asserting on Tailwind classes is how a previous test in this area passed for the wrong reason
(`toContain("disabled")` matched `disabled:opacity-64`). A dedicated data attribute cannot collide
with a variant prefix, and both the positive and negative case are asserted.

## Alternatives rejected

| Alternative | Why not |
|---|---|
| Replace the ref with state outright | Simpler, but makes the double-click decision depend on React having re-rendered between two clicks — the exact scenario the ladder serves. Not worth the risk for one removed line. |
| A second state variable written at each of the four call sites | Four writers is how the ref and its mirror drift. One helper, one writer. |
| Expire the armed state on a timer so a late second press is cooperative | Real improvement, but it changes *behaviour*, not just its legibility, and needs a number chosen from evidence we do not have. Recorded as a follow-up suggestion, not built. |
| Text label ("Force stop") instead of an icon swap | The control is a 32px circle beside Send; there is no room, and widening it moves the row — the thing `renderStopGenerationButton`'s existing comment is explicitly protecting. |
| Confirmation dialog on the second press | Defeats the purpose: the ladder exists as a fast escape hatch for a wedged turn. The deliberate second press *is* the confirmation. |

## Tradeoffs and limitations

- The armed window still has **no time decay**: it clears on settle, thread change, a fired
  force-stop, or a failed interrupt dispatch, and otherwise persists for as long as the turn runs.
  This change makes that state *visible*, which is the cheap half of the fix; bounding it is the
  deferred half.
- The mirror state adds one re-render per Stop press. Negligible — it is a user-initiated event,
  not a stream path.

## Design review

**6a — pillar sweep: SKIPPED, recorded.** No trigger fires: no service boundary, public API or
event contract, no data model or migration, no new dependency, no deployment/rollout change, and
no personal data, money movement, bulk mutation, or agentic side effect. This is presentation over
state that already exists. (The command contract change that *would* have tripped it shipped in
`6dae9acb6` and was reviewed there.)

**6b — lenses: correctness + simplicity** (always-on). No conditional lens triggers: no API or
config surface (compatibility), no new entry point or data (security/privacy), no new query or hot
path (performance), no new failure-capable path (observability), no new abstraction (evolvability).
Safety is worth a look on paper since the subject is a destructive action — but this change adds no
new way to reach it and only makes the existing one legible, so it is strictly safety-positive.
Standing instruction in this session is not to dispatch subagents, so the lenses were run inline;
recording the deviation rather than silently skipping the stage.

Findings applied:

1. **Correctness** — a boolean flag would leak across threads on a fast thread switch, since the
   button is memoized and the ledger is thread-keyed. Compare against `activeThread.id` and derive
   per render instead. *(Applied — the flag is a comparison, not stored.)*
2. **Correctness** — the pending-question row renders its own Stop via
   `renderStopGenerationButton(true)`. Missing it would leave a second, unmarked entry to the same
   ladder. *(Applied — the flag is read inside `renderStopGenerationButton`, so both call sites get
   it from one place.)*
3. **Simplicity** — challenged keeping both a ref and a state. Kept, with the double-click
   rationale written at the declaration; the alternative changes the timing of a decision that is
   currently timing-independent.
4. **Simplicity** — dropped a proposed `escalationArmedAt` timestamp. It is only useful for the
   decay behaviour, which is deliberately not in this change; storing it now would be dead state.

Round 2 re-ran correctness only (its findings were applied; no other dimension was edited) and
produced only repeats. **Exit: quiescent.**

## Files touched (planned)

- `apps/web/src/components/ChatView.tsx` — mirror state + `armStopEscalation` helper + derived flag
- `apps/web/src/components/chat/ChatComposer.tsx` — thread `isStopEscalated` through both prop
  interfaces and all four render sites
- `apps/web/src/components/chat/ComposerPrimaryActions.tsx` — escalated rendering of the Stop button
- `apps/web/src/components/chat/ComposerPrimaryActions.test.tsx` — armed and unarmed cases

## Follow-ups deferred

- **Bound the armed window with a timer** so a press now and a press half an hour later are not the
  same gesture. Behaviour change; wants evidence that accidental escalation happens in practice.
