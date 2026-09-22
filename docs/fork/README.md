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

As of 2026-09-22 (39th reconcile, 87 commits), against `origin/main`. No effect bump; its one
fork decision is recorded under invariant 40.

The 38th (2026-09-18, 181 commits) brought effect
rc.112 -> rc.115, Tiptap as the default composer editor, multi-model thread fan-out, provider
thinking traces and storage cleanup; the entries 52-56 below are its decisions.

Earlier: 2026-09-10 (34th reconcile, 17 commits). Concentrated in
`apps/server` and `apps/web`.

**The 34th reconcile was one feature, not seventeen commits.** Upstream's multi-pull-request
link work (#10839 + #10875 + #10870 + #11007 + #11045) touched 172 files in a single commit,
added `projection_thread_pull_requests` (a table), `ThreadPullRequestLink` (a contract), three
new `thread.pull-request-*` events, and derived the legacy `linkedPullRequest` from the new
array. Everything the fork holds on a thread shell — `crewRole`, `titleRegenerationFailedAt`,
`hasPendingBackgroundTask` — had to be re-grafted onto upstream's rewritten builders in
`ProjectionSnapshotQuery.ts`, because upstream re-indented those blocks and git aligned the
fork's un-indented version against them, cutting each conflict marker off mid-object.

**This reconcile carried two toolchain bumps**, and both are the kind that retire fork work
silently: `effect` beta.103 -> **rc.112** (which renamed `Schema.TaggedErrorClass` to
`Schema.TaggedError` repo-wide) and `@typescript/native-preview` -> **`typescript` 7.0.2**
(which renames the binary from `tsgo` to `tsc` in every package's `typecheck` script and
deletes `scripts/clean-tsgo-backups.mjs`). It also carried ten upstream **knip
export-classification** commits, whose whole purpose is to make exports module-private -
see invariant 38.

## Invariants a merge must not break

### 1. Migration filename number ≠ applied id

`apps/server/src/persistence/Migrations.ts` maps each migration file to an **explicit applied
id**, and the two deliberately diverge. Several filename numbers appear twice (`033`, `037`,
`038`, `039`) because upstream and the fork both claimed them; the applied ids stay unique because
the manifest assigns upstream's migration the next free id rather than its filename number.

Verified 2026-09-08 (32nd reconcile): 57 entries, all ids unique, monotonic, max 58; upstream's
`049_ProjectionThreadsActiveOrderKey` took applied id **58** (49-57 were already spent), and the
fork's `052_ProjectionThreadActivityKindIndex` holds 57. Filename numbers double up on `033`,
`037`, `038`, `039`, `041` and `042`. Id `34` is intentionally burned (an earlier fork DB applied
a since-renamed `034_PushSubscriptions`).

The 32nd reconcile is a worked example of the test half below: upstream's
`049_ProjectionThreadsActiveOrderKey.test.ts` ran `toMigrationInclusive: 48` then `49` - its
filename numbers - and was retargeted to `57`/`58`, with a `pragma_table_info` control asserting
`active_order_key` is ABSENT at 57. Without that control the test passes whether or not the
renumbering is right, because a column added earlier than intended is indistinguishable from one
added on time.

The manifest is a list of **positional tuples** (`[1, "OrchestrationEvents", Migration0001]`), not
object literals. A probe grepping for `id:` matches only the doc comment and reports nothing.

A migration's **test** carries this too. Upstream's `041_AuthSessionClientConnection.test.ts`
ran `toMigrationInclusive: 40` then `41` — its filename numbers — and found no columns, which is
how the 19th reconcile noticed. Retarget such a test to the fork's applied ids rather than
deleting it, and give it a control asserting the column is absent at the previous id, or it
passes whether or not the renumbering is right.

The 34th reconcile repeated it once more: upstream's `050_ProjectionThreadPullRequests` became
applied id **59**, and its test ran `toMigrationInclusive: 49` then `50` — the fork's
`ProjectionThreadLinkedPullRequest` and `ProjectionThreadsUnsettledAt`, nowhere near the table it
asserts. Retargeted to 58/59 with a `sqlite_master` control asserting
`projection_thread_pull_requests` is ABSENT at 58. The tell that this is due: any arriving
migration whose test names an id below the fork's current maximum.

The 36th reconcile made it three in a row: upstream's `051_ProjectionThreadMessageContext`
(the composer context records) became applied id **60**, and its test ran
`toMigrationInclusive: 50` then `51`. Retargeted to 59/60 with a `PRAGMA table_info` control
asserting `projection_thread_messages.context_json` is ABSENT at 59. The manifest now holds 59
entries, ids unique and monotonic, max 60.

The 37th reconcile added upstream's `052_ProjectionThreadTitleState` (#10720) as applied id **61**.
It arrived with no migration test, so nothing needed retargeting. Manifest: 60 entries, max 61.

The 38th reconcile added upstream's `053_PullRequestFilesViewed` (#7721) as applied id **62**, also
without a test. Manifest: 61 entries, max 62. The same reconcile's effect bump removed
`NodeSqliteClient.layerMemory()`; migration and crew tests use `layer({ filename: ":memory:" })`.

**The rule: never renumber an applied id — it has already run on live databases. Give the
arriving migration the next free id and leave its filename alone.** Each divergence is explained
in a comment above its import in `Migrations.ts`; keep that up when adding one.

A merge that "tidies" these into filename order will re-run or skip migrations on a live DB.

### 2. No patch in `patches/` is fork-owned any more — CLOSED at the 32nd reconcile

Every file in `patches/` is now upstream's. The fork's one entry,
`patches/@effect__platform-node@4.0.0-beta.103.patch`, added a no-op `socket.on("error")`
handler in `makeUpgradeHandler`: without it a peer RST between Node emitting `upgrade` and
`ws` attaching its listeners becomes an unhandled `error` event that **kills the server
process**. It was a backport of Effect-TS/effect#6927, which merged 95 minutes after beta.103
shipped and landed in beta.104.

The 32nd reconcile moved to `effect@4.0.0-rc.112`, so the fix is upstream's own code and the
patch is **deleted**, not re-pinned. That was confirmed against the published artifact rather
than by version arithmetic: the rc.112 `@effect/platform-node` tarball's
`src/NodeHttpServer.ts` contains `socket.on("error", () => {})` in `makeUpgradeHandler`.

**The guard that replaces it is `pnpm run check:deps`** (`scripts/check-dependency-invariants.ts`),
which probes the _installed_ module for the handler and passes on upstream's own code. It is
NOT part of `pnpm verify` - run it by hand on any effect bump. It also owns invariant 18's
`idle-aggregate-probe.ts` re-measurement, so one command covers both. Verified 2026-09-08:
"All 2 dependency invariants hold" on rc.112.

The original trap still applies to any future fork-owned patch: filenames are version-pinned,
so an effect bump rewrites the whole `patchedDependencies` block and can drop an entry with
nothing failing. Give any new one a `FORK-ONLY` comment so the loss shows up in the conflict.

### 3. Sidebar: which file is the default flipped

Upstream renamed the old `Sidebar.tsx` to `LegacySidebar.tsx` and promoted the v2 content into
`Sidebar.tsx`, **swapping which one is the default**. Today `Sidebar.tsx` renders by default and
`LegacySidebar.tsx` is opt-in behind the `legacySidebarEnabled` client setting
(`useSettings.ts:380`). Before that merge it was the other way round.

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

  **Widened 2026-09-02 (27th reconcile).** Upstream #9106/#9267 rebuilt that inline expansion
  around a `WorkGroupViewCtx` (per-entry `expandedEntries` set, an `onToggleEntry` callback
  threaded through `TimelineRowCtx`) and a `resolveWorkEntryToolPresentation`-driven row label.
  Roughly half of it merged **outside every conflict marker**, so rejecting only the marked
  hunks left a file that referenced a context nothing consumed. The whole per-entry expansion
  is rejected and its scaffolding removed: `WorkGroupViewCtx`, `expandedEntries`,
  `onToggleWorkEntry`. What is KEPT from the same commits, because it is about the group list
  rather than the row: `resolveWorkGroupScrollAnchor` + `workGroupViewState.scrollPositions`,
  and upstream's `ExpandedWorkGroupEntries` virtualized component — which now mounts the fork's
  `WorkEntryDetailDialog` itself, since its rows open detail the same way.

  **30th reconcile.** Upstream re-landed the same per-entry expansion (`WorkGroupViewCtx`,
  `expandedEntries`, `onToggleWorkEntry`, `PlainWorkEntryRow`'s `expanded`/`toggleExpanded` and
  its inline `expandedBody`) and this time brought a test with it:
  `MessagesTimeline.test.tsx`'s "restores the composer after closing $toolLifecycleStatus tool
  output only at the end", which drives the row through `findByProps({ "aria-expanded": false })`.
  The test is upstream-only (absent from the merge-base) and describes the rejected feature, so it
  is rejected with it. Two of its four cases pass against the fork's row by accident - do not read
  that as partial support.

  Also from this reconcile, unrelated to the feature: `@base-ui/react` 1.5.0 calls floating-ui's
  `isElement` on mount, so any react-test-renderer suite that stubs `window` now needs an `Element`
  constructor both as a global and on the stubbed window. Stub ONLY `Element`; defining
  `HTMLElement` or `Node` makes `@pierre/trees` register its web components at import time and
  fail on the missing `customElements`.

  Also relocated, not lost: `commandProgramName` / `tokenizeShellCommand` / the
  `COMMAND_WRAPPER_*` tables moved to `packages/client-runtime/src/work-log/commandLabel.ts`
  (upstream's copy is a superset — it also unwraps `sh -c`), and `liveWorkEntryLabel` moved to
  `MessagesTimeline.logic.ts`. The local copies are gone; a sweep reports ~92 fork-loss lines
  for this file and every one of them is that move.

- `ComposerPendingUserInputPanel.tsx` drops upstream's `Collapsible` wrapper (fork commit
  `a02c9e405`) for a bounded, kept-mounted options list that survives a collapse with its scroll
  position and keeps `aria-controls` resolvable. Upstream keeps restyling its own version, so this
  file conflicts on every reconcile that touches it; the resolution is the fork's — **but re-graft
  genuine fixes**: the 28th reconcile's conflict here was upstream's `optionLabel` → `optionValue`
  migration, half of which had already merged outside the markers. Taking the fork's side untouched
  would have left the file half-migrated.

- **Codex feedback is a composer banner, not thread messages (32nd reconcile).** The fork carried
  upstream's `codexFeedbackMessage` and rendered `/feedback` and its reply as ordinary user and
  assistant bubbles. Upstream #10398 **deleted that builder outright** and replaced it with
  `ComposerFeedback` / `codexFeedbackNotice` banners. It was never a fork feature - the merge-base
  has it and upstream removed its own code - so the deletion is adopted on every surface: the
  `localMessages` spread in `ChatView.tsx`, the `localFeedbackMessages` memo in mobile's
  `use-thread-composer-state.ts`, and the two `MessagesTimeline` tests that asserted the bubbles
  (upstream deleted its own copies of those in the same commit). What survives from the fork's
  side of those two files is unrelated and must not be dropped with it: the offline-outbox
  pending bubbles (`queuedMessages`) and the held-message strip filter.

- `ComposerPrimaryActions` has no `showSendWhileRunning` prop. Upstream gates Send behind it while a
  turn runs; here Send is always mounted beside Stop because a mid-turn send queues (invariant 5).
  Upstream re-adds the prop and passes it from `ChatComposer.tsx`; both sides of that are rejected.
  Only `ComposerPrimaryActions.test.tsx` recorded the removal before the 28th reconcile.

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
`SettingsSidebarNav`. Four fork panels (`SidebarLocalModels`, `SidebarResourceQueue`,
`SidebarCrew`, `SidebarSubagentBackend`) live **inside that component**, along with the shared
open state and the `relative` row wrapper the status panels anchor to. `SidebarChromeFooter` keeps
only `SidebarProviderUpdatePill` and `SidebarUpdateArchitectureWarning`. Keeping the four out of
the menu would have hidden them on the settings page, which is the one surface upstream added.

`SettingsSidebarNav.tsx`'s row is `items-end`, not upstream's `items-center`: these panels open
upward and anchor on the row's bottom edge. Upstream #9563 wrapped `T3ConnectSidebarSignIn` in a
`Suspense` beside it — that is kept, the alignment is not.

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

**Updated 2026-09-02 (27th reconcile). The phase is back, narrowed.** Upstream #9167 turned
`reconcileProviderSessions` from a dead orphan-settler into the engine for "continue active
threads across a server restart": `ServerSelfUpdate` marks every running thread's directory
binding with `continueAfterServerUpdate` before the update, and this phase resumes them
afterwards. That is a real feature, and `ws.ts` / `ServerRuntimeStartup`'s interface / the
`serverUpdateThreadContinuation` capability all merged cleanly around it, so rejecting it was
no longer free.

It is adopted **verbatim**, and made reachable by one change on the fork's side:
`reconcileInterruptedTurnsOnBoot` now reads each candidate thread's binding and **skips the
continuation-marked ones**. Without that skip the fork's earlier phase settles them to
`stopped`, upstream's filter (`starting`/`running`/`activeTurnId !== null`) matches zero, and
the resume silently never fires — the exact dead-phase shape this entry used to describe.
`SERVER_UPDATE_CONTINUATION_KEY` and `hasServerUpdateContinuationMarker` moved to
`ProviderSessionDirectory.ts` so both reconcilers can read them without a module cycle.

Upstream's `serverRuntimeStartup.reconcile.test.ts` is **restored** with it (the fork had
deleted it); its `ProviderService` / `OrchestrationEngine` stubs needed the fork's
`withdrawQueuedTurn` / `refreshAccountUsage` / `appendSessionNote` / `hubBacklog` members added.

