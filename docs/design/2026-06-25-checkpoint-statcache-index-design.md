# Checkpoint capture: seed the temp index from the real worktree index

**Date:** 2026-06-25
**Branch:** `fix/checkpoint-statcache-index`
**Status:** Design

## Goal

Stop per-turn checkpoint capture from timing out (and from wasting 30–90 s of
background work every turn) on workspaces that contain large tracked or untracked
content. Reported symptom:

```
Checkpoint capture failed×2 — VCS process timed out in
GitVcsDriver.checkpoints.captureCheckpoint:
git -C /Users/longngo/src/uni/routing-TSP-algo add -A -- . after 30000ms
```

## Background — root cause (empirically confirmed)

`GitVcsDriver.checkpoints.captureCheckpoint` (`apps/server/src/vcs/GitVcsDriver.ts`,
~line 609) builds a checkpoint commit against a **throwaway temp index**:

```
GIT_INDEX_FILE = <gitCommonDir>/t3-checkpoint-index-<uuid>
if HEAD exists:  git read-tree HEAD          # seed index from HEAD's tree
git add -A -- .                              # stage the whole working tree
git write-tree → git commit-tree → git update-ref
```

The problem is the seed. `git read-tree HEAD` populates the index with HEAD's tree
entries but **with no stat-cache data** — `ctime`, `mtime`, `dev`, `ino`, `size`
are all zero. With no valid stat data, `git add -A` cannot take the "unchanged"
shortcut for any path; it must **re-open, re-read and re-hash every tracked file**
(and hash every untracked, non-ignored file) on **every** capture.

A capture runs on every turn (`CheckpointReactor`: a baseline on `turn.completed`
plus the real checkpoint on `thread.turn-diff-completed` — that is the "×2"; it is
two capture code-paths, not a retry). So a repo with a few hundred MB of tracked
content re-hashes all of it every turn. Beyond `VcsProcess.DEFAULT_TIMEOUT_MS`
(30 000 ms, `apps/server/src/vcs/VcsProcess.ts:46`) the git child is killed and the
capture is reported as failed.

### Why `git status` was fast but `git add -A` was not

On the reproduction repo, `git status` ran in ~2 s while `git add -A` exceeded 30 s.
`git status` reads the **real** index (warm stat cache) and _summarizes_ wholly
untracked directories; the checkpoint `git add -A` runs against a **stat-less**
index and must descend into and hash everything.

### Measurements (real repo, `~/src/uni/routing-TSP-algo`, 2.9 GB)

A/B on the exact capture command, same machine, back-to-back:

| Arm          | Index seed                                   | `git add -A` time                   | resulting `write-tree` |
| ------------ | -------------------------------------------- | ----------------------------------- | ---------------------- |
| A (current)  | `read-tree HEAD` (no stat cache)             | **13.59 s** warm / **89.79 s** cold | `255168c3…`            |
| B (proposed) | copy of the real worktree index (stat cache) | **0.32 s**                          | `255168c3…`            |

Identical tree oid → the change is **behaviour-preserving**; only the work `git add`
must do changes. The cold-vs-warm spread on Arm A (CPU was ~2 s while wall-clock was
13–90 s) confirms the cost is I/O re-reading file content — exactly what the stat
cache lets git skip. (The repo's own untracked bloat — ~1 GB under `.research-team/`
— was separately fixed by a `.gitignore` change in that repo; that reduced the
untracked half of the work but, as Arm A shows, the _tracked_ re-hash alone still
blew the 30 s budget. The stat-cache fix is the one that actually removes the
timeout, and it is robust to cold page cache, which volume reduction is not.)

## Approach (chosen)

Seed the checkpoint temp index from the repository's **real, current index** instead
of from `read-tree HEAD`. The real index carries a valid stat cache for every tracked
file, so `git add -A -- .` only re-hashes files whose stat data actually changed.

Concretely, in `captureCheckpoint`, replace the `read-tree HEAD` seeding step with:

