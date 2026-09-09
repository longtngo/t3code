# Plan: a thread's model selection follows the thread

Design: `docs/design/2026-09-09-thread-model-selection-follows-the-thread-design.md`, reviewed
(6a CONDITIONAL GO, 6b one round, both built and run); must-fixes folded in.

1. **Shared equality.** `modelSelectionsEqual` moves to `packages/shared/src/model.ts`; mobile
   outbox and `ChatView.logic.ts` import it. Commit: `refactor(shared): one modelSelectionsEqual`.
2. **Web store.** `modelSelectionBasis` on the draft (type, normalize, partialize, hydrate),
   `basis` option on `setModelSelection` and `setProviderModelOptions`,
   `adoptThreadModelSelection` (overwrite semantics; a map entry for the thread's instance counts
   as a pick). Tests: the baseline cases plus reload round-trip, traits basis, map-only pick.
   Commit: `feat(web): a local model pick yields to the thread once it moves`.
3. **Web wiring.** Picker and traits picker record the basis; `ChatView` adoption effect with the
   session-consistency guard. Same commit as 2.
4. **Mobile.** `modelSelectionBasis` on `ComposerDraft` and its schema (no version bump),
   `adoptThreadModelSelection` (delete semantics), basis retained through content clear, picker
   records it, effect with the session guard keyed on the draft too. Tests: five cases.
   Commit: `feat(mobile): a local model pick yields to the thread once it moves`.
5. Gate: `pnpm verify`.
