# Right-panel tab reorder — design

## 1. Goal and baseline

The user can drag a right-panel tab left or right to change tab order, and the order sticks (per thread, across reloads).

Baseline (`baseline.sh`, untouched tree `e7c021c10`): `grep -c moveSurface` in `rightPanelStore.ts` and `RightPanelTabs.tsx` = **0 / 0**. No way to change order exists; new tabs append (`rightPanelStore.ts:325-327`).

## 2. Scope

In: `RightPanelTabs.tsx` tab strip, a `moveSurface` action in `rightPanelStore.ts`, and the three `RightPanelTabs` mounts: `ChatView.tsx` inline and sheet, `routes/_chat.pull-requests.tsx`.

Knowingly left:

- Mobile app (React Native) has no right panel.
- Keyboard reordering. Tabs today have no keyboard focus order of their own beyond buttons; a context-menu "Move left/right" can follow if wanted.
- Dragging a tab to another thread or window.

## 3. Premises

| #   | Premise                                                                                                                                                                           | Source                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| P1  | Tab order is the order of `ThreadRightPanelState.surfaces`, and that array is persisted                                                                                           | `RightPanelTabs.tsx:1238` maps `props.surfaces`; `rightPanelStore.ts:414` migrates persisted `surfaces` |
| P2  | Every mount renders the store's array unfiltered                                                                                                                                  | `ChatView.tsx:2102` and `_chat.pull-requests.tsx:460`: `rightPanelPresence.value?.surfaces ?? []`       |
| P3  | `closeSurfacesToRight` and "Undo closed tab" read array order, so reorder must change the array, not a view                                                                       | `rightPanelStore.ts:807-822`                                                                            |
| P4  | `@dnd-kit/core`, `sortable`, `modifiers` are already dependencies                                                                                                                 | `apps/web/package.json:18-21`                                                                           |
| P5  | On desktop the tab bar is a window drag region and each tab opts out with `no-drag`                                                                                               | `RightPanelTabs.tsx:1221, 1260`                                                                         |
| P6  | `[unsourced]` A pointer drag that crosses a `drag-region` gap between tabs in Electron can lose mouse events; clearing the bar's `drag-region` while a tab drag is live avoids it | reviewer to probe if a desktop build is reachable                                                       |

## 4. Approach

Store: `moveSurface(ref, surfaceId, toIndex)` — a `userAction` that removes the surface and inserts it at the clamped index; returns `current` unchanged when the id is missing or the index is the same (no revision bump for a no-op... `userAction` always bumps the revision, so the no-op check returns before calling it).

Tabs: wrap the tab list in `DndContext` + `SortableContext` (`horizontalListSortingStrategy`), modifiers `restrictToHorizontalAxis`. Each tab `div` uses `useSortable({ id: surface.id })` and applies its transform. Sensors:

- `MouseSensor` with `distance: 4`, so clicks, middle-click close and the close button keep working.
- `TouchSensor` with `delay: 250, tolerance: 5`, so a swipe still scrolls the strip on the mobile-web sheet and a long press lifts the tab.

`onDragEnd` computes the target index from `over.id` and calls a new prop `onMoveSurface(surfaceId, toIndex)`. The three mounts pass `(id, index) => useRightPanelStore.getState().moveSurface(ref, id, index)`.

While a drag is live the bar drops its `drag-region` class (P6).

## 5. Alternatives

| Alternative                      | Why rejected                                                                                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Do nothing                       | The ask                                                                                                                                        |
| Native HTML5 drag and drop       | Does not fire on touch, so the mobile-web sheet would not get it                                                                               |
| `PointerSensor` alone            | On touch, the browser's pan claims the pointer and cancels the sensor unless the tab sets `touch-action: none`, which blocks swiping the strip |
| Context-menu "Move left / right" | Not what was asked; can be added later for keyboard users                                                                                      |

## 6. Experiments

N/A.

## 7. Invariants

| #   | Property                                                                                                                                                 | Check that fails if it breaks      |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| I1  | `moveSurface` keeps the same set of surfaces and `activeSurfaceId`                                                                                       | store test                         |
| I2  | A missing id or same index returns the same state object (no persisted write, no revision bump)                                                          | store test                         |
| I3  | A click on a tab (no movement) still activates it; the close button still closes                                                                         | dom test                           |
| I4  | A mouse drag onto a neighbour calls `onMoveSurface(id, index)`; a touch hold that fires the long-press menu keeps it until the tab moves, then closes it | `RightPanelTabs.drag.dom.test.tsx` |

## 8. Shared resources

`rightPanelStore` persisted state, written by many actions, all synchronous zustand `set`s. No ordering hazard: each action reads `current` inside `set`.

## 9. Failure behaviour

| Failure                                           | Behaviour                                               | Operator sees                         | Overriding intent                  |
| ------------------------------------------------- | ------------------------------------------------------- | ------------------------------------- | ---------------------------------- |
| Drop outside the strip                            | no move                                                 | tab snaps back                        | —                                  |
| Surface closed/reconciled away mid-drag           | `moveSurface` no-ops on the missing id                  | tab gone                              | —                                  |
| Escape during drag                                | dnd-kit cancels                                         | tab snaps back                        | Escape                             |
| Touch hold also fires the long-press context menu | menu opens while still; `onDragMove` past 5px closes it | menu, then it closes as the tab moves | lift without moving keeps the menu |

## 10. Irreversible steps and rollback

None. Order is cosmetic; revert the commit.

## 11. Surface changes

- Web, desktop, mobile-web sheet: drag to reorder. Mobile app: N/A.
- Contracts, server: N/A. Persisted shape: unchanged (array order only).
- Docs: N/A.

## 12. Tradeoffs and limitations

Touch needs a 250 ms hold (rejected: immediate touch drag, which would make the strip unscrollable).

The lifted tab is clipped at the strip's scroll edges (rejected: a `DragOverlay` portal, extra machinery for a few pixels; dnd-kit auto-scrolls the strip when the pointer reaches an edge).

## 13. Open questions and follow-ups

None.

## 14. Review exit note

6a skipped: client-only UI change, no pillar trigger. 6b round 1 (Correctness + Simplicity, built and ran it): CONDITIONAL GO. Its must-fix (all three mounts pass `onMoveSurface`) was already in the branch; the reviewer had cloned mid-edit. Clip at scroll edges recorded as a limitation. P6 stays unsourced: no Electron run. No pseudocode, invariant or boundary change; quiescent after round 1.

Sanitize round 1 (built and ran it): blocker, the touch hold opened the tab context menu under a live drag. Fixed by closing the menu once the drag moves (the reviewer's "never open on touch" would have removed the only touch path to Close others / Close to the right). Added drag-wiring dom tests; mutations of the move call, the listener chain and the close all go red.
