# Ask-question panel: collapse + bounded, internally scrolling options

**Date:** 2026-08-07
**Branch:** `feat/ask-question-collapse-scroll`
**Restores:** `feat/composer: cap ask-question options height` (`00bd3b28f`, 2026-06-05) and
`feat(composer): resizable + collapsible ask-question panel` (`45b4f7b1`, 2026-06-06).
Prior reports: `~/reports/t3code/2026-06/2026-06-05/2026-06-05-ask-question-panel-scroll-cancel.md`,
`~/reports/t3code/2026-06/2026-06-06/2026-06-06-ask-question-resize-collapse.md`.

## Goal

While an `AskUserQuestion` is pending, the user must be able to read the conversation behind it.
Today the panel is unbounded: a question with many or long options grows until it covers most of
the viewport, and there is no way to get the space back short of answering.

## Where the feature went

Not the recent upstream sync, as assumed. Bisecting the file by content:

| Commit                                                           | Date       | `isCollapsed` |
| ---------------------------------------------------------------- | ---------- | ------------- |
| `45b4f7b1` fork: resizable + collapsible panel                   | 2026-06-06 | 8             |
| `a4757c265` **upstream #3018** "Composer polish: … answer panel" | 2026-06-10 | 0             |
| `HEAD`                                                           | 2026-08-07 | 0             |

Upstream PR #3018 rewrote the answer panel four days after the fork shipped the controls, taking
both fork commits with it (the `max-h` cap from 2026-06-05 and the collapse/resize from
2026-06-06). The 2026-06-05 `Cancel` button in `ComposerPrimaryActions.tsx` was collateral in the
same rewrite; it is _not_ restored here (out of the stated scope, recorded as a follow-up).

This file has taken four upstream changes since, so it is an actively-churned upstream surface:
expect this to be a recurring merge conflict, and resolve toward the fork.

## Mechanism of the symptom (source-pinned, not inferred)

1. `ComposerPendingUserInputPanel` renders its options in `<div className="mt-3 space-y-1.5">` —
   no `max-h`, no `overflow`. Panel height grows with option count and description length.
2. Nothing above it caps the height either: the wrapper, `.chat-composer-glass-host`,
   `.chat-composer-glass-shell` (`apps/web/src/index.css:430`) and the overlay div set no
   `max-height`.
3. `ChatView.tsx:1389-1406` measures the composer overlay with a `ResizeObserver` into
   `composerOverlayHeight`.
4. That value is passed to the timeline as `contentInsetEndAdjustment` and `bottomInset`
   (`ChatView.tsx:6403`, `MessagesTimeline.tsx:586,615`).

So visible message area = viewport − panel height, continuously. The same `ResizeObserver` is
what makes the fix work: shrinking the panel returns the space to the timeline on the next frame,
with no extra wiring.

## Approach — restore the cap and the collapse toggle

1. **Bounded, internally scrolling options.** `max-h-[40dvh] sm:max-h-[22rem] overflow-y-auto
overscroll-contain pr-1`. Only the options list scrolls; the header, the question text and the
   multi-select hint stay pinned above it, so the thing you must read to answer is never scrolled
   away. `dvh` (not `vh`) so the mobile keyboard opening or a rotation re-clamps.
   `overscroll-contain` stops a flick at the list's end from chaining into the timeline behind.
2. **Collapse toggle.** A chevron in the panel header hides the options entirely, leaving the
   header, the question, and a tappable "N options hidden" hint. Collapsed, the panel is a few
   rems tall and the conversation is readable at full height.
3. **Reset per question.** The card is keyed by `requestId`, so it does _not_ remount when
   `questionIndex` advances inside a multi-question prompt. Collapse state resets on
   `questionIndex` change, or a collapsed panel would hide the _next_ question's options.

### Rejected — move the composer and question into the conversation scroll

The user's stated alternative ("how Claude Code solves it"). Rejected on architecture, not taste:

- **The timeline is a virtualized `LegendList`** (`@legendapp/list/react`,
  `MessagesTimeline.tsx:577`) that owns its own scroller. The composer is a stateful, focus-holding
  component that renders through `createPortal`. Hosting it inside virtualized content invites
  focus loss on recycling, measurement thrash against `maintainScrollAtEnd`, and mobile-keyboard
  interplay — a large, risky change to the most load-bearing screen in the app.
