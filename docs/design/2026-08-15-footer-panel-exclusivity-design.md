# One footer panel at a time — design

**Date:** 2026-08-15
**Branch:** `fix/footer-panel-exclusivity`

## Goal

`55048d0a9` moved Local models and Resource Queue into the sidebar footer row and anchored both
panels to the row's `relative` wrapper. Both now carry the **identical** positioning:

```
absolute right-0 bottom-full left-0 z-50 mb-2
```

so when both are open they occupy the same box and one paints over the other. At most one may be
open.

## Root cause — source-pinned, not inferred

Read directly, not deduced from a symptom:

- `SidebarLocalModels.tsx:152` and `SidebarResourceQueue.tsx:347` — byte-identical position classes.
- `SidebarChrome.tsx:178` — the single `<div className="relative">` both resolve against.

Before the move, each panel was anchored to its own full-width stacked row, so both could be open
without colliding. Sharing one anchor is what made two open panels mutually exclusive *in fact*
while nothing in the code enforced it.

**Reachability is high, not theoretical.** Resource Queue opens on **hover**, and its trigger sits
immediately to the right of Local models'. Expanding Local models and drifting one button right
reproduces it.

Hard Rule 9's independent-RCA step is proportionate-skipped and recorded: the mechanism is pinned
to two exact lines by reading, not inferred from correlation, and there is no failed prior fix to
break anchoring on. (The standing instruction in this session is also not to dispatch subagents.)

## Premises validated (Hard Rule 8)

| Premise | Probe | Result |
|---|---|---|
| Both panels share one positioning context | `grep -n absolute` on both files + the single `relative` in `SidebarChrome` | ✅ identical classes, one anchor |
| Nothing already prevents both being open | each owns private open state (`expanded`; `pinned \|\| hovering`) with no channel between them | ✅ no existing coordination |
| Resource Queue's `pinned` is separable from "is it open" | `pinned` only decides whether a mouse-leave should close it | ✅ can stay local while `open` is lifted |

## Approach

Lift only the **identity of the open panel** into `SidebarChromeFooter`; each child keeps its own
interaction logic and becomes controlled on open/close.

```ts
const [openFooterPanel, setOpenFooterPanel] = useState<SidebarFooterPanel | null>(null);
```

**The close must be identity-scoped, and this is the part that is easy to get wrong.** A naive
`onOpenChange(false) → setOpenFooterPanel(null)` lets a *stale* close clobber the *other* panel:
Resource Queue's mouse-leave close is on a 160ms timer, so if the user leaves it and opens Local
models within that window, the late timer would null out `"models"`. So the reducer ignores a close
for a panel that is no longer the open one:

```ts
export function nextOpenFooterPanel(input: {
  readonly current: SidebarFooterPanel | null;
  readonly panel: SidebarFooterPanel;
  readonly open: boolean;
}): SidebarFooterPanel | null {
  if (input.open) return input.panel;
  return input.current === input.panel ? null : input.current;
}
```

Extracted to `sidebarChrome.logic.ts` (matching the existing `sidebarLocalModels.logic.ts` /
`sidebarResourceQueue.logic.ts` convention) so the race is unit-testable without a DOM.

**Per component:**

- **Local models** — `expanded` state is replaced by `isOpen` / `onOpenChange`. Mechanical.
- **Resource Queue** — `hovering` is replaced by the prop; `pinned` stays local because it records
  *why* the panel is open (a click, not a hover), which is what decides whether a mouse-leave
  closes it. Two consequences:
  - the 160ms leave timer must read `pinned` through a **ref**, since its closure would otherwise
    capture the value from the render that scheduled it;
  - `pinned` must reset when the panel is closed **externally** (the other panel opened), or it
    would stay latched and the next hover-leave would refuse to close.

## Alternatives rejected

| Alternative | Why not |
|---|---|
| Let them overlap | Not an option once they share an anchor — one silently hides the other, and hover makes it easy to hit. |
| Offset the second panel so both fit | Requires knowing the first panel's rendered height. No static answer, and both are variable-height. |
| Give each panel its own anchor + fixed width | Already rejected in `55048d0a9`'s design: breaks on the mobile drawer's different `--sidebar-width`, and `right-0` on the second-to-last item hangs past the footer's left edge. |
| Shared React context instead of props | Both children are rendered directly by `SidebarChromeFooter`; context buys nothing over two props and hides the coupling. |
| Keep both uncontrolled, have each "close the other" via a callback | The loser's *local* state stays true, so re-activating it re-opens a panel the user never asked for. Controlled is the honest shape. |

## Tradeoffs and limitations

- Opening one panel now closes the other. That is the intended behaviour and the only coherent one
  while they share an anchor, but it is a change from the pre-`55048d0a9` world where both could be
  open on separate rows.
- `SidebarChromeFooter` gains one piece of state. It is the smallest thing that can own this: the
  two panels are siblings with no other relationship.

## Design review

**6a — pillar sweep: SKIPPED, recorded.** No trigger: no boundary, public API or event contract, no
data model or migration, no new dependency, no deployment change, no personal data / money / bulk
mutation / agentic side effect. Self-contained internal UI state.

**6b — lenses: correctness + simplicity** (always-on). No conditional lens triggers — no API or
config surface, no new entry point or data, no new query pattern (polling is unchanged), no new
failure-capable path, no new abstraction beyond one pure reducer. Run inline rather than via
subagents per the standing instruction; recording the deviation.

Findings applied:

1. **Correctness** — the stale-close race above. A late `onOpenChange(false)` from the panel that
   is no longer open would close the one that is. *(Applied — identity-scoped reducer, and it is
   the reason the reducer is a tested pure function rather than an inline `setState`.)*
2. **Correctness** — Resource Queue's leave timer closes over `pinned`. Once `open` is a prop, the
   timer can no longer rely on `open = pinned || hovering` to keep a pinned panel up, so it must
   read `pinned` through a ref. *(Applied.)*
3. **Correctness** — `pinned` latches if the panel is closed externally. *(Applied — reset on
   `isOpen` going false.)*
4. **Simplicity** — challenged extracting `nextOpenFooterPanel` at all versus an inline updater.
   Kept: the stale-close branch is the whole point of the change and is invisible in a render test,
   so it wants a direct unit test.
5. **Simplicity** — rejected a generalised "panel registry" keyed by string. There are exactly two
   panels and no third is foreseen; a union of two literals is smaller and typechecks the call
   sites.

Round 2 re-ran correctness (three findings applied) and produced only repeats. **Exit: quiescent.**

## Files touched (planned)

- `apps/web/src/components/sidebar/sidebarChrome.logic.ts` — new, `nextOpenFooterPanel`
- `apps/web/src/components/sidebar/sidebarChrome.logic.test.ts` — new
- `apps/web/src/components/sidebar/SidebarChrome.tsx` — owns the open-panel state
- `apps/web/src/components/sidebar/SidebarLocalModels.tsx` — controlled open
- `apps/web/src/components/sidebar/SidebarResourceQueue.tsx` — controlled open, `pinned` local
- `apps/web/src/components/sidebar/sidebarFooterRow.test.tsx` — exclusivity render coverage

## Follow-ups deferred

None.
