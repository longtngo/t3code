/**
 * Branch bookkeeping for workspace member repositories.
 *
 * Everything here is a pure function of values the caller has already read, so
 * the rules that decide whether to touch a repository — and what a pull request
 * from it compares against — are testable without a git fixture.
 *
 * See docs/design/2026-08-04-multi-repo-workspace-design.md.
 */

/** Git config key naming the branch a pull request compares against. */
export function memberPrBaseConfigKey(branch: string): string {
  return `branch.${branch}.gh-merge-base`;
}

/** Git config key naming the thread that cut a branch. */
export function memberOwnerConfigKey(branch: string): string {
  return `branch.${branch}.t3code-thread`;
}

export type MemberBranchState =
  | "idle"
  | "cut-needed"
  | "owned-by-self"
  | "owned-by-other"
  | "unmanaged";

export interface MemberBranchInput {
  /** Read live from the repository, never trusted from stored state. */
  readonly currentBranch: string | null;
  readonly integrationBranch: string;
  /** From `branch.<current>.t3code-thread`, or null when the key is absent. */
  readonly ownerThreadId: string | null;
  readonly threadId: string;
  readonly isDirty: boolean;
}

/**
 * What a thread may do with a member repository right now.
 *
 * `unmanaged` is the deliberate do-nothing state. These checkouts are
 * long-lived and hand-pinned, so a repository sitting on a branch T3 Code did
 * not cut belongs to the user and is displayed rather than acted on.
 *
 * A detached HEAD reads as `currentBranch === null`, which lands in
 * `unmanaged` for the same reason: there is no branch to record ownership on
 * and cutting one would move the user off whatever they were inspecting.
 */
export function classifyMemberBranch(input: MemberBranchInput): MemberBranchState {
  if (input.currentBranch === null) return "unmanaged";
  if (input.currentBranch === input.integrationBranch) {
    return input.isDirty ? "cut-needed" : "idle";
  }
  if (input.ownerThreadId === null) return "unmanaged";
  return input.ownerThreadId === input.threadId ? "owned-by-self" : "owned-by-other";
}

export type MemberPrBaseSource = "configured" | "reflog" | "integration";

export interface MemberPrBaseInput {
  /** From `branch.<name>.gh-merge-base`. Explicit intent; always wins. */
  readonly configuredBase: string | null;
  /** The branch name the reflog records this branch as created from. */
  readonly reflogCreatedFrom: string | null;
  readonly integrationBranch: string;
}

/**
 * The branch a pull request from a member repository should compare against.
 *
 * The reflog must outrank the declared integration branch, and this is not a
 * nicety. A hotfix branch cut from `main` in a repository pinned to
 * `pickup-v2` would otherwise be stamped `pickup-v2` and open a pull request
 * against the wrong base — the exact failure this ladder exists to prevent, in
 * a case where the user did nothing wrong.
 *
 * The reflog is best-effort by nature: it is local-only, expires under
 * `gc.reflogExpire`, and is absent on a fresh clone. A missing record is
 * ordinary and falls through rather than failing.
 *
 * There is no topology step. Measured against known ground truth on four real
 * branches, both a decoration walk and a closest-merge-base heuristic were
 * right once out of four; git does not record branch ancestry, so a parent and
 * a sibling cut at the same commit are indistinguishable.
 */
export function resolveMemberPrBase(input: MemberPrBaseInput): {
  readonly base: string;
  readonly source: MemberPrBaseSource;
} {
  if (input.configuredBase !== null && input.configuredBase.length > 0) {
    return { base: input.configuredBase, source: "configured" };
  }
  if (input.reflogCreatedFrom !== null && input.reflogCreatedFrom.length > 0) {
    return { base: input.reflogCreatedFrom, source: "reflog" };
  }
  return { base: input.integrationBranch, source: "integration" };
}

const MAX_SLUG_LENGTH = 32;
const THREAD_ID_PREFIX_LENGTH = 8;

/**
 * The branch name to cut for a thread.
 *
 * The `t3code/` prefix matches the convention already on disk from
 * worktree-backed threads. The title slug is there because these branches are
 * long-lived in repositories the user browses by hand, where a bare hash is
 * unreadable — but the id suffix is what makes the name unique, so a thread
 * with an unusable title still gets a valid branch.
 */
export function memberFeatureBranchName(input: {
  readonly threadId: string;
  readonly threadTitle: string | null;
}): string {
  const slug = (input.threadTitle ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");
  const id = input.threadId.replace(/[^a-zA-Z0-9]/g, "").slice(0, THREAD_ID_PREFIX_LENGTH);
  return slug.length > 0 ? `t3code/${slug}-${id}` : `t3code/${id}`;
}

export interface BranchCreationRecord {
  /** What git recorded: a branch name, `HEAD`, or a sha. */
  readonly createdFrom: string;
  /** The commit the branch pointed at when it was created. */
  readonly sha: string;
}

/**
 * The creation entry in a branch's reflog, if it still has one.
 *
 * `git reflog show <branch>` ends with the entry that created the branch:
 * `<sha> <branch>@{n}: branch: Created from <X>`, where X is a branch name when
 * the user branched from one, and `HEAD` or a sha when they did not. Both are
 * returned, because a name is usable directly while `HEAD` has to be resolved
 * through the commit — and that commit is on this same line, not somewhere in
 * the branch's later history.
 */
export function parseBranchCreationRecord(reflogOutput: string): BranchCreationRecord | null {
  const match = /^(\S+)\s.*branch:\s+Created from (.+)$/m.exec(reflogOutput);
  const sha = match?.[1]?.trim();
  const createdFrom = match?.[2]?.trim();
  if (sha === undefined || createdFrom === undefined || createdFrom.length === 0) return null;
  return { createdFrom, sha };
}

/** `git branch --all` marks remote-tracking refs with this prefix. */
const REMOTE_REF_PREFIX = "remotes/";

/**
 * Which of the branches at a commit to treat as the one a branch was cut from.
 *
 * `git branch --points-at` can name several branches at one commit, and git
 * gives no way to tell which one the user branched from. The declared
 * integration branch wins when it is among them, because that is the effort's
 * ground truth. Otherwise a local branch beats a remote-tracking one: the
 * remote-tracking name would have to be stripped back to a branch name anyway,
 * and the local ref is the one a pull request base can actually be.
 *
 * Local and remote are told apart by git's own `remotes/` prefix rather than by
 * looking for a slash — plenty of local branches are named `feat/thing`.
 */
export function pickBranchAtCommit(
  branchNames: ReadonlyArray<string>,
  integrationBranch: string,
): string | null {
  const usable = branchNames.map((name) => name.trim()).filter((name) => name.length > 0);
  if (usable.includes(integrationBranch)) return integrationBranch;
  const local = usable.find((name) => !name.startsWith(REMOTE_REF_PREFIX));
  if (local !== undefined) return local;
  const remote = usable[0];
  if (remote === undefined) return null;
  // `remotes/origin/pickup-v2` names the branch `pickup-v2`.
  const withoutPrefix = remote.slice(REMOTE_REF_PREFIX.length);
  const slash = withoutPrefix.indexOf("/");
  return slash < 0 ? withoutPrefix : withoutPrefix.slice(slash + 1);
}
