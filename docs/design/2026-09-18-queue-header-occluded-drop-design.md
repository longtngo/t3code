# A row must not be able to take the Queue header's place - design

## 1. Goal and baseline

During a sidebar drag, a list row can be painted across the Queue header. A release aimed at what the
user sees - the row - enqueues into the Queue instead.

Baseline on `personal` at `fadeb04f5` (viewport 1400x900, both shelves open, 3 queued, 4 Active):
pick up an Active row, drag upward past an earlier row, and the row below it carries
`translate(0,133)` across the header at `428..460`. **810 of 810 sampled header pixels covered** and the Queue
toggle **100%** covered (an earlier draft said 73%; it does not reproduce at any inset, step or
viewport - it is 100% at every one). `check.sh` occluded-drop-zone.

The gesture matters and the older probes could not produce it: parking just below the picked-up row
gave 0 covered samples over 5 gestures x 3 reps. You must park over an EARLIER row. It is also a
race, not a steady state - once the pointer enters the header `over` flips to the Queue and the rows
slide back within ~100ms, so a sample taken after a 100ms dwell reads clean while the user's flick
does not.

## 2. Two defects, not one

The independent RCA established these as separate mechanisms.

|       | Defect                                                          | Where                                                                       |
| ----- | --------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **A** | A transform-moved row paints over the header                    | `collapseQueue` in `Sidebar.tsx`                                            |
| **B** | The drop is decided by rect containment, with no occlusion test | `pointerOverVisibleRect`, and the release override in `handleThreadDragEnd` |

**A**: the main list is positioned by CSS `transform`, which has no layout effect, while the Queue
header is a plain `li` in normal flow - so the projection's downward shift lands on it. The only
thing separating them was the drag-time collapse, `collapseQueue = queueDropShown && !listScrolls`,
and `listScrolls` is sampled once at drag start, so **when the list already scrolls the collapse
never runs**. One variable, nothing else changed: VH 900 overlaps, VH 1000 does not. The collapse is
not sufficient even when it runs - it frees a finite `mt-auto` slack that one row dragged in from a
shelf consumes (143 of 254 scan samples covered).

**B** is real as a mechanism - the RCA's 2x2 flips the drop by moving the rect and not by moving the
paint - but **only A can produce it today**: every element whose rect intersects the header during a
drag is that one translated row and its own descendants. Nothing else in the document.

## 3. Approach: fix A. B is deliberately not fixed.

**A - the header outranks the sorting preview, and is opaque.** The Queue header takes `relative
z-20 bg-sidebar` while a drag runs. Both classes are load-bearing, and the first draft of this design
had only the first:

| state                              | row ink inside the header |
| ---------------------------------- | ------------------------- |
| `z-20` + `bg-sidebar`              | **0 / 6480 px**           |
| `z-20` alone                       | 5953 / 6480 px            |
| neither                            | 6088 / 6480 px            |
| `bg-sidebar/50` (half-transparent) | 5953 / 6480 px            |

`z-20` wins the hit test - against the transformed `li`, which is its own stacking context, NOT
against the row card's `z-10` which that context already caps. But both elements are transparent, so
ordering alone left the row's title rendering across the drop zone and moved the user-visible result
from 6088 to 5953 of 6480 leaked pixels, a difference inside the arm's own run-to-run spread.
`bg-sidebar` is what actually hides it, and it must stay a WHOLE token: `bg-sidebar/50` is plainly
see-through and defeated both gates written for this. This aligns paint with behaviour instead
of fighting it: the header IS the drop target, so drawing it above a preview of where rows _would_
land is what the user needs to see.

`relative` is belt-and-braces: measured, `z-20` applies without it because the parent `ul` is a flex
container, and `relative` has no layout effect here (the header's box and all 11 descendant boxes are
byte-identical with and without it). It is kept so the z-index does not silently stop applying if
that parent ever stops being flex.

Rejected - making the collapse unconditional: it has no space to collapse into when the list
scrolls, which is exactly the failing case, and it would unmount the queue rows on every drag.

