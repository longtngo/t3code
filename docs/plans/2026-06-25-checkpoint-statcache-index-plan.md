# Plan — checkpoint stat-cache index seed

Design: `docs/design/2026-06-25-checkpoint-statcache-index-design.md`. Change is ~20
LOC in one function + 2 tiny helpers + behavioral tests. All in
`apps/server/src/vcs/`.

## TDD note

The fix is _tree-equivalence-preserving_ for normal files (that is the whole
correctness argument), so a normal-file test cannot distinguish old vs new code. The
genuinely **failing-first** tests are the ones that fail under a _naive_ copy (no
skip-worktree fallback) or a _missing_ fallback (no index): T2/T3/T4 below. The
performance win itself is proven empirically by the A/B in the design doc (89.79s→0.32s
on a real 2.9 GB repo); a wall-clock unit assertion would be flaky and is deliberately
omitted.

## Task 1 — Tests first (`GitVcsDriverCore.test.ts`)

Add `describe("checkpoint capture index seeding")` using the existing harness
(`initRepoWithCommit`, `writeTextFile`, `git`, `driver.checkpoints.captureCheckpoint`,
`driver.checkpoints.hasCheckpointRef`). Helper to read captured content:
`git(cwd, ["show", \`${ref}:${file}\`])`and captured tree:`git(cwd, ["rev-parse", \`${ref}^{tree}\`])`.

- **T1 correctness (normal):** init+commit; modify a tracked file, add an untracked
  file, delete a tracked file; capture ref `refs/t3/test/cp1`; assert
  `show ref:modified` = new disk content, `show ref:untracked` = disk content, and the
  deleted path is absent (`ls-tree -r ref`).
- **T2 skip-worktree regression (fails under naive copy):** init+commit
  `cfg="committed"`; `git update-index --skip-worktree cfg`; write `cfg="local-only"`
  on disk; capture; **assert `show ref:cfg` === "local-only"** (disk), not "committed"
  (index).
- **T3 assume-unchanged regression:** same shape with `--assume-unchanged`.
- **T4 no-index fallback:** raw `initRepo` (NO commit → no index file, no HEAD); write
  an untracked file; capture; assert `hasCheckpointRef` true and the file is in
  `ls-tree -r ref`. (Exercises the `read-tree HEAD`-skipped / empty-index branch.)
- **T5 equivalence guard:** init+commit; modify a file; capture via driver → `treeA`.
  Independently compute `treeB` by `read-tree HEAD` + `add -A` in a throwaway
  `GIT_INDEX_FILE`; assert `treeA === treeB` (the old path and new path agree).

Run: confirm T2/T3/T4 FAIL against unmodified `GitVcsDriver.ts` (T2/T3 capture stale
content; T4 — actually current code already handles no-index, so T4 mainly guards the
refactor). Commit: `test(vcs): cover checkpoint index-seed correctness + skip-worktree`.

## Task 2 — Implement (`GitVcsDriver.ts`)

Near `resolveGitCommonDir` (~597) add two helpers (plain `execute`, **no** env — they
query the REAL index):

```ts
// Worktree-correct real index path (NOT gitCommonDir/index — wrong file in a
// linked worktree). Resolve relative to cwd like resolveGitCommonDir.
const resolveGitIndexPath = (cwd) => execute(... ["rev-parse","--git-path","index"]) → abs

// Seeding from the real index is unsafe when it has skip-worktree/assume-unchanged
// entries (git add -A skips them → captures index, not disk, content). Detect via
// `git ls-files -v`: assume-unchanged → lowercase tag, skip-worktree → 'S'.
const realIndexHasSkipBits = (cwd) => execute(... ["ls-files","-v"]) → /^[a-zS]/m test
```

In `captureCheckpoint`, replace the `read-tree HEAD` seed block (626–635) with:

```ts
// Seed the temp index from the real index to preserve git's stat cache, so
// `git add -A` skips unchanged files instead of re-hashing the whole tree every
// turn. These queries read the REAL index → run with plain env, never commitEnv
// (which sets GIT_INDEX_FILE=tempIndexPath).
const indexPath = yield * resolveGitIndexPath(input.cwd);
const canCopy = yield * fileSystem.exists(indexPath) && !(yield * realIndexHasSkipBits(input.cwd));
if (canCopy) {
  yield * fileSystem.copyFile(indexPath, tempIndexPath);
} else {
  const headExists = yield * hasHeadCommit(input.cwd);
  if (headExists)
    yield * execute({ operation, cwd: input.cwd, args: ["read-tree", "HEAD"], env: commitEnv });
}
```

Everything after (`add -A` → `write-tree` → `commit-tree` → `update-ref`) and the
`Effect.ensuring(cleanupTempIndex)` is unchanged. `fileSystem` is already injected
(line ~353; already used for `fileSystem.remove`). Use `fileSystem.copyFile` +
`fileSystem.exists` (the `apps/server/scripts/cli.ts` pattern), not readFile/writeFile.
Set a generous `maxOutputBytes` on `ls-files -v` (e.g. the 16 MB workspace cap) and, if
truncated, treat as "has bits" → fall back (safe). Run tests → all green. Commit:
`fix(vcs): seed checkpoint index from the real index to skip re-hashing unchanged files`.

## Task 3 — Verify gate

`pnpm` (or repo's) typecheck + lint + the vcs unit tests; then the full suite before
merge (Stage 9). Paste evidence.

## Out of scope (deferred per design)

CheckpointReactor failure-activity de-spam; pre-flight untracked-size bound.
</content>
