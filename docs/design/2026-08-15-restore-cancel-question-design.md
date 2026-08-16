# Restore Cancel on the ask-question panel — design

**Date:** 2026-08-15
**Branch:** `feat/restore-cancel-question`

## Goal

Give the user a way to **decline a pending AskUserQuestion** instead of being forced to answer it.
The composer's pending-action row currently offers Stop (only while running), Previous (only past
the first question) and Submit/Next — there is no "I don't want to answer this" action.

## This is a real regression, and where it went

The fork shipped it in `00bd3b28f` ("cap ask-question options height + add Cancel button",
2026-06-05) and refined it in `f8e28104d`, which gave it a dedicated `onCancelQuestion` prop
described as a _"dedicated cooperative decline for a pending question — never escalates to a hard
stop."_

It was lost in upstream `c5ff51ec1` ("feat(web): refresh application surfaces", 2026-07-22), a
broad UI refresh that rewrote `ComposerPrimaryActions.tsx` wholesale. The reconcile that brought
that commit in did not notice, and this predates the two-way sweeps now run by
`reconcile-upstream-drift`.

Worth stating plainly: **the 101-commit reconcile earlier today is not the cause.** The Cancel
string was already absent at `d6994a22b~1`. `git log -S` did not surface the loss either, because
it skips merge commits by default — the file's history had to be walked blob-by-blob.

## Premises validated before designing (Hard Rule 8)

| Premise                                                                         | Probe                                                                                                                                                                                                                                           | Result |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `thread.turn.interrupt` still exists as a command                               | `packages/contracts/src/orchestration.ts:1051`                                                                                                                                                                                                  | ✅     |
| Interrupting **settles** a pending AskUserQuestion rather than leaving it stuck | `ClaudeAdapter.ts:4059-4065` registers an `abort` listener running `settleAsAborted`, commented _"turn interrupted while waiting for user input"_                                                                                               | ✅     |
| Today's Stop does **not** escalate to killing the provider session              | `ChatView.onInterrupt` → `interruptThreadTurn(buildThreadTurnInterruptInput(...))`, which carries only `threadId`/`turnId`; `thread.session-stop-requested` is emitted only from the separate `thread.session.stop` command (`decider.ts:1231`) | ✅     |

That third one is the load-bearing change since the feature was written, and it drives the design
below.

## Approach

**Re-add the Cancel control to the pending-action row, wired to the existing `onInterrupt`.**

- Compact: an icon button (`XIcon`), `aria-label="Cancel question"`.
- Full: a `Cancel` text button.
- Placed between Previous and Submit, matching the original layout.
- Disabled while `pendingAction.isResponding`, like its neighbours.

**Deliberately NOT re-adding the dedicated `onCancelQuestion` prop.** Its entire purpose was to
avoid arming a hard-stop escalation — and that escalation no longer exists on this path: the
composer's Stop is itself a plain cooperative interrupt, and session-killing now lives behind a
separate `thread.session.stop` command. Re-threading a prop through
`ComposerPrimaryActions → ChatComposer → ChatView` to reach the _same_ dispatch would be
indirection whose justification has expired.

**The guard is kept as a written tripwire instead of a prop.** A comment at the call site records
the history (`f4af9398e` fixed a real bug where cancelling killed the provider session) and states
the condition under which the distinction must come back: _if the composer's Stop ever regains
escalation, Cancel must split onto its own non-escalating path again._

## Alternatives rejected

| Alternative                                                       | Why not                                                                                                                                                                                          |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Restore the dedicated `onCancelQuestion` prop verbatim            | Three layers of prop threading to reach the identical dispatch. The semantic distinction it encoded no longer exists on this path; a comment carries the knowledge at a fraction of the surface. |
| Reuse the existing Stop button and add nothing                    | Stop is only rendered `isRunning`, and reads as "stop generating", not "decline this question". A question can be pending in states where no Stop is shown, leaving no exit at all.              |
| Put Cancel in the panel (`ComposerPendingUserInputPanel`) instead | The action row is where every other question action lives (Previous / Submit / Next). Splitting them across two surfaces is worse for both discoverability and keyboard order.                   |
| Answer-with-empty instead of interrupting                         | The runtime already models this: the abort path settles the request. Inventing a second "empty answer" resolution would create two ways to end a question, with different server-side effects.   |

## Tradeoffs and limitations

- Cancel interrupts the **turn**, not just the question. That is what the original did and what the
  runtime supports; the agent stops rather than continuing without an answer. The button is
  labelled for the question because that is the user's intent at that moment.
- Because it shares `onInterrupt`, a future change to Stop's semantics silently changes Cancel.
  That is the tripwire above, and it is why a test asserts the two share the cooperative path.

## Files touched

- `apps/web/src/components/chat/ComposerPrimaryActions.tsx` — the control.
- `apps/web/src/components/chat/ComposerPrimaryActions.test.tsx` — coverage.

## Design review

**6a (pillar sweep): skipped.** No trigger fires — no service boundary, API or event contract
change (the command already exists and is already dispatched by Stop), no data model or migration,
no new dependency, no deployment change, and no personal data, money movement, or bulk mutation.
The change renders one more button onto an existing dispatch.

**6b lenses: correctness + simplicity**, plus **safety** — the button ends a running turn, which is
a destructive-ish action, so that trigger genuinely fires. Round 1 findings, all applied:

| #   | Lens        | Finding                                                                    | Resolution                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ----------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Safety      | Cancel ends the turn. Is it gated?                                         | It sits beside Submit and can be hit by accident. Mitigated the cheap way: disabled while `isResponding`, and it is an icon-only button in compact mode matching the original. Not adding a confirm — the action is recoverable (the user can send a new message) and a confirm on a decline is friction the original deliberately avoided. Recorded rather than silently skipped. |
| 2   | Correctness | If the turn is _not_ running, does interrupting still settle the question? | Yes — the abort listener is registered when the request is created, not per-turn-state, and `interruptThreadTurn` omits `turnId` when no turn is running. Covered by a test that Cancel renders regardless of `isRunning`.                                                                                                                                                         |
| 3   | Simplicity  | Does this need the old prop back?                                          | No — see Approach. This is the finding that shaped the design.                                                                                                                                                                                                                                                                                                                     |

Round 2 produced only repeats (no lens's dimension changed after applying — the edits were the
button and its comment). Exit reason: quiescence after one substantive round.

## Found during implementation: a test that passed for the wrong reason

The "disabled while responding" test originally asserted
`expect(openingTag).toContain("disabled")`. That passes **unconditionally**: the shared `Button`'s
class list carries Tailwind variants like `disabled:pointer-events-none disabled:opacity-64`, so
the substring is present whatever the component does.

It was only exposed by adding the **negative** half (`isResponding: false` must _not_ be disabled),
which failed immediately. Both halves now assert on the rendered attribute `disabled=""` instead of
the substring.

Generalisable: on a Tailwind codebase, never assert a boolean HTML attribute by substring — the
utility classes are named after the very states being asserted. The negative case is what makes the
positive one trustworthy.

## Follow-ups deferred

None.
