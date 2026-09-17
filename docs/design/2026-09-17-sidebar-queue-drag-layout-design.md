# Sidebar drag layout around the Queue — design

## 1. Goal and baseline

No sidebar element overlaps another mid-drag, whether the drag starts in the main list or in the Queue.

Baseline (`baseline.sh record queue-drag-layout-overlaps`, `personal` at `18b22de22`, live dev server): `LAYOUT OVERLAPS total=10`.

- Queue drags (2 × 3): the "Pinned" and "Active" labels stack on each other and on the first Active row.
- Main-list drags (2 × 2): the Active rows and the drop gap slide under the Queue header and its first row.

Harness: `~/reports/t3code/2026-09/2026-09-17/queue-drag-layout/overlap.mjs`; the full arm set is `check.sh` beside it.

## 2. Scope

- **Must have:** a main-list drag never draws over the Queue; a Queue drag draws no stacked labels.
- **Not in scope:** a Queue row dragged over the main list does not follow the pointer (pre-existing; next follow-up). Collapsed-Queue reorder (product call).
- **Consumers:** `SidebarQueueBlock` (rendering only). The collision detector, drop resolution and the sorting strategy are untouched, which is what keeps the blast radius small.

## 3. Premises

| #   | Premise                                                                                                                                                                                               | Source                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| P1  | dnd-kit applies a list's sort preview only when the dragged row belongs to that list, so a Queue drag cannot move main-list rows                                                                      | `@dnd-kit/sortable` `sortable.esm.js:507`                                                     |
| P2  | The sidebar list is a flex column whose shelves are pushed down by `mt-auto`, so an element marked `mt-auto` earlier takes that free space instead                                                    | `Sidebar.tsx` shelf headers; measured: header at 534 mid-drag vs 345 at rest                  |
| P3  | A drop zone that moves with the drag preview is a target the pointer chases: measured on the abandoned approach, a Settled/Snoozed row aimed at the header queued 0/5 while the header slid 397 → 478 | review round 2, `refs/build-task/abandoned/queue-marker-base-c`                               |
| P4  | Queue rows are not drop targets during a main-list drag (only the header is), so hiding them removes nothing reachable                                                                                | `Sidebar.logic.ts` `isSidebarDragCandidate` (queue keys valid only `fromQueue`), `excludeIds` |

## 4. Approach

While a main-list drag runs, `SidebarQueueBlock` renders its header only, and that header takes `mt-auto`, docking above the Snoozed/Settled shelves:

- the rows the preview would have covered are gone, so nothing can overlap them;
- the freed height plus the shelf slack absorbs the label space and any cross-section growth;
- the drop zone sits in the sidebar's empty region, where no preview moves it (P3);
- the header carries the count (`Queue (3)`) while the rows are hidden, exactly as a user-collapsed Queue does;
- the open thread keeps its Queue row, again as in a user-collapsed Queue.

**The collapse is skipped when the thread list already scrolls** (measured at pickup, `sidebarScroller`). Removing height from a scrolling list makes the browser clamp `scrollTop`, which slides every row - the picked-up one included - out from under the pointer; a restore effect cannot undo it, because the clamp is a physical bound (max `scrollTop` 76 against a stored 150). A scrolling sidebar therefore keeps `personal`'s behaviour: no collapse, and no new jump.

`SidebarDragBoundary` labels stay hidden for Queue-origin drags (the measured Q1 arm, which stays as it is).

No change to drop resolution, collisions, the sorting strategy or list motion.

## 5. Alternatives

| Alternative                                                               | Why rejected                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Do nothing                                                                | 10 overlaps mid-drag                                                                                                                                                                                                                                                       |
| Move the Queue block with the preview (a `queue` marker in the main list) | Built and measured over two review rounds: broke Queue drag-out (clamped against the nested list), made header enqueue flaky 4/8, and left a shelf-origin drop at 0/5 because the zone runs from the pointer (P3). Kept at `refs/build-task/abandoned/queue-marker-base-c` |
| Labels take real height during Queue drags                                | measured: card drifts 15px from the pointer and the sidebar scrolls at pickup                                                                                                                                                                                              |
| Keep the Queue rows and dock only the header                              | the rows still sit under the opened space                                                                                                                                                                                                                                  |

