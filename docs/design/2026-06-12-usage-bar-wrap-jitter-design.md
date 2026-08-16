# Usage bar wrap jitter — stabilize meter width — 2026-06-12

## Goal

The branch-toolbar usage bar oscillates between a one-line layout and a
two-line (wrapped) layout — flipping back and forth on its own, which makes it
hard to read and click. Stop the oscillation so the row is visually stable.

## Symptom

`BranchToolbar.tsx:324` lays out two flex items in a wrapping row:

```tsx
<div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
  <UsageMeter ... />   {/* ctx · 5h · 7d · extra */}
  <HostMetrics ... />  {/* cpu · gpu · mem */}
</div>
```

State A: both groups on one line. State B: `UsageMeter` on line 1,
`HostMetrics` wrapped to line 2. It alternates between A and B continuously.

## Root cause

`flex-wrap` makes the line break a pure function of the two groups' combined
rendered width vs. the container width. That combined width is **not stable** —
it changes on nearly every render because the displayed values tick:

- **Host metrics** re-render every ~1–2 s (`useHostMetrics` subscription).
  `cpu`/`gpu`/`mem` render as `{Math.round(pct)}%`. Even with `tabular-nums`,
  `8%` → `10%` → `100%` differ by whole digit-widths.
- **Pace label** (`UsageMeter`) recomputes via `Date.now()` each render and
  flips between the `on pace` text and the `↑36%` / `↓30%` arrow form, and
  appears/disappears entirely (`computePace` returns `null` at window edges).
- **Percentages** for ctx/5h/7d and the **`$521/$2k` extra cost** are all
  variable-width.

When the combined width sits near the wrap threshold (the ≲510px regime the
existing comment describes — or any width where the row is near-full), these
few-pixel per-tick changes repeatedly cross the threshold, so the row wraps and
un-wraps every update. That is the "switching back and forth."

## Approach (chosen)

**Make every dynamic-width slot occupy a fixed width sized to its maximum
content.** Once each meter's width no longer changes as its numbers tick, the
wrap decision depends only on the viewport width — so for a given window size
the row deterministically wraps or doesn't, and never oscillates on its own.
The intentional narrow-screen wrap (so the groups don't overlap) is preserved.

Concretely, in the desktop and mobile readouts:

1. **Numeric percent value** (`ctx`, `5h`, `7d`, and `cpu`/`gpu`/`mem`): render
   inside a fixed-width, right-aligned, `tabular-nums` slot wide enough for
   `100%`. The host-metrics `—` placeholder uses the same slot.
2. **Pace label**: wrap in a fixed-width slot and **always render the slot** for
   the 5h/7d segments (empty when pace is `null` or on-pace is hidden), so the
   segment width is constant whether or not a pace arrow is present. The slot is
   sized for the widest of `on pace` and `↑100%` (these are ~equal width at
   11px, so one width covers both).
3. **Extra cost value** (`$…/$…`): fixed-width right-aligned slot sized for the
   widest realistic `$999/$9k`.

Widths are expressed so they survive theme/font changes (`tabular-nums` + a
generous `rem`/`ch` min-width) and are verified visually in the running app.

This is a pure-CSS/markup change in two components; no data, RPC, or layout
restructuring.

## Alternatives considered

- **`flex-nowrap` + overflow/scroll/truncate.** Removes wrapping entirely, but
  the existing comment notes the fixed-width bars can't shrink, so on a narrow
  screen the groups would overlap or be clipped — a worse UX than a stable wrap.
  Rejected.
- **JS hysteresis (ResizeObserver + sticky wrap state).** Add a dead-band so the
  layout only re-wraps after crossing the threshold by N px. Solves resize
  flapping but is heavier (observer, state, SSR care) and is the wrong tool:
  the oscillation here is driven by _data ticks_, not user resizing, and is
  fully removed once the width stops changing. Rejected as over-engineering;
  keep in reserve if visual verification still shows resize-edge flapping.
- **Round values more coarsely / drop the `on pace` text.** Reduces but does not
  eliminate width changes (e.g. 9%→10% still adds a digit). Insufficient alone.

The chosen fix is the minimal change that fully removes the data-driven width
jitter; if a residual resize-edge flap is observed during verification, the JS
hysteresis alternative is the documented follow-up.

## Files touched

- `apps/web/src/components/chat/UsageMeter.tsx` — fixed-width value + pace slots
  (desktop and mobile).
- `apps/web/src/components/chat/HostMetrics.tsx` — fixed-width value slot
  (desktop `MetricSegment` and mobile `MetricPill`).

## Tradeoffs & limitations

- Short values (e.g. `8%`) now show a small constant gap where the reserved
  width exceeds the content. This is intentional and far preferable to the row
  jumping lines; it also aligns the numbers into clean columns.
- Structural width changes that are **not** per-tick remain (GPU segment
  appearing/disappearing on first sample; a segment being enabled/disabled).
  These are one-time, not oscillating, so out of scope.

## Design-review resolutions (round 1)

- **Intermittent GPU segment (APPLY).** `readGpu` (server) degrades to `null` on
  a transient `ioreg` timeout/spawn error, not just on GPU-less hosts. A momentary
  null currently _unmounts_ the whole `gpu` segment (`{hasGpu ? … : null}`) and
  flips the wrap — a second, real oscillation path. Fix: **latch** "this host has
  a GPU" once any sample reports one; thereafter keep the segment mounted and let
  a transient null render as `—` in the fixed slot (constant width). Genuinely
  GPU-less hosts never latch, so no permanent empty slot.
- **`min-w` must be a true upper bound, not just `tabular-nums` (APPLY).** A
  `min-w` only stops shrink; if content exceeds it, the box grows. So each
  reserved width is sized to the real maximum content and the value uses
  `tabular-nums` — for percentages that is 3 digits + `%` (covers 0–999%, the
  hard ceiling for these metrics), so the box never grows and never clips.
- **Pace slot sized to `on pace`, not `↑100%` (APPLY).** `on pace` is proportional
  (non-tabular) and wider than the arrow form; the slot is sized to fit `on pace`
  and the magnitude (`↑9%`…`↑100%`) varies _inside_ the fixed slot. Verified in
  the running app.
- **Extra cost width (APPLY).** `formatCreditsShort` can emit `$N.Nk`; the slot
  is sized generously (fits `$99.9k/$99.9k`). Extra also updates rarely, so it is
  not a fast-oscillation contributor regardless.
- **Shared slot constants (CONSIDER→done).** Width/alignment classes live as
  exported constants in `lib/usage.ts`, imported by both components, to prevent
  the two meters' slots drifting out of sync.
- Popover open/close (portal overlay) and the live-dot pulse (opacity only) do
  not change row width — confirmed non-issues.

## Follow-ups deferred

- JS hysteresis on the wrap container — only if verification still shows
  flapping at the exact viewport-width boundary after width stabilization.
