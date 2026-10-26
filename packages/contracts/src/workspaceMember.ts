import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * A repository beyond `workspaceRoot`. `integrationBranch` is resolved once at attach and stored:
 * once a feature branch is cut, the current branch IS that branch, so auto-detecting is ambiguous
 * exactly when it matters. A member whose checkout no longer matches it is treated as unmanaged.
 */
export const WorkspaceMember = Schema.Struct({
  id: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  integrationBranch: TrimmedNonEmptyString,
});
export type WorkspaceMember = typeof WorkspaceMember.Type;

/**
 * A project's member list. Decodes absent as `[]` so shells and events written by
 * servers that never knew about members still decode.
 */
export const WorkspaceMembers = Schema.Array(WorkspaceMember).pipe(
  Schema.withDecodingDefault(Effect.succeed([])),
);

/**
 * What a workspace member repository's branch looks like to a thread.
 *
 * `unavailable` covers a path that is gone, renamed, or not a repository —
 * a sweep runs over every member and one bad path must not fail the others.
 */
export const WorkspaceMemberBranchState = Schema.Literals([
  "idle",
  "cut-needed",
  "owned-by-self",
  "owned-by-other",
  "unmanaged",
  "unavailable",
]);
export type WorkspaceMemberBranchState = typeof WorkspaceMemberBranchState.Type;

export const WorkspaceMemberBranchReport = Schema.Struct({
  memberId: TrimmedNonEmptyString,
  state: WorkspaceMemberBranchState,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  /** The thread that cut this branch, when one did. */
  ownerThreadId: Schema.NullOr(TrimmedNonEmptyString),
  detail: Schema.optional(TrimmedNonEmptyString),
});
export type WorkspaceMemberBranchReport = typeof WorkspaceMemberBranchReport.Type;

/**
 * Member paths are read from the project on the server rather than sent by the
 * caller: this runs git in the named directory, and the set of directories a
 * thread may reach is project state, not a client-supplied argument.
 */
export const WorkspaceMemberBranchesInput = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
});
export type WorkspaceMemberBranchesInput = typeof WorkspaceMemberBranchesInput.Type;

export const WorkspaceMemberBranchesResult = Schema.Struct({
  reports: Schema.Array(WorkspaceMemberBranchReport),
});
export type WorkspaceMemberBranchesResult = typeof WorkspaceMemberBranchesResult.Type;

/** Where the pull-request base came from, weakest last. */
export const WorkspaceMemberPrBaseSource = Schema.Literals(["configured", "reflog", "integration"]);
export type WorkspaceMemberPrBaseSource = typeof WorkspaceMemberPrBaseSource.Type;

/**
 * Readies one member repository for a git action the user is about to run.
 *
 * Called from the git panel rather than only after a turn, so a commit made
 * mid-turn does not race the post-turn sweep for the same branch.
 */
export const WorkspaceMemberActionPrepareInput = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  memberId: TrimmedNonEmptyString,
});
export type WorkspaceMemberActionPrepareInput = typeof WorkspaceMemberActionPrepareInput.Type;

export const WorkspaceMemberActionPrepareResult = Schema.Struct({
  report: WorkspaceMemberBranchReport,
  /**
   * The branch a pull request from this member should compare against, and
   * where that answer came from. Null when there is no branch to compare — a
   * member still sitting on its integration branch has nothing to open.
   */
  prBase: Schema.NullOr(
    Schema.Struct({
      branch: TrimmedNonEmptyString,
      base: TrimmedNonEmptyString,
      source: WorkspaceMemberPrBaseSource,
    }),
  ),
});
export type WorkspaceMemberActionPrepareResult = typeof WorkspaceMemberActionPrepareResult.Type;

/**
 * Records the base the user confirmed, so the pull request compares against it
 * and the next action short-circuits on it instead of inferring again.
 *
 * Deliberately separate from the prepare step: an inferred base must never
 * become sticky without the user having seen it.
 */
export const WorkspaceMemberPrBaseWriteInput = Schema.Struct({
  projectId: ProjectId,
  memberId: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
  base: TrimmedNonEmptyString,
});
export type WorkspaceMemberPrBaseWriteInput = typeof WorkspaceMemberPrBaseWriteInput.Type;

export const WorkspaceMemberPrBaseWriteResult = Schema.Struct({
  written: Schema.Boolean,
});
export type WorkspaceMemberPrBaseWriteResult = typeof WorkspaceMemberPrBaseWriteResult.Type;

/**
 * Checkpoints snapshot only the thread's own checkout; this records enough per member (HEAD and a
 * dirty flag, nothing written) to tell at rollback whether restoring that checkout alone still
 * produces the checkpointed tree.
 */
export const CheckpointMemberState = Schema.Struct({
  memberId: TrimmedNonEmptyString,
  /**
   * Absent when the server could not read this member at all — the checkout was
   * gone, or a git read timed out. Absence means "not observed", never "fine":
   * a rollback cannot restore a state nobody looked at, so the comparison treats
   * it as drift.
   */
  headSha: Schema.optional(TrimmedNonEmptyString),
  isDirty: Schema.Boolean,
});
export type CheckpointMemberState = typeof CheckpointMemberState.Type;
