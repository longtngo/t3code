# Fork registry

This checkout is a long-lived personal fork of `pingdotgg/t3code`. Upstream work is merged in
periodically; fork work never goes back upstream. This file records the things a reconcile must
not silently break — the invariants that are _invisible to the test suite_ and therefore cannot
be recovered from a green gate.

Everything here was verified against the tree, not recalled. Re-verify before trusting it: a
stale entry is a hypothesis, not evidence.

## Topology

|            |                                                           |
| ---------- | --------------------------------------------------------- |
| `origin`   | `pingdotgg/t3code` — upstream, read-only                  |
| `fork`     | `longtngo/t3code` — backup remote for `personal`          |
| `personal` | the fork trunk. Work lands here by **direct push, no PR** |

Reconcile is `git merge origin/main` into `personal`. Feature work branches off `personal`
(never `origin/main` — branching off upstream silently drops every fork feature).

`git rerere` is enabled repo-locally so conflict resolutions replay across reconciles.
`rerere.autoupdate` is deliberately left off: a replayed resolution still needs review, because
a resolution that was right against one upstream shape can be wrong against the next.

## Surface

As of 2026-08-26, against `origin/main`: **307 files added, 269 modified, 3 deleted.**
Concentrated in `apps/server` (208) and `apps/web` (167).

## Invariants a merge must not break

### 1. Migration filename number ≠ applied id

`apps/server/src/persistence/Migrations.ts` maps each migration file to an **explicit applied
id**, and the two deliberately diverge. Several filename numbers appear twice (`033`, `037`,
`038`, `039`) because upstream and the fork both claimed them; the applied ids stay unique because
the manifest assigns upstream's migration the next free id rather than its filename number.

Verified 2026-08-22: 47 entries, all ids unique, monotonic, max 48. Id `34` is intentionally burned (an
earlier fork DB applied a since-renamed `034_PushSubscriptions`).

A migration's **test** carries this too. Upstream's `041_AuthSessionClientConnection.test.ts`
ran `toMigrationInclusive: 40` then `41` — its filename numbers — and found no columns, which is
how the 19th reconcile noticed. Retarget such a test to the fork's applied ids rather than
deleting it, and give it a control asserting the column is absent at the previous id, or it
passes whether or not the renumbering is right.

**The rule: never renumber an applied id — it has already run on live databases. Give the
arriving migration the next free id and leave its filename alone.** Each divergence is explained
in a comment above its import in `Migrations.ts`; keep that up when adding one.

A merge that "tidies" these into filename order will re-run or skip migrations on a live DB.

### 2. One patch in `patches/` is fork-owned

15 of the 16 files in `patches/` are byte-identical to upstream. Exactly one is not:

- `patches/@effect__platform-node@4.0.0-beta.103.patch` — adds a no-op `socket.on("error")`
  handler in `makeUpgradeHandler`. Without it a peer RST between Node emitting `upgrade` and
  `ws` attaching its listeners becomes an unhandled `error` event that **kills the server
  process**. Backport of Effect-TS/effect#6927, which merged 95 minutes after beta.103 shipped.

Patch filenames are version-pinned, so an effect bump rewrites the whole `patchedDependencies`
block in `pnpm-workspace.yaml` and can drop this entry with nothing failing — that has happened
before. The entry now carries a `FORK-ONLY` comment so the loss shows up in the conflict.

Deleting it is correct **only** on a release containing #6927 (landed in beta.104). On any other
bump, re-pin it to the new version.

### 3. Sidebar: which file is the default flipped

Upstream renamed the old `Sidebar.tsx` to `LegacySidebar.tsx` and promoted the v2 content into
`Sidebar.tsx`, **swapping which one is the default**. Today `Sidebar.tsx` renders by default and
`LegacySidebar.tsx` is opt-in behind the `legacySidebarEnabled` client setting
(`useSettings.ts:288`). Before that merge it was the other way round.

Git is rename-blind during a merge, so fork edits to both files were presented **inverted** —
v1 edits pointed at v2 content, v2 edits stranded in a deleted file. Resolving the conflicts as
presented compiles, passes the full suite, and hides fork features in a sidebar nobody renders.

**When a reconcile touches either sidebar, confirm which file each fork edit belongs in by
reading the content, not by trusting the conflict markers.**

### 4. Deliberate deletions

