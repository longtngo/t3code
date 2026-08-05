import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import {
  classifyMemberBranch,
  type MemberBranchState,
  type MemberPrBaseSource,
  memberFeatureBranchName,
  memberOwnerConfigKey,
  memberPrBaseConfigKey,
  parseBranchCreationRecord,
  pickBranchAtCommit,
  resolveMemberPrBase,
} from "./MemberBranches.ts";

/**
 * What a member repository looks like right now, or why it could not be read.
 *
 * `unavailable` is a first-class outcome rather than an error because a
 * workspace sweep runs over every member and one bad path — deleted, renamed,
 * not a repository — must never fail the turn or block the other members.
 */
export interface MemberBranchReport {
  readonly state: MemberBranchState | "unavailable";
  readonly branch: string | null;
  readonly ownerThreadId: string | null;
  /** Present only for `unavailable`, explaining what was wrong. */
  readonly detail?: string;
}

export interface MemberBranchTarget {
  readonly cwd: string;
  readonly integrationBranch: string;
  readonly threadId: string;
}

export interface MemberPrBase {
  readonly base: string;
  readonly source: MemberPrBaseSource;
  readonly branch: string;
}

export class WorkspaceMemberBranches extends Context.Service<
  WorkspaceMemberBranches,
  {
    /** Reads a member's branch state. Never fails. */
    readonly inspect: (target: MemberBranchTarget) => Effect.Effect<MemberBranchReport>;
    /**
     * Puts a member on a feature branch when it is carrying uncommitted work on
     * its integration branch, recording the base and the owning thread.
     * Idempotent, and never fails.
     */
    readonly ensureFeatureBranch: (
      target: MemberBranchTarget & { readonly threadTitle: string | null },
    ) => Effect.Effect<MemberBranchReport>;
    /**
     * The branch a pull request from this member should compare against, and
     * where that answer came from. Null when there is no branch to compare.
     * Reads only; see `writePrBase` for persisting a confirmed answer.
     */
    readonly resolvePrBase: (input: {
      readonly cwd: string;
      readonly integrationBranch: string;
    }) => Effect.Effect<MemberPrBase | null>;
    /**
     * Persists a confirmed base so the next pull request action short-circuits
     * on it instead of walking the ladder again.
     */
    readonly writePrBase: (input: {
      readonly cwd: string;
      readonly branch: string;
      readonly base: string;
    }) => Effect.Effect<boolean>;
  }
>()("t3/workspace/WorkspaceMemberBranches") {}

