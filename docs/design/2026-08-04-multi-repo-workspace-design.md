# Multi-repo workspace support

**Status:** Design · **Date:** 2026-08-04

A project maps 1:1 to a repository today. This adds *workspace members*: additional
repositories a project's threads can read, edit, and open pull requests against, without
changing what a project or a thread fundamentally is.

---

## Motivating workflow

The `pickup-v2` effort is one staging repository plus six code repositories:

| Path | Branch | Remote |
|---|---|---|
| `~/src/uni/pickup-v2` (staging: docs, scripts, tests) | `main` | none |
| `~/src/uni/prm_portal_api` | `pickup-v2` | yes |
| `~/src/uni/unimap_front` | `pickup-v2` | yes |
| `~/src/uni/uniuni_web_prm` | `pickup-v2` | yes |
| `~/src/uni/warehouse` | `pickup-v2` | yes |
| `~/src/uni/uniexpress-openplatform-backend` | `pickup-v2` | yes |
| `~/src/uni/uniuni_api_prm` | `pickup-v2-prm2.0` | yes |

Two properties of this layout drive the design:

1. **The integration branch name is not uniform.** `uniuni_api_prm` is on
   `pickup-v2-prm2.0`. Any workspace-wide branch setting would be wrong on day one.
2. **The member checkouts are long-lived and hand-pinned.** They are not worktrees T3 Code
   created; their primary checkout is parked on the effort's branch. T3 Code attaches to
   them and must not fight the user for control of them.

## Scope

**In scope**

- Files and Diff panels operate across member repositories.
- The agent reaches member repositories without a per-directory permission prompt.
- Git actions (commit / push / pull request) run per member repository, with pull requests
  targeting that repository's integration branch.
- Feature branches are cut in member repositories and recorded so ownership is visible.

**Out of scope** — deliberately, each with a reason

