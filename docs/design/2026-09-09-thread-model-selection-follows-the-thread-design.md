# A thread's model selection follows the thread across devices

## Goal

Pick a model on one device and send; every other device looking at the same thread should show
that model. Today a device that once picked a model for a thread keeps showing its own pick
forever, even after another device moved the thread to a different instance.

The consequence is not only cosmetic. On 2026-09-07 01:17 (thread `c2431922…`) a "Stop" sent
mid-turn from a device whose picker still said `claudeAgent` while the thread ran on
`claudeAgent_personalsub` was refused with "stop it before switching", flipped the session to
`error` with `activeTurnId: null`, and the message was never delivered.

### Baseline (Stage 1b, taken on `324b28683`)

| Metric                       | Command                                                                                   | Before                     |
| ---------------------------- | ----------------------------------------------------------------------------------------- | -------------------------- |
| `web-adopt-thread-selection` | `cd apps/web && vp test run src/composerDraftStore.test.ts --project unit`                | `5 failed, 106 passed`     |
| `mid-turn-switch-refusals`   | count of `thread.session-set` events carrying "stop it before switching" + status `error` | `1` (floor: must not grow) |
| verify gate (floor)          | `pnpm verify` on `324b28683`                                                              | 14/14 green, 16,463 passed |

## What the code does now

The thread record already travels to every device, but it is written by the SENDING client, not
by the server on acceptance. A send whose selection differs from the thread's first issues
`thread.meta.update` (`ChatView.tsx` `persistThreadSettingsForNextTurn` via
`resolveThreadMetadataUpdateForNextTurn`; mobile `use-thread-outbox-drain.ts:700-707`) and only
then `turn.start`. The client reducer also copies `turn-start-requested.modelSelection` into the
detail (`packages/client-runtime/src/state/threadReducer.ts:283-289`); the server projection
pipeline does not. So `thread.modelSelection` is intent, and it can be wrong: on the incident
thread, event `2811885` (meta-updated → `claudeAgent`) landed 69 ms before the refusal
`2811888`, leaving the record on the refused instance while the session stayed bound to
`claudeAgent_personalsub`. The instance actually running is `session.providerInstanceId`.

Both clients then outrank it with a local pick:

- **Web.** `resolveComposerProviderSelection` (`apps/web/src/components/ChatView.logic.ts:403`)
  takes the first candidate of `[draft.activeProvider, session.providerInstanceId,
thread.modelSelection.instanceId, project default]`, and
  `deriveEffectiveComposerModelState` (`apps/web/src/composerDraftStore.ts:1156`) reads the model
  from `draft.modelSelectionByProvider[instance]` before the thread's. A picker click writes
  both with `modelSelectionExplicit: true` (`ChatView.tsx:8559`); the traits picker writes the
  same fields through `setProviderModelOptions` (`TraitsPicker.tsx:310`,
  `composerDraftStore.ts:3195`). Sending clears only the prompt and images
  (`clearComposerContent` via `ChatView.tsx:7204`); the pick persists in localStorage for the
  thread's life.
- **Mobile.** `selectedDraft?.modelSelection ?? selectedThread?.modelSelection`
  (`apps/mobile/src/state/use-thread-composer-state.ts:253`). Sending calls
  `clearComposerDraftContent`, which retains `modelSelection`
  (`use-composer-drafts.ts:1043-1071`), so a mobile pick outlives the send exactly like web.

Nothing compares the local pick with the thread selection it was made against.

## Approach

**Rule:** a local pick is an intent made against the thread's selection at that moment. When the
thread's selection moves (a turn started anywhere with a different selection), the pick has been
superseded and is dropped; the composer then shows the thread's selection through the existing
fallback order. A pick made against the current selection is kept.