export const make = Effect.gen(function* () {
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const git = yield* GitVcsDriver.GitVcsDriver;

  const unavailable = (detail: string): MemberBranchReport => ({
    state: "unavailable",
    branch: null,
    ownerThreadId: null,
    detail,
  });

  /** Null when the path is not a readable git repository. */
  const readLocalState = Effect.fn("WorkspaceMemberBranches.readLocalState")(function* (
    cwd: string,
  ) {
    const handle = yield* registry.detect({ cwd }).pipe(Effect.orElseSucceed(() => null));
    if (!handle || handle.kind !== "git") return null;
    const status = yield* git.statusDetailsLocal(cwd).pipe(Effect.orElseSucceed(() => null));
    if (status === null || !status.isRepo) return null;
    return { branch: status.branch, isDirty: status.hasWorkingTreeChanges };
  });

  const readOwner = (cwd: string, branch: string) =>
    git.readConfigValue(cwd, memberOwnerConfigKey(branch)).pipe(Effect.orElseSucceed(() => null));

  const inspect: WorkspaceMemberBranches["Service"]["inspect"] = Effect.fn(
    "WorkspaceMemberBranches.inspect",
  )(function* (target) {
    const local = yield* readLocalState(target.cwd);
    if (local === null) return unavailable("Not a readable git repository.");
    const ownerThreadId = local.branch === null ? null : yield* readOwner(target.cwd, local.branch);
    return {
      state: classifyMemberBranch({
        currentBranch: local.branch,
        integrationBranch: target.integrationBranch,
        ownerThreadId,
        threadId: target.threadId,
        isDirty: local.isDirty,
      }),
      branch: local.branch,
      ownerThreadId,
    };
  });

  const ensureFeatureBranch: WorkspaceMemberBranches["Service"]["ensureFeatureBranch"] = Effect.fn(
    "WorkspaceMemberBranches.ensureFeatureBranch",
  )(function* (target) {
    const report = yield* inspect(target);
    if (report.state !== "cut-needed") return report;

    const branch = memberFeatureBranchName({
      threadId: target.threadId,
      threadTitle: target.threadTitle,
    });
    // Creating the branch at HEAD and switching to it carries uncommitted work
    // over untouched: both refer to the same commit, so no checkout happens and
    // nothing is stashed.
    const created = yield* git
      .createRef({ cwd: target.cwd, refName: branch, switchRef: true })
      .pipe(Effect.as(true), Effect.orElseSucceed(() => false));
    if (!created) {
      return unavailable(`Could not create ${branch}.`);
    }

    // The base is known exactly here — this branch was just cut from the
    // integration branch — so writing it now is a record, not a guess.
    yield* git
      .writeConfigValue(target.cwd, memberPrBaseConfigKey(branch), target.integrationBranch)
      .pipe(Effect.ignore);
    yield* git
      .writeConfigValue(target.cwd, memberOwnerConfigKey(branch), target.threadId)
      .pipe(Effect.ignore);

    return { state: "owned-by-self", branch, ownerThreadId: target.threadId };
  });

  /**
   * The branch this one was cut from, per the reflog.
   *
   * `Created from` records a name when the user branched from one, but `HEAD`
   * or a sha when they did not. Those resolve through the branches pointing at
   * the commit on that same reflog line, which is where the branch actually
   * started — not the branch's current tip.
   */
  const resolveCreationBranch = Effect.fn("WorkspaceMemberBranches.resolveCreationBranch")(
    function* (cwd: string, branch: string, integrationBranch: string) {
      const reflog = yield* git.readBranchReflog(cwd, branch).pipe(Effect.orElseSucceed(() => ""));
      const record = parseBranchCreationRecord(reflog);
      if (record === null) return null;
      if (record.createdFrom !== "HEAD" && !/^[0-9a-f]{7,40}$/.test(record.createdFrom)) {
        return record.createdFrom;
      }

      const names = yield* git
        .listBranchNamesPointingAt(cwd, record.sha)
        .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
      // The branch itself points at that commit until it moves on, and it
      // cannot be its own base.
      return pickBranchAtCommit(
        names.filter((name) => name !== branch),
        integrationBranch,
      );
    },
  );

  const resolvePrBase: WorkspaceMemberBranches["Service"]["resolvePrBase"] = Effect.fn(
    "WorkspaceMemberBranches.resolvePrBase",
  )(function* (input) {
    const local = yield* readLocalState(input.cwd);
    const branch = local?.branch ?? null;
    if (branch === null) return null;

    const configuredBase = yield* git
      .readConfigValue(input.cwd, memberPrBaseConfigKey(branch))
      .pipe(Effect.orElseSucceed(() => null));
    // Skip the reflog read entirely when an explicit base already wins.
    const reflogCreatedFrom =
      configuredBase !== null && configuredBase.length > 0
        ? null
        : yield* resolveCreationBranch(input.cwd, branch, input.integrationBranch);

    return {
      ...resolveMemberPrBase({
        configuredBase,
        reflogCreatedFrom,
        integrationBranch: input.integrationBranch,
      }),
      branch,
    };
  });

  const writePrBase: WorkspaceMemberBranches["Service"]["writePrBase"] = (input) =>
    git
      .writeConfigValue(input.cwd, memberPrBaseConfigKey(input.branch), input.base)
      .pipe(Effect.as(true), Effect.orElseSucceed(() => false));

  return WorkspaceMemberBranches.of({
    inspect,
    ensureFeatureBranch,
    resolvePrBase,
    writePrBase,
  });
});

export const layer = Layer.effect(WorkspaceMemberBranches, make);
