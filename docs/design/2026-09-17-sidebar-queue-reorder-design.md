# Sidebar Queue drag reorder — design

## 1. Goal and baseline

Dragging a row inside the sidebar Queue reorders the Queue, as dragging inside Pinned or Active does.

Baseline (`baseline.sh record queue-drag-reorder`, tree `c47972335`, isolated dev server): a paused queue `[remote-command-center, beautiful-boot, handoff-haptics]`, row 1 dragged to 80% down row 3 at pointer x=128, gives `REORDER FAILED` (order unchanged, rc 1). Harness: `~/reports/t3code/2026-09/2026-09-17/queue-reorder/repro.mjs`.

## 2. Scope

- **Must have:** reorder inside the Queue at any pointer x, for queued threads and queued drafts.
- **Also fixed (same line, same mechanism):** a queued thread resting in Pinned, dragged up into Active, dropped as a pin, because the Pinned/Active switch started from its resting section.
- **Not in scope:** other Queue drag-out rules and main-list drags; unchanged.
- **Consumers of the mechanism:** the Pinned/Active boundary override in `createSidebarCollisionDetection` runs for every thread drag in `Sidebar.tsx`. Main-list drags already drop queue ids (`excludeIds`), so the change can only affect Queue-origin drags. `LegacySidebar.tsx` has no Queue and its own detector.

## 3. Premises

| #   | Premise                                                                                                                                                                                                                                                                                   | Source                                                                                                                                                           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | For a Queue-origin drag, the boundary override promotes the dragged row itself: the row is in `items` (via `withQueuedRow`) and resolves to `active`; other queue rows resolve to null. The detector then returns with `over` = the dragged row, and `routeSidebarDragEnd` returns `none` | Independent RCA, dnd-kit context read through React fibers: `over` stayed the dragged row for all 20 steps; `Sidebar.drag.ts:73-109`, `Sidebar.logic.ts:258-261` |
| P2  | Only pointer x decides it: the same drag at x=245 or x=10 (outside the divider label, x 19-237) gives `REORDER OK`                                                                                                                                                                        | RCA A/B runs                                                                                                                                                     |
| P3  | Drop handler and store are correct                                                                                                                                                                                                                                                        | P2; store spy saw no `enqueue`/`remove` call on the failing drop                                                                                                 |
| P4  | A queued thread resting in Pinned starts with `boundarySection = "pinned"`: dragging up inside the Queue lands on the divider (unqueue + pin), and dragging up into Active pins it                                                                                                        | `Sidebar.drag.ts:77`; design reviewer's synthetic matrix on the real detector, all four resting sections                                                         |
| P5  | Queued drafts take the same path: `sidebarDragListItems` adds any Queue drag to `items`, drafts included, so they fail the same way                                                                                                                                                       | `Sidebar.logic.ts:202`; reviewer live runs: 3/3 draft reorders fail before, 3/3 pass with the fix                                                                |

## 4. Approach

The boundary override decides Pinned vs Active while the pointer is in the main list. It should not run while the pointer is over the Queue.

`createSidebarCollisionDetection` gains an option `freeIds`: sortable ids outside the section list (queue rows). Before the override:

```
if collisions[0].id in freeIds: do not promote a section row (keep distance order)
boundarySection starts as "active" when the dragged row is in freeIds, else its section
```

Pointer tracking and section switching keep running while a queue row is nearest; only the promotion is skipped. Skipping the whole block instead froze `previousPointerY`, so a drag that visited Pins, dipped into the Queue and flicked back into the divider label read the wrong direction and dropped into Active (both sanitize reviewers, independently).

The dragged row is itself a queue key, so it needs no special case: when it is nearest, `over` is the row and the drop is a no-op, as before.

`Sidebar.tsx` passes `freeIds: [...queuedKeys]` for Queue-origin drags (main-list drags already exclude them). Then the nearest queue row is `over`, the existing validity rule accepts it (`isSidebarDragCandidate`: queue key + `fromQueue`), and the existing `reorder-queue` route applies.