The fork removes upstream lines on purpose (e.g. the offline-outbox send-gate). A later merge
that "restores" them looks clean and reverts the fix. After any reconcile, sweep the merged
files for fork-deleted lines that came back.

The sweep is mechanical — for every file both sides touched, the set of lines present at the
merge-base and absent in `personal` must stay absent in the merge result:

```sh
MB=$(git merge-base personal origin/main)
comm -23 <(git show "$MB:$f" | sort -u) <(git show "personal:$f" | sort -u) \
  | comm -12 - <(sort -u "$f")
```

This is what caught the ClaudeAdapter steering test below, which the conflict presented as an
ordinary upstream addition.

Two of the three deletions counted in Surface above are the fork's largest one: upstream's
`ContextWindowMeter.tsx` and its `ContextWindowMeter.test.tsx` are gone, replaced by the fork's
composer vitals gauge. The `.logic.ts` sibling survives for a reason of its own — see invariant 10. They come back only if upstream _modifies_ one of them: git then raises a
modify/delete conflict, and the resolution is a delete. `ChatComposer.tsx` carries a comment at
the former call site recording why.

Two more in-file deletions, each with a comment where the code used to sit, both re-presented as
ordinary upstream additions by the 17th reconcile:

- `MessagesTimeline.tsx` drops `buildToolCallExpandedBody`, `workEntryRawCommand` and
  `stopRowToggle`. The fork opens a work-entry's detail in a modal instead of an inline expanded
  body, so all three would be unused. Upstream still has them and still calls them.
- `ComposerPendingUserInputPanel.tsx` drops upstream's `Collapsible` wrapper (fork commit
  `a02c9e405`) for a bounded, kept-mounted options list that survives a collapse with its scroll
  position and keeps `aria-controls` resolvable. Upstream keeps restyling its own version, so this
  file conflicts on every reconcile that touches it; the resolution is the fork's.

### 4b. Send-blocked and environment-unavailable are different states

`ComposerPrimaryActions` takes both `isEnvironmentUnavailable` and `isSendBlocked`. Upstream has
only the first and folds the second into it. They are not the same: unavailable means the send is
**queued** and the button stays live ("Queue message to send on reconnect"), while blocked (no
provider, no project) is a hard stop. A merge that takes upstream's combined
`isEnvironmentUnavailable={environmentUnavailable !== null || noProviderAvailable || projectSelectionRequired}`
compiles only until the required `isSendBlocked` prop is noticed missing, and would make a merely
disconnected composer read as permanently dead. All three call sites in `ChatComposer.tsx` need
the split, plus the prop pass-through above them (four `isSendBlocked=` occurrences in total).
The 17th reconcile lost it and the line sweep caught it, not the type checker.

### 5. A mid-turn send queues; it does not steer

Upstream's Claude adapter treats a second `sendTurn` while a turn is running as a **steer** — the
message joins the live agent loop and the turn id does not change. The fork replaced that with
**FIFO queued follow-ups**: the message waits and then opens its **own** turn. That is what backs
the composer's Send-beside-Stop button ("Queue message"), and the fork carries its own tests for
the queue (drain order, interrupt discards the queue, model re-set on drain).

So upstream's `ClaudeAdapter.test.ts` test _"steers a running turn instead of opening a new one on
mid-turn sendTurn"_ asserts a behaviour this adapter no longer has, and fails against it
(`steeredTurn.turnId !== turn.turnId`). It is deliberately absent, with a comment where it used to
sit. A reconcile that "restores" it — it reads exactly like an upstream addition inside a
conflict — reintroduces a guaranteed red test.

### 5b. The fork's footer panels live inside upstream's `SidebarUtilityMenu`

Upstream `#7153` extracted the sidebar footer into `SidebarUtilityMenu` and reused it from
`SettingsSidebarNav`. The fork's two footer-only panels (`SidebarLocalModels`,
`SidebarResourceQueue`), their shared open state, and the `relative` row wrapper they anchor to
now live **inside that component**, not in `SidebarChromeFooter`, which is a bare
`<SidebarUtilityMenu />`. Keeping them out of it would have hidden them on the settings page,
which is the one surface upstream added.

`sidebarChromeFooter.test.tsx` covers this, and it mocks `@tanstack/react-router` — so a new
router hook in the utility menu breaks it with "No X export is defined on the mock" rather than
with anything about panels. Add the export; the test's subject still applies.

