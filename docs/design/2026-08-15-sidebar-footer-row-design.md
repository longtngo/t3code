# Local Models and Resource Queue join the sidebar footer row — design

**Date:** 2026-08-15
**Branch:** `feat/sidebar-footer-row`

## Goal

Move the two fork-only footer panels — **Local models** and **Resource Queue** — off their own
full-width rows and into the bottom line that already holds Settings, Pull Requests and Usage.
Each keeps its icon *and* its tags (the model status dot and online count; the maintenance flag
and the running/waiting counts). Hover and click keep doing exactly what they do today.

That reclaims two rows of vertical space from a footer that is otherwise three stacked strips, and
puts every footer affordance on one line.

## What is there now

```
SidebarFooter
├─ SidebarProviderUpdatePill
├─ SidebarUpdateArchitectureWarning
├─ SidebarLocalModels      ← full-width row; click expands an INLINE list below it
├─ SidebarResourceQueue    ← full-width row; hover/click opens an OVERLAY popover above it
└─ SidebarMenu (flex-row)  ← Settings · Pull Requests · Usage · SidebarUpdatePill
```

`SidebarChrome.tsx` carries a comment explaining why the two sit outside the row: *"upstream's row
is a compact strip of icon buttons, and these two are full-width readouts."* This change reverses
that decision, so the comment is replaced rather than left to contradict the code.

## Premises validated (Hard Rule 8)

| Premise | Probe | Result |
|---|---|---|
| One edit covers every surface that renders the footer | `grep -rn SidebarChromeFooter` → `Sidebar.tsx:4346` **and** `LegacySidebar.tsx:3806` | ✅ both v1 and v2 mount the same component; no dev-only-surface trap |
| Mobile needs no decision | `grep -rln "ResourceQueue\|LocalModels\|localLlm" apps/mobile packages/client-runtime` → only `client-runtime/src/state/resourceQueue.ts` | ✅ web-only UI; the shared state module has no React Native view |
| `SidebarMenuItem` can host an overlay | it is an `<li>` with `relative` baked into its base class | ✅ and `cn` is `twMerge`, so `className="static"` overrides that base — the escape hatch the panels need |
| There is room on the line | sidebar `16rem` (256px) − `2 × 0.5rem` inset ≈ 240px usable; three `size-8` icons + gaps ≈ 100px | ⚠️ ~140px left for two badge-bearing controls — tight, and `SidebarUpdatePill` adds more on desktop. Drives the wrap decision below. |

## Approach

**1. Each panel keeps ownership of its own state and its own popover.** Neither component's
interaction logic moves; only its *trigger* changes shape and position. Lifting `expanded` /
`pinned` / `hovering` into `SidebarChrome` would be a much larger change for no behavioural gain.

**2. Both panels become overlays anchored to the footer row.** Resource Queue is already an
overlay (`absolute bottom-full`); Local models currently expands inline. Inline expansion below a
32px trigger inside a horizontal row has nowhere sensible to go, so it becomes an overlay too —
same content, same toggle, drawn above the row instead of pushing it.

Anchoring: `SidebarChrome` wraps the row in a `relative` container, and each trigger's
`SidebarMenuItem` opts out of its own positioning with `className="static"`. The panel's
`absolute bottom-full left-0 right-0` then resolves against the **row**, so both popovers are
exactly footer-width on every sidebar size — desktop `16rem` and the wider mobile drawer alike —
with no width arithmetic to drift.

**3. Triggers show icon + tags, not `size="icon"`.** The existing three are bare icons; these two
carry live readouts that are the point of having them. Each is an auto-width `SidebarMenuButton`:

| Trigger | Contents |
|---|---|
| Local models | `CpuIcon` · status dot (online / loading / offline) · online count when > 0 |
| Resource Queue | `GaugeIcon` · `maint` flag when in maintenance · running count · waiting count |

The text labels ("Local models", "Resource Queue") drop out of the row and move to `aria-label` +
`title`, matching how Settings/Pull Requests/Usage already work. The panels themselves keep their
visible headings, so the names are never more than a hover away.

**4. The row wraps.** Measured above, two badge-bearing controls plus three icons plus the Electron
update pill will not always fit 240px. `flex-wrap` on the row is the honest answer: it stays one
line whenever it fits and becomes two when it genuinely cannot, instead of overflowing or forcing
the badges to shrink to illegibility. Wrapping when the content does not fit is correct behaviour,
not a compromise.

## Alternatives rejected