**Still true: every thread that is NOT continuation-marked keeps the fork's `stopped` resting
state, not upstream's `error`.** A reconcile that widens this phase back over ordinary restart
orphans, or drops the skip in `BootTurnReconciler`, is reverting a deliberate decision.

### 6. The workspace-repositories editor lives in upstream's project settings page

**Consolidated 2026-09-06; this entry moved with it.** Upstream `#5768`/`#5923` replaced the
sidebar's project-settings dialog with a `/projects/$projectKey` route. The fork's editor for
**workspace member repositories** — attaching one, choosing its integration branch, removing it —
had been mounted in that dialog, so the 8th reconcile restored the deleted dialog behind a second
ellipsis button rather than porting the editor. That arrangement is over: the editor is now a
`SettingsRow` titled **Workspace repositories** in the **Checkout** section of
`apps/web/src/components/settings/ProjectSettingsPanel.tsx`, and `Sidebar.tsx` carries only
upstream's gear.

**What a reconcile must protect.** `ProjectSettingsPanel.tsx` is upstream-owned and churns — 27
commits on `origin/main` since it was created — and it now holds the fork's only multi-repo mount on the
default sidebar. This is the FORK-LOSS direction: an upstream rewrite of that file drops the row
silently, and nothing about the deletion shows up as a conflict. The tripwire is
`ProjectSettingsPanel.dom.test.tsx`, whose tests fail if the row goes, is fed the group
representative's member list instead of each checkout's own, or stops honouring the write's result.
Do not delete that file to resolve a merge.

**Changed at the 36th reconcile:** upstream's per-project scoped settings rewrite removed the
checkout `Select` the fork's row used to hang off. The row is now rendered **once per checkout**,
each labelled by its environment and workspace root, each with its own
`WorkspaceMembersControl` keyed by `physicalProjectKey`. Same guarantee, no fork-only selector.
Two consequences: the panel's children now read `useSettingsScope`, so any test mounting
`ProjectSettingsPanel` must wrap it in `SettingsScopeProvider` or `ProjectActionsSettings` throws;
and the old "does not resurrect an abandoned edit when the checkout is switched back" test is gone
with the switching, replaced by one asserting a single open editor.

Scope of the row: `members` is a field on the **physical project**, so each row writes to its own
checkout and must never go through `updateAllMembers`. `LegacySidebar.tsx` keeps its own
plainly-labelled "Workspace repositories" dialog; that surface is opt-in and unchanged.

Per-member project **renaming** ended with the dialog on the default sidebar — upstream's Name is
group-level by design, and the per-member inputs were upstream's own deleted code. It still exists
in the legacy sidebar's context menu.

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

Two more fixtures realpath their roots for the same reason (28th reconcile): `CursorProvider.test.ts`
skills discovery and `AntigravityInstallation.test.ts` override resolution, both upstream's, both
comparing a raw temp path against the resolved one their subject returns.

Same prefix, second victim (28th reconcile): `AntigravityAdapter.resolveClientFilePath` realpathed
the session roots but fell back to the **unresolved** parent when a write targeted a directory that
did not exist yet, so under `/var/folders` every new nested file read as outside the workspace. The
fork's `realPathNearestAncestor` realpaths the nearest existing ancestor and re-joins the missing
tail. Not test-only: a symlinked project root hits the same branch in production. The adapter also
carries the three fork-only `ProviderAdapterShape` members (`refreshAccountUsage`,
`withdrawQueuedTurn`, `appendSessionNote`) as constant stubs, like the other ACP adapters.

**Recurred at the 36th reconcile**, in a file byte-identical to upstream:
`apps/server/src/usage/UsageService.test.ts` makes its home with `mkdtemp` and asserts against
`source.fingerprint.resolvedHomePath`, which the service resolves. On macOS the fixture path is
`/var/...` and the reported one `/private/var/...`, so the include fails — and the NEXT test in the
file then hangs to its 120 s timeout waiting on a scan that never matches, which reads like a
second, unrelated defect. Upstream's CI is Linux, so this lands green there and red here. Fix it at
the source: `NodeFSP.realpath(await NodeFSP.mkdtemp(...))`.

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

**The meter's whole load-time reservation path is rejected too (33rd reconcile).** Upstream #10768
stops the footer shifting while thread detail loads by holding the meter's slot:
`ContextWindowMeterPlaceholder`, `shouldReserveContextWindowMeter`, a `reserveContextWindowMeter`
prop, and a new `reportsContextWindow` flag on `ServerProvider`. Every piece of it serves the
component this fork deletes. The fork's footer does not have the bug it fixes: the Vitals gauge's
slot is gated on `showSecondaryStatus={!isComposerResting}`, which is the composer's layout state
and not the thread's load state, so nothing pops in when activities land.

Two of the four pieces landed OUTSIDE any conflict marker - the render site and the `pr-28` width
class in `ChatComposer.tsx`, plus the new tests in `ContextWindowMeter.logic.test.ts`, which
auto-merged - so rejecting the marked declarations alone left the tree red. Only the repo-wide
typecheck named them.

**`reportsContextWindow` is kept on the server and in contracts, and is NOT the fork's
`reportsContextUsage`.** They read alike and answer different questions, both live: upstream's is
a layout hint ("reserve the meter's space", absent means do not) set by two providers; the fork's
is a capability answer ("does this driver emit usage at all", absent means yes) set by five, and
`describeMissingContextUsage` uses it to explain an empty gauge. Keeping upstream's field costs a
schema line and keeps its edits merging; dropping the fork's would blank that explanation.

Upstream's `activeContextWindow: ContextWindowSnapshot | null` prop on `ChatComposer` is also
rejected: the fork derives the snapshot **and** the account-usage view the Vitals gauge needs from
`activeThreadActivities`, which stays the prop the parent passes. `compactDisabled` /
`compactDisabledReason` / `onCompactContext` are adopted — `compactThreadContext` consumes them,
so they are live, not vestigial.

### 12. The Claude adapter still calls `getContextUsage`; upstream deleted it

Upstream #8610 removed `queryCurrentContextUsage` and `normalizeClaudeContextUsageApiSnapshot`
outright, on the grounds that `getContextUsage`'s token-count fallback can make extra model
requests. This fork keeps the call. It is the **only** source of the compaction facts —
`compactsAutomatically`, `autoCompactThreshold`, `autoCompactSource` — that
`packages/contracts/src/providerRuntime.ts` carries on the wire and that the Vitals gauge's
compaction note and marker render from (`VitalsGauge.tsx`, `lib/contextWindow.ts`). Deleting it
compiles, passes, and leaves the note permanently blank.

The adapter's own names differ from the wire's, and the difference matters when grepping:
`isAutoCompactEnabled` and `autocompactSource` (lower-case `c`) are the **raw SDK response keys**
read in `normalizeClaudeContextUsageApiSnapshot`, and the second one is absent from the SDK's
declared type, so it is read off the raw object. Verified 2026-09-06.

Upstream's replacement is **adopted underneath it**, not instead of it. `latestAssistantUsage`
is tracked per assistant frame and `compactedSinceLatestAssistantUsage` guards the
post-compaction window, so the precedence reads
`contextUsageSnapshot ?? latestAssistantSnapshot ?? …`. The fork's snapshot wins when the CLI
answers; upstream's is the next-best fallback when it times out.

Three things upstream removed **outside every conflict marker**, all restored, all of which
break the build if lost again (the good case): `getContextUsage?` on `ClaudeQueryRuntime`, the
`SDKControlGetContextUsageResponse` type import, and `import * as Option from "effect/Option"`.

Two of upstream's tests are **retargeted, not deleted**:

- `completes with result usage without querying current context usage` asserts
  `getContextUsageCalls === 0`. Renamed to
  `completes with the latest assistant frame usage, not the result total`, with the stub and the
  call-count assertion dropped; the behaviour it is really about still holds here.
- `preserves compacted usage when completion follows an older assistant frame` expects
  `lastUsedTokens: 200`, the PRE-compact figure. `compactBoundaryTokenUsageSnapshot` deliberately
  resets it to `post_tokens`, because carrying the old value forward pins the meter at the usage
  the compaction just cleared. Retargeted to `40`.

Both also used a fixed `Stream.take(N)` sized to upstream's event count. This adapter emits a
token-usage event per assistant frame, so a fixed count truncates before the result-driven
update and the assertion silently reads an early event. They collect through `turn.completed`
and read the **last** usage event instead.

### 13. The provider-settings re-seed is UPSTREAM's, deliberately

Fork commit `8fe3190f5` fixed a silent data loss in `ProviderInstanceCard` ("applying a
local-LLM preset appeared to do nothing, then undid itself") with a render-phase `seededRef` +
`environmentKey` value comparison. Upstream #8472 later fixed the same class with a `useEffect`,
`previousEnvironmentRef` and `lastPublishedEnvironmentRef` + `providerEnvironmentsEqual`.

Upstream's is the superset — it remembers what this card last published, so its own round-trip
cannot re-seed the draft, and it runs in an effect rather than during render. The 23rd reconcile
merged **both** mechanisms into the file before this was noticed; they are collapsed to
upstream's. Only the fork's half-typed-row guard survives, as `if (published === null) return;`
on the publish path. `environmentKey` was deleted with the code it served.

**Restoring the fork's `seededRef` block is re-adding a second re-seed, not restoring a fix.**

### 14. Upstream keeps reintroducing raw NUL bytes; a guard test catches it

`apps/web/src/components/chat/composerSourceBytes.test.ts` fails if any `.ts`/`.tsx` under
`apps/web/src` contains a raw NUL byte. This is not style: a raw NUL makes the file opaque to
the tools a reconcile is audited with — BSD `sed` aborts mid-file and returns a plausible
truncated answer, `grep` prints `Binary file … matches` and nothing else. Both have already
misled a reconcile on this fork.

The fork converted all six in `ChatComposer.tsx` to `\0` escapes, which produce the identical
string. Upstream's copy still uses raw bytes, so **every reconcile that touches that file will
bring them back**, and the offending line reads as ordinary spaces in every diff, dump and grep
you would use to check. Only `cat -v` shows it. The guard is the thing that catches it; the
23rd reconcile is where it first did.

**Closed 2026-08-29.** `apps/server/src/sourceBytes.test.ts` is the sibling guard, rooted at
`apps/server/src`. `ActivityPayloadProjection.ts` used two raw NULs the same way — as dedup-key
delimiters — and is now escaped. A repo-wide scan (`perl -ne 'print if /\x00/'` over every
`.ts`/`.tsx` in `apps` and `packages`) returns no offenders, so the two guards cover every source
tree that has ever carried one. The walker is duplicated between them on purpose: it is a dozen
lines, and a package to hold it would be more machinery than the thing it holds.

Both guards were verified by planting a raw NUL and watching them go red before being trusted
green — an absence assertion that has never been seen to fail is not evidence.

### 15. `defaultTheme` / `defaultThemeSetAt` are deliberately unpatchable

Upstream #8569 added both to `ServerSettings` and not to `ServerSettingsPatch`, which trips the
fork's patch-parity guard in `packages/contracts/src/settings.test.ts` (the guard exists because
a field missing from the mirror silently drops edits — that is how `localModels` was found). It
is deliberate here: `t3 theme set` (`apps/server/src/cli/theme.ts`) rewrites `settings.json`
directly and removes both keys when cleared, and clients only ever read them. They are listed in
`deliberatelyUnpatchable` rather than mirrored, so there is one writer, not two.