### 5c. Boot reconciliation is the fork's, and it owns the directory binding too

Upstream `#7719` added `reconcileProviderSessions` — a `provider-sessions.reconcile` startup phase
that settles a restart-orphaned session to **`error`** and cleans its `ProviderSessionDirectory`
binding. The fork already had `reconcileInterruptedTurnsOnBoot` (`BootTurnReconciler.ts`), running
in an **earlier** phase, which settles the same sessions to **`stopped`** — the same clean resting
state the reactor's stop path produces — and also dispatches `thread.turn.interrupt` for history.

Measured on the 18th reconcile: with both present the fork's phase ran first and its `stopped` won,
so upstream's status decision never took effect while its binding cleanup did. Two halves of one
concern split across two phases, with the visible half silently dead.

Resolved by **porting upstream's binding cleanup into the fork's reconciler and deleting
`reconcileProviderSessions`** (a `FORK:` note sits where it was, and its startup phase is gone).
The fork's version is now the superset: it covers `idle`/`ready` as well as `starting`/`running`,
interrupts the turn, settles to `stopped`, and clears the binding's `status` /
`runtimePayload.activeTurnId` while `upsert`'s merge preserves `resumeCursor` and every other
payload key.

Upstream's `serverRuntimeStartup.reconcile.test.ts` was deleted with it — its two remaining cases
tested upstream's `listSessions()` gate, which this fork does not have (its phase runs before any
session is live, so it assumes zero). The behaviour is covered end-to-end by
`orphanedProviderSessionStartup.integration.test.ts`, whose two `sessionStatus` expectations are
retargeted to `stopped` with a comment. That test is the guard: disabling the binding block leaves
`bindingStatus: "running"` and a stale `activeTurnId`, verified 2026-08-21.

**A reconcile that restores upstream's `error` semantics, or reinstates the
`provider-sessions.reconcile` phase, is reverting a deliberate decision.**

### 6. Two project entry points in the sidebar, on purpose

Upstream `#5923`/`#5768` moved project settings to a `/projects/$projectKey` route and repurposed
the sidebar's per-project button to navigate there. The fork's own project-actions **dialog**
covers ground that route does not: **workspace member repositories** — attaching one, choosing
its integration branch, removing it. (Both surfaces carry a grouping-rule control, so grouping is
_not_ the fork-only part; verified against the running app on 2026-08-11.) The project row
therefore carries **both** buttons: an ellipsis opening the fork dialog and a gear navigating to
upstream's page. Collapsing them to one drops multi-repo workspace management entirely.
Consolidating the two is real work, not merge work.

### 7. `interruptTurn` is the COOPERATIVE rung; `stopSession` is the hard one

Upstream `#5891` replaced Claude's `interruptTurn` body with `stopSessionInternal(context)` — one
hard kill, on the reasoning that `interrupt()` can acknowledge while resumed background tasks keep
the CLI alive. This fork keeps the two rungs apart, because the Stop button is a **client-side
ladder** (`ChatView.logic.ts` `nextStopAction`): the first press sends a cooperative
`thread.turn.interrupt`, and a deliberate second press inside a 500ms–10s band escalates to a hard
`thread.session.stop`. Collapsing rung 1 into rung 2 makes that band vestigial for the
most-used provider and charges every "stop to redirect" a cold subprocess restart.

Neither side was a superset, so the 20th reconcile took a hybrid:

- **`interruptTurn` stays the fork's** — bounded `stopTask` fleet sweep (each task's
  `task.completed` made authoritative), then `query.interrupt()` bounded by
  `INTERRUPT_REQUEST_GRACE`. Both bounds exist because this runs on the single reactor command
  worker, where an unbounded await head-of-line blocks every later command including the
  watchdog's own `session.stop`.
- **`stopSessionInternal` is upstream's, hardened** — `query.close()` moved to the very top
  (before `context.stopped = true`, so a close failure leaves the session usable), a
  `task.completed` sweep over `liveTaskIds` that does not need `stopTask` support, an
  identity-guarded `sessions.delete`, and `stopSessions` collecting per-session failures for
  `stopAll`. The fork's own contribution here — bounding `Fiber.interrupt(streamFiber)` with
  `STOP_INTERRUPT_GRACE` — is kept on top of it.

