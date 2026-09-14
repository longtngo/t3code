# Draft row context menu — design

## 1. Goal and baseline

A "Not started" (draft) row in the sidebar gets a context menu, so a touch user can add it to the Queue (and discard it). Today its only actions are two hover-revealed buttons, which a phone never shows.

Baseline (`baseline.sh`, untouched tree `e7c021c10`): `onContextMenu` occurrences inside `SidebarDraftRow` = **0** (the same probe reads 7 inside `SidebarThreadRow`).

## 2. Scope

In: `SidebarDraftRow` in `apps/web/src/components/Sidebar.tsx`, both render variants (full row and compact rail button), used by the Not started block and by queued drafts under Queue.

Knowingly left:

- `LegacySidebar.tsx` has no drafts block and no Queue (0 matches), so nothing to add.
- Mobile (React Native) has no sidebar Queue.
- iOS Safari does not fire `contextmenu` on long-press; thread rows have the same limit today. Not addressed here.

## 3. Premises

| #   | Premise                                                                                                                          | Source                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| P1  | Thread rows already open their menu from a `contextmenu` event, which Android Chrome fires on long-press                         | `Sidebar.tsx:1478-1483` `handleContextMenu`; user report that only draft rows lack it |
| P2  | Draft rows have no `contextmenu` handler                                                                                         | baseline probe = 0                                                                    |
| P3  | `readLocalApi().contextMenu.show` renders the DOM fallback menu on web and the native menu on desktop                            | `localApi.ts:44-55`                                                                   |
| P4  | The queue row's drag sensor calls `preventDefault` on `contextmenu` but does not stop propagation, so React's handler still runs | `Sidebar.pointer.ts:46`                                                               |
| P5  | Queue toggle and discard already exist as callbacks on the row (`onToggleQueue`, `onDiscard`)                                    | `Sidebar.tsx:769-775`                                                                 |

## 4. Approach

`SidebarDraftRow` handles `onContextMenu` on the full row and on the compact button: `preventDefault`, then `api.contextMenu.show(items, {x, y})` with:

1. `Add to queue` / `Remove from queue` (icons `list-plus` / `list-x`, same labels as the thread menu)
2. `Discard draft` (destructive, `trash`, separator before)

The chosen id calls the existing `onToggleQueue(draftId, session)` or `onDiscard(draftId)`. Items come from a small pure `buildDraftActionMenuItems({ isQueued })` beside `buildThreadActionMenuItems`, so the queue labels live in one file.

## 5. Alternatives

| Alternative                                               | Why rejected                                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Do nothing                                                | Touch users cannot queue a draft at all (hover-only buttons)                    |
| Always show the buttons on touch (`@media (hover: none)`) | Crowds a narrow phone row and is not what was asked; the thread rows use a menu |
| Reuse `buildThreadActionMenuItems`                        | Almost every item there (pin, settle, rename, copy) needs a server thread       |

## 6. Experiments

N/A: no competing approaches with a measurable difference.

## 7. Invariants

| #   | Property                                                                                                   | Check that fails if it breaks                                                                                                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1  | The menu offers "Remove from queue" exactly when the draft is queued                                       | logic test on `buildDraftActionMenuItems`                                                                                                                                                                                                                                           |
| I2  | Choosing the queue item on a Not started draft puts it in the queue store; on a queued draft it removes it | none automated: `SidebarDraftRow` is file-private, and the reviewer's dom test had to re-implement the handler in a harness, which AGENTS.md rules out as mirroring. The handler only calls the existing `onToggleQueue`/`onDiscard`; typecheck pins the ids to the builder's union |

## 8. Shared resources

N/A: writes only the existing device-local queue store and draft store, through their existing actions.

## 9. Failure behaviour

| Failure                              | Behaviour                                                                                                                                                                                                                                                                                              | Operator sees | Overriding intent |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- | ----------------- |
| Menu dismissed                       | nothing happens                                                                                                                                                                                                                                                                                        | menu closes   | —                 |
| Draft sent/discarded while menu open | `onToggleQueue`/`onDiscard` act on a gone draft. harmless: `clearDraftThread` no-ops on a gone draft (`composerDraftStore.ts:2940-2950`); a stale enqueue is dropped by `ThreadQueueCoordinator` when the draft session is gone (`ThreadQueueCoordinator.tsx:167-168`). Same race as the hover buttons | nothing       | —                 |

## 10. Irreversible steps and rollback

Discard is irreversible, as the existing button already is. Rollback = revert the commit.

## 11. Surface changes

- Web / desktop: new menu. Mobile web: long-press. Mobile app: N/A (no Queue).
- Contracts, server: N/A.
- Docs: `docs/user/thread-sidebar.md` Queue section names the menu beside the queue button.

## 12. Tradeoffs and limitations

iOS Safari long-press stays unsupported (rejected: a custom long-press timer for draft rows only would make them behave differently from thread rows).

## 13. Open questions and follow-ups

None.

## 14. Review exit note

6a skipped: client-only UI change, no pillar trigger. 6b round 1 (Correctness + Simplicity, built and ran it): CONDITIONAL GO, no pseudocode, invariant or boundary change; doc sources fixed, the mirroring dom test declined (see I2). Quiescent after round 1.

Sanitize round 1 (built and ran it): no blockers. Applied: discard styling test, §11 docs line.