The 36th reconcile added a third: upstream's `projectSettingsFolded`, the one-time marker for the
legacy per-project settings fold in `apps/server/src/serverSettings.ts`. The server writes it once
and reads it on every load; a client patch would re-run or skip the migration. **The guard is
fork-only — upstream has no patch-parity test — so every `ServerSettings` field upstream adds
without a `ServerSettingsPatch` counterpart arrives as a red test in `packages/contracts`, with
nothing in the conflict markers to warn you.** Decide writer-ownership, then either mirror it or
list it here.

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

**Updated 2026-09-02 (27th reconcile).** Upstream #9140 renamed the chip's
`workspaceRelativePath` prop to `panelPath` and widened its meaning: workspace-relative when there
is one, otherwise the absolute host path of a non-media file. That is the fork's own "a report
under `~/reports` opens read-only" behaviour, re-implemented upstream and routed through
`openFileInPanel` rather than the fork's `openTrustedFile` detour, so the fork's two extra
branches in `handleOpenInFilePreview` are gone and `canOpenInPanel` is upstream's. The
`trustedFile` right-panel surface itself STAYS — `ChatView`, `FilePreviewPanel`'s directory
listing and `rightPanelStore.test.ts` still use it. A separate `workspaceRelativePath` prop was
added back beside `panelPath` because the fork's `onReveal` asks the workspace index for a
basename match, which only makes sense for a path inside the workspace.

Upstream's `onOpenMedia` is adopted, and its new "Preview media" item joins `sharedFileMenuItems`
rather than upstream's hand-written native menu — which is the whole point of the shared array.

The two menus deliberately differ: the in-DOM one carries "View in side panel" and "Open in new
tab", the native one carries "Open in integrated browser" and "Copy relative path". Everything
else comes from one `sharedFileMenuItems` array, built at `ChatMarkdown.tsx:2063`, which both
menus map — the native menu at `:2125`, the in-DOM menu at `:2314`. That sharing is the
enforcement: a shared item cannot drift between the two, because there is only ever one of it.

**Corrected 2026-08-29.** This section previously said the reveal item "uses `onReveal &&
revealLabel` inline at both sites, and nothing enforces the pairing, so change both". There is
**one** such site — `:2088`, inside `sharedFileMenuItems` — and the shared array is precisely what
enforces the pairing. Change it once. (The substance was right: the reveal item does appear in
both menus. Only the count and the "nothing enforces" claim were wrong.)

Do not extract that condition into a shared `boolean` predicate. `ContextMenuItem.label` is a
required `string` on the native side, and the inline truthiness test is what narrows
`revealLabel`; a boolean-returning call is opaque to control-flow analysis and the native mapping
stops compiling. A shared _object_ would narrow correctly, if the condition ever needs reusing.

### 17. The composer branch warning replaced upstream's branch-mismatch banner

Fork commit `cfdf25504` ("warn in the composer before a turn writes to another thread's branch")
removed upstream's `shouldShowBranchMismatchBanner` from `ChatView.logic.ts` and the banner it
drove from `ChatView.tsx`. Upstream still has both and still calls the helper.

That makes it invariant-4 shaped, but with a twist worth its own entry: the deletion is presented
by a merge as an **upstream import addition**. The 24th reconcile's only conflict was upstream
adding two names to the `./ChatView.logic` import list —
`shouldShowBranchMismatchBanner` (a fork deletion) beside `shoulderTabReserve` (genuinely new
and genuinely used at the time; the name has since gone from both sides, 0 hits on
`origin/main` and 0 here, so do not go looking for it). Taking both compiles and passes: the import
resolves to nothing, and nothing renders the banner.

**The mechanical tell:** after resolving, the merged `ChatView.logic.ts` exported the name
**zero** times while the merged `ChatView.tsx` still referenced it once. When a conflict is an
import list, count exports against references rather than reading the marker.

### 19. `contextWindowMeterEnabled` defaults to TRUE here, not upstream's false

Upstream #9190 made its circular context-window indicator opt-in, defaulting the setting OFF and
labelling the control "(legacy)" — it is retiring that indicator. In this fork the same switch
gates `activeContextWindow` on the composer's **Vitals gauge**, which is current, not legacy, and
has been on since it shipped. Taking upstream's default would have silently removed a shipped
feature from every existing user on the next launch.

The gate itself is upstream's and is KEPT: a settings switch that changes nothing is worse than
the divergence. Only the default flips, in
`packages/contracts/src/settings.ts`. `packages/contracts/src/settings.test.ts` ("defaults on and
preserves an explicit opt-out") and the "(legacy)" wording in `SettingsPanels.tsx` /
`settingsSearch.ts` follow it.

**Corrected 2026-09-08.** This entry used to list
`apps/desktop/src/settings/DesktopClientSettings.test.ts` as following the flip. It no longer
does and should not: upstream rewrote that fixture to spread `DEFAULT_CLIENT_SETTINGS`, and its
only defaults assertion compares `settings.get` against a re-decode of `{}` - self-referential,
so it pins no particular value. The fixture's `contextWindowMeterEnabled` is now arbitrary and
carries upstream's `false`. `settings.ts` is the single load-bearing site.

**A reconcile that restores `Effect.succeed(false)` here turns the Vitals gauge's context ring
off for everyone, and nothing fails.**

### 20. Two helpers upstream deleted as unused are still called here

Upstream #9150's dead-code sweep removed `newCommandId` from `apps/web/src/lib/utils.ts` and
`getProviderDisplayName` from `apps/web/src/providerModels.ts`. Both are dead upstream and live
here — `ChatView` mints a command id for a queued follow-up turn (invariant 5), and the composer's
provider label reads through the other. Both carry a `FORK-ONLY` comment now. The failure mode is
loud (typecheck), which is the good case; the point of the note is that upstream will keep
deleting them.

### 16. The socket TOS guard is load-bearing until Node >= 26.5.1

`apps/server/src/processGuards.ts` makes `net.Socket#setTypeOfService` non-fatal, and `bin.ts`
installs it inside the entrypoint guard so importing `cli` from a test patches nothing.

It is not defensive programming. On macOS a TCP socket whose connection was aborted at the
protocol layer - peer RST, or connect refused - keeps an open fd and still reports `AF_INET` from
`getsockname`, but `setsockopt(IP_TOS)` returns EINVAL. Node's **synchronous**
`setTypeOfService` throws on that; its own **deferred** path in `afterConnect` only _emits_ for
the identical failure. Bundled undici 8.5.0 calls it unconditionally on the first HTTP/1.1 write
to every plain-HTTP socket, from inside the socket's `connect` event - so the throw carries **zero
application frames** and nothing in the Effect error channel can catch it. It killed this server
five times, taking every in-flight turn with it. HTTPS is immune: `TLSWrap` has no such method.

Upstream fixed it: nodejs/undici#5544 -> #5547, undici 8.8.0, first shipped in **Node v26.5.1**.
This box runs 26.3.1. **Delete the guard once the minimum Node is >= 26.5.1** - the removal
condition is in the file.

Two things this deliberately is NOT:

- **Not a blanket `uncaughtException` handler.** That was the obvious fix and it is wrong here.
  This server is event-sourced; resuming after an _unknown_ fatal restarts a process whose decider
  or projector may be mid-transition, trading a visible restart for silent state corruption in the
  one system that cannot tolerate it. The guard rethrows anything whose `syscall` is not
  `setTypeOfService`, and a test asserts that.
- **Not silent.** `monitorFatalExceptions` registers `uncaughtExceptionMonitor`, which records the
  fatal and does **not** prevent the exit. Registering `uncaughtException` there instead would
  silently convert this into the crash suppressor above, so the test asserts the event _name_.

Verified by building it and running it, not by reading it: against a server that accepts and then
RSTs sub-millisecond, the unpatched arm crashes with the production stack (exit 1) and the guarded
arm survives 35,615 attempts (exit 0), suppressing 1 real EINVAL while every request still fails
as `ECONNRESET`.

### 21. `/api/assets` splits on which claim resolved the asset

Upstream #8919's `assetFileResponse` was rejected once, in favour of the fork's Range parser
(`assetVideoRangeResponse` + `assetResponseByteCap`), which also serves **audio**, caps the
rangeless video branch at `ASSET_MAX_VIDEO_BYTES`, caps images, and 404s a directory named
`foo.png` before headers are flushed. Upstream #9023 then gave `assetFileResponse` something the
fork's branch structurally cannot do: serve from an **already-open descriptor**, which is how a
`media-file-exact` claim (a host file outside any workspace) is served.

So the route splits on `asset.file`: present means the host-file claim resolved it and upstream's
helper answers; absent means a workspace asset and the fork's branch answers. `assetFileResponse`
and its `assetByteRange` are live again, with upstream's own suite restored in
`http.test.ts`'s "video asset byte ranges". The fork's retargeted edge-case suite above it now
says so.

`FilePreviewPanel` took the same shape: upstream's `WorkspaceVideoPreview` (retry + actions menu)
and `WorkspaceBrowserPreview` (HTML/PDF in place) are adopted, and the fork's component is
narrowed to `WorkspaceAudioPreview` — audio has no upstream branch at all. Upstream's browsable
`FileBreadcrumbs` (#8910) replaced the fork's display-only crumb list. It takes the root label as
`projectName`, and the fork passes **`fileRepoName`** — the repository the open file actually came
from — not the project's name. The two differ exactly when a file is opened out of an attached
workspace member, which is the wrong-root confusion the fork's label fix exists to prevent; the
merge dropped the only call site and left the label disagreeing with the `cwd` beside it.

### 22. Claude adapter tests: synthetic catalog by default, bundled where the model IS the subject

Upstream replaced the fork's hardcoded context-window table with the manifest-driven
`ClaudeModelCatalog`, and pointed `ClaudeAdapter.test.ts` at a **synthetic** catalog
(`ClaudeModelCatalog.testFixtures.ts`) so transport tests stay independent of manifest contents.
Keep that default.

But the fork's auto-compaction rules are keyed on **real slugs** (`claude-opus-4-8`,
`claude-opus-4-6`) and on the real `[1m]` API suffix, and against a synthetic catalog they resolve
no window at all — four wrong assertions, two hangs, and a percentage resolved against 200k instead
of 1M. Those tests pass `modelCatalog: Effect.succeed(BUNDLED_CLAUDE_MODEL_CATALOG)` to
`makeHarness`, because the bundled catalog is what the adapter resolves in production.

No production behaviour moved: `model-manifest.json` carries `fixedContextWindowTokens: 1000000`
for `opus-4-8`/`opus-4-7` and `contextWindowTokens` for every model with a window toggle, so the
catalog lookup returns what the fork's switch used to. `claudeCliContextWindow`'s hardcoded
native-1M switch and `CLAUDE_UNARMED_COMPACTION_MODELS` are still fork-owned and still real-slug
keyed.

Related: upstream's own new adapter tests may send a second turn while the first is running.
**Running a queued turn after the current one is fork-only**, so such a turn never reaches the
provider — the symptom is a test that _hangs_ on a prompt read rather than one that fails.
Retarget by completing the running turn first, which is the fork's actual contract.

Be precise about what "fork-only" covers here, because two upstream queues make the loose version
of this claim false. `origin/main` has both `promptQueue` in `ClaudeAdapter.ts` and
`threadHasQueuedTurnStart` in `ThreadSettlementPolicy.ts`. What it does not have is the adapter's
follow-up drain: `drainNextPendingTurn` and `withdrawQueuedTurn` are 0 hits on `origin/main` and
live across 18 fork files. Verified 2026-09-06.

### 23. Slow-by-design RPCs get the long leash, never the untracked set

Fork commit `facc05f9e` set the rule for `apps/web/src/rpc/requestLatencyState.ts`: a call that is
slow because it fans out or shells out joins `longRunningRpcAckMethods` (120s), not
`untrackedRpcAckMethods`. "Slow by design" and "unobservable" are different claims, and the
untracked set hides a call that has genuinely wedged. Upstream #9358 put `serverGetUsageSummary`
in the untracked set; here it sits on the long leash and its test asserts the 120s edge. Expect
upstream to keep adding to the untracked set; move each addition down.

