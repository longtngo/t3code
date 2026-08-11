# Fork registry

This checkout is a long-lived personal fork of `pingdotgg/t3code`. Upstream work is merged in
periodically; fork work never goes back upstream. This file records the things a reconcile must
not silently break — the invariants that are *invisible to the test suite* and therefore cannot
be recovered from a green gate.

Everything here was verified against the tree, not recalled. Re-verify before trusting it: a
stale entry is a hypothesis, not evidence.

## Topology

| | |
|---|---|
| `origin` | `pingdotgg/t3code` — upstream, read-only |
| `fork` | `longtngo/t3code` — backup remote for `personal` |
| `personal` | the fork trunk. Work lands here by **direct push, no PR** |

Reconcile is `git merge origin/main` into `personal`. Feature work branches off `personal`
(never `origin/main` — branching off upstream silently drops every fork feature).

`git rerere` is enabled repo-locally so conflict resolutions replay across reconciles.
`rerere.autoupdate` is deliberately left off: a replayed resolution still needs review, because
a resolution that was right against one upstream shape can be wrong against the next.

## Surface

As of 2026-08-11, against `origin/main`: **271 files added, 207 modified, 1 deleted.**
Concentrated in `apps/server` (179) and `apps/web` (134).

## Invariants a merge must not break

### 1. Migration filename number ≠ applied id

`apps/server/src/persistence/Migrations.ts` maps each migration file to an **explicit applied
id**, and the two deliberately diverge. Several filename numbers appear twice (`033`, `037`,
`038`) because upstream and the fork both claimed them; the applied ids stay unique because the
manifest assigns upstream's migration the next free id rather than its filename number.

Verified: 42 entries, all ids unique, monotonic, max 43. Id `34` is intentionally burned (an
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
(`useSettings.ts:275`). Before that merge it was the other way round.

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

### 5. A mid-turn send queues; it does not steer

Upstream's Claude adapter treats a second `sendTurn` while a turn is running as a **steer** — the
message joins the live agent loop and the turn id does not change. The fork replaced that with
**FIFO queued follow-ups**: the message waits and then opens its **own** turn. That is what backs
the composer's Send-beside-Stop button ("Queue message"), and the fork carries its own tests for
the queue (drain order, interrupt discards the queue, model re-set on drain).

So upstream's `ClaudeAdapter.test.ts` test *"steers a running turn instead of opening a new one on
mid-turn sendTurn"* asserts a behaviour this adapter no longer has, and fails against it
(`steeredTurn.turnId !== turn.turnId`). It is deliberately absent, with a comment where it used to
sit. A reconcile that "restores" it — it reads exactly like an upstream addition inside a
conflict — reintroduces a guaranteed red test.

### 6. Two project entry points in the sidebar, on purpose

Upstream `#5923`/`#5768` moved project settings to a `/projects/$projectKey` route and repurposed
the sidebar's per-project button to navigate there. The fork's own project-actions **dialog**
covers ground that route does not (per-project grouping overrides, removing a grouped project's
member repositories), so the project row carries **both** buttons: an ellipsis opening the fork
dialog and a gear navigating to upstream's page. Collapsing them to one drops the fork-only half.
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