1. Resolve the **worktree-correct** index path:
   `git -C <cwd> rev-parse --git-path index`, resolved to absolute relative to `cwd`.
2. Decide whether the real index is a _safe_ seed (see "skip-worktree" below). It is
   safe to copy iff the index exists **and** carries no `skip-worktree` /
   `assume-unchanged` entries.
3. **Safe →** copy the real index to `tempIndexPath` (a plain byte file copy).
   **Not safe** (index missing, or has skip/assume bits) → fall back to the existing
   behaviour: `read-tree HEAD` if HEAD exists, else leave the temp index empty.

Everything after seeding (`git add -A -- .` → `write-tree` → `commit-tree` →
`update-ref`) is unchanged, as is the `GIT_INDEX_FILE` wiring and the
`Effect.ensuring(cleanupTempIndex)` cleanup.

> **Env ordering (load-bearing).** The `rev-parse --git-path index` resolve and the
> skip/assume probe **must** run with the _plain_ process env — **not** `commitEnv`,
> which sets `GIT_INDEX_FILE` to the temp path. `git rev-parse --git-path index` and
> `git ls-files -v` both honour `GIT_INDEX_FILE`; running them under `commitEnv` would
> resolve/probe the _temp_ index (copying it onto itself, probing the wrong file).
> They are read-only queries of the _real_ index and run before the copy.

### Handling `skip-worktree` / `assume-unchanged` (correctness)

`git add -A` honours the `skip-worktree` and `assume-unchanged` index bits — it
**skips** those paths. So if the real index marks a tracked file skip-worktree (a
common user pattern for local-only edits to a tracked config file), seeding from it
would freeze that path at its **index** content, whereas the current `read-tree HEAD`
seed (which clears those bits) captures its **disk** content. That divergence would
make turn-diffs blind to such files and could let a later revert restore stale
content. t3code itself never sets these bits, but users do, and agents run in user
repos — so it is reachable.

Mitigation (cheap, provably equivalent to today): before copying, probe the real
index with `git ls-files -v` and fall back to the `read-tree HEAD` seed if any entry
is flagged. The divergent bits are exactly the lines whose status letter matches
`^[a-zS]` — verified: `assume-unchanged` → lowercase tag (`h`), `skip-worktree` → `S`
(`intent-to-add` stays `H` and is **not** divergent, since `add -A` reconciles it to
disk). A repo with these bits simply gets today's (correct, slower) path; everyone
else gets the fast path. A regression test asserts the captured tree for a
skip-worktree file equals the `read-tree HEAD` path's tree.

### Why `--git-path index` and not `gitCommonDir/index`

Verified live on this repo:

| Location            | `git rev-parse --git-path index` | `gitCommonDir/index`              |
| ------------------- | -------------------------------- | --------------------------------- |
| main checkout       | `.git/index`                     | `.git/index`                      |
| **linked worktree** | `.git/worktrees/<name>/index`    | `.git/index` ← **wrong worktree** |

t3code captures checkpoints **inside linked worktrees** (agents run there). The
existing code already computes `gitCommonDir` for the temp-index _location_, but the
common dir's `index` belongs to the **main** worktree. Seeding from it in a linked
worktree would carry a stat cache for the wrong set of files → every path looks
dirty → full re-hash → no speedup (the final tree would still be correct because
`git add -A` reconciles to disk, but the performance fix would silently not apply).
`git rev-parse --git-path index` returns the per-worktree index in every case.

## Why this is correctness-preserving