Two consequences a later reconcile must not undo:

- `ClaudeQueryRuntime.interrupt` and `.stopTask` were **removed by upstream outside any conflict
  marker**, and restored here. If they vanish again, the fork's `interruptTurn` stops compiling —
  which is the good case; the bad case is a resolution that also takes upstream's `interruptTurn`
  and leaves nothing failing.
- Upstream's four new tests are **retargeted, not deleted**. Three of them now drive
  `stopSession`, whose semantics they actually describe here: the one about settling live tasks
  and closing the provider session, the one about keeping the session available when the process
  close fails, and the one about keeping a resumed replacement session during slow stop cleanup.
  The fourth, covering `stopAll` when one close fails, needed no change.

### 8. The interrupt reactor gates on the LIVE session, not the projection

`processTurnInterruptRequested` asks `hasLiveSessionForThread` before forwarding. With no live
session the interrupt's goal is already met, so it settles the thread to `stopped` (clearing the
spinner) rather than appending a `provider.turn.interrupt.failed` activity — and deliberately does
not resume a subprocess just to no-op it. Upstream reads `thread.session` from the projection
instead.

Upstream `#7412`'s `recoverInterruptFailure` (stop the session and record the detail when the
provider's interrupt fails) is **adopted on top of** that gate. Its three tests set up a projected
session only, so each needed `harness.runtimeSessions.push({...})` added to reach the path it
tests; without it they pass through the fork's gate and assert `lastError: null`. A future
upstream test about interrupt failure will need the same line.

### 9. `entrypoint.test.ts` realpaths its temp dir (macOS)

Upstream's `matches through a symlinked entrypoint` fixture builds its paths under
`os.tmpdir()`, which on macOS is `/var/folders/...` — itself a symlink to `/private/var/...`.
`realpathSync` resolves that prefix as well as the fixture's own link, so the assertion can never
hold. It passes on upstream's Linux CI and fails on every macOS run. `makeTempDir` realpaths the
temp root here; `isEntrypoint` itself is untouched, and production is unaffected (an
npm-installed CLI symlink carries no such prefix indirection). Worth sending upstream.

### 10. `ContextWindowMeter.logic.ts` outlives its component, on purpose

The meter component is deleted (invariant 4). Its `.logic.ts` sibling is **not**: upstream `#8144`
put the Claude resume-compaction helpers there, and `ChatView`'s compaction banner uses them. The
banner is independent of the meter, so rejecting the meter must not reject the compaction feature.

The file is kept under upstream's name so upstream edits to those helpers keep merging instead of
arriving as a modify/delete every reconcile. Two of its exports are deliberately absent:
`resolveContextWindowModelDisplayName` (reimplemented inline in `ChatComposer.tsx`, which already
carries a comment saying so) and `formatContextWindowCompactionMessage` (only ever served the
deleted component). `ContextWindowMeter.logic.test.ts` is trimmed to match; upstream's new
`ContextWindowMeter.test.tsx` is deleted with the component it tests.

Upstream's `activeContextWindow: ContextWindowSnapshot | null` prop on `ChatComposer` is also
rejected: the fork derives the snapshot **and** the account-usage view the Vitals gauge needs from
`activeThreadActivities`, which stays the prop the parent passes. `compactDisabled` /
`compactDisabledReason` / `onCompactContext` are adopted — `compactThreadContext` consumes them,
so they are live, not vestigial.

### 11. One `environmentId` for markdown rendered without a thread

The fork's `fileEnvironmentId` prop on `ChatMarkdown` and upstream `#7140`'s `environmentId` are
the same concept. Upstream's is the superset and replaced it: besides "Open in new tab" it drives
remote-open resolution, the editor hook, server config and the workspace basename lookup — the
exact narrowness the fork's own comment recorded as a known gap. `TrustedFileView` passes the new
name; the inner `MarkdownFileLink` keeps `fileEnvironmentId` and is fed from it.

The chip itself stays the fork's superset — a `<span>` wrapping the tooltip **and** an in-DOM
`<Menu>`, a visible affordance for actions the native context menu otherwise hides behind a
right-click — with upstream's `hasPrimaryAction` / `useBrowserPrimaryAction` gating, repositioned
native context menu, and no-primary-action `<button>` fallback grafted into the tooltip trigger.
`onOpen` became optional upstream, so the menu's "Open in editor" item now follows it.

