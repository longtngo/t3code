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

export interface MemberCheckpointState {
  readonly memberId: string;
  readonly headSha: string;
  readonly isDirty: boolean;
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
     *
     * `cutOn` is the difference between the two callers. The post-turn sweep
     * passes `tracked`, because a stray untracked file the user left lying
     * around is not evidence a turn wrote here and must not move their
     * checkout. The git panel passes `any`, because there the user has asked
     * to commit in this repository — and `git add -A` would otherwise land
     * those same untracked files directly on the integration branch.
     */
    readonly ensureFeatureBranch: (
      target: MemberBranchTarget & {
        readonly threadTitle: string | null;
        readonly cutOn?: "tracked" | "any";
      },
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
     * Where each member stands right now, for recording on a checkpoint or for
     * comparing against one. Members that cannot be read are omitted, which the
     * comparison reads as drift — a revert cannot restore what it cannot see.
     */
    readonly readCheckpointStates: (
      members: ReadonlyArray<{ readonly id: string; readonly path: string }>,
    ) => Effect.Effect<ReadonlyArray<MemberCheckpointState>>;
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

const MAX_BRANCH_NAME_ATTEMPTS = 5;

/**
 * How many member repositories a read-only fan-out inspects at once.
 *
 * Reading a member costs several git subprocesses, so inspecting a six-member
 * workspace one repository at a time takes as long as the six repositories
 * added together — long enough for the client to raise its slow-request
 * warning. The members are independent checkouts and the reads take no locks,
 * so they overlap safely. The cap keeps a large workspace from spawning one git
 * process per member all at once.
 *
 * Only the read-only paths fan out. `sweepWorkspaceMembers` writes to the
 * user's own checkouts and stays deliberately sequential.
 */
export const MEMBER_READ_CONCURRENCY = 8;

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
    const hasTrackedChanges = yield* git
      .hasTrackedChanges(cwd)
      .pipe(Effect.orElseSucceed(() => false));
    return {
      branch: status.branch,
      isDirty: status.hasWorkingTreeChanges,
      hasTrackedChanges,
    };
  });

  const branchExists = (cwd: string, branch: string) =>
    git.listLocalBranchNames(cwd).pipe(
      Effect.map((names) => names.includes(branch)),
      Effect.orElseSucceed(() => false),
    );

  /**
   * The name to cut, stepping aside from a branch that is not ours.
   *
   * An existing branch this thread already owns is reused; anything else gets a
   * numbered suffix rather than colliding. Bounded, because an unbounded search
   * on a repository full of near-miss names is a worse failure than giving up.
   */
  const resolveFreeBranchName = Effect.fn("WorkspaceMemberBranches.resolveFreeBranchName")(
    function* (cwd: string, preferred: string, threadId: string) {
      for (let attempt = 0; attempt < MAX_BRANCH_NAME_ATTEMPTS; attempt += 1) {
        const candidate = attempt === 0 ? preferred : `${preferred}-${attempt + 1}`;
        if (!(yield* branchExists(cwd, candidate))) return candidate;
        const owner = yield* readOwner(cwd, candidate);
        if (owner === threadId) return candidate;
      }
      return `${preferred}-${MAX_BRANCH_NAME_ATTEMPTS}`;
    },
  );

  const readOwner = (cwd: string, branch: string) =>
    git.readConfigValue(cwd, memberOwnerConfigKey(branch)).pipe(Effect.orElseSucceed(() => null));

  const inspectWith = Effect.fn("WorkspaceMemberBranches.inspectWith")(function* (
    target: MemberBranchTarget,
    cutOn: "tracked" | "any",
  ) {
    const local = yield* readLocalState(target.cwd);
    if (local === null) return unavailable("Not a readable git repository.");
    const ownerThreadId = local.branch === null ? null : yield* readOwner(target.cwd, local.branch);
    return {
      state: classifyMemberBranch({
        currentBranch: local.branch,
        integrationBranch: target.integrationBranch,
        ownerThreadId,
        threadId: target.threadId,
        hasTrackedChanges: cutOn === "any" ? local.isDirty : local.hasTrackedChanges,
      }),
      branch: local.branch,
      ownerThreadId,
    };
  });

  const inspect: WorkspaceMemberBranches["Service"]["inspect"] = (target) =>
    inspectWith(target, "tracked");

  const ensureFeatureBranch: WorkspaceMemberBranches["Service"]["ensureFeatureBranch"] = Effect.fn(
    "WorkspaceMemberBranches.ensureFeatureBranch",
  )(function* (target) {
    const report = yield* inspectWith(target, target.cutOn ?? "tracked");
    if (report.state !== "cut-needed") return report;

    const preferredBranch = memberFeatureBranchName({
      threadId: target.threadId,
      threadTitle: target.threadTitle,
    });
    // The name is a pure function of the thread, so it can already exist: from
    // an earlier attempt that failed after creating the ref, or from another
    // member backed by the same repository. Reusing our own and stepping aside
    // from anyone else's is what keeps a second attempt from failing forever on
    // "a branch named X already exists".
    const branch = yield* resolveFreeBranchName(target.cwd, preferredBranch, target.threadId);
    const existed = branch === preferredBranch && (yield* branchExists(target.cwd, branch));

    // Creating the branch at HEAD and switching to it carries uncommitted work
    // over untouched: both refer to the same commit, so no checkout happens and
    // nothing is stashed.
    const switched = yield* (existed
      ? git.switchRef({ cwd: target.cwd, refName: branch }).pipe(Effect.asVoid)
      : git.createRef({ cwd: target.cwd, refName: branch, switchRef: true }).pipe(Effect.asVoid)
    ).pipe(Effect.as(true), Effect.orElseSucceed(() => false));
    if (!switched) {
      // `createRef` creates the ref and then checks it out, so a refused
      // checkout — an unresolved merge, an index that needs resolving — would
      // otherwise leave a branch behind that permanently blocks every later
      // attempt under the same name.
      if (!existed) {
        yield* git.deleteRef(target.cwd, branch).pipe(Effect.ignore);
      }
      return unavailable(`Could not switch ${target.cwd} to ${branch}.`);
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

      const refNames = yield* git
        .listBranchNamesPointingAt(cwd, record.sha)
        .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
      return pickBranchAtCommit(refNames, { integrationBranch, branch });
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

  const readCheckpointStates: WorkspaceMemberBranches["Service"]["readCheckpointStates"] =
    Effect.fn("WorkspaceMemberBranches.readCheckpointStates")(function* (members) {
      // Read-only, so the members overlap. `Effect.forEach` keeps the results in
      // member order regardless of which repository answers first.
      const states = yield* Effect.forEach(
        members,
        (member) =>
          Effect.gen(function* () {
            const local = yield* readLocalState(member.path);
            if (local === null) return null;
            const headSha = yield* git
              .readHeadSha(member.path)
              .pipe(Effect.orElseSucceed(() => null));
            if (headSha === null) return null;
            return { memberId: member.id, headSha, isDirty: local.isDirty };
          }),
        { concurrency: MEMBER_READ_CONCURRENCY },
      );
      return states.filter((state): state is MemberCheckpointState => state !== null);
    });

  const writePrBase: WorkspaceMemberBranches["Service"]["writePrBase"] = (input) =>
    git
      .writeConfigValue(input.cwd, memberPrBaseConfigKey(input.branch), input.base)
      .pipe(Effect.as(true), Effect.orElseSucceed(() => false));

  return WorkspaceMemberBranches.of({
    inspect,
    ensureFeatureBranch,
    resolvePrBase,
    readCheckpointStates,
    writePrBase,
  });
});

export const layer = Layer.effect(WorkspaceMemberBranches, make);
