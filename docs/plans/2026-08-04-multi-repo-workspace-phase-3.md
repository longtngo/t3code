# Multi-repo workspace — Phase 3: branch lifecycle

Implements the *Branch lifecycle* section of
`docs/design/2026-08-04-multi-repo-workspace-design.md`. Phase 3 is the only phase
that writes to member repositories.

**Goal:** every member repository a thread touches ends up on a feature branch that
records who owns it, and any pull request opened from one targets that repository's
integration branch rather than `main`.

## Premises, validated before designing

| Premise | Probe | Result |
|---|---|---|
| `resolveBaseBranch` consults `branch.<name>.gh-merge-base` first | read `GitManager.ts:1341` | true — it short-circuits before upstream tracking and the provider default |
| Real member repositories carry a reflog creation record | `git reflog show pickup-v2-prm2.0` in `~/src/uni/uniuni_api_prm` | true — `branch: Created from pickup-v2` |
| A config write primitive already exists in this codebase | `GitVcsDriverCore.ts:2643` | `createWorktree` already writes `gh-merge-base` via `runGit(["config", key, value])` |
| Creating a branch at `HEAD` carries uncommitted changes over | `createRef` is `git branch X` then `git switch X`, both at the same commit | true — no checkout happens, so nothing is stashed or lost |
| A member's current branch is readable without a new git call | `VcsStatusLocalResult.refName` | true — the local status the sweep already loads carries it |

## Files

- Create `apps/server/src/workspace/MemberBranches.ts` — pure classifier + base ladder.
- Create `apps/server/src/workspace/MemberBranches.test.ts` — table tests, no git.
- Create `apps/server/src/workspace/WorkspaceMemberBranchService.ts` — the effectful
  `ensureMemberFeatureBranch` / `ensureMemberPrBase`.
- Create `apps/server/src/workspace/WorkspaceMemberBranchService.test.ts` — real git
  fixtures; these are the load-bearing tests the design names.
- Modify `apps/server/src/vcs/GitVcsDriver.ts` + `GitVcsDriverCore.ts` — add
  `writeConfigValue`, `readBranchCreationRef`, `listBranchNamesPointingAt`.
- Modify `apps/server/src/orchestration/Layers/CheckpointReactor.ts` — post-turn sweep.

## Task 1 — the classifier

Pure, five states, no git. `currentBranch` is always read live rather than trusted
from stored state, so a hand-switched branch is detected rather than assumed away.

```ts
classifyMemberBranch(input: {
  currentBranch: string | null;
  integrationBranch: string;
  ownerThreadId: string | null;
  threadId: string;
  isDirty: boolean;
}): "idle" | "cut-needed" | "owned-by-self" | "owned-by-other" | "unmanaged"
```

| State | Condition |
|---|---|
| `idle` | on the integration branch, clean |
| `cut-needed` | on the integration branch, dirty |
| `owned-by-self` | the owner key names this thread |
| `owned-by-other` | the owner key names a different thread |
| `unmanaged` | off the integration branch with no owner key, or the branch is unreadable |

## Task 2 — the base-resolution ladder

Pure given its inputs, so the ordering is testable without git:

```ts
resolveMemberPrBase(input: {
  configuredBase: string | null;      // branch.<name>.gh-merge-base
  reflogCreatedFrom: string | null;   // resolved to a branch name already
  integrationBranch: string;
}): { base: string; source: "configured" | "reflog" | "integration" }
```

Reflog must outrank the declared integration branch: a hotfix cut from `main` in a
repository pinned to `pickup-v2` would otherwise open a pull request against the
wrong base, in a case the user did nothing wrong in.

## Task 3 — driver primitives

- `writeConfigValue(cwd, key, value)` — `git config <key> <value>`, mirroring the
  existing `readConfigValue`.
- `readBranchCreationRef(cwd, branch)` — parses `git reflog show <branch>` for
  `branch: Created from X`; returns `null` when absent (the reflog is local-only and
  expires, so absence is ordinary, not an error).
- `listBranchNamesPointingAt(cwd, commit)` — `git branch --points-at`, used to turn a
  `Created from HEAD` or a raw sha back into a branch name.

## Task 4 — the service

- `ensureMemberFeatureBranch({ cwd, integrationBranch, threadId, threadTitle })` —
  idempotent; on `cut-needed` creates `t3code/<slug>-<id8>` and writes both config
  keys. Best effort per member: a failing repository is logged and reported
  unavailable, never failing the turn.
- `ensureMemberPrBase({ cwd, branch, integrationBranch })` — runs the ladder and
  writes `gh-merge-base` so the next PR action short-circuits at step 1.

## Task 5 — the post-turn sweep

`CheckpointReactor` already captures the checkpoint and refreshes status after a turn.
The sweep joins it there, over the project's members, isolated per member.

## Testing

The pull-request story rests entirely on the base resolving to the integration branch,
so it is verified on real git fixtures rather than trusted:

- T3 Code cut the branch → both config keys written, `resolveBaseBranch` returns the
  integration branch.
- The user cut it from the integration branch → `ensureMemberPrBase` yields the
  integration branch rather than `main`.
- The user cut it from `main` in a repository pinned to `pickup-v2` → the reflog step
  wins and the base is `main`. This is the case the ordering exists for.
- Reflog says `Created from HEAD` → the sha resolves back to a branch name.
- Reflog absent → clean fall-through to the declared integration branch.
- Regression guard: with `gh-merge-base` deliberately unset, the base resolves to
  `main`, proving the key is what does the work.