`git add -A -- .` makes the index match the working tree regardless of what the index
started as — **except** for paths the index explicitly tells it to skip
(`skip-worktree` / `assume-unchanged`), which the mitigation above routes to the old
seed. With that one carve-out handled, the seed only affects _how much work_ `git add`
does, never the final tree. The A/B test confirms a byte-identical `write-tree` oid.
Seeding from the real index (which may contain the user's staged/unstaged selections)
is reconciled away by `add -A`, which stages everything on disk.

Two edge cases were probed and are **not** regressions: (1) **unmerged/conflict
entries** — `git add -A -- .` resolves every unmerged path to stage 0 _before_
`write-tree` runs, so `write-tree` never sees the unmerged entries it would refuse;
both seeds yield the same tree. (2) **intent-to-add** (`git add -N`) — stays a normal
entry that `add -A` reconciles to disk.

## Alternatives considered

- **Persistent per-repo checkpoint index** (reuse one index file across turns so its
  stat cache stays warm). Also works, but: cold on the first capture, needs an
  invalidation/lifecycle story (when does it get rebuilt? what if HEAD moves?), and a
  durable on-disk file per repo to manage. Copying the real index is warm on the very
  first capture and adds no new persistent state. _Rejected as the primary fix; could
  layer on later if first-capture latency ever matters._
- **Just raise the 30 s timeout** (e.g. to 5 min). Trades a fast failure for a
  multi-minute background stall every turn and an ever-growing `.git` (every capture
  re-writes loose objects for everything it re-hashes). Treats the symptom, not the
  cause. _Rejected._
- **`git add -u` (tracked-only) for the checkpoint.** Would drop untracked files from
  checkpoints — a behaviour change (revert-turn would no longer restore new files).
  _Rejected; out of scope._

## Files / modules touched

- `apps/server/src/vcs/GitVcsDriver.ts` — `captureCheckpoint`: resolve the
  worktree-correct index path (`rev-parse --git-path index`, resolved like the
  existing `resolveGitCommonDir`); probe `git ls-files -v` for skip/assume bits;
  replace the `read-tree HEAD` seed with the safe-copy-then-fallback logic. Uses
  `FileSystem` (already injected at `makeVcsDriverShape` line ~353, already used for
  `fileSystem.remove`) via `fileSystem.exists` + `fileSystem.copyFile` (the same
  pattern as `apps/server/scripts/cli.ts` — not `readFile`/`writeFile`, not the
  recursive `copy`). All real-index queries run with plain env (no `commitEnv`).
- `apps/server/src/vcs/GitVcsDriver.test.ts` / `GitVcsDriverCore.test.ts` — add
  coverage (see Plan).

No contract, schema, or call-site change. `CheckpointStore` / `CheckpointReactor`
are untouched by the primary fix.

## Tradeoffs and known limitations

- **Racy-clean window.** If a file is modified within the same filesystem-timestamp
  granularity as the index's recorded mtime and keeps the same size, git's stat
  shortcut can miss it. This is the **standard** git racy-clean caveat that every
  `git add` / `git status` already lives with (git mitigates it via the racy-clean
  re-check on entries whose mtime equals the index mtime). Seeding from the real
  index inherits exactly the same behaviour the user's own `git status` has — it is
  not a new correctness regression. _Accepted; do not over-engineer._
- **Concurrent index writes.** If the user runs a git command that rewrites the index
  while capture copies it, git's lockfile+rename means the copy reads a _complete_
  index (old or new), never a torn one. A slightly stale copy only costs a few extra
  re-hashes (add -A reconciles to disk). _Accepted._
- **First capture after a fresh clone/large checkout** is still a full hash (the real
  index is warm for content already checked out, so in practice this is fine). Covered
  by the deferred pre-flight follow-up below if it ever bites.

## Follow-ups deferred (not in this change)

These are real but separable; the design review will decide whether any get pulled in
or filed for later:

1. **De-spam the failure activity.** `CheckpointReactor` appends a
   `checkpoint.capture.failed` activity on every failing turn. With the primary fix
   the failure should stop occurring, but a genuinely pathological workspace would
   still emit a per-turn error. De-duplicate / rate-limit per workspace and include
   actionable detail (untracked byte count + "add to .gitignore"). _Low risk, small._
2. **Cheap pre-flight bound** for a huge brand-new untracked drop (where even a warm
   stat cache can't help because the content is genuinely new). Out of scope for the
   reported bug, which is dominated by _unchanged_ content.