- **Its main benefit is already there.** Reachability is not the problem: because
  `contentInsetEndAdjustment` tracks the overlay height, no message is ever _permanently_ hidden
  behind the composer — you can already scroll every message into the strip above it. What the
  alternative would add is that the question scrolls _out of view_, freeing the whole viewport.
  Collapse delivers exactly that, in one click, reversibly.
- **It is strictly worse while the question is on screen.** Keeping the panel "full height" by
  design means that at any scroll position where the question is visible it still eats the
  viewport. The cap plus collapse helps in both states.

### Rejected — render the question as the timeline's `ListFooterComponent`

The cheaper half of the same idea, and genuinely available: that slot currently holds only a
`<div className="h-3 sm:h-4" />` spacer (`MessagesTimeline.tsx:191,611`). Rejected because it
splits the question from the custom-answer input that stays in the composer, and because a
question that can scroll away with no affordance to bring it back is a discoverability
regression against an explicit toggle. It also would not cover the collapsed-mobile composer,
which renders the same panel from a second site (`ChatComposer.tsx:2856`).

### Not restored — the drag-resize handle

`45b4f7b1` also shipped a pointer-capture drag handle. The current request is collapse plus a max
height; the handle is the part that produced three of the five defects that branch's review found
(sticky drag on lost pointer capture, render-time viewport clamp, stale height across questions).
Left out deliberately; the cap plus collapse covers the stated need. Cheap to restore from
`45b4f7b1` if wanted.

## Files touched

| File                                                                  | Change                                                                                                                         |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `apps/web/src/components/chat/ComposerPendingUserInputPanel.tsx`      | Collapse state + chevron toggle + collapsed hint; bounded scrolling options list; scroll a keyboard-selected option into view. |
| `apps/web/src/components/chat/pendingUserInputPanelLayout.ts`         | New. Pure labelling logic for the toggle and the collapsed hint.                                                               |
| `apps/web/src/components/chat/pendingUserInputPanelLayout.test.ts`    | New. Unit tests for the above.                                                                                                 |
| `apps/web/src/components/chat/ComposerPendingUserInputPanel.test.tsx` | New. Static-markup tests for the cap classes and toggle a11y.                                                                  |

## Side effects mitigated

- **Invisible keyboard selection.** The number-key 1-9 shortcut can now target an option below the
  fold of a scrolling list — a nit deferred in June that the cap makes reachable again. The
  selected option is scrolled into view (`block: "nearest"`), and a keyboard selection on a
  collapsed panel expands it first, so a selection is never invisible.
- **Scrollbar crowding the checkmark** — `pr-1`, as in June.
- **Overscroll chaining** — `overscroll-contain`, matching `toast.tsx:144`.

## Tradeoffs and known limitations

- **A very long question string can still make the panel tall.** Only the options list is bounded.
  This is deliberate and unchanged from June: the question is what you must read to answer. The
  collapse toggle is the escape hatch for that case.
- **Fork divergence.** Upstream owns this file and has changed it four times since June. This
  re-diverges it.
- **No interactive test coverage.** `apps/web` registers only a `unit` project
  (`vite.config.ts:344`); there are no `.browser.tsx` files and no testing-library anywhere in the
  repo, so the only web idiom is `renderToStaticMarkup`. Clicking the chevron cannot be asserted in
  CI. The collapse interaction is therefore verified live in the running app against a real
  `AskUserQuestion`, and the pure labelling logic is unit-tested. See follow-ups.

## Follow-ups discovered

- `apps/web` has **no browser test project** and no browser tests at all, so no interactive web
  behaviour in this repo is covered by the gate. Pre-existing; recorded in the 2026-08-07 review-diff
  report as well. Not fixed here — restoring that harness is its own piece of work.
- The 2026-06-05 **Cancel button** on a pending question (`ComposerPrimaryActions.tsx`) was removed
  by the same upstream rewrite and is still gone. Out of scope for this request.
