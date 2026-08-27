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

Verified 2026-08-27: 49 entries, all ids unique, monotonic, max 50. Id `34` is intentionally burned (an
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