**Basis.** Each pick records the thread selection it was made against. Web:
`modelSelectionBasis?: ModelSelection` on the persisted thread draft, written by BOTH picker
call sites (`setModelSelection` and `setProviderModelOptions` gain a `basis` option; the traits
picker receives `activeThreadModelSelection` through `providerTraitsPickerInput`). Web
persistence is hand-enumerated, not schema-driven (`normalizePersistedDraftsByThreadId`,
`partialize`, `toHydratedThreadDraft`), so the field is added at all three sites; the persisted
`Schema` struct is type-only and gets the key for the type. Mobile: `modelSelectionBasis?` on
`ComposerDraft`, written by `onUpdateModelSelection`, retained by
`clearComposerDraftContentState` alongside `modelSelection`, and added to the persisted schema
as `Schema.optional` without bumping `COMPOSER_DRAFTS_SCHEMA_VERSION` (a version mismatch fails
the whole file decode). A pick with no basis (persisted by a build
before this change, or seeded) is treated as superseded the first time it meets a thread
selection it does not match. That costs at most one unsent pick per thread on upgrade, and only
where the pick already disagreed with the thread.

**Adoption.** A new store action `adoptThreadModelSelection(threadRef, threadSelection)` (web) and
an equivalent `adoptThreadModelSelection(draftKey, threadSelection)` (mobile):

- no local pick → no-op (so opening a thread never creates a persisted draft);
- basis equals the thread selection (instance, model, options) → no-op;
- otherwise the pick is superseded. Web OVERWRITES: `activeProvider = threadSelection.instanceId`,
  `modelSelectionByProvider[threadSelection.instanceId] = threadSelection`, `basis` set to it,
  `modelSelectionExplicit` cleared; other instances' remembered models stay. Nulling the pick
  instead was measured to flicker: between `meta-updated` and the new `session-set` the resolver's
  second candidate is the OLD session instance, and the effective selection became the old
  instance with the new model, a pair that never existed. Mobile DELETES `modelSelection` and
  `modelSelectionBasis`; it has no session fallback, so the thread's selection shows directly.
- The store returns the same state object when nothing changes, so the effect below cannot loop.

**Guard.** Because the thread record is intent (above), adoption only runs when the record is
consistent with the running session: `session === null`, or `session.providerInstanceId ===
threadSelection.instanceId`. A refused mid-turn switch leaves the record on the refused instance
with the session elsewhere; that record is never adopted, so it cannot spread a stale instance to
devices whose pick was right. During a successful switch the guard delays adoption by the gap
between `meta-updated` and the final `session-set` (milliseconds); the effect depends on the
session instance too, so it fires when that lands.

**Trigger.** An effect in the composer host keyed on the active server thread's selection
(instance, model, options as a string key), the session instance, and on mobile the draft's own
selection and basis (the draft hydrates asynchronously; without that dependency a draft arriving
after the first run is never reconciled): web in `ChatView.tsx` next to the other draft effects,
mobile in `use-thread-composer-state.ts`. Runs on thread open and on every change, which covers a
thread that changed while it was in the background.

**Equality.** `modelSelectionsEqual` exists in `apps/mobile/src/state/thread-outbox-model.ts:122`
(instance, model, JSON of options), and an inline copy sits in
`apps/web/src/components/ChatView.logic.ts:315-320` (`resolveThreadMetadataUpdateForNextTurn`).
It moves to `packages/shared/src/model.ts` beside `createModelSelection` and both call sites
import it (Hard Rule 11). The JSON comparison is option-order sensitive; that is already the
send-path rule, so the basis compare cannot be stricter than the write that produced the record.

## Alternatives considered

- **Clear the local pick on send.** Handles only the sending device; the other device's stale
  pick is exactly the reported case. Rejected.
- **Timestamp the pick and drop it when a newer turn exists.** Compares a device clock with the
  server's; the basis compares two values the client already holds. Rejected.
- **Make the thread selection always win over the draft.** Removes the ability to pick a model
  before sending on an existing thread. Rejected.
- **Server-side "selected but unsent" state.** A new contract for a client preference; the
  existing turn-start already broadcasts the selection that matters. Rejected.

## Files touched

- `packages/shared/src/model.ts` — `modelSelectionsEqual` (moved from mobile).
- `apps/mobile/src/state/thread-outbox-model.ts`, `use-thread-outbox-drain.ts` — import it.
- `apps/web/src/composerDraftStore.ts` — `modelSelectionBasis`, `basis` option,
  `adoptThreadModelSelection`; persisted schema gains the optional key.
