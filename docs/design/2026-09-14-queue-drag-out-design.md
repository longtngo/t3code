# Drag queued threads out of the Queue — design

## 1. Goal and baseline

A thread in the sidebar Queue can be dragged into Pinned, Active or Settled. The drop removes it from the Queue and applies that section's action (pin, place in Active, settle), the same as dragging any other thread there.

Baseline: unmeasurable on the untouched tree (`baseline.sh` record `queue-drag-out`). Queue rows live in their own nested `DndContext` (`SidebarQueueBlock.tsx:142-157`) whose `onDragEnd` only reorders (`:61-70`); nested dnd-kit contexts cannot see each other's droppables, so no other section is reachable.

## 2. Scope

In: `SidebarQueueBlock.tsx`, the drag handlers and collision setup in `Sidebar.tsx`, drop-target resolution in `Sidebar.logic.ts` / `Sidebar.drag.ts`.

Knowingly left:

- **Queued drafts** keep reorder-only. A draft has no server thread, so it cannot be pinned, placed or settled; its way out stays the "Remove from queue" button (and the draft row context menu shipped separately). Dragging it onto "Not started" is not added.
- **Dropping an Active thread onto a queue row** stays unsupported; the Queue header remains the way in (unchanged).
- **Live gap preview in the destination.** The main list's sorting strategy animates a gap only for rows that are members of its own `SortableContext`. A queued row is not, so the destination shows the existing section highlight and drag labels, not an opening gap. Rejected alternative in section 5.
- `LegacySidebar.tsx` has no Queue. Mobile app has no Queue.

## 3. Premises

| #   | Premise                                                                                                                                                        | Source                                                                                                                                                  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | A queued thread is hidden from every section, whatever its resting section (pinned, active, snoozed, settled)                                                  | `Sidebar.tsx:3009-3015` filters `queuedKeys` before classification                                                                                      |
| P2  | Queue order and membership are a device-local zustand store with synchronous `enqueue`/`remove`                                                                | `threadQueueStore.ts:83-104`                                                                                                                            |
| P3  | One `DndContext` can host several `SortableContext`s; a row is displaced only when the active and over ids are both in its own context, otherwise it stays put | `@dnd-kit/sortable` `sortable.esm.js:310-314, 507-517` (design reviewer); `Sidebar.drag.ts` strategy returns stationary transforms for `activeIndex -1` |
| P4  | `resolveSidebarDropTarget` returns null when the active id is not in `items`                                                                                   | `Sidebar.logic.ts:157`                                                                                                                                  |
| P5  | The main list cancels any drag whose active key is not a main-list thread row                                                                                  | `Sidebar.tsx:3905-3912`                                                                                                                                 |
| P6  | Drag start ignores keys missing from `sectionByThreadKey`, which excludes queued threads                                                                       | `Sidebar.tsx:3833-3835`, `:3694-3706`                                                                                                                   |
| P7  | `planSidebarThreadDrop` returns `none` for a same-section drop that changes nothing (e.g. settled → settled)                                                   | `Sidebar.logic.ts:279`, `:284-289`                                                                                                                      |

## 4. Approach

**One drag context.** `SidebarQueueBlock` drops its own `DndContext` and sensors and keeps only a `SortableContext` over the queue keys, so queue rows join the main list's `DndContext` (the block already renders inside it, `Sidebar.tsx:5367`). Queue reorder moves into the main `onDragEnd`.

**Drag state** gains `fromQueue: boolean`. For a queued thread, `activeSection` is its resting section (`sidebarRestingSection`), so the existing plan logic (unpin, unsettle, unsnooze) applies unchanged.

**Target resolution for a row that is not in the list.** New pure helper in `Sidebar.logic.ts`:

```
withQueuedRow(items, key, restingSection):
  slot = index of first "snoozed-header" or "settled-header" marker, else items.length
  return items with {kind: "thread", key, section: restingSection} inserted at slot
```

The slot is where the Queue renders (`pushQueue` runs before those two markers). Target resolution, collision boundary logic and the verb badge use `withQueuedRow(sidebarListItems, activeKey, restingSection)` when `fromQueue` (the resting section seeds the pinned/active divider logic in `createSidebarCollisionDetection`). With no shelves (compact, or no settled/snoozed markers) the slot is the end of the list, which is where `pushQueue` renders last, so arrayMove semantics (land after `over` when moving down, before when moving up) match what the pointer sees.

**Validity** (collision filter), by origin:

```
queue draft      → valid iff id is a queue key
queue thread     → id is a queue key: valid
                   else target = resolve(withQueuedRow(...)); valid iff
                     target != null and (plan.kind != "none" or target.section == restingSection)
main-list thread → queue keys are removed from the collision list before choosing (`excludeIds`, beside `pointerDropIds`),
                   then the existing rule
```

**Drop** (`onDragEnd`), queue origin:

```
over is a queue key      → enqueue(entry, indexOf(over))            // reorder, as today
target resolves (valid)  → queue.remove(key); if plan.kind != "none": run the existing plan path
else                     → nothing
```

Removal runs first and synchronously, so the thread is back in its resting section in the same render that sets `optimisticDrop` (whose `sourceSection` is the resting section).

**Feedback.** The lifted row's badge shows the section verb (`resolveSidebarDropVerb(resting, target)`); for a drop back into its resting section it shows a new `unqueue` verb ("Unqueue", list-x icon). The Queue header's dashed drop-zone styling shows only for main-list drags. Placeholder hints that assume the dragged row left its section (`from === "active" && activeThreads.length === 1`) ignore queue-origin drags. The compact snoozed-footer `DragOverlay` shows only for main-list snoozed rows, never for a Queue row resting in snoozed.

