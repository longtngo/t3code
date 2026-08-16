# Review diff: remove the server-cwd workspace bound

**Date:** 2026-08-07
**Branch:** `fix/review-diff-workspace-bound`
**RCA:** `~/reports/t3code/2026-08/2026-08-07/2026-08-07-rca-diff-panel-workspace-root.md`

## Goal

Make the Diff panel show each repository's own changes, for every repository the user works in,
and never show one repository's diff under another's name.

Two observable defects, one cause:

- Member repositories render `VCS repository detection failed in ReviewService.getDiffPreview:
… Review diff preview cwd must stay within the configured workspace root.`
- The primary repository renders **the t3code server repo's working tree** under the project's
  name, because the client silently retries the failed request at the server's own cwd.

Cause (confirmed by live reproduction and a planted-file experiment — see the RCA):
`ReviewService.assertWorkspaceBoundCwd` allows a diff cwd only under `config.cwd` or
`config.worktreesDir`. `config.cwd` is `process.cwd()`, which under launchd is
`/Users/longngo/src/playground/t3code/apps/server`. Nothing the user reviews is under it.

## Approach — delete the bound

Remove `assertWorkspaceBoundCwd` (and its `canonicalizePath` / `isWithinRoot` helpers) from
`ReviewService`, and remove the client-side fallback that hid the failure for the primary repo.

### Why deleting is right, not just easy

The bound reads like a security boundary. It is not one, and this is measured rather than
assumed (Hard Rule 8 — the load-bearing premise for this design):

1. **A weaker scope already reads any file on the machine.** `projectsReadTrustedFile` and
   `projectsReadFile` require `orchestration:read`; the review RPCs require `review:write`. Both
   scopes are in `AuthStandardClientScopes`, so every ordinary client token carries both — there
   is no caller who has the review scope but not the read scope.

2. **That unrestricted read is deliberate and documented in this fork.**
   `WorkspaceFileSystem.readTrustedFile` says so in its own comment:

   > No path sandbox: any file the server process can read is readable here. […] what keeps it
   > authorized is the `orchestration:read` scope on the calling RPCs.

   `readAccess.ts` was deleted for exactly this reason.

3. **No sibling VCS RPC enforces it.** `assertWorkspaceBoundCwd` appears in one file.
   `vcs.status`, `vcs.listRefs`, `filesystem.browse` and the terminal all accept any path — which
   is why the `warehouse` tab correctly showed its real branch and changed-file count _next to_
   the message claiming that repository was out of bounds.

So the bound blocks a real feature while protecting nothing: a caller who can request a diff can
already read the same bytes, with a lesser scope, through a documented path. A half-enforced
boundary is worse than none, because it reads as protection.

### Why the client fallback must go with it

`DiffPanel.tsx` retried the failed request at `serverConfig.cwd`. That is what turned an honest
error into wrong data: the panel rendered the server's own repository under the project's name,
and only looked harmless because t3code's tree happened to be clean. Its own code comment already
called this "a silent lie" for member repos; it is equally untrue for the primary repo.

Once the bound is gone the fallback is unreachable dead code, so removing it is required cleanup
rather than an independent choice.

## Alternatives considered

**A. Bound against the project registry instead of `config.cwd`.** Accept a cwd matching any
registered project's `workspaceRoot`, any attached member path, any thread `worktreePath`, or
`worktreesDir`. This is the semantically correct repair and was the RCA's first recommendation.

Rejected because it buys a boundary that premise (1) shows is already bypassable with a _lower_
scope, and it is not free:

- a projection read (`ProjectionProjectRepository.listAll`) on every diff request;
- thread rows too — the reported thread's primary cwd was `/var/folders/…/T/…`, a worktree under
  neither `workspaceRoot` nor `worktreesDir`, so a projects-only allow-list would still have
  rejected it;
- a new failure mode where a just-registered project is not yet projected and its diff 403s.

More code and more edge cases for a guarantee that does not hold. If the fork ever re-sandboxes
reads, this becomes the right change and the recipe above is the recipe.

**B. Widen `config.cwd` (e.g. point launchd's `WorkingDirectory` at the repo root).** Rejected:
config-only, fixes nothing for member repos, and leaves the behaviour dependent on how the service
happens to be installed.

**C. Keep the bound, drop only the fallback.** Rejected as a half fix: it converts the primary
repo from silently-wrong to honestly-broken, which is an improvement, but every tab stays broken.

## Files touched

| File                                           | Change                                                                                                                                                                                        |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/review/ReviewService.ts`      | Delete `canonicalizePath`, `isWithinRoot`, `assertWorkspaceBoundCwd` and both call sites; drop the now-unused `FileSystem` / `Path` / `ServerConfig` / `VcsRepositoryDetectionError` imports. |
| `apps/server/src/review/ReviewService.test.ts` | Invert the two rejection tests into reachability tests; drop the `canonicalizePath` failure test with the code it covered; keep the inside-root test.                                         |
| `apps/web/src/components/DiffPanel.tsx`        | Remove `shouldRetryBranchDiffAtEnvironmentCwd` and `fallbackBranchDiffPreview`; use the single query directly.                                                                                |

## Tradeoffs and known limitations

- **Fork divergence.** Upstream keeps the bound, so this becomes a recurring merge conflict in one
  file. It is ~30 lines in one place and the rationale is recorded here and in memory; acceptable.
- **Errors get more honest, not fewer.** A member path that is not a git repository now yields
  "no changes" from `detect` returning null rather than a bound error. That is correct, but it is
  a different empty state than before.
- **A NUL-byte or otherwise unresolvable cwd** now fails inside `VcsDriverRegistry.detect` rather
  than in `canonicalizePath`. The error is still surfaced, with a different operation label.

## Follow-ups deferred

None identified. The RCA's remaining suggestions (log rejections server-side; rename one of the
two "workspace root" concepts) are moot once the bound is gone: there is no rejection to log, and
`WorkspacePaths`' project-relative root becomes the only "workspace root" on the server.