**One exception, added 2026-09-04.** `isTrackedRpcAck` drops every method whose name contains
"subscribe" before the leash is consulted, because a subscription is a long-lived stream rather
than a request. The fork's two `pullRequests.` tests enumerate that namespace from `WS_METHODS`,
so upstream #9496's new `pullRequests.subscribeRefreshes` broke them with nothing wrong; the
enumeration now excludes subscribe-shaped methods. A new non-subscribe method in the namespace
should still be picked up automatically.

### 24. The resting composer and the strip toggle are orthogonal, and meet in `ChatView`

Upstream #7855 auto-collapses the whole composer when an existing desktop thread's composer is
unfocused, and relocates the model/mode controls into the thread-context strip. The fork's
`ed3b7263e` is an explicit, persisted footer toggle that hides that strip. Both are kept. They
meet at one point: upstream needs the strip **mounted** while invisible so the resting composer can
measure it, and the fork needs the `aria-controls` target to exist. `ChatView.tsx` therefore
mounts the strip on upstream's `mountComposerContextStrip` and passes
`contextStripVisible={renderComposerContextStrip}` — the fork's collapse suppresses the strip's
chrome, not its mount. With the strip collapsed a resting composer's relocated controls are hidden
too; upstream's own doc accepts that case (the controls return on focus).

The `ContextWindowMeter` upstream renders behind `showSecondaryStatus` is still rejected (§4, §10);
the fork's Vitals gauge sits behind the same flag so a resting composer stays one line high.

### 25. ACP cancel keeps the fork's generation guard over upstream's dispatch semaphore

Upstream's Antigravity rework of `AcpSessionRuntime.ts` (`activePromptRef`,
`promptDispatchSemaphore`, `acquireUseRelease`, `cancelBehavior`) does not cover the fork's fix
`73ac45066`: a prompt parked on `promptSerializationSemaphore` has run none of the body that
registers it, so `cancel` cannot see it and it goes to the agent after Stop. The semaphore only
serialises cancel against dispatch in `wait-for-prompt` mode; in the default `interrupt` mode
(Cursor, Grok, OpenCode) the window is still open. The fork's `promptCancelGenerationRef` is
layered on top: read before parking, re-checked before dispatch, re-checked once more after
registration, and bumped in `cancel` before `getStartedState`. The post-registration re-check is
gated on `cancelBehavior !== "wait-for-prompt"` — ungated it would fire on every Antigravity cancel
of a running prompt and turn its wait-for-confirmation into a failed cancel. Mutation-checked:
dropping the bump in `cancel` turns `AcpJsonRpcConnection.test.ts`'s parked-prompt case red.

### 26. `isKnownFilesystemRootPath` is a FORK-ONLY export of client-runtime

Upstream #9250 (`922bd6922`) moved `apps/web`'s path helpers into
`packages/client-runtime/src/markdownLinks.ts` and kept `POSIX_FILE_ROOT_PREFIXES` module-private.
The fork's chat prose linkifier (`chatFilePathLinks.ts`) and the link gate must share one answer to
"is this a filesystem path", so the predicate is exported from client-runtime and re-exported by
`apps/web/src/markdown-links.ts`. It tests Windows **drive** paths only — an escaped backslash in
prose is not a UNC path (measured 0 true positives). Three of upstream's new helpers are the fork's
own re-implemented line for line (`fileBasename` = `basenamePathSegment`, `workspaceRelativeFilePath`
= the local `workspaceRelativePath`, `formatFilePathPosition` = `withPosition`), so the fork's copies
are aliases or gone.

### 27. The provider settings form has one dropdown, upstream's

The fork's native `<select>` (`69212ea7e`) was removed on 2026-09-03 after the premise it rested
on was measured false. `selectedOptionValue` is fork-only and feeds upstream's
`ProviderSettingsSelect`; a reconcile that brings back a `field.options !== undefined` branch is
restoring a deleted duplicate. One line of upstream's component is fork-edited: `current` reads
`selectedOptionValue(...)` rather than the raw stored string, so an off-list value shows the first
row (Antigravity's `authMethod` included) instead of a choice the driver will not use; re-picking
that row still writes the omitted key.

### 28. Claude's continuation group is the transcript store

Upstream keys Claude's continuation group on HOME only (`makeClaudeContinuationGroupKey`,
`ClaudeHome.ts`). The fork keys it on `realpath(<configDir>/projects)` instead — the directory
`claude --resume` actually reads `<cwd>/<sessionId>.jsonl` from — normalised through the deepest
existing ancestor so the key does not flip the first time Claude creates `projects`. Two config
dirs whose `projects` resolve to one directory share a key even with different HOME, because HOME
does not locate the transcript once `CLAUDE_CONFIG_DIR` is set.

A persisted resume cursor follows the thread across two instances that share a key
(`sharesContinuation` in `apps/server/src/provider/Layers/ProviderService.ts`), not only across the same instance id.
Mobile's model picker filters to the thread's continuation group (`filterThreadProviderGroups`,
`apps/mobile/src/lib/modelOptions.ts`), ported from web's existing predicate
(`ChatView.logic.ts`).

A reconcile that restores the upstream HOME-only key, or any key built from the raw config-dir
string instead of the resolved `projects` path, silently re-refuses a switch this fork means to
allow. A reconcile that restores the old id-only cursor inheritance (dropping
`sharesContinuation`) silently loses history on a stopped-session switch between two instances of
the same store, because the switch itself is no longer refused but nothing hands the cursor over.

### 29. Two rate-limit events, one Codex notification

Upstream #9507's Limits tab reads `account.rate-limits.updated`; the fork's composer Vitals
gauge reads `account.usage.updated` with a `fetchedAt` stamp. Both are emitted from the single
`account/rateLimits/updated` notification in `CodexAdapter.ts`, through two different
normalizers (`codexRateLimitsToUpdate` and `normalizeCodexRateLimitsNotification`). A reconcile
that keeps only upstream's branch silently blanks the gauge; one that keeps only the fork's
leaves the Limits tab empty for Codex.

### 30. A failed session stop: clear the spinner, unless a compaction was in flight

Two rules meet in `processSessionStopRequested` (`ProviderCommandReactor.ts`) and a compaction
in flight is the only thing that tells them apart.

- FORK (`868ed1c02`): a provider that cannot be stopped — dead process, closed transport — must
  still get the `stopped` session write, or the thread sits with a spinner nothing can clear.
  Its test is "still clears the session, and says so, when the provider fails to stop".
