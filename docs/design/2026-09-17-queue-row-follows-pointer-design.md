# A dragged sidebar row keeps following the pointer - design

## 1. Goal and baseline

A row picked up in the sidebar follows the pointer for the whole drag, whatever it is currently over.

Baseline (`baseline.sh record queue-row-pointer-drift`, `personal` at `614ef106c`, live dev server):
`max drift vs pointer: 382`. The dragged Queue row does not move at all once the pointer leaves the
Queue, so the drift equals the pointer's travel, 1:1.

The shipped arms sweep at 4px per pointer event, which is what a real mouse emits; a coarse sweep
reads one event of lag as a fraction of its own step size and says nothing about what a user sees.
On that sweep the baseline reads 298px (case 1) and 470px (case 2), and the fix reads 0px on both.

Harness: `~/reports/t3code/2026-09/2026-09-17/queue-drag-layout/review1/w/qlag.mjs` (case 1, the
shipped arm), `qdrift.mjs` (case 1, coarse, kept for the recorded baseline) and `mdrift.mjs` (case 2).

## 2. Scope

- **Must have:** a Queue row dragged over the main list follows the pointer; a main-list row dragged
  onto the Queue header follows the pointer.
- **Not in scope:** the modifier clamps, which hold a healthy drag back the same way on either
  path - `restrictBelowSidebarLabel` near the top of the list and
  `restrictToFirstScrollableAncestor` near the bottom of the scrollport. The offset they impose
  scales with the row: 11-41px measured on a slim row, 57-65px on an 82px card.
- **Consumers:** every sidebar drag, because the overlay is mounted once for the whole list. That
  is deliberate: the cause is shared (section 3, P1/P4), so the fix sits where every crossing picks
  it up rather than at the one that was reported.

## 3. Premises

| #   | Premise                                                                                                                                                         | Source                                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| P1  | dnd-kit gives a drag source a transform only while `over.id` is a member of that row's own `SortableContext.items`: `displaceItem` requires a valid `overIndex` | `@dnd-kit/sortable@10.0.0` `sortable.esm.js`; independent RCA, confirmed by two manipulations |
| P2  | With no `DragOverlay` in the tree, the source element is the only thing that can move, and the raw pointer delta reaches it only through that same gate         | grep: zero `DragOverlay` hits; instrumented `useDragOverlay: false`                           |
| P3  | The sidebar has two sortable contexts (main list, Queue) plus plain droppables, and their item sets are disjoint (10 ids vs 3)                                  | `Sidebar.tsx` outer `SortableContext`; `SidebarQueueBlock.tsx` nested one                     |
| P4  | The same gate parks a main-list row over the Queue header, a plain droppable                                                                                    | RCA prediction test: `overId: "sidebar-queue-drop"`, `overIndex -1`, drift 214                |
| P5  | `active.rect.current` carries the same offset with modifiers already applied, and is public and typed                                                           | `@dnd-kit/core@6.3.1` `PublicContextDescriptor`; measured drift 382 -> 1px                    |

## 4. Approach

A `DragOverlay` renders a copy of the picked-up row, and dnd-kit drives that copy. Mounting an
overlay flips `usesDragOverlay` inside the library, which stops it displacing the drag source at all
and hands the overlay `modifiedTranslate` directly - the one path that carries the pointer delta,
the modifiers and the scroll delta together, in every `over` state.

- The copy is `renderThreadRowInner(thread, section, overlaySortableBag)`, i.e. the same row the
  list draws, rendered in its dragging state. `isDragging` is what suppresses the row's hover
  tooltip and puts the drop verb and the lifted card on the copy the pointer carries; without it
  the tooltip stayed open beside the pointer for the whole drag and the verb sat on the parked row.
- The copy is `aria-hidden` and `inert`, the way the sidebar's own fade clone in `Sidebar.motion.ts`
  is: it is a second rendering of a row that is still in the list, so it must not be reachable or
  announced twice.
- The overlay wrapper is a `div`, not an `li`. An `li` wrapper sat inside the row's own `li` and
  React reported a DOM-nesting error on every page's first drag.
- A queued **draft** has no thread behind it, so it gets its own branch drawing `QueuedDraftRow`.
  Without it the overlay renders nothing and the user drags an invisible row - measured, and the
  arm reports `NO OVERLAY` when the branch is removed.
