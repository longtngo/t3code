# Resource-queue pool meters — wrap instead of overflow — 2026-08-07

## Goal

The pool-capacity strip at the top of the Resource Queue popover renders every pool in one
non-wrapping row. With the broker's current pool set the row is wider than the sidebar and
spills out past the popover's right edge, painting over the thread list.

Target: the strip fits the popover at any sidebar width and any pool count, and every pool
label stays readable.

## Verified premises (Hard Rule 8)

Probed live before designing, via `resctl status --json`:

| Premise                                     | Probe                                                  | Result                                                                              |
| ------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| How many pools does the strip render?       | `resctl status --json`                                 | **7** — `gpu`, `cpu_perf`, `cpu_eff`, `ram`, `dev_tab_a9`, `dev_pixel10`, `machine` |
| How many survive the client filter?         | `resource !== "ram"` in `SidebarResourceQueue.tsx:274` | **6**                                                                               |
| Is `ram` the only advisory pool?            | same JSON                                              | yes — `advisory: true` on `ram` only                                                |
| Is the container narrow enough to overflow? | `SIDEBAR_WIDTH = "16rem"` (`ui/sidebar.tsx:27`)        | 256px outer, ~220px inner to the strip                                              |

6 columns whose narrowest legible content is `DEV_PIXEL10 0/1` (~85px) need ~510px. The
container gives ~220px. The overflow is arithmetic, not a guess.

## Root cause

`SidebarResourceQueue.tsx:350` lays the strip out as `flex gap-1.5` with `flex-1` children.
A flex item defaults to `min-width: auto`, so it cannot shrink below its content's min-content
width. Each cell's min-content width is set by its pool name, which is a single unbreakable
token (`dev_pixel10`). `flex-1`'s `flex-shrink: 1` is therefore inert: the row's width floors
at the sum of the six names and overflows the popover, which sets no `overflow` and so paints
the excess outside its own box.

The bug is not new code — it is the pool set outgrowing a layout written when there were three
pools (`gpu`, `cpu`, `machine`). Any future pool re-breaks a fixed single-row layout, so the fix
must be count-agnostic rather than tuned to six.

## Approach

**Replace the single flex row with an auto-fitting grid.**

```
grid grid-cols-[repeat(auto-fit,minmax(min(84px,100%),1fr))] gap-x-2 gap-y-1.5
```

- `auto-fit` derives the column count from the available width, so the strip wraps to as many
  rows as it needs: 2 columns in the 256px sidebar, 3+ in the wider mobile drawer. Nothing is
  tuned to today's pool count.
- `minmax(min(84px,100%),1fr)` sets a legible floor (84px fits `DEV_PIXEL10 0/1`) while the
  inner `min(…,100%)` keeps a single column from overflowing a container narrower than the
  floor itself.
- `auto-fit` over `auto-fill` so a short pool list stretches to fill the row instead of leaving
  dangling empty tracks.
- Each cell gets `min-w-0`, the name `truncate` + a `title`, and the count `shrink-0`. This is
  the guard that makes the layout total: a pathologically long pool name degrades to an
  ellipsis with a tooltip rather than reopening the overflow.

**Also: restore the per-pool accent colors.** `RESOURCE_BADGE` / `RESOURCE_BAR` are exact-match
maps keyed `gpu` / `cpu` / `machine`. The broker's CPU split (`cpu` → `cpu_perf` + `cpu_eff`)
and the new `dev_*` device pools no longer match, so 4 of 6 pools currently fall back to gray.
The strip being fixed reads as half-broken without this. Replaced by a prefix-matching pure
helper `resourceAccent(name)` in `sidebarResourceQueue.logic.ts` (unit-tested there), covering
`gpu`, `cpu*`, `dev_*`, `machine`, and a fallback.

## Alternatives rejected

- **`min-w-0` on the existing flex children only.** One line, and it does stop the overflow —
  but 6 equal columns in 220px is 33px each, so every label truncates to `DEV…`. Fixes the
  overflow by destroying the information.
- **Fixed `grid-cols-3`.** Wraps, but hard-codes a column count against a pool set that just
  demonstrated it grows, and ignores the much wider mobile drawer.
- **Vertical list, one pool per row.** Fully legible, but 6 rows of a label + bar adds ~110px
  to a popover that already caps its scroll list at 262px, pushing the actual queue off-screen.
- **Horizontal scroll on the strip.** Hides pools behind a gesture in an at-a-glance widget,
  and a trackpad scroll over it would fight the queue list's vertical scroll.

## Files touched

- `apps/web/src/components/sidebar/SidebarResourceQueue.tsx` — strip layout, accent lookup
- `apps/web/src/components/sidebar/sidebarResourceQueue.logic.ts` — `resourceAccent` helper
- `apps/web/src/components/sidebar/sidebarResourceQueue.logic.test.ts` — its tests

## Tradeoffs and limitations

- The strip grows from one row to three in the 256px sidebar (+~45px), making the popover
  taller. Accepted: it is bounded, it is inside the popover, and the alternative is content
  painted outside the widget.
- Accent colors are prefix-matched, so a future pool named e.g. `cpu_gpu_hybrid` takes the
  first matching prefix. The fallback keeps any unmatched pool legible, so a miss is cosmetic.

## Follow-ups deferred

- The advisory pool is dropped by the literal name `"ram"` in three places rather than by the
  `advisory` flag the server already carries in the DTO. Same class of brittleness as the color
  map that this change repairs, but it is not the layout ask — recorded as an improvement
  suggestion.
