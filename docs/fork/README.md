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

As of 2026-08-21, against `origin/main`: **302 files added, 244 modified, 4 deleted.**
Concentrated in `apps/server` (196) and `apps/web` (162).

## Invariants a merge must not break

### 1. Migration filename number ≠ applied id

`apps/server/src/persistence/Migrations.ts` maps each migration file to an **explicit applied
id**, and the two deliberately diverge. Several filename numbers appear twice (`033`, `037`,
`038`, `039`) because upstream and the fork both claimed them; the applied ids stay unique because
the manifest assigns upstream's migration the next free id rather than its filename number.

Verified 2026-08-21: 45 entries, all ids unique, monotonic, max 46. Id `34` is intentionally burned (an
earlier fork DB applied a since-renamed `034_PushSubscriptions`).

**The rule: never renumber an applied id — it has already run on live databases. Give the
arriving migration the next free id and leave its filename alone.** Each divergence is explained
in a comment above its import in `Migrations.ts`; keep that up when adding one.

A merge that "tidies" these into filename order will re-run or skip migrations on a live DB.

### 2. One patch in `patches/` is fork-owned

14 of the 15 files in `patches/` are byte-identical to upstream. Exactly one is not:

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

The three deletions counted in Surface above are the fork's largest one: upstream's
`ContextWindowMeter.tsx`, `.logic.ts`, and `.logic.test.ts` are gone, replaced by the fork's
composer vitals gauge. They come back only if upstream _modifies_ one of them: git then raises a
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
disconnected composer read as permanently dead. Both call sites in `ChatComposer.tsx` need the
split. The 17th reconcile lost it at both and the line sweep caught it, not the type checker.

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

## CI does not run here — the pre-push hook is the gate

`.github/workflows/ci.yml` correctly triggers on `personal`, but every job requests
`blacksmith-*` runners, provisioned for the upstream org. Jobs queue until GitHub's 24h timeout
and are cancelled: **429 runs on this fork, zero successes and zero failures.**

The compensating control is `.githooks/pre-push`, activated via `core.hooksPath` by the root
`package.json` `prepare` script. It runs the full `pnpm run verify` (typecheck + lint + test)
on every push, because nothing else executes the ~7.5k-test suite automatically. Read the
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