- Peers keep their sorting preview: the strategy is untouched.
- The source row stays in its slot and keeps its lifted styling, as it already did while parked.

**The subscription sits in the row WRAPPERS, not the rows.** `useDndContext()` rerenders its
consumer on every pointer move, and the row components are memoized precisely to stay out of that.
Reading the offset inside the memoized row cost 16.1 row renders per pointer move against 1.7
without the fix; reading it in the wrapper and folding it into the already-memoized bag costs 3.2,
and 1.7 is itself an undercount because the parked row was not rerendering at all - the drag source
has to rerender per move for the fix to do anything. Both wrappers memoize the bag for this reason;
the Queue's previously did not, which was worth 1 render per queued row per move.

One fallback covers both cases in section 2, because both arrive through the same gate.

## 5. Alternatives

| Alternative                                                     | Why rejected                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Do nothing                                                      | 382px drift on case 1; 214px on case 2                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Carry the offset from `active.rect` (built, measured, rejected) | reached 4px on the headline gesture but is structurally wrong: `active.rect.current.translated` is `draggingNodeRect + modifiedTranslate`, with no scroll term and one render stale. A scroll mid-drag displaced the row by the scroll distance (211px once dnd-kit's own auto-scroll fired at the scrollport edge) and the row never settled when the pointer stopped (residual = last event size, up to 32px). The correct value, `appliedTranslate`, is not public |
| Put the queue keys into the main list's `SortableContext`       | this is the abandoned queue-marker approach from the previous item; measured three regressions and is recorded at `refs/build-task/abandoned/queue-marker-base-c`                                                                                                                                                                                                                                                                                                     |
| Merge both item sets into each context                          | makes `overIndex` valid, but the peers' strategy then runs over a bogus index space and they displace wrongly                                                                                                                                                                                                                                                                                                                                                         |
| Patch the library                                               | proves the mechanism (the RCA used it) but is not shippable                                                                                                                                                                                                                                                                                                                                                                                                           |

## 6. Experiments

The RCA's bidirectional manipulation is the experiment: removing the gate in the served module took
drift 382 -> 0, and forcing `overIndex = -1` everywhere reproduced the parking in both previously
healthy drags. The chosen approach reaches the same number without touching the library.

## 7. Invariants

| #   | Property                                                                 | Check that fails if it breaks                                                |
| --- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| J1  | A Queue row dragged over the main list follows the pointer               | `check.sh` queue-row-follows-pointer                                         |
| J2  | A main-list row dragged onto the Queue header follows the pointer        | `check.sh` main-row-follows-on-header                                        |
| J3  | What follows the pointer settles under it when the pointer stops         | unit test on the hook's guard                                                |
| J4  | Every layout and drop behaviour from the previous item still holds       | the 12 existing arms                                                         |
| J5  | The memoized rows stay out of the per-move render                        | row renders per pointer move: 3.2, against 16.1 with the hook inside the row |
| J6  | A queued draft draws an overlay too                                      | `check.sh` queued-draft-has-an-overlay                                       |
| J7  | The copy opens no tooltip, nests no `li`, is inert, and carries the verb | `check.sh` overlay-hygiene                                                   |
| J8  | The drag presentation is on the copy ALONE; the parked source recedes    | `check.sh` overlay-hygiene                                                   |
| J9  | A queued DRAFT gets the same split: copy lifts, parked row recedes       | `check.sh` queued-draft-split                                                |
| J10 | A release anywhere inside the Queue header enqueues, both edges included | `check.sh` header-edges                                                      |
| J11 | A drop zone only accepts a release where it is actually painted          | `check.sh` clipped-drop-zone                                                 |

## 8. Shared resources

N/A: rendering only.

## 9. Failure behaviour

| Failure                        | Behaviour                       | Operator sees       | Overriding intent |
| ------------------------------ | ------------------------------- | ------------------- | ----------------- |
| `active.rect` not yet measured | fallback returns null, as today | row parks, no crash | -                 |
| Drag cancelled (Escape, blur)  | unchanged                       | row returns         | Escape            |

## 10. Irreversible steps and rollback

None. Revert the commit.

## 11. Surface changes

Web and desktop sidebar. Mobile app has no Queue.

## 12. Tradeoffs and limitations

**A drag now moves a copy of the row, not the row itself.** The source stays in its slot until the
drop lands, and the drop feedback - the verb badge, the lifted card, the raised stacking - travels
with the copy, while the source recedes to 40% opacity so the two are never mistaken for each
other. That split is not automatic: both rows see dnd-kit's `isDragging`, so the presentation is
gated on an explicit `isOverlayCopy` prop instead, and every site that previously keyed off
`isDragging` for appearance had to move to it. That is the visible cost of this approach and it
applies to every sidebar drag, not just the crossings this item is about.

Measured with the overlay: 0px drift in continuous motion, 0px residual after the pointer stops at
final-event sizes of 4, 16 and 32px, and 0px displacement across a 60px scroll mid-drag. The
rejected alternative in section 5 read 4px, 4-32px and "displaced by the scroll" on those same
three.

## 13. Open questions and follow-ups

**A drop in the last ~2px of the Queue header was unreliable, and it was two defects.** Filed from
n=5 and explicitly inconclusive; re-measured properly it split in half.

With entries in the Queue there is no defect at all: 510/510 across the header's full 32px. It
reproduces only with an EMPTY Queue, where the header mounts mid-drag - 19% at the worst pixel
against 100% non-empty, p = 9.4e-09. So the original n=5 was right to be called inconclusive, and
the "both trees" comparison in it was measuring nothing.

The first defect was geometry: as a flex item the header's `h-8` is a basis the column may
compress, and dnd-kit measures a droppable's rect once per drag, so a moment of compression froze a
hit box 2px shorter than the header is drawn (stored 658-688 against a drawn 658-690). `shrink-0`
makes them match exactly. This fixed a real discrepancy and did NOT move the drop rate.

The second was a feedback loop, and it was what actually caused the misses. Every pointer event
toggles the list between two content heights one row apart - rows flip between their
`content-visibility` intrinsic size and their real height - and the list sits within a pixel of its
scroll threshold, so the taller phase scrolls and carries the header up to 2px. dnd-kit decides
`over` on the last pointermove and reuses it at release, so the stored decision describes a layout
the user never released over. The cure is to resolve a Queue drop from the real pointer at release;
`over` is still wrong at release in 8-12 of 20 trials per arm, it is simply no longer what decides.

**The measurement trap worth keeping.** A single synthesized pointer move reads 60/60 even with the
defect live: it teleports the pointer and computes collision once, against a cache taken before the
oscillation starts. Every arm that used one move was an artifact. Multi-event gestures: 55/80
before, 140/140 after. `check.sh` header-edges uses two events for exactly this reason, and covers
the top edge too, which no round had measured.

**The queued-draft row's split is now in place** (it previously never read `isDragging`, so its
copy and its parked row looked identical). A draft's surface is a 4%-opacity tint, so the copy takes
a solid sidebar backdrop on its wrapper instead of the thread row's stacked gradient. Measured by
`check.sh` queued-draft-split.