- `apps/web/src/composerDraftStore.test.ts` — five cases (written for the baseline).
- `apps/web/src/components/ChatView.tsx` — basis at the picker site; adoption effect with the
  session guard; `ChatView.logic.ts` uses the shared equality.
- `apps/web/src/components/chat/ChatComposer.tsx` — the traits picker input carries the thread
  selection so `setProviderModelOptions` can record a basis.
- `apps/mobile/src/state/use-composer-drafts.ts` — `modelSelectionBasis`,
  `adoptThreadModelSelection`; persisted schema gains the optional key.
- `apps/mobile/src/state/use-thread-composer-state.ts` — basis at the picker site; adoption
  effect.
- `apps/mobile/src/state/use-composer-drafts.test.ts` — the same cases.

## Invariant (Hard Rule 12)

Property: a client's local model pick for an existing thread is honoured only while the thread's
selection is the one the pick was made against. Sites: web draft store, mobile draft store.
Writers of a pick: web model picker and traits picker (both record a basis); web draft-thread
promotion (`removeDraftThreadReferences`, no basis: equal to the thread by construction, no-op);
mobile picker (basis), mobile outbox restore (`use-thread-outbox-drain.ts:313,404`) and pending
message edit (`edit-pending-thread-message.ts:55`) (no basis: treated as superseded on the first
mismatch, which is the intended "thread wins" outcome). Directions: pick → thread (basis recorded
at pick time), thread → pick (adoption on change).
Consumers of the pick: web `resolveComposerProviderSelection` + `deriveEffectiveComposerModelState`
(unchanged, they read the draft after adoption), `useHandleNewThread.ts:121-125` (reads
`activeProvider` for a new thread's default; after adoption it reads the thread's instance),
mobile `modelSelection` derivation (unchanged), the web offline outbox and mobile outbox (they
capture the selection at queue time; a queued message keeps the selection it was queued with,
see Improvement suggestions in the report).
Out of scope: new-thread drafts (no server thread, so no thread selection to follow); the sticky
"last picked" global default (a new-thread concern).

## Tradeoffs and limitations

- A pick made on device B while device A's turn is already in flight with a different selection
  is dropped when A's turn-start lands, even if B picked seconds earlier. The alternative, keeping
  B's pick, is the bug this fixes. Accepted.
- Persisted drafts from older builds carry no basis and lose an unsent pick once if it disagrees
  with the thread. The alternative, grandfathering them, would leave the reported stale device
  stale until the next remote change. Accepted. The count of such picks cannot be measured
  (client-local storage); the cost is bounded by one pick per thread.
- Observability: the only post-ship signal is the refusal-count floor, which cannot distinguish
  "fixed" from "nobody switched devices". Accepted for a client preference fix.
- The web effect runs on every thread-detail replacement, but the action's first check is an
  early return on a missing pick or an equal basis, and the effect's dependency is a string key
  of the selection rather than the object.

## Follow-ups deferred

- The mid-turn switch refusal itself (server flips the session to `error` with the turn still
  running) is a separate defect in how the guard reports; it is recorded, not fixed here.

## Review exit note

6a (embedded `review-technical-design`): CONDITIONAL GO. Must-fixes, all applied above: the doc
and its baseline tests encoded different adoption semantics (overwrite chosen); the thread record
is client-written intent, so adoption is guarded by session consistency; the mobile send keeps
its pick (premise corrected) and the mobile effect keys on the draft too. Deferred: outbox picks
captured before adoption (improvement suggestion), option-order canonicalisation (nit).

6b (Correctness + Simplicity + Compatibility, one reviewer that built web and mobile halves and
ran the tests, typechecks and lint): NOT READY on the same semantics conflict; must-fixes applied:
overwrite (measured flicker with null+delete), traits-picker basis (a trait edit was silently
dropped on re-open), web persistence is hand-enumerated so the field is threaded through all
three sites with a reload round-trip test, the third inline equality copy. Exit: both reviews
converged on the same design after one round; every applied finding was verified by the
reviewer who built it.