- UPSTREAM (#9293): when the stop interrupted a compaction, the failure path restores the
  session itself, and a `stopped` write on top clobbers that fresher state. Its test is "does
  not overwrite concurrent session state after compaction failure".

So the write is skipped exactly when this handler found the thread in `compactingThreadIds` on
entry. Note the ordering trap: `restoreCompaction` returns without writing while the thread is
in `stoppingThreadIds`, so the stopping mark has to come off before it is called.

### 31. The live subscription is bounded by upstream's budget, not the fork's pump

**Superseded at the 30th reconcile.** The fork used to chain upstream's coalescer into a bounded
`Queue.dropping` (`WS_LIVE_BUFFER_CAPACITY`, `pumpBoundedLiveBuffer`), and answered a
`requestCompletionMarker` subscription with `offerAndWait` because the pump draining that queue
raced upstream's `takeAll`.

Upstream #9521's follow-up made that chain unnecessary. `makeLiveStreamBudget`
(`apps/server/src/orchestration/LiveStreamBudget.ts`) bounds a subscription by **retained items
AND retained serialized bytes** (1,000 / 8 MiB) and _fails_ the stream on overflow, which the
client transport treats exactly as the fork's dropping queue did: resubscribe with
`afterSequence` and resync losslessly. Every offer into the coalescer's output queue goes through
`budget.retain` / `budget.check`, so the queue being `Queue.unbounded` no longer means unbounded
memory. That is a strictly stronger bound than the fork's row count, and it restores the single
buffer the marker ordering needs — so `liveBuffer.offer({ kind: "synchronized" })` is safe again
and there is no `takeAll` to race.

`boundedLiveBuffer.ts` and its test were deleted with the last caller. The discriminating test is
still `server.test.ts`'s "buffers thread events published while the initial snapshot loads": if a
future reconcile reintroduces a second buffer in front of the coalescer, that test is what catches
the marker overtaking an in-flight event.

### 33. The per-value failure-budget reset must not be a `Stream.tap`

The fork clears the expected-failure budget on every emitted value ("a value proves the
subscription works"). It used to do that with `Stream.tap(() => resetExpectedFailures)` inside
`subscribeDynamicMapped`'s inner stream.

Upstream #10120 added `subscribeDynamicWithSession`, which tags each value with the session that
produced it via a plain `Stream.map` - deliberately, so `switchMap` cannot lose a value the old
session had already buffered when the session changes (its own comment says so). A `Stream.tap`
sitting next to that tag re-introduces exactly the Effect boundary it engineers away: the
buffered value is dropped and the subscription stalls. `client.test.ts`'s "keeps the producer
session on an old value buffered across a session switch" hangs, and it is the only thing that
catches it.

The reset is therefore recorded synchronously (`producedValue`, set in a `Stream.map`) and
flushed inside `catchCause`, where an Effect boundary is free. Anything else added to that inner
pipeline has to be synchronous for the same reason.

### 32. Claude notifications are `runtime.notification`; only three subtypes warn

Fork commit `e71c04825` deleted `emitRuntimeWarning` from the Claude adapter to stop the
per-turn "Runtime warning" spam: every SDK message subtype the adapter does not model used to
reach the user as a warning row, when `logNativeSdkMessage` had already captured it. The
`default:` arm drops to `Effect.logDebug` instead, and `case "notification"` emits a dedicated
`runtime.notification` event regardless of priority.

The 30th reconcile put the helper back, deliberately and narrowly. Upstream added three subtypes
that describe something a user genuinely needs to see, and none of them is the unmodelled-subtype
spam the fork removed:

- `model_refusal_fallback` - a safety fallback silently switched the model mid-session.
- `model_refusal_no_fallback` - the model declined and nothing took over.
- `informational` with `level === "warning"` - e.g. a Stop hook that refused continuation.

What must stay: the `default:` arm logs at debug and never warns (it now also carries upstream's
`message satisfies never` guard, so a new SDK subtype fails typecheck rather than slipping
through), and notifications of every priority go to `runtime.notification`, never to a warning
row. Upstream's `case "notification"` emitting a high-priority warning is dropped on sight - it
would sit unreachable behind the fork's arm and re-open the spam if the arms were ever reordered.
`ClaudeAdapter.test.ts`'s "consumes undeclared and UX-internal system subtypes without warning
rows" pins the whole shape: exactly three warnings, two notifications.

### 34. Ingestion command ids: the fork skips the receipt, upstream only adds entropy

`apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` (the path in this entry used
to say `apps/server/src/provider/`, which has never existed - corrected 2026-09-08) keeps a
**synchronous** `providerCommandId` (a plain
`provider:<eventId>:<tag>` name) and dispatches through the fork's `dispatchWithFreshCommandId`,
which appends a UUID _and_ passes `{ singleUseCommandId: true }` so the engine writes no receipt.
Ingestion receipts were 98.5% of a real 2.08M-row receipt table and none was ever read back.

Upstream shipped a competing version at the 31st reconcile: it moved the UUID **into**
`providerCommandId`, making it an Effect, and dispatches through plain `orchestrationEngine.dispatch`.
That fixes replayable ids but still writes every receipt - `singleUseCommandId` does not exist
upstream at all (it is fork-only across 8 files). The fork's version is strictly stronger, so keep it.

**The tell after a merge:** a `yield* providerCommandId(...)` anywhere in this file. The fork's is
not an Effect, so yielding it produces `undefined` where a `CommandId` is required. Count them:
upstream has 11, the fork must have 0.

### 35. The Claude result classifier is the fork's pair, not upstream's `resultOutcome`

Upstream #10296 folded `turnStatusFromResult` and `resultUserFacingError` into one `resultOutcome`
that classifies from `terminal_reason` alone. Adopting it silently drops four things the fork's
pair does: abort handling (`isAbortedResult`, so a user Stop is not recorded as a failure), the
guard for a non-string `result` (the CLI runs ahead of the typed SDK and throwing here tears down
the session), per-**line** diagnostic filtering (`[ede_diagnostic]` can sit on any line), and the
529 `OVERLOADED_RESULT_MESSAGE` fallback. Keep the fork's two functions and its
`FAILED_TERMINAL_REASONS` set, which upstream does not have.

The 31st reconcile took upstream's _call site_ without its _declaration_, which typecheck caught.
The dangerous version of this merge is the one that takes both.

**Widened 2026-09-08 (32nd reconcile).** Upstream #10321 and #10549 gave `resultOutcome` something
the fork's pair did not have: a `failureHint` assembled from evidence the turn recorded while it
was failing - `authenticationFailureMessage` (set when the CLI reports `authentication_failed`,
via `claudeSignedOutMessage`) and `rejectedRateLimitTypes` / `latestAssistantRateLimited`. Its
point is that `terminal_reason: "api_error"` should name the expired login or the usage window
instead of "Claude gave up after repeated API errors."

That is adopted, on the fork's classifier rather than upstream's. `resultOutcome` and
`terminalResultError` are still rejected; the hint is threaded into
`resultUserFacingError(result, failureHint)` and `structuredResultFailureMessage(result, failureHint)`,
which is where the shared `switch` already reads it. The three `ClaudeTurnState` fields and every
site that writes them are upstream's, merged unchanged. Status classification did NOT move:
`api_error` is already in the fork's `FAILED_TERMINAL_REASONS`, so `turnStatusFromResult` needs no
hint.

**Threading the hint is not the whole graft, and the first attempt at it was wrong twice** - nine
upstream tests caught both. The message for a result the CLI tags `success` while setting
`is_error` now has a strict order, in `successTaggedFailureMessage`:

1. **The typed `errors[]` entry**, if any. The fork previously read that list only for
   non-`success` subtypes, so a success-tagged failure carrying `Tool execution failed: EACCES`
   reported the _hint_ instead - a rate-limit or expired-login line, describing the category while
   throwing away the actual error.
2. **The CLI's own prose**, per-line diagnostic filtering intact.
3. **A structured fallback, and here the fork and upstream genuinely disagree.** The fork refuses
   to build a message out of `terminal_reason`, because it reads `api_error` for every provider
   HTTP failure and would claim a turn was abandoned after repeated retries when it was not.
   Upstream's new tests require exactly that message. **The discriminator is whether the payload
   HAS a `result` field**: present but unusable (blank, or not a string) means the CLI had a place
   to say why and said nothing, so only the turn's recorded evidence may speak and the caller's
   generic "Claude turn failed." otherwise stands; absent entirely is a different payload shape -
   upstream's rate-limit results carry no `result` at all - where `terminal_reason` is the only
   account of the failure there is. Both sides' tests pass on that split; picking either rule
   outright reddens three tests belonging to the other.

### 40. `homePath` and `configDirPath` are two settings here, and a blank one SCRUBS

Upstream's `makeClaudeEnvironment` has one path setting and maps it straight onto
`CLAUDE_CONFIG_DIR`, deliberately leaving `HOME` alone (overriding `HOME` moves the macOS login
keychain and the CLI then reports "Not logged in"). A blank `homePath` returns the base env
untouched, so an **inherited** `CLAUDE_CONFIG_DIR` survives into the spawned CLI.

The fork splits them: `homePath` sets `HOME`, the fork-only `configDirPath` sets
`CLAUDE_CONFIG_DIR`, and a blank `configDirPath` **deletes** any inherited one. The deletion is
the load-bearing part. Continuation and capabilities keys resolve a blank config dir to `""`
(invariant 28), so an instance that inherited someone else's `CLAUDE_CONFIG_DIR` would run against
a different login than its own keys encode - it would resume, and be refused resumption, on the
wrong transcript store. `ClaudeHome.test.ts` pins all three cases, including that `homePath` alone
leaves `CLAUDE_CONFIG_DIR` unset.

Upstream's new `ClaudeAdapter` test "reports the same Claude config and cwd used by the spawned
query" drives `homePath` and asserts the inherited value survives - true upstream, false here. The
property it pins IS fork-relevant (the auth-failure message must name the config dir and cwd the
query was _actually_ spawned with, JSON-quoted, not a re-derived guess), so its rows drive
`configDirPath` instead, and the blank row asserts the scrub end to end: no config dir in the env,
and none named in the message.

**39th reconcile: upstream #12624 is rejected whole.** It makes `resolveClaudeHomePath` fall back
to an inherited `CLAUDE_CONFIG_DIR`, then `~/.claude`, and threads `processEnv` into both keys.
Upstream's `homePath` IS the config dir; here it is `HOME`, and the fork's key appends `.claude`
itself, so that rewrite (which merged OUTSIDE the markers) turns a blank instance's key into
`~/.claude/.claude`. The bug it fixes (blank and explicit `~/.claude` in different groups) does not
exist here: the key is the realpath of `<configDir>/projects` and an inherited config dir is
scrubbed. `ClaudeHome.ts`, its test and `ClaudeDriver.ts` are the fork's. A future upstream edit to
`resolveClaudeHomePath` needs the same check: same name, different setting.

### 36. Web tests run two projects; `--project dom` is fork-only

`apps/web/package.json`'s `test` script is `vp test run --passWithNoTests --project unit --project dom`.
Upstream ships only `unit`. The fork's `*.dom.test.tsx` files - real-DOM tests via
`src/testing/renderDom` - are invisible to a merge that takes upstream's script, and they fail
open: `--passWithNoTests` means a run that matches nothing still exits 0. A gate that "passed"
having never executed the dom project has happened twice; the only reliable signal is the **test
count**, not the exit code.

The fork also renamed several upstream test files to `.dom.test.tsx` (`MessagesTimeline`,
`ChatMarkdown`, `ProviderStatusBanner`, `ComposerPrimaryActions`, `sidebarChromeFooter`). Git is
rename-blind mid-merge, so upstream's edits to the old name arrive as a **new file** rather than a
conflict. After a merge, check that no `<name>.test.tsx` sits beside the fork's `<name>.dom.test.tsx`,
and port any tests upstream added to its copy.

**A fork-ORIGINAL `.dom.test.tsx` has no upstream ancestor, so nothing carries upstream's mock
updates into it — and the sweeps cannot see the gap.** The 34th reconcile is the worked example.
`git merge` did detect nine of the renames and applied upstream's edits to the renamed copies, so
`ChatMarkdown.dom.test.tsx` learned upstream's new `useServerConfigs` mock automatically. But
`ChatMarkdown.remote.dom.test.tsx` is fork-written, never existed upstream, mocks the same
`../state/entities` module wholesale, and therefore went on returning a module without that export.
Four tests died at render with `No "useServerConfigs" export is defined on the mock`. Nothing in
the sweep output named the file: FORK-LOSS reported only the renamed siblings, because the fork
file lost no line — it needed a line it never had.

After a merge that adds a hook call anywhere in a widely-rendered component, grep the fork's own
`vi.mock("<module>")` factories for the newly-required export, not just the renamed test files.

### 37. `FORCE_KILL_AFTER` on the git spawn is fork-only, and every git timeout depends on it

`apps/server/src/vcs/GitVcsDriverCore.ts` passes `forceKillAfter: FORCE_KILL_AFTER` (5s) as a
spawn option on every git child. Upstream does not: zero occurrences of `forceKillAfter` in
`origin/main`'s driver. It is consumed by the Node spawner's release finalizer — SIGTERM, await
exit, SIGKILL after the grace — which runs on _any_ scope close, so the driver's own command
timeouts and any external interruption (the startup auto-pull bound, `serverRuntimeStartup.ts`)
all go through it. Without it the finalizer waits on a git that ignores SIGTERM forever: measured
on an upstream-main tree, a SIGTERM-proof child hung a 2s timeout past **180s**; on the fork the
same case resolves at budget + 5s. Every bound in the driver is therefore `timeout +
FORCE_KILL_AFTER`, and the retry a timeout exists to trigger can only fire because of it. The 5s
is also the accepted `index.lock` residue window (a git that ignores SIGTERM for the whole grace
is SIGKILLed holding the lock; an ordinary git releases it in ~50ms). Pinned by
`GitVcsDriver.test.ts` "a git that ignores SIGTERM is still reaped": a `git` shim on the child's
PATH that traps TERM and loops; the test hangs to its 30s ceiling with the option removed, and
passes at ~5.5s with it. A merge that drops this line reads as a clean upstream sync and
un-bounds every git command in the server.

### 38. Upstream's knip pass un-exports things; three fork-only exports live on

Ten upstream commits in the 32nd reconcile were `refactor(<area>): classify <x> exports` plus
`ci(knip): enforce <area> exports`. Their whole purpose is to narrow the public surface, so each
one is a chance to take away a symbol the fork imports. The failure is loud (typecheck) when the
importer is fork code, which is the good case. Three had to be given their `export` back:

- **`migrationEntries`** (`apps/server/src/persistence/Migrations.ts`) - read by the fork's
  `051_CrewTasks.test.ts`. **This one is the cautionary tale of the reconcile.** The fork's only
  change to that line was the `export` keyword, and it sat _outside every conflict marker_, so
  the merge silently took upstream's module-local version. The **line sweep did not report it**:
  FORK-LOSS for this file came back with two DROPPED lines and nothing else. Only the repo-wide
  typecheck caught it. Treat the sweep as a supplement to `pnpm run typecheck`, never a
  substitute, for anything whose loss is a _visibility_ change rather than a deleted line.
- **`resolveClaudeCatalogContextWindow`** (`apps/server/src/provider/ClaudeModelCatalog.ts`) -
  still defined, still called internally, no longer exported. The fork's `claudeCliContextWindow`
  switch (invariant 22) needs the window **mode** (`"1m"`), and upstream's surviving
  `resolveClaudeCatalogContextWindowTokens` returns a token count, so it is not a substitute.
- **`SettingsSearchTargetProvider`** (`apps/web/src/components/settings/settingsLayout.tsx`) -
  un-exported by upstream #9917 with its only upstream test; the fork's
  `settingsLayout.dom.test.tsx` drives it directly. Restored at the 38th reconcile.
- **`ComposerServerUpdateIcon`** (`apps/web/src/components/chat/ComposerServerUpdateStatus.tsx`) -
  the inverse direction. The **fork** had deleted it as unused; upstream's new
  `useAutoBalanceUpdateBanner` imports it, so the merge arrived with a live caller and the
  deletion had to be undone. Restored verbatim.

Expect more of these. `knip` is wired as a script (`pnpm run knip`) but is **not** in
`pnpm verify`, and its CI job does not run on this fork, so nothing here will flag a fork-only
export as unused - the pressure is entirely one-way.

### 39. Two interrupts, and only one of them arms the Stop ladder

Upstream #4308 added a keybinding command for stopping a thread, and its handler is a stable
`useCallback` in `ChatView.tsx` fed by `interruptContextRef`. The fork already had an
`onInterrupt` there: the two-press Stop ladder (invariant 7). They collided on the name only, and
the merge produced two `const onInterrupt` in one scope.

Upstream's is renamed **`onInterruptRunningThread`** - it pairs with the
`canInterruptRunningThread` predicate declared beside it - and the ladder keeps `onInterrupt`.
The rename is not cosmetic: like Cancel, the keybinding dispatches the plain cooperative
interrupt and neither reads nor advances the escalation ledger, so a shortcut press cannot arm a
force-stop. A merge that unifies these two into one handler makes every keyboard interrupt a
candidate first rung, and the next Stop click a force-stop.

### 41. Work-entry detail is a dialog here, so upstream's in-row expansion has no fork surface

`PlainWorkEntryRow` in `apps/web/src/components/chat/MessagesTimeline.tsx` opens a purpose-built
detail dialog (`hasWorkEntryDetail` / `onOpenDetail`). Upstream instead expands the row in place,
and carries `previewText`, `canExpand`, `expandedBody`, `commandMatchesVisibleLabel` and a
`stopRowToggle` handler for it. **The fork deleted all of that**, so every upstream commit that
tunes the expansion arrives as a conflict against machinery that no longer exists here. #10981
("allow expanding duplicate tool call commands") is the 34th reconcile's example: it rewrites
`canExpand` and a `truncate` class, both fork-absent, and was rejected whole.

The count also lives in a different place: the fork folds `×N` into `displayText` so it reaches
the accessible name, where upstream renders bare `previewText`. Taking upstream's `<span>` silently
drops the count from screen readers.

Reject the row-expansion half, but read the rest of such a commit: #11020 in the same batch was a
genuine touch-device fix (`pointer-coarse:opacity-100`) that belonged in the fork's own
`messageMetaVisibilityClasses` helper in `MessagesTimeline.logic.ts`. That helper auto-merged
untouched, so the fix would have been lost on both call sites had only the marked hunks been read.

That paragraph is about a **genuine** fix in the same commit that you would lose. The converse
also happens, and the 35th reconcile hit it three times: the **rejected** feature's own lines land
outside the markers and you keep them. #11014/#11017 left behind

- `const accessiblePreview = [previewText, answerPreview]…`, referencing two variables the
  rejection deletes — a typecheck error, so survivable;
- `stopRowToggleWhileSelectingText`, a self-contained dead helper — **the gate is green with it
  in**, measured;
- a new test, "only withholds an expanded tool-call label click while text is selected", which
  git's rename detection merged into the fork's `MessagesTimeline.dom.test.tsx`. It asserts a
  `select-text` class the fork never renders, so it is a guaranteed red.

The 36th reconcile hit the same shape from a new direction: #11433 turned the subagent spawn
entry into an expandable row (`AgentSpawnRow`, `AgentSpawnMemberRow`, `AGENT_MEMBER_STATUS_LABEL`,
`expandedSpawnEntryIds`, an `onToggleSpawnRow` handler). The fork's spawn entry is a
call-to-action row (`AgentSpawnCtaRow`) that opens the Agents panel, so the whole thing was
rejected — 112 lines on the sweep's DROPPED list, all deliberate. `AgentSpawnCtaRow`'s body had to
be restored from `personal` afterwards: git had spliced upstream's component in over it.

After rejecting these hunks, grep `MessagesTimeline.tsx` **and** `MessagesTimeline.dom.test.tsx`
for the expansion's vocabulary — `previewText`, `answerPreview`, `accessiblePreview`, `canExpand`,
`expandedBody`, `stopRowToggle*`, `select-text`. General rule and its measured detection coverage:
"Rejecting an upstream feature" below.

### 42. Upstream's new server test fixtures do not set `members`

`OrchestrationProject` carries a fork-only required `members` array (migration id 39, workspace
members). Every project fixture upstream adds needs `members: []` appended, and the only thing
that names them is the **repo-wide** typecheck — five such fixtures arrived in the 34th reconcile
(`linkCreatedPullRequest`, `pullRequests/handlers`, `PullRequestSyncReactor`,
`decider.pullRequests`, `projector`), all in files that merged without a single conflict marker.
`packages/client-runtime` has the same shape for `OrchestrationThreadShell.pullRequests`.

### 43. The fork's revert prompt-restore is RETIRED; upstream's rewind owns it

Until the 36th reconcile the fork carried its own revert affordance: `onArmRevertPromptRestore`,
a `pendingRevertRestoreRef` latched before the await, and an effect that put the removed message's
text back in the composer once it left the thread. Upstream's rewind (#11338/#11358) does the same
job store-side — `isRevertingCheckpoint`, a `pendingRevert` confirm dialog, `waitForRevertedMessage`
and `prepareRevertedMessageAttachments` — and it also restores **attachments**, which the fork's
ref never did. **Upstream's was adopted whole and the fork's machinery deleted.**

Two fork pieces were grafted onto it and must survive future merges:

- the discarded-message count in the confirm dialog, computed from `resolveRevertRetention` and
  rendered as "N messages and their turn diffs are discarded.";
- `MessagesTimeline`'s control keeps the fork's "Edit from here" label and passes the message id
  alongside the turn count (`onRevertToTurnCount(turnCount, messageId)`).

`noopHeldRevert` is now `(_targetTurnCount: number, _messageId: MessageId) => {}` — a reworded
signature, which is why the sweep lists it as BOTH-KEPT. Do not "restore" the deleted ref: an
upstream commit touching the rewind will look like it is reverting a fork feature, and is not.

### 44. Composer contexts travel as RECORDS, not as prose appended to the prompt

The fork used to append terminal output, review comments, preview annotations and element
contexts into the prompt text (`appendTerminalContextsToPrompt` and friends in
`apps/web/src/lib/threadSend/composeTurnStart.ts`). Upstream #11265/#11442 replaced that with
context **records** carried beside the message (`buildOutgoingMessageContext` /
`buildMessageContext`, rendered as inline references). Upstream's model was adopted; the fork's
prose-append helpers and `elementContexts` are gone from both send paths.

**Both send paths, not one.** The composer path (`ChatView`) and the queued path
(`queuedSend.ts` / `executeQueuedSend.ts`) each build their own context, and only the composer one
is reachable from the UI in a normal test. A merge that updates one and not the other loses
contexts on whichever path it missed, silently — nothing typechecks the pairing.

What stayed fork-side: `composeTurnStart` still owns the title seed, now derived from the
terminal/review/preview labels rather than the appended prose, and the trimmed prompt is still
`assistantCitationsToPlainText(stripInlineContextReferences(trimmed)).trim()`.

Legacy prose-appended messages are upgraded on read by upstream's
`packages/shared/src/composerContextLegacy.ts`, which the fork does not touch.

The change reaches the TIMELINE, not just the composer. A legacy `<review_comment>` block now
renders as a reference chip naming the file and range (`contextWindow.test.ts L47 to L58`, a
`lucide-message-circle`), not as a card with the comment body and its diff; a `@terminal-…`
mention is substituted in place, inside the prompt's own paragraph, instead of being appended
after it with a spacing span. Several fork assertions in `MessagesTimeline.dom.test.tsx` described
the old layouts and had to be rewritten — upstream rewrote its own copies of the same two tests in
the same commit, which is the confirmation that the new rendering is intended and not a merge
defect. The whole render path (`reviewCommentContext.ts`, `lib/composerContextRecords.ts`,
`composerContextPresentation.tsx`, `packages/shared/src/composerContextLegacy.ts`) is
byte-identical to upstream; keep it that way.

Two fork DOM test files went with the components upstream deleted:
`ComposerPendingReviewComments.dom.test.tsx` and `ComposerPreviewAnnotationCards.dom.test.tsx`.
They are the fork's own `renderDom` conversions, so they show on the sweep as 113 lines of
FORK-LOSS. That is correct: the components they drove no longer exist.

### 47. Thread notifications: the fork's stack and upstream's both ship

Upstream #11481/#11569/#11570 added its own thread-completion notifications, sounds and unread
badges. The fork already had a notification stack (web push, desktop badge, completion hooks) and
the two are not the same feature: upstream's is in-app and per-thread, the fork's survives a
closed tab and a screen-off phone. **Both were kept**, deliberately, rather than picking a winner.

Consequence for a future merge: an upstream commit that "fixes duplicate notifications" is
reasoning about one stack. Read which one before taking it, and check the fork's settings surface
still exposes both toggles.

### 50. Upstream's client-side message queue is rejected; the server queue owns mid-turn sends

Upstream #11673 added `apps/web/src/queuedMessageStore.ts`: a mid-turn send is held in an
in-memory per-tab store, shown as a dashed bubble, and dispatched at the next tool boundary or
when the turn ends. On this fork a mid-turn send already queues **server-side** (invariant 5):
durable, visible on every client, withdrawable, and opening its own turn. Keeping both would
hold a message in the tab and then queue it again on the server, and the client intercept in
`onSend` (`phase === "running"` -> `enqueue`) would bypass the fork's queue for every new send.

Rejected whole at the 37th reconcile by reverse-applying `cc839c42b` to `ChatView.tsx`,
`MessagesTimeline.tsx`, `MessagesTimeline.logic(.test).ts` and `docs/user/composer.md`, and
deleting the store and its test. Most of it had merged OUTSIDE the conflict markers. The sweep
shows ~500 DROPPED lines for this; all of them are the rejection. After a future upstream commit
touching this queue, grep `apps/web` for `queuedMessageStore`, `QueuedComposerMessage`,
`onSteerQueuedMessage`, `isQueuedMessageDue`: expect 0.

### 51. The compact sidebar is gone upstream, and the fork's copies of its code went with it

Upstream #11685 reverted its own compact (icon-collapsed) sidebar. The fork had built on it in
`Sidebar.tsx` (a compact draft row, a snoozed-footer portal and its drag overlay, a compact
sorting strategy), `SidebarChrome.tsx`, `SettingsSidebarNav.tsx` and `useSettings.ts`. None of
that is a fork feature; it is removed with upstream's. What survives from the fork in those
places is unrelated and kept: the Queue drag-out (`fromQueue`, `leavingSection`, `pushQueue`),
the footer panels' `items-end` row (5b), and `formatRelativeTime`'s `nowMs` parameter, which the
fork's task panels pass.

### 52. Upstream's queue-or-steer setting and its keybinding are rejected with the client queue

Upstream #11964 added `followUpBehavior` ("queue" | "steer") and a `thread.steerQueuedMessage`
keybinding (`mod+shift+enter`); #12075 turned `mod+Enter` while a turn runs into an `"alternate"`
submission that flips that setting for one message. All three drive the client-side queue rejected
in invariant 50, and this fork has no steer (invariant 5), so the 38th reconcile removed the
setting (schema, patch, its contracts test, the General row, its search entry, its restore
entries), the keybinding (contracts, shared defaults, `keybindings.test.ts`) and the docs that
describe them. `sendShortcut` from #12075 is independent and kept. The `"alternate"` intent in
`composer-logic.ts` is kept as upstream wrote it; `ChatView` treats it like `"foreground"`, which
here means the send queues server-side like any mid-turn send.

After an upstream commit that touches this, grep `apps/web/src`, `packages/contracts/src` and
`packages/shared/src` for `followUpBehavior` and `steerQueuedMessage`: expect 0.

### 53. `ProjectionCheckpointRepository` is fork-owned now; upstream deleted it as dead

Upstream #9917 ("remove obsolete code") deleted `persistence/{Layers,Services}/ProjectionCheckpoints.ts`
and inlined the checkpoint row schema into `ProjectionSnapshotQuery.ts`. The fork's copy carries
`memberStates` (migration id 40), and `ProjectionSnapshotQuery` still decodes checkpoint rows
through `ProjectionCheckpoint.mapFields`, so the files are kept (restored from `personal`) with the
fork's schema. `ProjectionRepositories.test.ts` still exercises the legacy-NULL decode through the
repository. A later upstream commit re-inlining the schema will conflict in `ProjectionSnapshotQuery`;
keep `memberStates` in whichever schema survives.

### 54. A folder opened from chat shows the fork's listing, not upstream's revealed tree

Upstream #10909 answers "a chat link to a folder" by hiding the preview pane and revealing the
folder in the workspace tree (`file.isNotFile`, `previewPath`). The fork's `1d1b15f84` answers the
same failure with a browsable listing in the preview pane (`useDirectoryListingQuery`), which also
works for a host path outside the workspace - upstream's leaves those on a read error. The 38th
reconcile kept `FilePreviewPanel.tsx` byte-identical to `personal`. The rest of #10909
(`projectFilesQueryState.isNotFile`, `FileBrowserPanel` reveal, `rightPanelStore` trailing-slash
trim) merged and is harmless.

### 55. Checkpoint capture is upstream's index reuse plus the fork's size bound and whole-op retry

Upstream's #10792/#12154/#12181/#10944 rewrote `captureCheckpoint` in `vcs/GitVcsDriver.ts`:
copy the real index, `read-tree --reset HEAD`, restore a racy timestamp, fall back on any
assume-unchanged / non-sparse skip-worktree flag, sparse-checkout support, empty-nested-repo
recovery, and fsync'd writes. That is a superset of the fork's own seeding (`resolveGitIndexPath`,
`realIndexHasSkipBits`), which the 38th reconcile removed. Two fork pieces stay on top and must
survive: `enumerateOversizedUntracked` (its `:(exclude,literal)` pathspecs are prepended to every
`stageFiles` call, including the nested-repo retry) and the whole-operation `captureRetryPolicy`
(on `resolveGitCommonDir` and around the body). Upstream's per-command transient retry in
`VcsProcess.run` (#11665) is complementary and kept. Upstream's racy stamp now calls the fork's
`copiedIndexStampSeconds`, which keeps its unit test pinned to the production path.

### 56. The fork's arraybuffer WebSocket constructor must accept effect's options argument

`apps/web/src/lib/runtime.ts` and `apps/mobile/src/lib/runtime.ts` replace effect's
`layerWebSocketConstructorGlobal` to force `binaryType = "arraybuffer"` (Blob frames decode
asynchronously and reordered under load). effect rc.115 widened the constructor's second argument from
protocols to `string | string[] | WebSocketClientOptions`; both wrappers now carry effect's own
guard (throw on client options, pass protocols through). A future effect bump that changes the
signature again shows up as a typecheck error in exactly these two files.

### 57. Every copied git index is re-stamped below its source, not only the checkpoint one

A copy of `.git/index` is stamped "now", so an entry rewritten in the source index's own second
stops looking racy and a same-size edit reads as unchanged. Upstream's capture re-stamps its copy
(`copiedIndexStampSeconds`); its review diff's `prepareReviewIndex` in `GitVcsDriverCore.ts` did
not, and the diff panel could hide a real edit whenever the copy landed a second after the write
(measured 5/5 with a 1 s delay, 0/5 against the real index). The 38th reconcile re-stamps that
copy too, after the two commands that rewrite it; `sees a same-size edit made in the same second
as the index` pins it. Any new `copyFile` of an index needs the same stamp.

Also from the 38th: capture's oversized-untracked scan (invariant 55) runs on the REAL index, so a
corrupt user index fails it. Capture now logs and captures without the bound on a git exit;
restore must keep failing there, since an empty set would let `git clean` delete the large files.
For the same reason a listing too large to size (truncated at 16 MiB) comes back `null`, not
empty: capture adds everything, and restore skips `git clean` entirely with a warning.

### 58. Upstream's restyle ceiling does not hold here, and is left alone

Upstream's `scripts/lint-restyle-ceiling.ts` caps `shadcn(no-restyle)` findings (className
overrides on `components/ui` exports) at a number it lowers as it migrates. It runs only in
upstream's CI, not in `pnpm verify`. At the 39th reconcile upstream sat exactly at its ceiling
(1207) and the fork at 1254: the net +47 is entirely fork-owned files (`LocalLlmSettings`,
`WorkspaceMemberEditor`, `TaskListPanel`, the three sidebar footer panels, `WorkEntryDetailDialog`,
`ComposerShortcutsControls`, `viewer.$`, `VitalsGauge`, plus a few lines in `GitActionsControl` and
`ComposerPrimaryActions`), minus the deleted `ContextWindowMeter`.

The constant is deliberately NOT raised: nothing here runs it, and a fork value would conflict every
time upstream lowers it. A red `pnpm run lint:restyle-ceiling` on this fork is expected. To measure
the fork's share, lint an `origin/main` worktree with `vp lint --format json apps/web/src` and diff
per file. New fork UI should still use variants, per the Taste rule in `AGENTS.md`.

### 45. The manual-Effect-runner debt ceilings in `vite.config.ts` are merge-sensitive numbers

`t3code/no-manual-effect-runtime-in-tests` permits no NET-NEW manual runners per file, via a
per-file `maxOccurrences` ledger in `vite.config.ts`. When a merge keeps both sides' tests in one
file, the count is the SUM and the ceiling has to be raised — the lint error names the file and
the line, but nothing points at the ledger. The 36th reconcile: `CheckpointReactor.test.ts` went
to 45 (fork 43 + upstream's two-arm cwd-fallback test), against upstream's ceiling of 42.

**This is the fork's cheapest false-red and its most expensive one to diagnose late**, because
lint runs before tests in `pnpm verify`: a two-error lint failure cancels the entire test step, so
the run tells you nothing about the other 10k tests. Front-load `pnpm run lint` after the last
merge edit.

### 46. Run the gate on the PINNED Node (`^24.13.1`), not whatever `node` resolves to

Every `pnpm` line in a gate log opens with `[WARN] Unsupported engine: wanted {"node":"^24.13.1"}`
when it is not. That warning is the only tell, and it is easy to read past.

Measured at the 36th reconcile on Node v26.2.0: `/[\p{L}]$/u.test("\u{10400}")` returns **false**,
while `/\p{L}$/u` on the same string returns true — a V8 regression on a unicode property escape
inside a character class matched against a non-BMP code point at an end anchor. It reds exactly one
test, upstream's `composerContextLegacy.test.ts` "does not replace terminal labels embedded in
𐐀@build:7", in a file byte-identical to `origin/main`. Node 22 and 24 both return true.

A red test in a file with a **zero-line diff against upstream** is the signature: baseline it
against the pinned runtime before believing the merge caused it.

### 48. `activitiesInOrder` memoizes by ARRAY IDENTITY; upstream's tests mutate one array

`apps/web/src/session-logic.ts` caches the sorted activity list in a `WeakMap` keyed by the input
array. Its own comment states the contract: _"a caller that mutated an array and re-derived would
see the previous order."_ Production always hands it a fresh list.

Upstream's tests do not. #11433's new
`deriveWorkLogEntries` test pushes into one array and re-derives after every push; under the fork's
memo, every call after the first reads the FIRST snapshot, so the whole test sees one activity and
returns zero rows. The failure reads like a broken derivation — `expected [] to have a length of
1` — and points at fork code that is correct.

When an arriving test re-derives from a mutated array, give each call its own copy
(`deriveWorkLogEntries([...activities])`). Do not weaken the memo: it is what keeps a long
thread's timeline from re-sorting on every render.

The same shape will recur for any fork-added identity cache. The tell: a red assertion whose
"received" value corresponds to an EARLIER state of the fixture.

### 49. The General-panel catalog coverage check reads source, so a child mount looks missing

`settingsSearch.test.ts` asserts every `/settings/general` catalog entry has a mounted anchor by
grepping `SettingsPanels.tsx` for `searchableSetting("<id>")`. Upstream mounts some anchors from a
CHILD component with a computed `SettingsSection id` — `project-defaults` in
`ProjectDefaultsSettings.tsx`, `thread-notifications` in `NotificationSettings.tsx`. Both render in
the General panel and both read as missing.

The check now also scans the sibling components the panel imports, one level deep, and carries a
negative control (`not-a-real-settings-anchor`) so a substring search over several whole files
cannot silently start matching everything.

### 18. The event hub is unbounded; every consumer of it must not be

`apps/server/src/orchestration/Layers/OrchestrationEngine.ts` publishes domain events into an
**unbounded** `PubSub`. That is deliberate - the dispatch worker must never backpressure on a
slow reader - and it is exactly why every consumer needs its own bound. Two confirmed OOM
crash-loops came from this hub, and each fix is a separate piece that a merge can revert on its
own:

- **There is exactly one eager accessor, `subscribeDomainEventsLossless`, and it is unbounded.**
  A bounded sibling, `subscribeDomainEvents`, used to sit beside it for WebSocket callers, backed
  by `boundedSubscriberStream` and `T3CODE_WS_SUBSCRIBER_BUFFER`. It was **removed in a standalone
  cleanup after the 31st reconcile**: `ws.ts` had already moved to `makeLiveStreamBudget`
  (invariant 31), leaving the bounded accessor with **zero production callers** while it went on
  attracting reactors by mistake - `d2bb199d4` (the 112-commit merge) put `ProviderCommandReactor`
  on it, and the 31st reconcile brought `ThreadPullRequestReactor` in on it. Both were caught by
  review, neither by a test.

  **The `Lossless` suffix is a live merge tripwire, not a leftover contrast.** Upstream has its own
  `subscribeDomainEvents` **today**: `git show origin/main:apps/server/src/orchestration/Layers/OrchestrationEngine.ts`
  defines it, upstream has no `Lossless` accessor at all, and upstream's `ProviderCommandReactor`
  calls it. Every reconcile therefore arrives carrying call sites named `subscribeDomainEvents`.
  Measured by replaying upstream's exact call site into both trees:

  ```
  PARENT (bounded sibling present) + upstream's line   typecheck exit 0, 0 errors
  HEAD   (sibling deleted)         + upstream's line   typecheck exit 1
    ProviderCommandReactor.ts: error TS2339: Property 'subscribeDomainEvents'
      does not exist on type 'OrchestrationEngineShape'
  ```

  That is what the deletion buys: a merge that used to silently put a droppable buffer in front of
  a reactor is now a compile error. Do **not** rename `Lossless` away to match upstream - that
  re-opens exactly this door, and upstream's accessor is unbounded, so a later upstream change to
  it would land unreviewed.

  The 38th reconcile fired the tripwire as designed: upstream moved `ThreadSettlementReactor`,
  `PullRequestSyncReactor` and the new `storageCleanup` onto `subscribeDomainEvents`, typecheck
  named all three plus two test stubs, and each now takes `subscribeDomainEventsLossless`.

  **Probing this invariant.** The compiler now enforces the half that mattered: there is no bounded
  accessor left to bind to. For the rest, grep non-test server source for `subscribeDomainEvents`
  without `Lossless`. On the tree this ships with it matches **exactly one line** - the comment in
  `OrchestrationEngine.ts` that records why the name is a tripwire. Any _other_ hit is an upstream
  call site that arrived in a merge.

  Read the matched lines, never the count, and note that the expected count is one rather than
  zero: an earlier wording here said it "should match nothing", which the fork's own comment
  falsifies on every run. That is the same comment-matches-the-probe trap that made three
  invariant probes flag a correct tree in reconcile 22. An earlier wording still ("only the
  definition and the WS layer may match") had gone **stale, not vacuous**: it would still have
  caught a mis-wired reactor, but `ws.ts` had stopped matching and two other files matched that
  the wording did not permit.

  **Known gap:** deleting `boundedSubscriberStream.test.ts` removed the only test that drove a
  stalled consumer against a **live hub**. The unit-level bound is covered - the single test in
  `LiveStreamBudget.test.ts` retains to `maxItems`, deliberately never resumes the consumer, and
  asserts the next `retain` fails - but there is still no end-to-end `subscribeShell` /
  `subscribeThread` overflow test. The accessor invariant is structural; the bound is covered in
  isolation and not at the seam.

  (An earlier version of this paragraph said that file held "two `it` blocks, neither of which is
  overflow-under-stall". It has one, and that one is overflow-under-stall. Corrected after being
  measured - in the section rewritten to remove exactly this kind of claim.)

- **`ws.ts` bounds through `makeLiveStreamBudget`** (see invariant 31). Upstream's coalescer
  (#8368) was `Queue.unbounded` at _both_ ends - the precise shape that OOM-ed this server - and
  the fork chained it into a `Queue.dropping`. Upstream has since put every offer behind a budget
  that caps retained items **and bytes** and fails the stream on overflow, so the fork's chain was
  dropped at the 30th reconcile in favour of it. What must not come back is an offer path into the
  coalescer that skips `budget.retain` / `budget.check`: the queue itself is still unbounded, and
  the budget is the only thing standing between a stalled socket and the heap.
- **`groupedWithin`/`aggregate`/`aggregateWithin`/`aggregateWithinEither` are banned in new
  code** by `oxlint-plugin-t3code/rules/no-unsafe-stream-aggregate.ts`; the replacement is
  `batchWithinStackSafe`. They lower to a non-stack-safe `stepToBuffer` schedule loop that pins
  continuation frames on every _idle_ tick (~1.9 GB/hr, crash every 13-14h). That was the
  confirmed heap burst - not the `Stream.take` recycle first blamed and later falsified. Note
  what is NOT true: no patch in `patches/` touches `Stream` any more, so the two allowlisted
  `ws.ts` shell-coalescing sites are safe by virtue of the **pinned effect version alone**.
  Re-measure with `scripts/idle-aggregate-probe.ts` on any effect bump.

- **Why reactors need the eager accessor at all.** Moving `ProviderCommandReactor` off
  `streamDomainEvents` onto an eager accessor was a real fix - its subscription then exists before
  `start()` returns; reverting it locally took the reactor suite from 3 failures to 18 and a 235s
  run. The mistake was only _which_ eager accessor. Any new internal reactor takes
  `subscribeDomainEventsLossless`.

  A side effect worth knowing when writing tests: with the subscription eager but the _enqueue_
  still happening on a separate stream fiber, `reactor.drain` is **not** a barrier for work
  triggered by a `dispatch` that just returned - the drain can find an empty worker queue and
  return before the event has been enqueued at all. Wait on the observable outcome first (the
  `waitFor` yield-loop in `ProviderCommandReactor.test.ts`), then drain if the assertion also needs
  the unit's follow-up dispatch to have landed.

**The health gauge belongs to the running server, not to the layer.** It reads
`OrchestrationEngineShape.hubBacklog` and is forked in `serverRuntimeStartup.ts`
(`T3CODE_HUB_GAUGE_MS`, default 60s, `0` disables). It lived inside the engine layer for one
release and had to move: an interval fiber constructed with the layer starts at the _test_ clock's
epoch, so any test that warps the clock to a real timestamp replays the gauge once per interval
across the whole span. That wedged upstream #8600's auto-settle test at the full 120s timeout
while the same test passed in 78ms with the gauge disabled. Anything else that wants a timer
inside this layer inherits the same trap.

## Rejecting an upstream feature: its own lines land outside the markers too

Several entries above say the fork has no surface for some upstream feature, so the answer is to
reject it. Rejecting the **marked hunks** is not rejecting the feature. Git puts a conflict marker
only where both sides edited the same region; the rest of the same commit merges clean and stays.

Three reconciles have now hit this, in both directions:

- 20th — a resolution's own _removals_ landed outside the markers.
- 33rd — #10768's meter reservation had four pieces; two merged clean (a render site, a width
  class, a whole `describe` block in an auto-merged test). Rejecting only the marked declarations
  left the tree red, and the repo-wide typecheck named all four.
- 35th — #11014/#11017's row expansion left three pieces behind. Detail in invariant 41.

**What the gate catches is only the subset that references something the rejection deleted.**
Measured on the 35th reconcile, on the real tree:

| Leftover shape                                                        | Caught by                        |
| --------------------------------------------------------------------- | -------------------------------- |
| references a variable the rejection removed (`accessiblePreview`)     | repo-wide typecheck, as an error |
| self-contained dead helper (`stopRowToggleWhileSelectingText`)        | **nothing** — see below          |
| a test asserting the rejected behaviour, in a rename-paired test file | that test, red                   |

The middle row is the one to plan around. A dead module-local helper was re-introduced
deliberately as a probe: `typecheck` exited **0** with it in, and `lint` named it exactly
(`warning eslint(no-unused-vars): Variable … is declared but never used`) but still exited **0**,
because it is a warning among ~744 of them. The gate is green with it in the tree.

**The sweeps do not see it either**, and the reason is structural rather than a gap worth fixing:
the line was added by upstream and kept by the merge, which is the ordinary case no direction
flags. RESURRECTED needs a fork deletion, FORK-LOSS a fork addition, DROPPED an upstream line the
merge lacks. A leftover from a rejection is none of those.

So after rejecting a feature, **grep the file and its paired test file for the feature's own
vocabulary** — the identifiers named in the entry that told you to reject it — rather than
trusting the conflict list, the gate, or the sweep. Renamed test files matter here: upstream edits
a `*.test.tsx` the fork has migrated to `*.dom.test.tsx`, git's rename detection merges them, and
the new test lands under the fork's filename.

## Probing an invariant that asserts ABSENCE

Half the entries above say a thing must **not** be there. Three of them were probed with
`grep -c` on the 22nd reconcile and every one came back non-zero against a correct tree: each
hit was the **FORK comment recording the deletion**, sitting exactly where the deleted code used
to be. That is by design — the comments are what stop a later reconcile restoring the code — and
it makes a bare count useless in the one direction it is most often reached for.

Read the matched **lines**, never the count. A count of 0 is also not proof: it can mean the
comment is gone too, which is its own finding.

The same sitting also produced a probe that matched nothing because it assumed the wrong file
shape (see invariant 1). Both failures are the same mistake — trusting a grep's number without
looking at what it matched.

## Checking a gate's test-count delta without re-running the baseline

A merge changes the total, and the cheap instinct is to net additions against deletions and see
if the number looks right. That is precisely what let four destroyed tests through a green gate
earlier this month: removed and added cancelled out.

Re-running the full gate on the pre-merge tree costs ~20 minutes. A **per-file test-declaration
diff** costs seconds, needs no worktree and no install, and answers the question that actually
matters — _did any file lose tests?_

```python
# for every test file at <trunk>, count `it(` / `test(` declarations at the trunk ref and in
# the merged worktree; print every file whose count DROPPED
```

On the 22nd reconcile: 18,268 -> 18,297 declarations over 2,526 files, and every file that lost
any was upstream's own deletion plus one deduplicated case. No fork test file lost a declaration.
The residual gap against the executed-test delta is `.each` expansion, which the regex cannot
see — so treat the totals as approximate and the **per-file drop list** as the real result.

## The sweep's fourth and fifth directions

The sweep script lives in the `reconcile-upstream-drift` **skill**, not in this repo — the path
`scripts/sweep-merge.py` written here previously was wrong. It checked three directions:
fork-deleted lines resurrected, upstream-added lines dropped, fork-added lines lost. The 21st
reconcile prompted two more, both shipped on 2026-08-26.

**BOTH-KEPT — a line the base, the fork and upstream all still have, that the merge lost.** Nobody
deleted it; the hand resolution dropped it. All three older directions are blind: it was not
fork-added, not fork-deleted, and not upstream-added. Demonstrated on a synthetic merge where the
old script prints `Both directions clean.` and exits **0** while a shared line is missing. Runs by
default — measured 0 hits against 186 real candidates, so it costs nothing to leave armed.

**UPSTREAM-DELETED (`--upstream-deleted`, opt-in) — base-and-fork lines upstream removed, with the
merge honouring the removal.** Usually correct; a defect only when the fork still references the
removed thing.

```python
upstream_deleted = ((base_lines & fork_lines) - result_lines) - upstream_lines
both_kept        = (base_lines & fork_lines & upstream_lines) - result_lines
```

Opt-in because it is loud and its precision is unproven: **186 lines over 28 files on reconcile
21, against 61 for the other four combined, and zero true positives.** Its exhibit was three CSS
rules in `index.css` that upstream had _widened_ (`a.chat-markdown-file-link` ->
`.chat-markdown-file-link`, so its new `<button>` chip picks them up), not dropped.

Two cautions, both learned the expensive way:

- **Do not dismiss its `.ts`/`.tsx` bulk as "typecheck covers that."** Typecheck catches dangling
  _references_, not dropped _behaviour_. A lost `if (guard) {` or a lost `.filter(...)` is exactly
  as invisible to the compiler as a lost CSS rule.
- The two reconcile-21 breakages often cited for this direction — `composerHasDraftContent` and
  `ChatComposer`'s `activeThreadActivities` prop — were **caught by typecheck**, and neither is
  reproducible from any tree that can be rebuilt: they were transient states of a hand resolution,
  not output of the merge algorithm. Re-running the naive resolve-toward-HEAD merge scores zero on
  both from all directions. Treat this direction as an enumeration aid, not a proven net.

All the directions are set differences over stripped lines, so they share one blind spot: a line
whose count drops N -> N-1 is invisible, and a moved line reads as present.

### Which files get swept, and which merges get refused

The directions above are only as good as the file list they run over, and that list had three holes
— each one a confident `All directions clean.` at exit 0. Fixed 2026-08-26, every one first
reproduced on a scratch repo that scored a false green before the change:

- **Only files BOTH sides changed were opened.** A file one side touched is exactly where a
  wholesale clobber hides: `git checkout --ours`/`--theirs`, or a hand-revert. The sweep now runs
  over the **union**. One-sided findings print `[one-sided]`, because that wider net is far more
  often a reword than a real loss — on the 21st reconcile it added 4 files and 52 lines with zero
  true positives, 41 of them from `ContextWindowMeter.test.tsx`, a file this fork deletes on
  purpose and whose three siblings were already being reported.
- **An octopus merge was swept as if it had two parents.** Parents 3 and beyond were read by
  nothing. Now refused outright rather than half-swept.
- **`--trunk`/`--upstream` were ignored entirely once the merge was committed.** A typo'd ref
  swept whatever `HEAD` happened to be and called it clean. They are now checked against `HEAD`'s
  parents: an explicit ref that does not resolve is an error, and a merge committed from the
  **upstream** side has its sides swapped with a note — left unswapped every direction reads
  mirrored, so a lost fork line is reported as a dropped upstream one, pointing at the wrong half
  of the merge.

Four pre-existing defects in the sweep were fixed at the same time, each of which made it report
clean while something was genuinely missing:

- **Renames erased the collision.** `git diff --name-only` reports a detected rename as the
  destination path only, so when upstream moved a file the fork had edited, the two path sets never
  intersected and the file was never swept — "files touched by BOTH sides: 0 / All directions clean
  / exit 0" with a fork-added line provably gone. That is the ask-question Cancel button scenario
  the FORK-LOSS direction exists for. Now read with `--no-renames`.
- **An unresolved index guaranteed a green.** Mid-merge, conflict markers keep BOTH sides' text, so
  every direction is empty — at exactly the moment the tool tells you to run it. Now exits 2.
- **Files absent from the merge result** were flagged but their lost lines were never named. Now
  swept against an empty merged side. This is why reconcile 21's `dropped` reads **37**, not the
  19 originally recorded: the extra 18 are all `ContextWindowMeter.tsx`, the fork's deliberate
  deletion under invariant 4, and are expected.
- **A path with invalid UTF-8** killed the text report mid-loop under any strict locale while the
  exit code still said "findings", silently losing every finding after it.

And a zero-intersection sweep no longer prints "All directions clean" — it exits 2 and says nothing
was examined. That is the reconcile-15 failure, where a merge whose two sides touched no file in
common reported all-green having checked nothing.

**The 186 above corrects a "167" previously recorded here.** That figure does not reproduce under
any of twelve formula variants (they give 147/149/186/188); it was a mid-merge number quoted in a
post-merge document. The same reconcile's `fork-loss` was recorded as 16 and is **18**. Re-measure
before quoting a sweep number — the tool is one command.

## Sweep numbers from the 36th reconcile

93 upstream commits, 61 conflicted files, merge-base `211618fd9`. Sweep totals: **resurrected 13,
dropped 331, fork-loss 320, both-kept 2**, every file accounted for in
`~/reports/t3code/2026-09/2026-09-13/`. The numbers are the largest yet and almost entirely
explained by three deliberate adoptions and one rejection: upstream's rewind replacing the fork's
revert prompt-restore (§43), context records replacing the prose-append path (§44), the scoped
project-settings rewrite (§6), and the rejected spawn-row expansion (§41, 112 dropped lines on its
own). One real miss surfaced: `git apply -3` of `b1e223e2b` had errored during a reset-and-replay
and the sweep caught 27 dropped lines in `ProjectionSnapshotQuery.test.ts`.

The lesson this reconcile added: **a big DROPPED number is not the signal; an unexplained one is.**
Triage cost here was per-file, and 36 of 37 flagged files were rewordings, rename pairs or decisions
already made. The single real finding came from a step that had reported an error hours earlier and
been read past.

## Sweep numbers from the 28th reconcile

73 upstream commits, 40 conflicted files (one modify/delete). Sweep totals: **resurrected 16,
dropped 47, fork-loss 120, both-kept 1**, all named in `~/reports/t3code/2026-09/2026-09-03/`.
The resurrected 10 in `ProviderCommandReactor.test.ts` are one test restored on purpose (see the
report); the rest of the fork-loss is relocation into upstream helpers (§26) and comment reshaping.

Two things only this reconcile taught:

- **Typecheck is a structural false green while any file still carries conflict markers.** Both
  `tsgo` and `tsc` report only TS1185 and suppress every semantic diagnostic program-wide.
  Falsified twice with deliberate type errors that were reported clean. Typecheck a group's files
  with a throwaway per-file tsconfig, or only after the LAST marker is gone.
- **Upstream deletions in unconflicted files reach fork files that are also unconflicted.**
  `terminal-links.ts` lost `splitPathAndPosition` with no conflict; `chatFilePathLinks.ts` (fork
  only, untouched by the merge) still imported it and 27 tests threw at runtime. Only typecheck
  after the last marker, or a test run, sees it — and only because the export vanished rather than
  changing meaning.

## Sweep numbers from the 27th reconcile

112 upstream commits, 53 conflicted files, the largest reconcile on this fork so far. Sweep
totals: **resurrected 343, dropped 121, fork-loss 193, both-kept 1**. Every one is named in
`~/reports/t3code/2026-09/2026-09-02/`. The bulk is three deliberate adoptions
(`serverRuntimeStartup.reconcile.test.ts` restored whole, `assetFileResponse` back, the
`commandProgramName` block relocated to `client-runtime`), so a large non-zero here is not by
itself a defect — but each file still needs a sentence.

The one finding the sweep caught that nothing else would have: `packages/contracts/src/ipc.ts`.
Resolving its import conflict as "union of both sides" resurrected 18 type imports the fork had
deliberately deleted along with 219 lines of Electron IPC surface. They referenced nothing,
typecheck was green, and only the RESURRECTED direction saw them.

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
