# Fix: "Failed to remove project" when the project's only threads are archived

**Date:** 2026-06-05
**Branch:** `fix/remove-project-archived-threads`

## Goal

Removing a project from the sidebar must succeed even when the project still
holds archived threads. Today it fails with:

> Orchestration command invariant failed (project.delete): Project
> '67119381-c05a-4c05-acc5-388334de4b58' is not empty and cannot be deleted
> without force=true.

## Root cause (verified against live data)

The live project `pickup-v2-poc`
(`~/.t3/userdata/state.sqlite`, id `67119381-…`) has two threads:

| thread     | deleted_at            | archived_at           |
| ---------- | --------------------- | --------------------- |
| `e00207dd` | 2026-05-29 (deleted)  | —                     |
| `0a63fbd0` | NULL                  | 2026-06-01 (archived) |

So one thread is **archived but not deleted**.

The deletion decision is split across two layers that disagree on what "empty"
means:

- **Server** — `project.delete` decider
  (`apps/server/src/orchestration/decider.ts:169`) counts
  `listThreadsByProjectId(projectId).filter(deletedAt === null)`. That set
  **includes archived threads** (archived ≠ deleted), so it sees 1 active
  thread and rejects deletion unless `force === true`. It *must* include them:
  the force path cascades a `thread.delete` for exactly this set, so excluding
  archived threads would orphan them under a deleted project.

- **Client** — `handleRemoveProject` in `apps/web/src/components/Sidebar.tsx`
  decides whether to pass `force` from `memberThreadCountByPhysicalKey`, which
  is built from the sidebar thread store. The sidebar **bootstrap snapshot
  excludes archived threads** (`ProjectionSnapshotQuery.ts:370` —
  `WHERE deleted_at IS NULL AND archived_at IS NULL`); archived threads load via
  a separate query and are not in the per-project sidebar count after an app
  restart. So the client counts 0 threads → takes the "empty" path →
  `removeProject(member)` **without** `force` → server invariant fires.

(When a thread is archived *during a live session* it stays in the client store,
so the bug only appears after a restart — matching the timeline: archived
2026-06-01, delete attempted 2026-06-05.)

The wire error is `OrchestrationDispatchCommandError { message }`
(`packages/contracts/src/orchestration.ts:1248`); only the message string
survives to the renderer — the underlying `_tag` is flattened.

## Approach (chosen)

**Server-authoritative retry.** The client's per-project count is an unreliable
hint; the server is the only reliable source of truth on emptiness. So:

1. **Single source of truth for the invariant wording** — add to
   `packages/contracts/src/orchestration.ts`:
   - `projectNotEmptyDeleteInvariantDetail(projectId)` — builds the detail
     string.
   - `isProjectNotEmptyDeleteInvariantMessage(message)` + a shared marker
     constant — predicate the client uses to recognize the error.
2. **Server** decider uses the shared builder for the detail (no behavior
   change; keeps client/server wording in lockstep).
3. **Client** `handleRemoveProject` empty-path catch: if the failure is the
   "project not empty" invariant, the project actually has hidden (archived)
   threads. Re-confirm with an explicit data-loss warning and retry with
   `force: true`. Other errors keep the existing error toast.

Common case (truly empty project) is unchanged: one light confirm, succeeds.
Only the rare hidden-thread case shows a second, honest data-loss confirm.

## Alternatives considered

- **Always pass `force` after the empty-path confirm.** Simplest (no error
  detection), fully robust. Rejected: it would delete archived threads' history
  under the light "removes only this project entry" message — no data-loss
  warning. Progressive disclosure (try → escalate) is the more honest UX.
- **Include archived threads in the client emptiness count.** They are
  deliberately excluded from the sidebar bootstrap and genuinely absent from the
  client store after a restart, so the client cannot count them without a new
  server round-trip. Rejected: fights an intentional design and is still racy.
- **Change the server invariant to ignore archived threads.** Then the force
  cascade would no longer delete them, orphaning archived threads under a
  deleted project. Rejected: data-integrity regression.

## Files touched

- `packages/contracts/src/orchestration.ts` — shared marker + builder +
  predicate (and `orchestration.test.ts`).
- `apps/server/src/orchestration/decider.ts` — use the shared builder.
- `apps/web/src/components/Sidebar.tsx` — detect invariant, re-confirm, retry
  with force; extract a shared `reportRemoveProjectFailure` helper to remove the
  duplicated error-toast block.

## Tradeoffs / limitations

- Detection is by message marker (the wire schema carries only a string). The
  marker is centralized in `contracts` and consumed by both sides, so the two
  stay in sync; a contracts unit test pins it.

## Follow-ups discovered

- The warning-path confirm ("delete its N threads") counts only non-archived
  threads, so N can undercount when archived threads exist. Cosmetic (the force
  cascade still deletes them all). Candidate follow-up, out of scope here.