**The overlay now mounts outside the sidebar list** (it previously sat inside the `<ul>` with a
`<div>` wrapper, which is invalid markup). The first fix made both wrappers list elements, which was
valid but worse: dnd-kit's wrapper became a real `<li>` child of `role="list"` and Chrome announced
it as an extra empty unnamed item for the length of every drag. `aria-hidden` cannot be passed to
that wrapper - `DragOverlay` destructures a closed prop set - so the overlay moved out of the list
instead. It is `position:fixed` and no ancestor establishes a containing block for it, so the move
costs nothing visually. Measured by `check.sh` overlay-markup, which asserts both rules.

That relocation also retired a false measurement: the scrolling arm had pinned "1 row overlaps the
queue header", which was the floating copy - it shares the dragged row's title and sits under the
pointer by design, and was only ever in the list dump because the overlay was mounted there.

## 14. A withdrawn finding, and why it is recorded

A review round filed a MEDIUM that queued draft rows never start a drag at all, which would have
made the whole draft overlay branch dead code. It was false, and the cause is worth keeping: the
shared fixture's seeded snooze expires on a timer. When it lapsed, the snoozed shelf disappeared and
a thread that round had settled stayed settled, so the layout shifted and the draft row moved from
y=751 to y=834 - out of reach of a probe that pressed at a computed row centre. The reviewer's own
discriminator, re-run on a restored fixture, then reported the pickup normally (`Draggable item
...:draft-r5-fixture was moved over droppable area ...`, `overlay:true`, `moved:4`).

