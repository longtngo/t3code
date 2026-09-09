# Collapsed composer: show the context gauge, hide an idle Send

## Goal

When the composer is collapsed, the context gauge (the vitals glyph whose primary arc is context
fullness) should stay visible, and the Send button should appear only when there is something to
send. Two collapsed layouts exist on web: the desktop resting layout (a scrolled timeline shrinks
the composer to one line with its actions overlaid bottom-right) and the phone's one-line row.

### Baseline (Stage 1b, taken on `3431b7edf`)

| Metric                        | Command                                                                                            | Before                        |
| ----------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------- |
| `send-hidden-when-idle`       | `cd apps/web && vp test run src/components/chat/ComposerPrimaryActions.dom.test.tsx --project dom` | `2 failed, 25 passed`         |
| `resting-gauge-gate-removed`  | `grep -c showSecondaryStatus apps/web/src/components/chat/ChatComposer.tsx`                        | `4` (target `0`)              |
| `phone-collapsed-send-hidden` | unmeasurable                                                                                       | inline in a 9k-line component |
| verify gate (floor)           | `pnpm verify` on `3431b7edf`                                                                       | 14/14 green, 16,459 passed    |

## What the code does now

- **Desktop resting layout.** `ComposerFooterPrimaryActions` is rendered with
  `showSecondaryStatus={!isComposerResting}` (`ChatComposer.tsx:6346`), which hides the
  `VitalsGaugeConnected` glyph exactly when the composer rests. Upstream removed that gate in
  #9430 ("show context meter in compact composer", `f559fe0ba`) and widened the resting editor's
  right padding to `pr-28` to make room; the fork's reconcile kept the padding
  (`ChatComposer.tsx:6122-6127`) but re-applied the gate because the fork's gauge had replaced
  upstream's `ContextWindowMeter`. So the resting composer reserves the space and draws nothing.
- **Send when idle.** `ComposerPrimaryActions` always renders the Send button and disables it
  when `hasSendableContent` is false. In a collapsed layout that leaves a greyed 32px circle as
  the only control.
- **Phone collapsed row.** Renders the gauge already (`ChatComposer.tsx:5631`), plus Stop while
  running and a Send button disabled when there is nothing to send (`:5666-5686`).

## Approach

1. Drop `showSecondaryStatus` (three sites, mirroring upstream #9430): the gauge and the
   "Preparing worktree..." note render in every footer layout. Preparing a worktree already
   counts as expanded chrome (`composerHasExpandedChrome`), so it never coincides with resting.
2. `ComposerPrimaryActions` gains `hideIdleSend?: boolean`. When true and
   `!hasSendableContent && !isSendBusy`, the Send button is omitted in the default branch and in
   the running branch (Stop stays). The pending-question and plan-follow-up branches are
   untouched: their primary action is not Send. `ComposerFooterPrimaryActions` passes
   `hideIdleSend={isComposerResting}`.
3. The phone collapsed row renders its Send button only when
   `isSendBusy || composerSendState.hasSendableContent`. (A pending question never reaches this
   row: `showCollapsedMobilePromptRow` requires no pending user inputs, so an
   `activePendingProgress` guard would be dead code.) The row's collapse/expand transition
   marker moves from the Send button to the action cluster so the slide still has a target
   when Send is absent.
4. The resting editor's right padding keys on what the overlay actually renders, not on the
   context-meter setting: `showComposerAttachAction ? "pr-28" : "pr-20"`. The fork's gauge
   mounts whether or not a context snapshot exists (upstream's `ContextWindowMeter` did not),
   so the old `settings.contextWindowMeterEnabled && activeContextWindow` arm let draft text
   run under the gauge by ~29px.

## Alternatives considered

- **Keep the gate and add a resting-only gauge.** Duplicates the gauge mount; upstream's own
  fix is the gate's removal. Rejected.
- **Hide Send everywhere when empty.** In the expanded composer the disabled Send is the "type
  here" affordance and the request scoped the change to the collapsed layouts. Rejected.
- **Hide Send only on desktop resting.** Leaves the phone row with a dead grey button beside a
  live gauge, which is the same complaint on the surface the user reads most. Rejected;
  the phone rule is guarded so a pending answer keeps its submit.

## Files touched

- `apps/web/src/components/chat/ComposerPrimaryActions.tsx` — `hideIdleSend`.
- `apps/web/src/components/chat/ComposerPrimaryActions.dom.test.tsx` — three cases (written for
  the baseline).
- `apps/web/src/components/chat/ChatComposer.tsx` — gate removed; `hideIdleSend` wired; phone
  row's Send conditional.

## Invariant (Hard Rule 12)

Property: a collapsed composer shows Send only with sendable content. Sites: desktop resting
(`ComposerPrimaryActions` via `hideIdleSend`), phone collapsed row (inline). Consumers of the
Send button's presence: none read it (keyboard Enter submits through the form, not the button).
Not in scope: the expanded footer, mobile (React Native) which has its own composer and already
disables rather than hides.

## Tradeoffs and limitations

- The resting editor's padding does not shrink when Send is hidden; an extra 32px of right
  padding on an empty resting prompt is invisible in practice and avoids a third branch.
- Running with a typed follow-up in the resting overlay (Stop + Send + gauge + attach) overflows
  the padding by about 35px. Pre-existing without the gauge (the no-context arm already
  overflowed); typing lifts the resting layout, so the state is transient. Not addressed here.
- No screenshots: the user did not ask for browser verification.

## Review exit note

6a skipped: UI-only, no contract or boundary change. 6b: one round, Correctness + Simplicity in
one reviewer that implemented all three changes in a detached worktree and ran the tests,
apps/web typecheck, lint and fmt (red-then-green on the baseline cases). Findings: the resting
padding arm keyed on the context-meter setting was wrong for the fork's always-mounted gauge
(must-fix, applied as item 4); the phone `activePendingProgress` guard was dead (applied); the
phone transition marker should move to the cluster (applied); the `hideIdleSend` prop beats
keying on `compact`, with a concrete counterexample (kept). Exit after one round: every applied
finding was an edit to code the reviewer had built and run.
