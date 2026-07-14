# Checkpoint capture: bound heavy untracked files so `git add -A` can't time out

**Date:** 2026-07-14
**Status:** Design (build-task, defect re-attempt)
**Symptom:** `VCS process timed out in GitVcsDriver.checkpoints.captureCheckpoint: git -C /Users/longngo/src/uni/routing-TSP-algo add -A -- . after 30000ms` — recurring *after* the prior fix `d5e276e34`.

## Goal

Make per-turn checkpoint capture robust against repos that carry heavy **untracked**
generated artifacts, so `git add -A` never blows the 30s process timeout — generally, for
any repo, without per-repo `.gitignore` maintenance.

## Consolidated root cause (my investigation + independent RCA agree, high confidence)

`captureCheckpoint` runs `git add -A -- .` (GitVcsDriver.ts:704) into a throwaway index. This
must hash → **zlib-deflate → write** a new blob for *every untracked, non-ignored file whose
content is new*. In `routing-TSP-algo`, an active research process periodically regenerates
heavy untracked artifacts (`.npy` distance-matrix caches ≈ 852MB, plus `.npz` matrices under
`.research-team/extreme/matrices/`). Directly measured: a cold `git add -A` over ~1.76GB of
untracked artifacts takes **51.6s** (43s CPU deflating incompressible float arrays) → exceeds
the 30s timeout. When the same content already exists as objects, the add is ~1–4s (hash-only,
no write) — so it fails **intermittently, on regeneration turns**.

Two facts make this a *class* of bug, not a one-off:
1. **The prior stat-cache fix (`d5e276e34`) is structurally incapable of helping.** It seeds the
   temp index from the real index so git's warm stat cache lets `add -A` skip re-hashing
   *tracked, unchanged* files. The heavy files are **untracked (0 index entries)** — no stat
   entry can exist for them, so they are always fully hashed+written regardless of the seed.
2. **`.gitignore` masking is whack-a-mole.** The prior edit ignored `.npy`/`cache/`; the process
   then wrote `.npz` matrices in a non-`cache` dir → slipped through → timed out again. Measured
   now: **13 untracked-not-ignored files ≥10MB (214MB), 0 of 31 `.npz` ignored.** The next new
   artifact type will slip through again.

## Load-bearing premises (validated before design — Hard Rule 8)

- **Heavy files are untracked, not tracked** → `git ls-files --stage | grep npy` = 0 entries. ✓
- **The cost is blob deflate+write, not traversal/stat** → cold add 51.6s vs warm 4.3s over the
  identical tree; `--dry-run` (no write) 2.3s. ✓
- **Enumerating untracked files + sizes is cheap enough to do every capture** →
  `git ls-files --others --exclude-standard -z` = 0.06s; `stat` of all 5,525 files = 0.04s on
  the 3.9GB repo. ✓ (Removes the per-turn-overhead objection.)
- **Restore couples to capture via `git clean -fd`** (GitVcsDriver.ts:780). `restoreCheckpoint`
  runs `git restore --source <c> --worktree --staged -- .` then **`git clean -fd -- .`**. `clean
  -fd` deletes every untracked, non-ignored file not in the checkpoint tree — **but respects
  `.gitignore`** (no `-x`). ✓ **This is the critical constraint:** any file capture *skips* would
  be *deleted* on the next restore. A size-bound MUST be applied symmetrically to both ends, or
  it silently destroys the user's 446MB artifacts on undo.

## Approach (chosen): symmetric per-file size bound

Introduce a single invariant, applied identically at capture and restore:

> **Checkpoints do not manage untracked files whose on-disk size ≥ `S`. They are neither
> captured (not written into the checkpoint tree) nor cleaned (not deleted on restore).**

Threshold `S` is a fixed **`const` 10 MiB** (well above normal source/config/small assets; below
data artifacts like matrices, caches, model weights). *(Env-configurability cut per the Stage-6
simplicity review — speculative config; the log line already gives visibility, and a constant is
code-editable.)*

`enumerateOversizedUntracked(cwd, S)` — a shared helper (used by both ends so the predicate can
never drift): `git ls-files --others --exclude-standard -z` → `lstat` each → keep those with
`size ≥ S`. **Must run with plain `process.env` (the real index), never `commitEnv`** — the
`git ls-files --others` notion of "untracked" is relative to the active index, and `commitEnv`
points `GIT_INDEX_FILE` at the throwaway temp index (which may not even exist yet at capture step
1). ~0.1s on the 3.9GB repo; returns empty for normal repos.

### Capture (`captureCheckpoint`)

Before `git add -A`:
1. `oversized = enumerateOversizedUntracked(cwd, S)` (plain env — see above).
2. If `oversized` is empty → run **`git add -A -- .`** exactly as today (zero behavior change).
3. Else → `git add -A -- . :(exclude,literal)<p1> :(exclude,literal)<p2> …` as **plain args**
   (`git add` is per-file, so a literal-path exclude works even for a file in a fully-untracked
   subtree — verified). The oversized set is small (measured: 13), so no arg-length concern.
4. `log(info)` a compact one-liner: how many files / how many bytes were skipped and the
   threshold, so a user can see *why* their big artifact isn't in the checkpoint.

### Restore (`restoreCheckpoint`)

**⚠ The obvious symmetric mechanism is WRONG and loses data — the Stage-6 correctness review
caught it (verified on real git 2.50.1).** `git clean -fd` does **not** delete file-by-file:
when it meets a *fully-untracked directory* (no tracked file anywhere in the subtree) it removes
the **whole directory as a unit**, and a file-level `:(exclude,literal)` pathspec for a file
*inside* it is silently ignored. Since the motivating artifacts live in `.research-team/extreme/
matrices/` (a fully-untracked subtree), `git clean -fd -- . :(exclude,literal)<file>` would
delete the 446MB file anyway. Ancestor-directory exclusion "fixes" that but then over-preserves
the *small* untracked siblings — so no pathspec formulation is correct.

