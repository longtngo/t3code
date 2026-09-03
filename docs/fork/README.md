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

As of 2026-09-02 (27th reconcile), against `origin/main`. Concentrated in `apps/server`
and `apps/web`.

## Invariants a merge must not break

### 1. Migration filename number ≠ applied id

`apps/server/src/persistence/Migrations.ts` maps each migration file to an **explicit applied
id**, and the two deliberately diverge. Several filename numbers appear twice (`033`, `037`,
`038`, `039`) because upstream and the fork both claimed them; the applied ids stay unique because
the manifest assigns upstream's migration the next free id rather than its filename number.

Verified 2026-09-03 (28th reconcile): 54 entries, all ids unique, monotonic, max 55; upstream's
`046`/`047` took applied ids 54/55. Id `34` is intentionally burned (an
earlier fork DB applied a since-renamed `034_PushSubscriptions`).

The manifest is a list of **positional tuples** (`[1, "OrchestrationEvents", Migration0001]`), not
object literals. A probe grepping for `id:` matches only the doc comment and reports nothing.

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

### 6. Two project entry points in the sidebar, on purpose

Upstream `#5923`/`#5768` moved project settings to a `/projects/$projectKey` route and repurposed
the sidebar's per-project button to navigate there. The fork's own project-actions **dialog**
covers ground that route does not: **workspace member repositories** — attaching one, choosing
its integration branch, removing it. (Both surfaces carry a grouping-rule control, so grouping is
_not_ the fork-only part; verified against the running app on 2026-08-11.) The project row
therefore carries **both** buttons: an ellipsis opening the fork dialog and a gear navigating to
upstream's page. Since upstream #5931 that row is a `ComboboxItem`, not a `MenuRadioItem` — the
23rd reconcile rebuilt the fork's button onto upstream's combobox, inside its `project ? …`
guard, and dropped the then-dead `Menu*` import. Collapsing them to one drops multi-repo workspace management entirely.
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

### 12. The Claude adapter still calls `getContextUsage`; upstream deleted it

Upstream #8610 removed `queryCurrentContextUsage` and `normalizeClaudeContextUsageApiSnapshot`
outright, on the grounds that `getContextUsage`'s token-count fallback can make extra model
requests. This fork keeps the call. It is the **only** source of the compaction facts —
`autocompactSource`, `autoCompactThreshold`, `isAutoCompactEnabled` — that
`packages/contracts/src/providerRuntime.ts` carries on the wire and that the Vitals gauge's
compaction note and marker render from (`VitalsGauge.tsx`, `lib/contextWindow.ts`). Deleting it
compiles, passes, and leaves the note permanently blank.

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
else comes from one `sharedFileMenuItems` array, which both menus map — the native menu at
`ChatMarkdown.tsx:1599`, the in-DOM menu at `:1771`. That sharing is the enforcement: a shared
item cannot drift between the two, because there is only ever one of it.

**Corrected 2026-08-29.** This section previously said the reveal item "uses `onReveal &&
revealLabel` inline at both sites, and nothing enforces the pairing, so change both". There is
**one** such site — `:1563`, inside `sharedFileMenuItems` — and the shared array is precisely what
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
and genuinely used, called at `ChatView.tsx:4762`). Taking both compiles and passes: the import
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
preserves an explicit opt-out"), `apps/desktop/src/settings/DesktopClientSettings.test.ts`, and
the "(legacy)" wording in `SettingsPanels.tsx` / `settingsSearch.ts` follow it.

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
**Queued follow-up turns are fork-only** (`origin/main` has no queue at all), so such a turn never
reaches the provider — the symptom is a test that _hangs_ on a prompt read rather than one that
fails. Retarget by completing the running turn first, which is the fork's actual contract.

### 23. Slow-by-design RPCs get the long leash, never the untracked set

Fork commit `facc05f9e` set the rule for `apps/web/src/rpc/requestLatencyState.ts`: a call that is
slow because it fans out or shells out joins `longRunningRpcAckMethods` (120s), not
`untrackedRpcAckMethods`. "Slow by design" and "unobservable" are different claims, and the
untracked set hides a call that has genuinely wedged. Upstream #9358 put `serverGetUsageSummary`
in the untracked set; here it sits on the long leash and its test asserts the 120s edge. Expect
upstream to keep adding to the untracked set; move each addition down.

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

### 18. The event hub is unbounded; every consumer of it must not be

`apps/server/src/orchestration/Layers/OrchestrationEngine.ts` publishes domain events into an
**unbounded** `PubSub`. That is deliberate - the dispatch worker must never backpressure on a
slow reader - and it is exactly why every consumer needs its own bound. Two confirmed OOM
crash-loops came from this hub, and each fix is a separate piece that a merge can revert on its
own:

- **`boundedSubscriberStream`** wraps `subscribeDomainEvents`. A forked pump takes from the
  PubSub subscription _unconditionally_ into a bounded queue (`T3CODE_WS_SUBSCRIBER_BUFFER`,
  default 4096). A WebSocket consumer that stops draining therefore ends its own subscription
  cleanly and resubscribes from its last-applied sequence; it can never pin the hub.
- **`ws.ts` chains coalesce -> bound**, in that order: the thread-live coalescer feeds a
  `Queue.dropping` of `WS_LIVE_BUFFER_CAPACITY`. Upstream's own coalescer (#8368) is
  `Queue.unbounded` at _both_ ends, which is the precise shape that OOM-ed this server. Adopting
  it wholesale reintroduces the crash; the two must stay chained.
- **`groupedWithin`/`aggregate`/`aggregateWithin`/`aggregateWithinEither` are banned in new
  code** by `oxlint-plugin-t3code/rules/no-unsafe-stream-aggregate.ts`; the replacement is
  `batchWithinStackSafe`. They lower to a non-stack-safe `stepToBuffer` schedule loop that pins
  continuation frames on every _idle_ tick (~1.9 GB/hr, crash every 13-14h). That was the
  confirmed heap burst - not the `Stream.take` recycle first blamed and later falsified. Note
  what is NOT true: no patch in `patches/` touches `Stream` any more, so the two allowlisted
  `ws.ts` shell-coalescing sites are safe by virtue of the **pinned effect version alone**.
  Re-measure with `scripts/idle-aggregate-probe.ts` on any effect bump.

- **Internal reactors take `subscribeDomainEventsLossless`, never `subscribeDomainEvents`.**
  Upstream #9152 moved `ProviderCommandReactor` off `streamDomainEvents` onto the _WS-facing_
  accessor so its subscription exists before `start()` returns (a real fix - reverting it locally
  took the reactor suite from 3 failures to 18 and a 235s run). But that accessor carries the
  bounded drop-buffer above, which **ends the stream** on a slow consumer; a reactor that loses
  events silently stops reacting. `subscribeDomainEventsLossless` is the same eager subscription
  without the bound. Any new internal reactor uses it. The merge that introduced this violated the
  invariant and typechecked, linted and tested clean.

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