- **Cross-repo checkpoint capture.** Checkpoints stay staging-only; see
  [Checkpoint integrity](#checkpoint-integrity) for how revert stays honest without it.
- **Per-member scripts.** A script command is a shell string, so
  `cd ../warehouse && pnpm test` already works.
- **A Workspace aggregate that owns projects.** See [Alternatives](#alternatives).
- **Worktree-per-thread for members.** Contradicts the attach model; see
  [What this cannot do](#what-this-cannot-do).
- **Checked-in workspace config.** Member paths are machine-specific and the staging repo
  has no remote to share through.
- **Merge-conflict UI.** The pull request flow handles conflicts.

---

## Why the existing architecture absorbs this cheaply

Every server-side service is already parameterized by `cwd` rather than bound to a project:

| Service | Shape |
|---|---|
| `VcsDriverRegistry.resolve({ cwd })` | stateless per call |
| `GitWorkflowService` | `status`, `localStatus`, `remoteStatus`, `createRef`, `switchRef`, `runStackedAction`, `createWorktree` — all take `cwd` |
| `CheckpointStore` | `captureCheckpoint({ cwd })`, `restoreCheckpoint({ cwd })` |
| `WorkspaceFileSystem` / `WorkspacePaths` | `cwd` per operation |
| `WorkspaceSearchIndex` | a `LayerMap.Service` keyed by root, with `idleTimeToLive` eviction |
| `project.*` and `vcs.*` RPCs | every input carries `cwd` |

The 1:1 assumption lives in four places only:

1. `OrchestrationProject.workspaceRoot` and `repositoryIdentity` — one each
   (`packages/contracts/src/orchestration.ts:213`).
2. `OrchestrationThread.worktreePath` / `branch` — one each (`:356`).
3. `CheckpointReactor` derives a single `cwd` from the provider session runtime
   (`apps/server/src/orchestration/Layers/CheckpointReactor.ts:198`).
4. The client repeats `thread.worktreePath ?? project.workspaceRoot` in six places
   (`DiffPanel.tsx:225`, `SidebarV2.tsx:525` and `:1091`, the file browser,
   `BranchToolbar.tsx:249`).

So this is additive work at the edges, not a rewrite of the core.

---

## Model

```ts
// packages/contracts/src/orchestration.ts
export const WorkspaceMember = Schema.Struct({
  id: TrimmedNonEmptyString,                 // server-generated uuid, stable across a path move
  path: TrimmedNonEmptyString,               // absolute checkout directory
  title: TrimmedNonEmptyString,              // "prm_portal_api"
  integrationBranch: TrimmedNonEmptyString,  // "pickup-v2-prm2.0"
});

// added to OrchestrationProject and OrchestrationProjectShell
members: Schema.Array(WorkspaceMember).pipe(
  Schema.withDecodingDefault(Effect.succeed([])),
),
```

`workspaceRoot` keeps its exact current meaning: the staging repository, and the thread's
cwd. Members are additional repositories. A thread still belongs to exactly one project.

**`integrationBranch` is per member and non-nullable.** An "auto-detect the current branch"
option reads as convenient but is ambiguous precisely when it matters: once a feature branch
is cut, the current branch *is* the feature branch and the integration branch is gone. It is
resolved once when the member is attached and stored. If the stored value later disagrees
with what is on disk, that member is **unmanaged** — T3 Code displays the state and takes no
action, because these checkouts are hand-pinned and the tool should not fight the user.

**Version skew** is clean in both directions via `withDecodingDefault`: an older client
ignores `members`; an older server yields `[]` and no workspace UI appears. This matches the
pattern already used for `archivedAt` and `settledOverride`.

**Attaching a member** goes through the existing `project.meta.update` command, which
already accepts partial fields. The UI is a row in project settings: pick a directory, and
T3 Code reads its current branch as the `integrationBranch` default and its remote to decide
whether pull requests are available. The staging repo has no remote, so it is commit-only —
derived from `git remote`, never configured.

---

## Branch lifecycle

### Ownership lives in git config, not in a projection

Two keys are written on each feature branch T3 Code cuts:

| Key | Value | Purpose |
|---|---|---|
| `branch.<name>.gh-merge-base` | the integration branch | the existing PR flow targets it |
| `branch.<name>.t3code-thread` | the thread id | who owns this branch |

This survives a database wipe and a server restart, it is discoverable with
`git config --get-regexp`, and it makes each member repository self-describing — `cd` there
and you can see what T3 Code did and why.

`gh-merge-base` is not an invention. `resolveBaseBranch` already consults it **before**
upstream tracking or the provider default (`apps/server/src/git/GitManager.ts:1341`):

```ts
const configured = yield* gitCore.readConfigValue(cwd, `branch.${branch}.gh-merge-base`);
if (configured) return configured;
```

It is also `gh`'s own convention, so `gh pr create` run by hand in that repository targets
the integration branch too.

### The invariant: `gh-merge-base` is set before the PR step runs

Without the key, the base resolves to the wrong branch. `runPrStep` refuses to run unless
the branch is pushed (`GitManager.ts:1565`), so at PR time every branch has an upstream, and
it is `origin/<its own name>`. `resolveBaseBranch` then walks:

1. `branch.<name>.gh-merge-base` — absent, skip.
2. Upstream tracking — the guard is `upstreamBranch !== branch`, and the upstream *is* the
   branch itself, so it is correctly rejected.
3. `provider.getDefaultBranch({ cwd })` → **`main`**.

The consequences escalate: the PR diff becomes `main...feature`, which includes every commit
on `pickup-v2` not yet merged to `main`; the generated title and body describe that same
wrong diff, because `resolveBaseRangeRef` feeds `readRangeContext` feeds `generatePrContent`
(`:1596`–`:1604`); and merging the PR pushes the entire effort branch into `main`
prematurely.

So the invariant is **not** "T3 Code cuts the branch". It is narrower and covers more:

> `gh-merge-base` must be set on the current branch before any PR action in a member
> repository.

`ensureMemberPrBase(cwd, branch, integrationBranch)` — idempotent, sets the key only when
unset — is called pre-action in the git panel. That covers every branch origin uniformly:

| Branch origin | How the key gets set |
|---|---|
| Cut by T3 Code | at cut time; the pre-action call is a no-op |
| Cut by the user by hand | pre-action |
| Pre-dates this feature | pre-action |

The one case that cannot be fixed from outside is `runStackedAction` with
`featureBranch: true`, which creates the branch *inside* the action (`GitManager.ts:2022`),
after the last chance to write config. Member actions therefore always run with
`featureBranch: false` against a branch that already exists — which the post-turn cut
provides. `GitManager` needs no change either way.

A member sitting on its integration branch with no feature branch is offered commit and
push but **not** pull request: a PR from `pickup-v2` to `pickup-v2` is meaningless.

### The classifier

A pure function, unit-testable without git:

```ts
// apps/server/src/workspace/MemberBranches.ts
classifyMemberBranch(input: {
  currentBranch: string;
  integrationBranch: string;
  ownerThreadId: string | null;   // from branch.<current>.t3code-thread
  threadId: string;
  isDirty: boolean;
}): "idle" | "cut-needed" | "owned-by-self" | "owned-by-other" | "unmanaged"
```

| State | Condition | Action |
|---|---|---|
| `idle` | on integration branch, clean | none |
| `cut-needed` | on integration branch, dirty | cut and record |
| `owned-by-self` | owner is this thread | proceed |
| `owned-by-other` | owner is a different thread | warn, take no action |
| `unmanaged` | off integration branch with no owner key | none — the user is driving |

`currentBranch` is always read live (`git branch --show-current`) rather than trusted from
stored state, so a hand-switched branch is detected rather than assumed away.

### `ensureMemberFeatureBranch`

Idempotent, best-effort per member — a failing repository is logged and marked unavailable
and never fails the turn. On `cut-needed` it runs
`git switch -c t3code/<thread-title-slug>-<first 8 chars of thread id>` and writes both
config keys. Uncommitted changes carry over to the new branch automatically; no stash is
involved, and creating a branch at `HEAD` cannot conflict.

The `t3code/` prefix matches the convention already on disk from worktree-backed threads
(for example `t3code/12b5c8e4` in `uniexpress-openplatform-backend`). The title slug is
added because these branches are long-lived in repositories the user browses by hand, where
a bare hash is unreadable.

Called from exactly two places:

- **Post-turn sweep** — in `CheckpointReactor`, alongside the checkpoint capture (`:253`)
  and status refresh (`:540`) it already performs.
- **Pre-action in the git panel** — so a mid-turn commit does not race the sweep.
  `runStackedAction` then runs with `featureBranch: false` against an already-correct branch.

### The guard runs pre-turn

A post-turn sweep alone permits silent cross-thread contamination: thread A cuts
`t3code/foo` in `prm_portal_api`; thread B then writes there; the sweep sees
`current != integrationBranch` and correctly does nothing — so B's changes land on A's
branch, invisibly.

The classifier therefore runs over every member **before the agent starts**, and
`owned-by-other` surfaces as a warning in the composer. It warns rather than blocks:
blocking a turn is a harsh failure mode, and since isolation is impossible under a shared
checkout (below), blocking buys less than it costs.

### What this cannot do

With one shared checkout per member repository, **isolation between threads is impossible**.
If two threads write to the same directory their changes mix in the working tree, and no
amount of branch bookkeeping separates them. The guard makes the state *visible*; it does
not prevent it.

Real prevention requires a worktree per thread per member, which was considered and
declined: it contradicts the attach model and multiplies seven repositories by N threads on
disk. This limitation is therefore bought, not accidental, and the UI shows ownership
prominently rather than implying a safety it does not have.

---

## Panels

### Diff aggregates

A repo selector would make the user click through seven repositories to find the two with
changes. What a thread needs from Diff is "what did this change, everywhere", so the panel
groups by repository, hides repositories with no changes, and shows branch, ownership, and
counts per group.

**Local status for all members; remote status only for the expanded member.**
`VcsStatusBroadcaster` runs local and remote together (`:376`), and remote status touches
the network. Fanning seven remote refreshes resembles the git-fetch storm that previously
pegged CPU and made the backend read as unresponsive. `GitWorkflowService` already exposes
`localStatus` and `remoteStatus` separately (`:41`, `:44`), so this is a flag on the RPC
rather than new machinery.

### Files selects

A file tree needs a single root, so Files gets a root selector over
`[staging, ...members]`. **Search stays scoped to the selected root in v1.** Cross-root
fan-out would make all seven `WorkspaceSearchIndex` instances resident at up to
`WORKSPACE_INDEX_MAX_ENTRIES` (25,000) entries each; given this codebase's history with
memory growth, that is measured before it ships rather than assumed cheap.

### Agent reach

`ClaudeAdapter.ts:3710` becomes:

```ts
additionalDirectories: [
  ...(input.cwd ? [input.cwd] : []),
  ...members.map((member) => member.path),
  serverConfig.attachmentsDir,
],
```

Member paths also join the `readAccess` extra roots. They qualify under that module's own
rule — it requires roots to come from server-side state, never from a client-supplied `cwd`
— because members are project state. Paths that do not exist are filtered at session start.

This is a deliberate widening of what the agent may write without prompting. It is the
requested behavior and is recorded here explicitly rather than left implicit.

### Client refactor

A single `useWorkspaceRepos(threadRef)` hook replaces the six scattered copies of
`thread.worktreePath ?? project.workspaceRoot`, returning the ordered repository list plus
the active selection. Active-repo selection is a client-side view preference per thread, not
server state.

---

## Checkpoint integrity

Checkpoints remain staging-only. Dropping cross-repo capture does not drop the hazard: a
revert that restores staging while leaving member repositories changed produces an
inconsistent tree while the UI implies a clean undo.

The fix is to make checkpoint completeness a function of **what the turn actually touched**,
not of whether the project is a workspace:

1. Capture the staging checkpoint as today.
2. Record each member's `HEAD` sha and dirty flag as **checkpoint metadata** — no snapshot,
   no objects written. This is a new optional field on `OrchestrationCheckpointSummary`
   (`packages/contracts/src/orchestration.ts:300`), which already carries `checkpointRef`,
   `status`, and `files` per turn:

   ```ts
   memberStates: Schema.optional(
     Schema.Array(
       Schema.Struct({
         memberId: TrimmedNonEmptyString,
         headSha: TrimmedNonEmptyString,
         isDirty: Schema.Boolean,
       }),
     ),
   ),
   ```

   It is `optional` rather than defaulted, so a checkpoint captured before this shipped is
   distinguishable from one captured with no members — the former cannot make a completeness
   claim and is treated as complete, matching today's behavior.

3. At revert, compare recorded to current:
   - **No member drifted** → the checkpoint is complete. Revert normally, with no warning
     and no degradation. This is the common case for turns that only touch staging.
   - **Members drifted** → name the drifted repositories precisely and refuse there.

This is nearly free because `CheckpointReactor` already performs both the capture and the
post-turn status refresh, and the member sweep reads each member's branch and dirty state
anyway. The only addition is one `git rev-parse HEAD` per member.

Disabling checkpoints outright for workspace projects was considered and rejected: it
removes the capability in the case where it works correctly (staging-only turns, likely the
majority in a docs-and-scripts repository) in order to fix the case where it does not.

Member work also remains recoverable through git regardless, because it lands on a feature
branch with commits.

**Capture cost was measured, not assumed.** On `~/src/uni/pickup-v2` (272 tracked files, 2
untracked, 173 MB worktree), the full seed-index → `git add -A` → `write-tree` sequence
completes in **0.035 s**. Capture cost is not a motivation for changing checkpoint behavior
here, and the existing untracked size-bound and git-timeout-retry work already covers the
modes that caused past incidents.

---

## Error handling

| Condition | Behavior |
|---|---|
| Member path missing or not a repository | Member shown as unavailable with the reason; excluded from `additionalDirectories`; panels and sandbox unaffected |
| `integrationBranch` absent from the repository | Member treated as unmanaged; flagged in project settings |
| Branch cut fails (detached HEAD, permissions) | Logged, member left unmanaged, surfaced in the diff group header |
| One member fails during the sweep | Isolated — never fails the turn or blocks other members |
| Two members resolve to the same path | Rejected at attach time |

---

## Testing

- `classifyMemberBranch` — unit table across all five states, no git required.
- Contract decode defaults for `members` in both skew directions.
- **The load-bearing integration tests.** The entire pull-request story rests on the base
  resolving to the integration branch, so it is verified rather than trusted, on a real git
  fixture, for both branch origins:
  - *T3 Code cut it* — cut a member branch, assert both config keys are written, assert
    `resolveBaseBranch` returns the integration branch.
  - *The user cut it by hand* — create a branch with no config, run `ensureMemberPrBase`,
    assert `resolveBaseBranch` returns the integration branch rather than `main`.
  - *Regression guard* — with `gh-merge-base` deliberately unset, assert the base resolves
    to `main`, so the test proves the key is what is doing the work rather than passing for
    an unrelated reason.

  `apps/server/src/vcs/testing/VcsDriverContractHarness.ts` provides the harness.
- Checkpoint completeness: capture with members clean → revert proceeds; capture then dirty
  a member → revert refuses and names it.
- `useWorkspaceRepos` unit tests; diff aggregation grouping.

---

## Delivery phases

Each phase is independently shippable and leaves the product coherent.

| Phase | Contents | Value on its own |
|---|---|---|
| **1. Model + reach** | `WorkspaceMember` contract, attach UI in project settings, `additionalDirectories`, `readAccess` roots | The agent edits member repositories without prompts — the highest-value, lowest-risk slice |
| **2. Read surfaces** | `useWorkspaceRepos` hook (replacing the six scattered cwd derivations), Files root selector, aggregated Diff with local-only status for non-active members | You can see what changed across all repositories |
| **3. Branch lifecycle** | `classifyMemberBranch`, `ensureMemberFeatureBranch`, `ensureMemberPrBase`, post-turn sweep, pre-turn guard warning, per-member git actions | Commit and pull request per repository, targeting the integration branch |
| **4. Checkpoint integrity** | `memberStates` on the checkpoint summary, completeness check at revert | Revert stops being able to mislead |

Phase 3 is the only one that writes to member repositories. Phases 1 and 2 are read-only
with respect to git, which makes them safe to live on before the branch machinery lands.

## Alternatives

**A Workspace aggregate owning N projects.** Conceptually cleaner — each repository keeps
its own identity, scripts, and favicon, and members become first-class sidebar rows. It was
rejected because this repository is a fork of `pingdotgg/t3code` that carries a recurring
reconcile cost against upstream, and this approach rewrites the orchestration aggregate, the
projector, the decider, `projectGrouping.ts`, and the sidebar — the worst possible surface on
which to diverge, re-paid at every drift merge. The chosen design is additive: one optional
contract field plus new client components.

The honest cost of the chosen design is that a workspace cannot have per-member scripts or
favicons, and members are not first-class sidebar rows. It does not foreclose the
alternative: `WorkspaceMember.id` is stable and can become a project id later.

**Linked directories only** — a settings list feeding `additionalDirectories` and the read
sandbox, with no per-repo diff or git actions. Rejected as too thin for the requested
per-repository pull request flow.

---

## Open items

- Cross-root search fan-out: measure `WorkspaceSearchIndex` residency and latency across
  seven roots before enabling it. v1 ships search scoped to the selected root.
