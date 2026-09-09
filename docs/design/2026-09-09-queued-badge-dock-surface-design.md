# The queued-message badge is docked but never visible

## Goal

A message sent while the agent is still working is held by the server and shown in a strip above
the composer. The strip's collapsed form, a "1 waiting" badge, has not been visible since the
composer banner rebuild on 2026-08-31, so held messages look like they were dropped. Make the badge
visible again whenever a message is held.

### Baseline (Stage 1b, taken on `37a2dfb25`)

| Metric                      | Command                                                                                            | Before               |
| --------------------------- | -------------------------------------------------------------------------------------------------- | -------------------- |
| `queued-badge-dock-visible` | `cd apps/web && vp test run src/components/chat/ComposerQueuedMessages.dom.test.tsx --project dom` | `1 failed, 1 passed` |
| verify gate (floor)         | `pnpm verify` on `a5e413f3d` this morning                                                          | 14/14 green, 16,509  |

The test renders the badge and the drawer inside `ComposerBanner.Dock` and asserts each has an
ancestor carrying `data-composer-banner-surface="attached"`. The drawer passes, the badge fails.

## Root cause

`ComposerBanner.Dock` (`apps/web/src/components/chat/ComposerBanner.tsx:122`) carries
`not-has-data-[composer-banner-surface=attached]:hidden`. The built stylesheet confirms the rule:

```
.not-has-data-\[composer-banner-surface\=attached\]\:hidden:not(:has([data-composer-banner-surface=attached])){display:none}
```

So the whole dock is `display:none` unless one of its descendants is a `ComposerBanner.Root`
(which stamps that attribute through `Surface`). Every dock child in `ChatComposer.tsx` renders a
`Root` except one: `ComposerQueuedBadge`
(`apps/web/src/components/chat/ComposerQueuedMessages.tsx:29`) is a bare `<button>` inside a
`ComposerBanner.Attachment`. The badge is the strip's default state (`isQueuedDrawerOpen` starts
false and resets on every thread change), so when a held message is the only docked item the
dock hides and nothing is drawn. The drawer, which does have a `Root`, can only be opened from
the badge, so it is unreachable too.

The badge reappears whenever something else docks a `Root` (a stash entry, a tasks tab, a pending
approval), which is why it looked intermittent rather than gone.

The rule arrived with upstream's composer banner system (#8734) and the fork's rebuild of its own
affordances on those primitives (`881e95e5d`, 2026-08-31). That commit rebuilt the drawer on
`Root` but left the badge as a plain button. Nothing in the gate could see it: no test rendered
the badge inside a dock (happy-dom does evaluate `:has()`; the RCA proved the hide with the
built rule injected, both arms).

**Second regression, same commit.** `881e95e5d` also adopted upstream's `deriveTimelineEntries`
signature and, in doing so, fed it `timelineMessages` instead of `heldPartition.transcript`
(`apps/web/src/components/ChatView.tsx:3596`). `heldPartition.transcript` now has no consumer, so
a held message stays in the transcript looking delivered. Found by the independent RCA and
confirmed by `git show 881e95e5d -- apps/web/src/components/ChatView.tsx` (lines 225-232 of the
diff). The feature's original commit (`4b9b39e5f`) had the transcript as the only consumer.

Server-side holding is intact. The live event log shows a message held on 2026-09-06 (thread
`2ea0f5c1…`, message sent at 13:03:36 during turn `695facf4…`) and drained into its own turn
`fe812c5d…` the moment the running turn completed. The client rule
(`packages/client-runtime/src/state/threadSettled.ts:132`) and its wiring in `ChatView.tsx` are
unchanged since the feature landed.

## Approach

Rebuild `ComposerQueuedBadge` on the banner primitives exactly the way `ComposerTasksBadge`'s
`tab` placement is built: a `ComposerBanner.Root density="comfortable" data-composer-shoulder-tab`
wrapping a `ComposerBanner.Row` rendered as a button, with `Icon` / `Content` / `Actions`. That
gives the badge an attached surface, the shoulder-tab outline the tasks tab already has, and the
same hit target.