Rejected - excluding the header's band from the projection: the projection is dnd-kit's, shared by
every sortable row. Bending it for one non-sortable sibling is a far larger blast radius than a
stacking change.

### Why B is not fixed

A prototype of B - accept a point only if `document.elementsFromPoint` reaches the zone - was built
and driven against the live sidebar. It loses on four measurements:

1. **It cannot refuse at the release.** The override in `handleThreadDragEnd` is additive: if the
   detector already left `over` holding the Queue, a release-time refusal is inert. Instrumented, the
   guard reported _not painted_ and the thread enqueued anyway, 2/2. Only the collision detector can
   enforce it, which is the path A already protects.
2. **It regresses a shipped fix.** `rounded-md` is 8px, so the header does not paint its own corners.
   A release 1px above the bottom border and 3px from the left went from 3/3 enqueue to 0/3 - inside
   the visibly dashed box, and inside the 2px band `e96e79b37` shipped to protect.
3. **The repo cannot test it.** happy-dom has no `elementsFromPoint` and its `elementFromPoint`
   returns `null` unconditionally, so the guard crashed all six pointer-drop-zone DOM tests. Testing
   it in-repo means stubbing the hit test, which pins a hand-written stack rather than real paint.
4. **Its failure mode is silent and total.** The drag overlay sits at index 0 of the hit stack at the
   pointer on every release, so the overlay exclusion IS the guard. Mutating only the exclusion - skip
   the overlay's `ul` but not dnd-kit's wrapper `div`, a one-element slip - refused the Queue drop
   100% of the time with no error. A guard whose only in-repo coverage is impossible and whose
   failure disables the feature is worse than the hypothetical it protects against.

So the invariant is enforced by the LAYOUT, not by the hit test. If a future change reintroduces an
overlap, occluded-drop-zone reports it.

The arm has now been wrong twice, in the same direction, and both versions passed a build a human
could see was broken. Version 1 asked `elementsFromPoint` who was on top, which is ordering and not
paint. Version 2 counted fully-saturated sentinel glyph pixels, and scored 0 on a `bg-sidebar/50`
header - the leaked glyphs composite to about G=126, so the saturation gate discarded every one.
Version 3 paints a sentinel BACKGROUND on each row and accepts a composited tint, so a leak is a
large solid area rather than a few antialiased edges, and it also reports the served class so a stale
dev-server transform cannot read as a pass.

## 4. Withdrawn premise

An earlier draft carried **P1: "the drag overlay does not hit-test at the pointer"**, from one
measurement reading `overlayInStack:false`. It is FALSE. That measurement used a single-teleport
gesture, and the overlay had not repositioned yet; on any multi-step gesture the overlay is at index
0 of the stack on every release. The lesson is the same one the clipped-drop work learned twice: a
single synthesized pointer move is not evidence about a gesture.

## 5. Invariants

| #   | Invariant                                                                              | Proof                                                                                                                                                                                       |
| --- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| K1  | No sidebar list row's INK is visible inside the Queue header during a drag             | `check.sh` occluded-drop-zone, which screenshots the band and counts composited sentinel tint: 0/6480 with the fix, 5953/6480 with only the ordering half, and 5953/6480 at `bg-sidebar/50` |
| K2  | The Queue toggle and pause button stay uncovered throughout a drag                     | measured 100% -> 0% covered by hand; NOT pinned by an arm, see section 6                                                                                                                    |
| K3  | A release where the header is painted still enqueues, on both edges and at the corners | existing header-edges and clipped-drop-zone arms stay green                                                                                                                                 |

## 6. Known gaps, recorded on purpose

K2 is measured but not pinned: `occl.mjs` screenshots the header band only, so a future change that
re-covers the Queue toggle without touching the header would not fail an arm.

For ~30-60ms after mouseup the row paints back over the header while it animates home, because
`dragging` drops at the release. Cosmetic: no drop decision happens after the release.

A drop zone is still accepted on rect containment plus the clip test, not on paint. Today nothing but
a translated row can cover the Queue header, and A removes that - so the gap is unreachable rather
than tolerated. Anyone reopening it should read section 3 first: the obvious fix was built, measured,
and rejected on evidence, not skipped.