| Alternative | Why not |
|---|---|
| Leave the panels stacked, only restyle them | Does not do what was asked; the vertical space is the point. |
| Lift all panel state into `SidebarChrome` and render panels as normal-flow siblings above the row | Much larger diff, and it makes both panels *push* the thread list up when opened rather than overlay it — a behaviour regression for Resource Queue, which is an overlay today. |
| Fixed pixel width on each popover (`w-[15rem]`) with `right-0` | Breaks on the mobile drawer (a different `--sidebar-width`), and `right-0` on the second-to-last item leaves the panel hanging past the footer's left edge. Anchoring to the row has no such cases. |
| Keep `size="icon"` and drop the tags | The user asked for the tags, and they are the reason to glance at these controls at all — a Resource Queue icon with no counts tells you nothing. |
| `overflow-x: auto` on the row instead of wrapping | Hides controls behind a scroll gesture nobody will discover in a 240px strip. |

## Tradeoffs and limitations

- **Local models' expansion changes mechanism** from inline to overlay. Same trigger, same content,
  same toggle; it now floats over the thread list instead of compressing it. Called out because it
  is the one interaction that is not literally identical.
- **The row can become two lines** on a narrow sidebar with the Electron update pill present. That
  is one line better than today's three strips, and only in the crowded case. The Usage and Pull
  Requests pages are the likeliest to wrap, since "Back" is a labelled full-height button sharing
  the line with the two readouts.
- Both popovers are `z-50` overlays anchored to the footer; on a very short viewport a tall queue
  list is bounded by its existing `max-h` and scrolls internally, as it does today.

## Design review

**6a — pillar sweep: SKIPPED, recorded.** No trigger fires: no service boundary, public API or
event contract, no data model or migration, no new dependency, no deployment or rollout change, and
no personal data, money, bulk mutation or agentic side effect. This is a layout change over
components that already exist and already fetch what they render.

**6b — lenses: correctness + simplicity** (always-on). No conditional lens triggers — no API or
config surface, no new entry point or data, no new query pattern (both panels keep their existing
polling), no new failure path, no new abstraction. Run inline rather than via subagents, per the
standing instruction in this session; recording the deviation rather than skipping the stage.

Findings applied:

1. **Correctness** — anchoring a popover to the `<li>` gives it the trigger's ~32px width. Caught
   before implementation; resolved by the row-anchored `static` escape hatch. *(Applied.)*
2. **Correctness** — `SidebarMenu` is a `<ul>`, so a panel rendered as a bare sibling `<div>` of the
   `<li>` would be invalid markup. The panel therefore lives *inside* its `<li>`, positioned against
   the row. *(Applied.)*
3. **Correctness** — the footer's `currentFooterPage` branch replaces the whole row with a single
   "Back" button on the Usage and Pull Requests pages, so where the two triggers sit relative to
   that ternary decides whether they survive those pages.

   *First answer, and it was wrong:* put them inside the Settings branch, "matching
   Settings/PR/Usage". Implemented that way, then corrected. Settings, Pull Requests and Usage are
   **navigation**, which is exactly why "Back" replaces them — you are already at the destination.
   These two are **live status readouts** with no destination, and today they render on every page
   because they live outside the row entirely. Burying them in that branch would have quietly
   removed the resource queue and model status from two pages as a side effect of a layout change
   nobody asked to change behaviour. `SidebarUpdatePill` already sits outside the ternary for the
   same reason and is the precedent. *(Applied — outside the branch, beside the update pill; the
   Back item is `flex-1` and simply shares the line.)*
4. **Simplicity** — challenged whether Local models needs an overlay at all versus keeping the
   inline list. Kept the overlay: an inline list rendered from inside a horizontal `<ul>` row is
   both invalid-ish markup and visually wrong, and matching Resource Queue means one mental model
   for both footer panels.
5. **Simplicity** — rejected a shared `FooterPanel` abstraction wrapping both. The two have
   genuinely different open semantics (toggle vs hover-with-close-delay-plus-pin); a wrapper would
   have to parameterise all of it and would be longer than the duplication it removes.

Round 2 re-ran correctness (findings applied) and produced only repeats. **Exit: quiescent.**

## Files touched (planned)

- `apps/web/src/components/sidebar/SidebarChrome.tsx` — `relative` row wrapper, `flex-wrap`, the two
  triggers moved into the row, the stale "they stay stacked" comment replaced
- `apps/web/src/components/sidebar/SidebarLocalModels.tsx` — row trigger + overlay panel
- `apps/web/src/components/sidebar/SidebarResourceQueue.tsx` — row trigger + row-anchored popover
- a render test locking the two into the row and out of the Back-button branch

## Follow-ups deferred

None identified; the drain runs after implementation.