**Verified 2026-08-26.** `readLocalApi()` is gated on `typeof window`, not on Electron, and
`contextMenu.show` falls back to `showContextMenuFallback`, a real DOM menu with its own passing
suite — so the native context menu works in any browser, and right-click has always offered these
actions there. The in-DOM menu earns its place on **discoverability** and on touch, not on reach.
`apps/mobile` is a separate React Native app that never renders this component.

(Both this section and a comment in `ChatMarkdown.tsx` previously claimed the native menu was
"Electron-only" and the in-DOM menu "the only options surface reachable on web and mobile". Both
were wrong when written, and the comment is what seeded the doc. If a reconcile restores that
wording from upstream, it is still wrong.)

The two menus deliberately differ: the in-DOM one carries "View in side panel" and "Open in new
tab", the native one carries "Open in integrated browser" and "Copy relative path". What must not
differ is a **shared** item's condition. The reveal item closed that gap on 2026-08-26; it uses
`onReveal && revealLabel` inline at both sites, and nothing enforces the pairing, so change both.

Do not extract that condition into a shared `boolean` predicate. At the **native** site
`ContextMenuItem.label` is a required `string`, and the inline truthiness test is what narrows
`revealLabel`; a boolean-returning call is opaque to control-flow analysis and the native site
stops compiling. (At the in-DOM site the test is only defensive — a `MenuItem` child is a
`ReactNode`.) A shared _object_ would narrow correctly, if the pairing ever needs enforcing.

## A fourth sweep direction the script does not have

`scripts/sweep-merge.py` checks three directions: fork-deleted lines resurrected, upstream-added
lines dropped, fork-added lines lost. The 21st reconcile hit a fourth it cannot see:

**a line present in the merge-base AND in the fork, deleted by upstream, with the merge honouring
the deletion.** It is not fork-_added_, so FORK-LOSS is blind to it; it is not fork-_deleted_, so
RESURRECTED is blind to it; it is not upstream-_added_, so DROPPED is blind to it.

Usually that is exactly right — a merge should honour upstream's deletions. It is a defect only
when the fork still references the deleted thing. Twice in one merge it did:

- upstream renamed `composerHasDraftContent` to `composerHasUnsentContent` in `ChatView`; the
  fork's five references stayed behind pointing at a binding that no longer existed.
- upstream replaced `ChatComposer`'s `activeThreadActivities` prop with a precomputed
  `activeContextWindow`; the fork's body still derived from `activeThreadActivities`.

Both were caught by `typecheck`, which is the good case. The bad case is a runtime-only reference.
The probe is cheap — for every file both sides touched, `(base ∩ fork) \ result`:

```python
lost = (base_lines & fork_lines) - result_lines
```

167 lines on that merge, almost all legitimate (version bumps, dependency pins, upstream
refactors of upstream's own code). What matters is the same rule as the other three: every file in
the list needs a name.

## CI does not run here — the pre-push hook is the gate

`.github/workflows/ci.yml` correctly triggers on `personal`, but every job requests
`blacksmith-*` runners, provisioned for the upstream org. Jobs queue until GitHub's 24h timeout
and are cancelled: **429 runs on this fork, zero successes and zero failures.**

The compensating control is `.githooks/pre-push`, activated via `core.hooksPath` by the root
`package.json` `prepare` script. On every push it runs the full `pnpm run verify`, which is four
steps and starts with formatting: `fmt:check`, `typecheck`, `lint`, `test`. A gate you assembled
by hand from the last three is not this gate — it will pass and the hook will still reject the
push. It runs because nothing else executes the ~7.5k-test suite automatically. Read the
comment at the top of that hook before weakening it — an earlier version ran only typecheck and
lint on the false belief that CI covered the unit suite.

Bypass is `git push --no-verify`. Don't, unless you have just run the gate by hand.

Remaining gap: every gate run is macOS, so a Linux-only failure still has no way to surface.
Pointing the fork at runners that exist would close it, and would let the hook go back to a fast
static gate.

## Where the detail lives

Per-change reports (root cause, alternatives rejected, measurements) are outside the repo, under
`~/reports/t3code/<yyyy-mm>/<yyyy-mm-dd>/`. Design docs for fork features are in `docs/design/`.
This file is only the durable index of what a merge can silently break.
