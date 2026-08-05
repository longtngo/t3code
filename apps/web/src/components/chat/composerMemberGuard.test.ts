import type { WorkspaceMemberBranchReport } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { WorkspaceRepo } from "~/hooks/useWorkspaceRepos";
import {
  contestedMembersKey,
  describeContestedMembers,
  dismissContestedMembersForSession,
  isContestedMembersDismissedForSession,
  selectContestedMembers,
} from "./composerMemberGuard";

function repo(id: string, title: string): WorkspaceRepo {
  return { id, kind: "member", cwd: `/repos/${title}`, title, integrationBranch: "main" };
}

function report(
  overrides: Partial<WorkspaceMemberBranchReport> & { memberId: string },
): WorkspaceMemberBranchReport {
  return {
    state: "owned-by-other",
    branch: "t3code/other-thread-1a2b3c4d",
    ownerThreadId: "other-thread",
    ...overrides,
  };
}

describe("selectContestedMembers", () => {
  const repos = [repo("api", "api"), repo("web", "web")];

  it("names the repository and branch another thread is working in", () => {
    expect(selectContestedMembers({ reports: [report({ memberId: "api" })], repos })).toEqual([
      { memberId: "api", title: "api", branch: "t3code/other-thread-1a2b3c4d" },
    ]);
  });

  it.each(["idle", "cut-needed", "owned-by-self", "unmanaged", "unavailable"] as const)(
    "stays quiet for %s",
    (state) => {
      expect(selectContestedMembers({ reports: [report({ memberId: "api", state })], repos })).toEqual(
        [],
      );
    },
  );

  it("drops a report whose repository the project no longer lists", () => {
    expect(selectContestedMembers({ reports: [report({ memberId: "gone" })], repos })).toEqual([]);
  });

  it("drops a report with no branch to name", () => {
    expect(
      selectContestedMembers({ reports: [report({ memberId: "api", branch: null })], repos }),
    ).toEqual([]);
  });
});

describe("contestedMembersKey", () => {
  const one = [{ memberId: "api", title: "api", branch: "t3code/one" }];

  it("is null when there is nothing to warn about", () => {
    expect(contestedMembersKey("thread-1", [])).toBeNull();
  });

  it("is null before the thread exists", () => {
    expect(contestedMembersKey(null, one)).toBeNull();
  });

  it("does not depend on the order the reports arrived in", () => {
    const a = { memberId: "api", title: "api", branch: "t3code/one" };
    const b = { memberId: "web", title: "web", branch: "t3code/two" };
    expect(contestedMembersKey("thread-1", [a, b])).toBe(contestedMembersKey("thread-1", [b, a]));
  });

  it("changes when the repository moves to a different branch, so a dismissal does not hide a new fact", () => {
    expect(contestedMembersKey("thread-1", one)).not.toBe(
      contestedMembersKey("thread-1", [{ memberId: "api", title: "api", branch: "t3code/two" }]),
    );
  });

  it("differs per thread, so dismissing in one does not silence the next", () => {
    expect(contestedMembersKey("thread-1", one)).not.toBe(contestedMembersKey("thread-2", one));
  });
});

describe("dismissContestedMembersForSession", () => {
  it("only silences the key it was given", () => {
    dismissContestedMembersForSession("thread-1:api@t3code/one");
    expect(isContestedMembersDismissedForSession("thread-1:api@t3code/one")).toBe(true);
    expect(isContestedMembersDismissedForSession("thread-2:api@t3code/one")).toBe(false);
    expect(isContestedMembersDismissedForSession(null)).toBe(false);
  });
});

describe("describeContestedMembers", () => {
  it("is null with nothing to describe", () => {
    expect(describeContestedMembers([])).toBeNull();
  });

  it("names the branch for a single repository", () => {
    expect(describeContestedMembers([{ memberId: "api", title: "api", branch: "t3code/one" }]))
      .toMatchInlineSnapshot(`
        {
          "description": "It is on t3code/one. Anything this turn writes there lands on that branch and mixes with the other thread's work.",
          "title": "api is on another thread's branch",
        }
      `);
  });

  it("lists two repositories by name", () => {
    expect(
      describeContestedMembers([
        { memberId: "api", title: "api", branch: "t3code/one" },
        { memberId: "web", title: "web", branch: "t3code/two" },
      ])?.description,
    ).toBe(
      "api and web are on branches other threads are working in. Anything this turn writes there mixes with that work.",
    );
  });

  it("counts the rest rather than enumerating them", () => {
    const described = describeContestedMembers([
      { memberId: "api", title: "api", branch: "t3code/one" },
      { memberId: "web", title: "web", branch: "t3code/two" },
      { memberId: "jobs", title: "jobs", branch: "t3code/three" },
    ]);
    expect(described?.title).toBe("3 repositories are on another thread's branch");
    expect(described?.description).toBe(
      "api, web and 1 more are on branches other threads are working in. Anything this turn writes there mixes with that work.",
    );
  });
});