## 5. Alternatives

| Alternative                                                                          | Why rejected                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Do nothing / "Remove from queue" then drag                                           | Two steps and the thread lands in its resting section, not where the user points                                                                                                                                      |
| Keep nested context; hit-test `elementsFromPoint` on release                         | No hover feedback, bypasses the collision rules, duplicates target logic                                                                                                                                              |
| Make queue rows members of the main list (`section: "queued"` in `sidebarListItems`) | Full gap preview, but changes `resolveSidebarDropTarget`, the section projection in `createSidebarSortingStrategy` and the pinned/active boundary logic for every drag. Much larger blast radius for a preview nicety |

## 6. Experiments

N/A.

## 7. Invariants

The drop rules live as pure functions in `Sidebar.logic.ts` (`sidebarDragLostItsRow`, `isSidebarDragCandidate`, `routeSidebarDragEnd`, `sidebarDragListItems`); `Sidebar.tsx` only executes the route.

| #   | Property                                                                                                                                                                                       | Check that fails if it breaks                                                                                                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1  | A queue-origin drag is not cancelled by the "row left the list" effect                                                                                                                         | `Sidebar.logic.test.ts` "keeps the drag alive while its row is only in the Queue"                                                                                |
| I2  | `withQueuedRow` + `resolveSidebarDropTarget`: over an active row → active with the key in order; over a pinned row → pinned; over `settled-header` → settled; shelfless list → slot at the end | "resolves a Queue row as if it sat above the shelves", "puts a Queue row at the end"                                                                             |
| I3  | Dropping a queued thread on its own resting section is a candidate and only unqueues                                                                                                           | "allows dropping a queued thread back on its resting section"; verb test                                                                                         |
| I4  | A queue draft never resolves or collides with a main-list target                                                                                                                               | "never lets a queued draft leave the Queue"                                                                                                                      |
| I5  | Main-list drags never pick a queue row                                                                                                                                                         | `Sidebar.drag.test.ts` excluded-ids test; "keeps main-list drags on their existing rules"                                                                        |
| I6  | Queue reorder routes to the over entry; a drop on itself does nothing                                                                                                                          | "reorders within the Queue"                                                                                                                                      |
| I7  | Unqueue happens before any server command; a failed command leaves the thread unqueued with the existing toast                                                                                 | route carries `unqueue: true` (tested); the order inside `handleThreadDragEnd` is one synchronous line before the plan and is verified by reading, not by a test |

## 8. Shared resources

Queue store: written by `enqueue`/`remove` from menus, buttons, the queue runner (`claimHead`) and now the drop. All synchronous zustand sets; the runner claims the head before sending. Race: the runner claims the dragged thread mid-drag → the entry leaves `entries`; on drop `remove` is a no-op and the plan still runs on a thread that is now sending. Acceptable: the section action applies to a running thread, as it would from the context menu.

## 9. Failure behaviour

| Failure                                    | Behaviour                                                           | Operator sees                   | Overriding intent                       |
| ------------------------------------------ | ------------------------------------------------------------------- | ------------------------------- | --------------------------------------- |
| Server rejects pin/settle/reorder          | thread stays unqueued in resting section; `optimisticDrop` released | existing error toast            | redo the drag or re-queue from the menu |
| Drop on no valid target                    | nothing                                                             | row returns to Queue            | —                                       |
| Escape / window blur                       | sensor cancels                                                      | row returns to Queue            | Escape                                  |
| Entry claimed by the queue runner mid-drag | drag continues; drop applies the plan                               | thread starts sending and moves | —                                       |

## 10. Irreversible steps and rollback

Settle is reversible (un-settle). Unqueue is reversible (re-queue). Revert the commit to roll back.

## 11. Surface changes

- Web / desktop sidebar. Mobile web: same sensor as today. Mobile app: N/A.
- Contracts, server: N/A.
- Docs: N/A unless `docs/user` describes Queue drag; check during implementation.

## 12. Tradeoffs and limitations

No gap preview in the destination (rejected: queue rows as main-list members, section 5). Drafts cannot be dragged out (no server thread to act on).

## 13. Open questions and follow-ups

None.

## 14. Review exit note

6a skipped: no service boundary, data model, dependency, rollout or side-effecting agent action changes (client-only drag handling).

6b round 1 (one reviewer, Correctness + Simplicity, built and ran a prototype): CONDITIONAL GO. Applied: resting section seeds the divider logic (pseudocode changed), compact snoozed overlay excluded for Queue rows, P3 sourced, I2 reworded. Rejected: the prototype's one-line wrapper helpers and store-only I6/I7 tests (they assert zustand, not the drop). Round 2 is carried into the code review of the implementation, where the changed pseudocode now exists as running code; the remaining questions (first `dragOver` before the re-render that adds the Queue row, queue runner claiming a dragged row) are code-shaped.

Sanitize round 1 (built and ran it, mutated each guard): no production blocker; I1, I3, I4, I6, I7 had no failing test. Fixed by extracting the drop rules into the pure functions above and testing them (each guard mutation now goes red, I7 order excepted as noted). Also applied: `onDragOver` resolves inside the state updater so the first move after pickup sees the Queue origin; `draggedSettledOrder` skips Queue rows. Rejected: hiding the Settled header's drop chrome for Queue drags, since Settled is a valid target for them.

Re-review round 2 (built and ran it): no blockers; every refactored path matches the old handling except one, a main-list drop planned from the drag-start section instead of re-reading it. Restored. Left: the collision detector can use the previous render on the very first frame after pickup (drop resolution does not), and the I7 order is read, not tested.
