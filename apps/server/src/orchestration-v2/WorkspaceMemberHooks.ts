/**
 * Fork: workspace member repositories in the run lifecycle.
 *
 * A project can list member repositories beyond its workspace root. Three run
 * milestones touch them:
 * - checkpoint capture records where each member stood (`checkpointStates`),
 * - run finalization cuts a feature branch in every member the run wrote to
 *   (`sweep`), and
 * - a file-restoring rollback refuses when a member has moved since the target
 *   checkpoint (`rollbackRefusal`), because restoring the thread's own checkout
 *   alone would leave the workspace out of step behind a UI promising a clean undo.
 *
 * A required service, not a `Context.Reference` with an inert default: a
 * default let the production wiring go missing while everything still compiled
 * and passed. `OrchestrationV2ProductionLayerLive` provides `live`; tests that
 * never attach members provide `inert`.
 */
import {
  type CheckpointMemberState,
  type OrchestrationV2Checkpoint,
  type ProjectId,
  type ThreadId,
  type WorkspaceMember,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import {
  describeCheckpointDrift,
  isCheckpointComplete,
  resolveCheckpointDrift,
  resolveTurnZeroDrift,
  shouldCheckMemberDrift,
} from "../workspace/CheckpointMemberDrift.ts";
import * as WorkspaceMemberBranches from "../workspace/WorkspaceMemberBranches.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";

type HookError = ProjectStore.ProjectStoreV2Error | ProjectionStore.ProjectionStoreV2Error;

export interface WorkspaceMemberHooksShape {
  /**
   * Member states to record on a run's checkpoint. Undefined when the thread's
   * project has no members, so checkpoints of single-repository projects are
   * unchanged.
   */
  readonly checkpointStates: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<ReadonlyArray<CheckpointMemberState> | undefined, HookError>;
  /** Cuts feature branches in the thread's members after a run. Never fails. */
  readonly sweep: (input: { readonly threadId: ThreadId }) => Effect.Effect<void>;
  /**
   * Why restoring files to `checkpoint` would leave members out of step, naming
   * them; null when the restore is complete.
   */
  readonly rollbackRefusal: (input: {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly checkpoint: Pick<OrchestrationV2Checkpoint, "appRunOrdinal" | "memberStates">;
  }) => Effect.Effect<string | null, HookError>;
}

export class WorkspaceMemberHooks extends Context.Service<
  WorkspaceMemberHooks,
  WorkspaceMemberHooksShape
>()("t3/orchestration-v2/WorkspaceMemberHooks") {}

/**
 * For orchestration tests whose projects never attach members. Production
 * provides `live` in `OrchestrationV2ProductionLayerLive`.
 */
export const inert = Layer.succeed(WorkspaceMemberHooks, {
  checkpointStates: () => Effect.succeed(undefined),
  sweep: () => Effect.void,
  rollbackRefusal: () => Effect.succeed(null),
});

export const make = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const branches = yield* WorkspaceMemberBranches.WorkspaceMemberBranches;
  const vcsStatus = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;

  const membersOf = (projectId: ProjectId) =>
    projects
      .get(projectId, { includeDeleted: true })
      .pipe(
        Effect.map((project): ReadonlyArray<WorkspaceMember> =>
          Option.match(project, { onNone: () => [], onSome: (row) => row.members }),
        ),
      );

  const checkpointStates: WorkspaceMemberHooksShape["checkpointStates"] = Effect.fn(
    "WorkspaceMemberHooks.checkpointStates",
  )(function* ({ threadId }) {
    const thread = yield* projections.getThreadShell(threadId);
    if (thread === null) return undefined;
    const members = yield* membersOf(thread.projectId);
    if (members.length === 0) return undefined;
    const states = yield* branches.readCheckpointStates(members);
    // A member we could not read is recorded without a head rather than
    // dropped, which arms the rollback guard for this checkpoint.
    const unread = states.filter((state) => state.headSha === undefined);
    if (unread.length > 0) {
      yield* Effect.logWarning("workspace members unreadable at checkpoint capture", {
        threadId,
        members: unread.map(
          (state) => members.find((member) => member.id === state.memberId)?.path ?? state.memberId,
        ),
      });
    }
    return states;
  });

  /**
   * Members are swept one at a time rather than concurrently: this writes to
   * the user's own long-lived checkouts, and a predictable order is worth more
   * than the milliseconds. Every member is isolated — one bad path must never
   * fail the run or stop the others.
   */
  const sweepMembers = Effect.fn("WorkspaceMemberHooks.sweep")(function* ({
    threadId,
  }: {
    readonly threadId: ThreadId;
  }) {
    const thread = yield* projections.getThreadShell(threadId);
    if (thread === null) return;
    const members = yield* membersOf(thread.projectId);
    for (const member of members) {
      const report = yield* branches.ensureFeatureBranch({
        cwd: member.path,
        integrationBranch: member.integrationBranch,
        threadId,
        threadTitle: thread.title,
      });
      if (report.state === "unavailable") {
        yield* Effect.logInfo("workspace member unavailable", {
          threadId,
          member: member.title,
          detail: report.detail,
        });
        continue;
      }
      if (report.state === "owned-by-other") {
        yield* Effect.logWarning("workspace member is on another thread's branch", {
          threadId,
          member: member.title,
          branch: report.branch,
          ownerThreadId: report.ownerThreadId,
        });
      }
      // A member's status is cached per directory and nothing else recomputes
      // a directory that is not some thread's own cwd, so the panels would
      // keep showing what they read before the sweep moved the branch.
      yield* vcsStatus.refreshLocalStatus(member.path).pipe(Effect.ignoreCause({ log: true }));
    }
  });
  const sweep: WorkspaceMemberHooksShape["sweep"] = (input) =>
    sweepMembers(input).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("workspace member sweep failed", {
              threadId: input.threadId,
              cause: Cause.pretty(cause),
            }),
      ),
    );

  const rollbackRefusal: WorkspaceMemberHooksShape["rollbackRefusal"] = Effect.fn(
    "WorkspaceMemberHooks.rollbackRefusal",
  )(function* ({ threadId, projectId, checkpoint }) {
    const members = yield* membersOf(projectId);
    const isTurnZero = checkpoint.appRunOrdinal === null;
    if (
      !shouldCheckMemberDrift({
        isTurnZero,
        liveMemberCount: members.length,
        recordedMemberCount: checkpoint.memberStates?.length ?? 0,
      })
    ) {
      return null;
    }
    // The thread start has no recorded member states, so it asks instead
    // whether any member still carries this thread's work.
    const drift = isTurnZero
      ? resolveTurnZeroDrift(
          yield* Effect.forEach(
            members,
            (member) =>
              branches
                .inspect({
                  cwd: member.path,
                  integrationBranch: member.integrationBranch,
                  threadId,
                })
                .pipe(Effect.map((report) => ({ memberId: member.id, state: report.state }))),
            { concurrency: WorkspaceMemberBranches.MEMBER_READ_CONCURRENCY },
          ),
        )
      : resolveCheckpointDrift(
          checkpoint.memberStates,
          yield* branches.readCheckpointStates(members),
        );
    if (isCheckpointComplete(drift)) return null;
    return describeCheckpointDrift(
      drift,
      (memberId) => members.find((member) => member.id === memberId)?.title ?? memberId,
    );
  });

  return { checkpointStates, sweep, rollbackRefusal } satisfies WorkspaceMemberHooksShape;
});

export const live = Layer.effect(WorkspaceMemberHooks, make);