## 6. Experiments

`~/reports/t3code/2026-09/2026-09-17/2026-09-17-queue-drag-layout-experiment.md` (Q0/Q1/Q2), plus the two review rounds on the abandoned approach.

## 7. Invariants

| #   | Property                                                                         | Check that fails if it breaks                                                                                           |
| --- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| I1  | A main-list drag hides the Queue rows                                            | `SidebarQueueBlock.dom.test.tsx` "collapses to a docked header…"                                                        |
| I2  | The header docks above the shelves during a main-list drag                       | same test (`mt-auto`)                                                                                                   |
| I2b | The hidden rows are accounted for by the header count                            | same test (`Queue (2)`)                                                                                                 |
| I3  | Nothing overlaps mid-drag, from either origin                                    | `check.sh` overlaps (10 on `personal`)                                                                                  |
| I4  | A drop on the header queues the thread, from Active, Settled and Snoozed origins | `check.sh` header-enqueue-3queued / -empty / shelf-flick-settled / -snoozed (shelf arms fail on the abandoned approach) |
| I5  | Queue drags still reorder and can leave the Queue                                | `check.sh` dragout-to-active, mid-block-stays-queued; `metrics.mjs`; `repro.mjs`                                        |
| I6  | A drag in an already-scrolling sidebar keeps the row under the pointer           | `check.sh` scrolled-card-tracks-pointer (drift <= 20px)                                                                 |
| I7  | Both shelves expanded, no scroll: the header is clear                            | `check.sh` dense-shelves-open (tall viewport)                                                                           |
| I8  | The same fixture while scrolling stays exactly as `personal` draws it            | `check.sh` dense-scrolling-parity (1 overlap, measured identical on `18b22de22`)                                        |
| I9  | The arms run against a fixture that has not decayed                              | `check.sh` fixture-shape (the seeded snoozes expire; the store drops unresolvable queue ids)                            |
| I10 | A scrolling list keeps its rows and takes no auto margin                         | `SidebarQueueBlock.dom.test.tsx` "keeps the rows in place…" (`dragging` true, `collapse` false)                         |

## 8. Shared resources

N/A: rendering only.

## 9. Failure behaviour

| Failure                       | Behaviour               | Operator sees        | Overriding intent |
| ----------------------------- | ----------------------- | -------------------- | ----------------- |
| Drop outside any target       | unchanged               | row returns          | —                 |
| Drag cancelled (Escape, blur) | the Queue expands again | rows return in place | Escape            |

## 10. Irreversible steps and rollback

None. Revert the commit.

## 11. Surface changes

Web and desktop sidebar. Mobile app has no Queue.

## 12. Tradeoffs and limitations

The queued rows are not visible while a main-list drag runs; the header keeps its count ("Queue (3)") and stays the drop target. Rejected alternative: move the Queue with the preview (section 5) — it keeps the rows visible and costs three measured regressions.

Two further limitations, both accepted:

- **A scrolling sidebar gets no collapse**, so a main-list drag there still draws over the Queue rows, as it does on `personal` today. Collapsing would cost the pointer its grip on the dragged row, which is worse than the overlap it removes. Measured 2026-09-17 with both shelves open at a 900px viewport: the mid-drag geometry is byte-identical on this branch and on `18b22de22`, one overlap either way (29px; 32px once a fixture reorder put a different row in the slot, which is why the arm asserts the count and not the pixels).
- **The docked header floats in the free space** rather than sitting tight above the shelves, because the shelf headers hold their own `mt-auto` and the two split what is free. Giving the shelves' margin up measured two new overlaps (queue header x snoozed header, 29px), so the float stays.

## 13. Open questions and follow-ups

A Queue row dragged over the main list does not follow the pointer (next branch).

## 14. Review exit note

6a skipped: client-only rendering change. The first approach was built and reviewed twice live; its regressions are recorded in section 5 and its arms are kept in `check.sh`.
