import type { WorkspaceMemberBranchReport } from "@t3tools/contracts";

import type { WorkspaceRepo } from "~/hooks/useWorkspaceRepos";

/**
 * A member repository sitting on a branch some other thread cut.
 *
 * See docs/design/2026-08-04-multi-repo-workspace-design.md, "The guard runs
 * pre-turn". One shared checkout per member means two threads writing to the
 * same repository cannot be isolated — this warning is the whole protection
 * available, so it has to reach the user *before* they send rather than in the
 * post-turn log where the damage is already done.
 */
export interface ContestedMember {
  readonly memberId: string;
  /** The repository's title as the project lists it. */
  readonly title: string;
  readonly branch: string;
}

/**
 * The member repositories a turn would write into behind another thread's back.
 *
 * Only `owned-by-other` qualifies. `unmanaged` is a checkout the user pinned by
 * hand, `owned-by-self` is this thread's own branch, and `unavailable` is
 * already visible as an unplug icon on the repository bar — none of them are a
 * reason to interrupt someone who is typing.
 *
 * A report whose repository is no longer in the project is dropped rather than
 * shown under its id: the reports and the repository list are two queries and
 * can disagree for a frame, and a warning naming a uuid helps nobody.
 */
export function selectContestedMembers(input: {
  readonly reports: ReadonlyArray<WorkspaceMemberBranchReport>;
  readonly repos: ReadonlyArray<WorkspaceRepo>;
}): ReadonlyArray<ContestedMember> {
  const titlesById = new Map(input.repos.map((repo) => [repo.id, repo.title]));
  const contested: ContestedMember[] = [];
  for (const report of input.reports) {
    if (report.state !== "owned-by-other") continue;
    // `branch` is what makes the warning actionable, and a report without one
    // cannot be `owned-by-other` in the first place — the classifier reads
    // ownership off the branch it is on.
    if (report.branch === null) continue;
    const title = titlesById.get(report.memberId);
    if (title === undefined) continue;
    contested.push({ memberId: report.memberId, title, branch: report.branch });
  }
  return contested;
}

/**
 * Identity of a warning, for remembering that the user dismissed *this* one.
 *
 * The branch is part of the key on purpose. Dismissing by repository alone
 * would silence the warning for the rest of the session, including when the
 * repository later moves onto a *different* thread's branch — a new fact the
 * user has not seen. So is the thread: `owned-by-other` is a statement about
 * some *other* thread, so the same repository on the same branch is a fresh
 * warning to everyone but its owner, and one thread's dismissal must not
 * silence it in the next. Returns null when there is nothing to warn about.
 */
export function contestedMembersKey(
  threadId: string | null,
  members: ReadonlyArray<ContestedMember>,
): string | null {
  if (threadId === null || members.length === 0) return null;
  const identities = members
    .map((member) => `${member.memberId}@${member.branch}`)
    .sort()
    .join(",");
  return `${threadId}:${identities}`;
}

// Session-scoped and module-level so it survives ChatView remounts, matching
// the branch-mismatch banner next to it. Its own set rather than a shared one:
// these keys are built from different parts and must not be able to collide.
const sessionDismissedContestedKeys = new Set<string>();

export function dismissContestedMembersForSession(key: string): void {
  sessionDismissedContestedKeys.add(key);
}

export function isContestedMembersDismissedForSession(key: string | null): boolean {
  return key !== null && sessionDismissedContestedKeys.has(key);
}

/**
 * What the banner says.
 *
 * Named repositories up to a point, then a count: the composer is not the
 * place to enumerate seven repositories, and the repository bar in the Diff
 * and Files panels already marks every one of them.
 */
const MAX_NAMED_REPOS = 2;

export function describeContestedMembers(members: ReadonlyArray<ContestedMember>): {
  readonly title: string;
  readonly description: string;
} | null {
  const first = members[0];
  if (first === undefined) return null;
  if (members.length === 1) {
    return {
      title: `${first.title} is on another thread's branch`,
      description: `It is on ${first.branch}. Anything this turn writes there lands on that branch and mixes with the other thread's work.`,
    };
  }
  const named = members.slice(0, MAX_NAMED_REPOS).map((member) => member.title);
  const remaining = members.length - named.length;
  const list = remaining > 0 ? `${named.join(", ")} and ${remaining} more` : named.join(" and ");
  return {
    title: `${members.length} repositories are on another thread's branch`,
    description: `${list} are on branches other threads are working in. Anything this turn writes there mixes with that work.`,
  };
}