**Correct mechanism (verified): exclude via git's ignore machinery, `git clean -e <pattern>`.**
Ignore-aware `clean` *descends into* an untracked directory that contains excluded content and
preserves just that content, while still deleting the small untracked siblings — exactly the
file-granular behavior we need.

`git restore --worktree` only rewrites tracked paths, so the oversized untracked files are still
on disk at the clean step. Recompute the predicate and pass each as a `-e` exclude:
- `oversized = enumerateOversizedUntracked(cwd, S)` (plain env)
- `git clean -fd -- .` if empty; else
  `git clean -fd -e <pat1> -e <pat2> … -- .`

where each `<pat>` = **repo-root-anchored, gitignore-escaped** path:
prefix `/`, and backslash-escape gitignore metacharacters (`\ * ? [ ]` and a leading `! #`).
**Escaping is load-bearing** — verified that an unescaped `[` in a filename makes the pattern
miss and the parent dir is removed wholesale (data loss); the escaped+anchored form preserves the
file and still cleans siblings.

Verified end-to-end on real git 2.50.1 against the exact `a/b/matrices/{big.npz, small.txt}` +
top-level layout: `big.npz` survives, `small.txt` and the top-level file are cleaned, the dir is
kept. Symmetry holds by *outcome* (skip ⟺ preserve), achieved with different flags on each side
(`:(exclude,literal)` for the per-file `add`, `-e` for the dir-recursing `clean`) precisely
because `add` and `clean` have different directory granularity.

## Why not the alternatives

- **Complete + commit the repo `.gitignore` only** — repo-side band-aid, already failed twice
  (whack-a-mole). Does not generalize. *Kept as an immediate mitigation, not the fix.*
- **Raise/scale the `add` timeout** — blocks the turn 50s+, still fails on truly huge trees,
  doesn't bound checkpoint size. No restore-interaction, but poor UX and non-general.
- **Tracked-only capture (`git add -u`)** — restore's `clean -fd` would then delete *all*
  untracked files, including small new source files the user created this turn. Worse behavior.
- **Auto-maintain `.git/info/exclude`** — mutates the user's repo, hides files from their own
  `git status`, patterns accumulate. Intrusive.
- **Post-timeout fallback to `git add -u`** — wastes 30s every regeneration turn before falling
  back, and inherits the tracked-only clean-delete problem above.
- **Cumulative-byte budget instead of per-file** — the measured failures are dominated by *large
  individual* files (446MB, 42MB); a per-file threshold handles them with the simplest possible
  rule. Cumulative budget noted as a follow-up if a many-medium-files repo ever appears.

## Files touched

- `apps/server/src/vcs/GitVcsDriver.ts` — `captureCheckpoint` (exclude oversized from add),
  `restoreCheckpoint` (exclude oversized from clean), a shared `enumerateOversizedUntracked`
  helper, and the threshold constant/env read.
- `apps/server/src/vcs/GitVcsDriverCore.test.ts` — TDD tests (below).

## Tradeoffs / limitations

- **Checkpoints exclude untracked files ≥ S.** Restoring a checkpoint will not recreate a
  >10MB untracked artifact — acceptable: checkpoints are ephemeral per-turn undo, and such files
  are regenerable data, not source. The `log(info)` line makes it visible.
- **Predicate re-evaluated at restore time.** A file oversized at capture but shrunk below `S`
  by restore would be cleaned (minor edge; it is now small and was never in the checkpoint).
  A file oversized-at-capture that *grew from* a small captured file is handled correctly:
  `git restore --worktree` overwrites it back to the captured content first (verified). Not
  guarded — guarding the shrink case would require persisting the captured skip-set, not worth it.
- **Non-UTF-8 filenames (low).** `git ls-files -z` emits raw path bytes; a filename that is not
  valid UTF-8 can be mangled when decoded to a JS string and re-encoded for the argv/`-e`
  pattern, so the exclude may not byte-match → the file could be added/cleaned despite being
  oversized. Space/newline/UTF-8 names are fine (verified). A non-UTF-8-named untracked file
  ≥10MB is extraordinarily rare; documented, not guarded.

## Test plan (TDD, red → green)

In `GitVcsDriverCore.test.ts` (real git via the `git()` helper):
1. **Capture skips an oversized untracked file** — create a >S untracked file + a small one;
   capture; the checkpoint tree contains the small file but **not** the oversized one.
2. **Restore preserves an oversized untracked file in a FULLY-UNTRACKED subtree** — the exact
   data-loss case: `research/matrices/big.npz` (>S) with no tracked sibling anywhere in the
   chain; capture then restore; `big.npz` **still exists on disk**. (Guards against the
   `git clean -fd` wholesale-dir-removal bug — the reason restore uses `-e`, not a pathspec.)
3. **Restore still cleans small untracked files** — a small untracked file (both a top-level one
   and a sibling *inside* the preserved oversized file's dir) is deleted by restore.
4. **Normal repo, no oversized files → identical to today** — capture uses plain `git add -A`,
   restore plain `git clean -fd` (assert via the checkpoint tree containing all untracked files
   and a post-restore clean of untracked files).
5. **Threshold is honored** — a file just under S is captured; just over S is skipped.
6. **Tracked file over S is still captured** — the bound is untracked-only; a large *tracked*
   file must remain in checkpoints (regression guard).
7. **Oversized filename with a gitignore metacharacter** (e.g. `big[v2].npz`) — capture skips it
   and restore preserves it (guards the `-e` escaping; unescaped → data loss, verified).