Hard Rule 11: `excludeIds` and `pointerDropIds` are the precedent for id-list options on this detector; no helper exists that tells the detector which ids are outside `items`. `resolveSidebarDropTarget(...) === null` would also mark them, but the dragged row itself resolves, and an explicit list keeps the rule to queue rows (section 5).

## 5. Alternatives

| Alternative                                            | Why rejected                                                                                                                        |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Do nothing                                             | Reorder fails whenever the pointer is inside the divider label's x range, which spans the whole sidebar width (P2)                  |
| Never promote `active.id` in the override              | Then a main-list active row is promoted instead and the drop unqueues into Active rather than reordering                            |
| Skip the override for all Queue-origin drags           | Loses Pinned vs Active switching when a queued thread is dragged out near the divider                                               |
| Treat unresolvable nearest ids as free (no new option) | Works today, but a marker or future non-row droppable would silently disable the override; explicit ids keep the rule to queue rows |

## 6. Experiments

N/A: the RCA's pointer-x A/B already isolates the cause.

## 7. Invariants

| #   | Property                                                                                                                | Check that fails if it breaks                                                                                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1  | Queue-origin drag whose collision rect is nearest a queue row: `over` is that row, any resting section, drafts included | "picks the nearest queue row inside the divider label's width" (4 sections); live harness `REORDER OK` at x=128                                                                   |
| I2  | Queue-origin drag over the main list: the Pinned/Active switch still applies, starting in Active                        | "still switches to Pinned when the pointer crosses the divider" (card held off-centre, so distance alone cannot pass it); "starts in Active even when the thread rests in Pinned" |
| I3  | Pointer direction stays current while a queue row is nearest                                                            | "keeps tracking the pointer while a queue row is nearest"                                                                                                                         |
| I4  | Main-list drags unchanged                                                                                               | existing "switches on crossing the divider row" cases                                                                                                                             |

## 8. Shared resources

N/A: no new writer; the Queue store write path is unchanged.

## 9. Failure behaviour

| Failure                        | Behaviour                | Operator sees        | Overriding intent |
| ------------------------------ | ------------------------ | -------------------- | ----------------- |
| Drop on the dragged row's slot | `none`, as today         | row returns to place | —                 |
| Escape / blur                  | sensor cancels, as today | row returns to place | Escape            |

## 10. Irreversible steps and rollback

None. Revert the commit.

## 11. Surface changes

Web and desktop sidebar only. Mobile app has no Queue. No contract or server change.

## 12. Tradeoffs and limitations

While a queue row is nearest, a Queue-origin drag keeps distance order instead of the Pinned/Active promotion; the section switch itself keeps tracking the pointer. That is the intent (alternative: skip for all Queue drags, rejected in section 5).

## 13. Open questions and follow-ups

None.

## 14. Review exit note

6a skipped: no service boundary, data model, dependency, rollout or side-effecting agent action (client-only collision rule).

6b round 1 (one reviewer, Correctness + Simplicity, built and ran three variants live and on synthetic geometry): applied all. Drafts are affected (premise was false, now P5); the Pinned-resting drag-out sibling is fixed here (P4); block skip instead of promotion skip; I1 reworded to the collision rect. Pseudocode changed, so round 2 is the code review of the implementation.

Implementation: mutation of `!overFreeRow` → 4 red, of the Active start → 1 red. A "nearest other than the dragged row" step was an equivalent mutant (the dragged row is a queue key) and was removed.

Sanitize round 1 (two reviewers, both built and ran it; one fuzzed 15,000 random walks against the old detector): applied all. Promotion-only skip replaces the block skip (stale `previousPointerY`, now I3); the Pinned-switch test held the card off-centre so it can fail (the "skip for every Queue drag" mutant had passed it); fixture uses `layout` with the real `active-placeholder`. Mutants now red: no promotion guard (5), no Active start (1), any free collision (2), block skip (1). Main-list drags: 0 differences from the old detector over ~5,000 walks. Security: N/A (client-only pointer geometry).
