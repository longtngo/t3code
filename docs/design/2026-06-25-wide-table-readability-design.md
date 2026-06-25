# Wide-table readability in chat — design

**Date:** 2026-06-25
**Branch:** `feat/table-readability`
**Status:** Design

## Goal

When the assistant renders a wide Markdown table in the chat view, cell text is
currently **truncated with an ellipsis** by default and the table is **wider than
the 768px message column**, so the rightmost column is clipped — and because the
horizontal scrollbar is hidden, there is no cue that more content exists. The user
cannot read the table without discovering and clicking the "Expand table cells"
toggle.

Make wide tables readable **by default**, on both desktop and mobile, with no
required interaction.

## Current behavior (root cause)

- `apps/web/src/components/ChatMarkdown.tsx` → `MarkdownTable` wraps the table in a
  `ScrollArea` with `hideScrollbars` (scroll works but is invisible).
- `apps/web/src/index.css`:
  - `.chat-markdown table { min-width: max-content }` — forces the table wider than
    its container, which is what pushes the last column off-screen.
  - `[data-expanded="false"] th,td { white-space: nowrap; text-overflow: ellipsis;
    overflow: hidden; max-width: 24rem }` — truncates every cell to one line by
    default.
  - An `expanded` toggle (the `⤢` button) flips cells to `overflow-wrap: anywhere`
    and freezes measured column widths.

So the three "options" in the ask partially exist already: horizontal scroll (but
invisible) and wrap (but behind a click and not the default).

## Approach — responsive hybrid (prototype "D")

Chosen after building an HTML prototype comparing four approaches on both a 768px
desktop column and a ~390px mobile column
(`~/reports/t3code/2026-06/2026-06-25-table-readability-prototype.html`).

**Wrap-to-fit by default; scroll only when it genuinely cannot fit; expand to a
full-width overlay for the extreme case.**

1. **Default = wrap, not truncate.** Remove `min-width: max-content` and the
   `nowrap/ellipsis` truncation. Cells get `white-space: normal; overflow-wrap:
   anywhere`. With `table { width: 100% }` and auto table layout, the browser caps
   the table at the column width and wraps cell content — no text is ever hidden.
   `overflow-wrap: anywhere` also breaks long unbreakable tokens (URLs/paths) so
   they cannot force horizontal overflow on desktop.

2. **Responsive floor for mobile.** Pure wrap on a ~390px phone column crushes
   short columns into one-word-per-line "towers" (measured in the prototype). Below
   640px, apply `table { min-width: 32rem }` so the table keeps usable column
   widths and **scrolls horizontally** instead of crushing. The label/prose columns
   stay readable; the narrow trailing column is reached by a swipe.

3. **Make the scroll visible.** Drop `hideScrollbars` from the `ScrollArea` (keep
   `scrollFade`). On desktop, wrapping means there is usually no overflow, so no
   scrollbar appears (clean). When there *is* overflow (mobile floor, or a residual
   wide table), a real scrollbar + edge fade signal it.

4. **Expand → full-width overlay.** Repurpose the existing `⤢` footer button: it no
   longer toggles wrap (wrap is now the default), it opens a `Dialog` (reusing
   `./ui/dialog` → `DialogPopup` + scrollable `DialogPanel`) that renders the same
   table at the full window width — escaping the 768px column for genuinely huge
   tables. The overlay goes near-fullscreen on small screens (the Dialog primitive
   already handles mobile sizing).

The `Copy as Markdown / CSV` menu is unchanged.

## Alternatives considered

- **B — wrap only (no overlay, no responsive floor).** Simplest diff, but the
  prototype showed it is the *worst* on mobile: fixed narrow columns become tall
  word-towers. Rejected as the sole solution; its wrap behavior is the desktop core
  of D.
- **C — visible horizontal scroll only (keep single-line cells).** Preserves table
  shape (good for dense numeric grids) and is natural with touch, but every wide
  prose row requires scrolling back and forth to read — does not satisfy "easier to
  read" for the prose-heavy tables in the screenshot. Its visible-scroll mechanism
  is reused in D as the *fallback*, not the default.
- **A — current (truncate + invisible scroll).** The status quo being fixed.

## Files touched

- `apps/web/src/index.css` — replace the `.chat-markdown` table truncation rules
  with wrap-by-default + the `@media (max-width: 640px)` min-width floor.
- `apps/web/src/components/ChatMarkdown.tsx` — `MarkdownTable`: remove the
  `expanded`/`toggleExpanded` truncation toggle and its column-width-freeze logic;
  add a `Dialog` overlay opened by the `⤢` button; drop now-unused imports
  (`Minimize2Icon`, and the `[data-expanded]` attribute).
- `apps/web/src/components/ChatMarkdown.browser.tsx` — update the table tests that
  pin the old truncate/toggle behavior to assert: cells wrap by default
  (`white-space: normal`), wide tables do not overflow the container on desktop, and
  the `⤢` button opens the overlay dialog. Keep the copy-as-markdown/csv test.

## Tradeoffs & limitations

- A very wide many-column table wrapped into 768px becomes tall. That is the
  intended tradeoff (nothing hidden); the overlay is the escape hatch for it.
- Auto table-layout distributes column widths by content heuristics rather than an
  explicit ratio. Acceptable and standard (matches common Markdown renderers); we do
  not control per-column widths because Markdown tables have no colgroup.
- Removing the collapse/compact mode means dense numeric grids also wrap — but
  numbers don't wrap, so grids are unaffected in practice.

## Follow-ups deferred

- None anticipated. If the overlay's duplicate render of cell content (interactive
  file chips) proves heavy for enormous tables, a lazy "render dialog table only
  when open" guard is a cheap follow-up (the Dialog already mounts lazily, so this
  is likely already covered).