Two consequences, both applied: `check.sh` opens with a `fixture-shape` pre-flight arm that must
print `FIXTURE OK`, and a measurement taken either side of a `FIXTURE STALE` is void rather than
reportable.

**The header's hit test now checks that the zone is painted, not just laid out.** A drop zone docked
at the end of a scrolling list can sit beyond its scroller's clip: at a 500px viewport the Queue
header is laid out at 428..460 against a clip ending at 424, for the whole drag, invisible but
geometrically live. A rect-only test accepted a release there - measured 2/2 - so a release aimed at
whatever IS painted at that point silently enqueued instead.

Two review rounds called this unreachable and were right to refuse to report from vacuous arms, but
the conclusion was wrong: the variable was the GESTURE. Approaching the point gradually makes the
header move and become visible, which erased the condition every time. Parking the pointer and
jumping once keeps it - for a VARYING number of the eight trials. Three independent measurements of
the same arm on the same source gave 2, 4 and 8; the header sometimes holds still at 428..460 for the
whole run and sometimes climbs to ~345, because the seeded fixture ages while the run executes (rows
auto-settle, shelves resize) and a landed drop changes the queue's height. **Do not quote a count
here** - this doc has now carried three, two of them wrong. The arm prints its own n, and reads
VACUOUS rather than PASS when the condition never holds, which is the property that matters. On the
trials that hold, across every run: with the guard 0 enqueue, without it all of them, and the
painted-header control is 3/3 either way.

The rule is deliberately narrow - the nearest ancestor that actually scrolls, and only when it has a
box to clip with. A first version walked every non-visible ancestor and rejected legitimate points
whenever one measured 0x0. This doc, the source comment, and the body of commit `eefe48d93` all said
an existing detector test caught that - the claim is WITHDRAWN, and the commit message cannot be
edited, so this paragraph is the correction of record. It was never committed, so it can only be rebuilt from its
description, and three reconstructions redden between one and six of this rule's own unit tests and,
every time, zero of the 19 pre-existing detector tests. The reconstructions disagree on the count,
which is itself the reason not to quote one.

`pointerOverVisibleRect` has two consumers. The collision detector is covered twice - by the
`Sidebar.drag.dom` tests, each shown red under a mutation of the line it pins, and by the
`clipped-drop-zone` arm. The release resolve in `handleThreadDragEnd` is covered by that arm ALONE:
mutating it to plain containment leaves the whole web suite green - which proves nothing on its own,
because NO test loads `Sidebar.tsx` at all (replacing its first line with a syntax error also leaves
451 files and every test green). The arm is the only thing watching that consumer. The arm reports the same
`CLIP GUARD BAD` whichever consumer is broken, so it cannot say WHICH one regressed - only the unit
tests can, and only for the detector.

A fifth review round mutated every operand of the guard in turn - 29 mutations - and found three that
the suite could not see, all of them live-reachable:

- The clip box's TOP edge. Dragging a row downward auto-scrolls the list until the header sits at
  73..105 under a viewport starting at 96, so its top 23px are unpainted; dropping `pointer.y >=
box.top` enqueued wrongly 5 times out of 5 with 6032 tests and all 20 arms green. Every existing
  check sampled the BOTTOM edge only.
- The zone rect's RIGHT edge. No arm can discriminate a horizontal operand - every probe fixes x at
  the dragged row's centre and varies only y - so releasing 5px right of the header enqueued 3/3.
- The ancestor WALK. Three non-scrolling elements sit between the header and the scroll viewport
  live, but every fixture made the scroller the node's direct parent, so `continue` -> `break` left
  the guard inert in production with the whole suite green.

The lesson generalizes past this guard: a fixture can be wrong in the value it supplies (round four
found a test pinning `auto` when production computes `scroll`) or in the SHAPE it builds, and both
read as full coverage. The fixtures now carry the live depth, and each edge has its own assertion.

"Nearest scrolling ancestor" is the right clipper here, not a convenient one. Measured live across
seven viewport sizes: between the Queue header and the sidebar's scroll viewport every ancestor is
`overflow-y: visible`; the nearest `overflow: hidden` element sits ABOVE the viewport with an
identical box, and the one conditional hidden below it is unreachable because the sidebar is
`collapsible="offcanvas"`. Honouring `hidden` too would therefore change nothing today and could
only ever reject legitimate points, so the rule stays `auto|scroll` and a test pins it.
