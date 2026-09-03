# Subagent backend panel inside the sidebar utility menu — design

**Date:** 2026-09-03 · **Branch:** `fix/subagent-panel-in-utility-menu`

## Goal

`SidebarSubagentBackend` mounts in `SidebarChromeFooter` only, so the settings page — which
renders `SidebarUtilityMenu` and nothing else of the footer — never shows it. The fork's other
footer panels (`SidebarLocalModels`, `SidebarResourceQueue`, `SidebarCrew`) live inside the
utility menu for exactly that reason (registry §5b). Move it there.

Baseline @ 8537c8bad: the `SidebarUtilityMenu` function body contains `<SidebarSubagentBackend`
→ False. Target: True, and the settings page shows the disclosure row.

## Approach

`apps/web/src/components/sidebar/SidebarChrome.tsx`: `SidebarUtilityMenu` returns a fragment of
`<SidebarSubagentBackend />` followed by the existing `relative` footer row; `SidebarChromeFooter`
drops its own mount. The panel keeps its internal `open` state and its expand-in-place layout: it
is a settings surface with real controls, not a floating status popover, so it does not join the
`openFooterPanel` mutual exclusion (those two share one anchor box; this one occupies its own
rows). Its comment already says so.

The settings page's footer wraps the menu in `min-w-0 flex-1` beside the T3 Connect avatar
inside a `flex items-center gap-1` row (`SettingsSidebarNav.tsx:297`). With two stacked children
in the menu the avatar would centre on the taller column; the row becomes `items-end` so the
avatar stays pinned to the utility icon row, collapsed or expanded. Measured with a static render:
the main sidebar's footer markup is byte-identical before and after (fragments emit no node).

Tests: `sidebarChromeFooter.test.tsx` mocks the panel to `null`. The panel mock returns a marker
element instead, and two assertions are added: rendering `SidebarUtilityMenu` itself (not the
footer, which mounts the panel today and would make the assertion vacuous) contains the marker,
and rendering the footer contains it exactly once (a forgotten footer mount would double it).
Both were checked to fail on today's tree in a static-render prototype.
`docs/fork/README.md` §5b is rewritten: four panels live inside the menu (`SidebarLocalModels`,
`SidebarResourceQueue`, `SidebarCrew`, `SidebarSubagentBackend`), and the footer keeps only the
two update pills — its current "bare `<SidebarUtilityMenu />`" clause is already false.

## Surfaces

Web and desktop (settings page and main sidebar). Mobile has no sidebar utility menu; its
subagent-backend surface, if any, is separate and unchanged. Reverse state: the disclosure closes
as before.

## Alternatives rejected

- Join the `openFooterPanel` exclusion and float like the status panels: changes its layout for
  no user benefit; the panel was deliberately in-place.
- Mount it in `SettingsSidebarNav` separately: two mount points to keep in step, which is the
  defect being fixed.

## Review exit

One combined 6a/6b round (pillars + correctness + simplicity): CONDITIONAL GO. Applied: the
guard test renders the menu, the double-mount assertion, the avatar alignment, the §5b rewrite.
Rejected: none.

## Follow-ups deferred

None.
