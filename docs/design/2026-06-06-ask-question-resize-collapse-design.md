# Ask-question panel: resize handle + collapse — 2026-06-06

## Goal

The pending-user-input ("ask question") composer panel sits docked above the
chat composer (bottom-sheet style, growing upward). On a web mobile viewport its
options list — capped at `max-h-[min(50vh,22rem)]` — still covered ~80% of the
screen, so the user could not read the conversation behind it before deciding.

Give the user two controls:

1. A **drag handle** to resize the options list height (explicitly requested).
2. A **collapse toggle** to hide the options and read the chat behind, then
   re-expand to answer.

## Approach (chosen)

Local component state in `ComposerPendingUserInputCard`:

- `isCollapsed: boolean` — collapse hides the options list + select hint, leaving
  the header, question text, and a tappable "N options hidden" hint.
- `optionsHeight: number | null` — `null` keeps a responsive CSS cap; a number
  switches the list to an explicit pixel height (fixed by drag), still clamped by
  a CSS `max-height` so it can never exceed the viewport.

Resize uses pointer events + pointer capture (works for touch _and_ mouse, which
native CSS `resize: vertical` does not). Bounds: `[72px, 80dvh]`. Reset via
double-click (desktop) **or** a reset button that appears once resized (touch),
**or** keyboard ArrowUp/Down on the focusable separator.

Mobile default cap lowered to `max-h-[40dvh] sm:max-h-[22rem]` — directly shrinks
the default footprint on phones while leaving desktop unchanged; the handle lets
users grow it back if they want more.

## Alternatives considered

- **Cut drag entirely; keep only collapse + smaller cap.** (Simplicity review's
  top pick.) Collapse + the lower default cap already solve the 80%-screen
  problem with far less code. _Rejected_ because the user explicitly asked for "a
  handle to resize the height"; continuous resize is a distinct, requested need.
  We _did_ adopt the smaller default cap from this suggestion.
- **Two fixed-height "compact/expand" toggle instead of continuous drag.** Less
  code, covers most of the need. _Rejected_ for the same reason — a "handle"
  implies continuous control. Noted as a fallback if drag proves low-value.
- **Native CSS `resize: vertical`.** _Rejected_ — no touch support, which is the
  primary target (web mobile).

## Files touched

- `apps/web/src/components/chat/ComposerPendingUserInputPanel.tsx` (only).
  Both composer render sites (desktop + collapsed-mobile) use this same card, so
  no `ChatComposer.tsx` change is needed.

## Correctness hardening (from adversarial review)

- **Render-time viewport clamp.** The 80vh bound was a drag-time-only invariant;
  a fixed px height set in portrait could swallow the chat after the mobile
  keyboard opens / on rotation. Fixed by also applying a CSS `max-h-[80dvh]`
  whenever an explicit height is set (`dvh` tracks the dynamic viewport).
- **Sticky drag.** If the element loses pointer capture without a `pointerup`
  (some mobile browsers, node removal), the drag state lingered. Fixed by
  clearing on `pointercancel` + `lostpointercapture` and a `event.buttons === 0`
  guard in move; `setPointerCapture` wrapped in try/catch.
- **Stale state across questions.** Card is keyed by `requestId`, so it does not
  remount when `questionIndex` advances within a multi-question prompt — collapse
  / height persisted onto the next question (could hide a new question's options).
  Fixed by resetting both on `questionIndex` change.
- **`event.repeat` guard** added to the number-key option shortcut (held key was
  restarting the auto-advance timer and toggling multi-select rapidly).

## Accessibility

- Resize separator: `role="separator"`, `aria-orientation`, `aria-label`,
  `tabIndex={0}`, ArrowUp/Down keyboard resize.
- Chevron + reset buttons: explicit `aria-label`.

## Tradeoffs / known limitations

- The resize separator does not expose `aria-valuenow/min/max` (would require a
  measured live value); it is operable but not fully value-annotated. Minor.
- A drag-resized height intentionally allows empty space below short option lists
  (resize semantics: the box can be taller than its content).

## Follow-ups deferred

- None blocking. The `event.repeat` guard was a pre-existing bug in the keyboard
  handler fixed opportunistically since it lives in the same handler.