Restore `heldPartition.transcript` as the input to `deriveTimelineEntriesWithState` in
`ChatView.tsx`, with the memo's dependency list updated to match. Nothing else consumed the
transcript half in the original commit, so this is a one-line restoration.

The DOM test written for the baseline stays as the regression guard. It is generic over the dock
contract rather than over this badge's markup: anything rendered as a dock child must carry an
attached surface.

## Alternatives considered

- **Drop the `:hidden` rule from `Dock`.** Upstream owns `ComposerBanner.tsx`; the rule is what
  keeps the dock from reserving space when nothing is attached. Editing it re-creates a conflict
  on every reconcile and hides the real contract. Rejected.
- **Stamp `data-composer-banner-surface="attached"` on the bare button.** Satisfies the selector
  without the surface styling, leaving the badge unstyled against the composer edge. The tasks
  badge shows what the strip is supposed to look like. Rejected.
- **Open the drawer by default.** The drawer has a `Root` and would show, but the strip was
  designed as a shoulder tab so it does not displace the composer for a one-line notice. Rejected.

## Experiments

None beyond the baseline: the mechanism is a CSS selector, confirmed in the built stylesheet.

## Files touched

- `apps/web/src/components/chat/ComposerQueuedMessages.tsx` — badge rebuilt on the primitives.
- `apps/web/src/components/chat/ComposerQueuedMessages.dom.test.tsx` — new, the dock contract.
- `apps/web/src/components/ChatView.tsx` — timeline entries derive from the transcript half again.

## Invariant (Hard Rule 12)

Property: every child of `ComposerBanner.Dock` renders a `ComposerBanner.Root`. Sites checked in
`ChatComposer.tsx`: banner stack (upstream, Roots inside), activity strip (Root), top drawer
(Root), tasks drawer (Root), tasks badge (Root), queued drawer (Root), stash badge (Root), queued
badge (**missing — this fix**). Mobile (React Native) has no dock; its held-message band is a
separate component and is not affected.

## Tradeoffs and limitations

- The fix is web-only because the defect is web-only. Mobile's `ComposerHeldMessages` was checked
  and renders unconditionally.
- No screenshot proof: the fix restores markup the tasks tab already uses, and the user asked for
  no browser verification unless requested.

## Follow-ups deferred

- A same-driver instance switch sent mid-turn is refused with "stop it before switching", flips
  the session to `error`, and the held message is never delivered (seen once, 2026-09-07 01:17,
  thread `c2431922…`). That is item C's cross-device stale-selection problem and is handled there.

## Independent RCA (Stage 3b)

Dispatched on the symptom alone. It reproduced the hide in happy-dom with the deployed CSS rule
copied in (`getComputedStyle(dock).display === "none"` with the badge alone, not `none` with the
tasks badge or the open drawer), replayed the client rule against a real held shell from the event
log (fires), and ruled out the server, the projection, and a stale bundle. It agreed on the dock
rule and found the transcript regression above, which my own read had missed.

## Review exit note

6a skipped: no service boundary, contract, data model, dependency, or rollout change; a
self-contained change to existing UI markup. 6b: one round, Correctness + Simplicity in one
reviewer that built both changes in a detached worktree and ran the tests, apps/web typecheck
and lint. Findings: the doc's happy-dom claim was wrong (fixed above); the new test needed
formatting (must-fix, applied); drop the unused `cn` import and `String(count)` (applied); keep
the `closest()` contract rather than copying upstream's selector into the test (kept). It also
enumerated every other `timelineMessages` consumer and confirmed each wants the full list, and
replayed the hold/release across six shell states with no re-hold. No blockers; exit after one
round because the applied findings were edits to the artefacts the reviewer had already run.
