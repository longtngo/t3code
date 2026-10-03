import type { WorkspaceMemberBranchReport } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { WorkspaceRepo } from "~/hooks/useWorkspaceRepos";
import {
  contestedMemberKey,
  contestedMembersKey,
  describeContestedMembers,
  describeUnknownMemberGuard,
  dismissContestedMembersForSession,
  resolveMemberGuardState,
  selectContestedMembers,
  withoutDismissedContestedMembers,
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

const contested = (memberId: string, branch: string) => ({ memberId, title: memberId, branch });

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
      expect(
        selectContestedMembers({ reports: [report({ memberId: "api", state })], repos }),
      ).toEqual([]);
    },
  );

  it("drops a report with no branch to name", () => {
    expect(
      selectContestedMembers({ reports: [report({ memberId: "api", branch: null })], repos }),
    ).toEqual([]);
  });

  it("still warns when the repository list dropped the member, naming it by path", () => {
    expect(
      selectContestedMembers({
        reports: [report({ memberId: "gone" })],
        repos,
        pathsByMemberId: new Map([["gone", "/Users/someone/src/prm_portal_api/"]]),
      }),
    ).toEqual([
      { memberId: "gone", title: "prm_portal_api", branch: "t3code/other-thread-1a2b3c4d" },
    ]);
  });

  it("falls back to the member id rather than going silent when there is no path either", () => {
    expect(selectContestedMembers({ reports: [report({ memberId: "gone" })], repos })).toEqual([
      { memberId: "gone", title: "gone", branch: "t3code/other-thread-1a2b3c4d" },
    ]);
  });
});

describe("contestedMembersKey", () => {
  it("is null when there is nothing to warn about", () => {
    expect(contestedMembersKey("thread-1", [])).toBeNull();
  });

  it("is null before the thread exists", () => {
    expect(contestedMembersKey(null, [contested("api", "t3code/one")])).toBeNull();
  });

  it("does not depend on the order the reports arrived in", () => {
    const a = contested("api", "t3code/one");
    const b = contested("web", "t3code/two");
    expect(contestedMembersKey("thread-1", [a, b])).toBe(contestedMembersKey("thread-1", [b, a]));
  });

  it("changes when the repository moves to a different branch", () => {
    expect(contestedMembersKey("thread-1", [contested("api", "t3code/one")])).not.toBe(
      contestedMembersKey("thread-1", [contested("api", "t3code/two")]),
    );
  });

  it("differs per thread, so dismissing in one does not silence the next", () => {
    expect(contestedMembersKey("thread-1", [contested("api", "t3code/one")])).not.toBe(
      contestedMembersKey("thread-2", [contested("api", "t3code/one")]),
    );
  });
});

describe("session dismissal", () => {
  it("keys on the member and branch together", () => {
    expect(contestedMemberKey("t", contested("api", "b"))).toBe("t:api@b");
  });

  it("silences only the repository and branch it was given", () => {
    const api = contested("api", "t3code/one");
    const web = contested("web", "t3code/two");
    dismissContestedMembersForSession("thread-1", [api]);
    expect(withoutDismissedContestedMembers("thread-1", [api, web])).toEqual([web]);
    expect(withoutDismissedContestedMembers("thread-2", [api, web])).toEqual([api, web]);
  });

  it("does not re-raise the remaining repository when another one resolves", () => {
    const api = contested("api", "t3code/three");
    const web = contested("web", "t3code/four");
    dismissContestedMembersForSession("thread-3", [api, web]);
    // `web` merged back to its integration branch. `api` is still contested and
    // the user dismissed it a moment ago; a set-shaped key would re-raise it.
    expect(withoutDismissedContestedMembers("thread-3", [api])).toEqual([]);
  });

  it("raises a newly contested repository even after a dismissal", () => {
    const api = contested("api", "t3code/five");
    const jobs = contested("jobs", "t3code/six");
    dismissContestedMembersForSession("thread-4", [api]);
    expect(withoutDismissedContestedMembers("thread-4", [api, jobs])).toEqual([jobs]);
  });
});

describe("resolveMemberGuardState", () => {
  const base = {
    hasMembers: true,
    hasAnswer: true,
    hasError: false,
    isEnvironmentUnavailable: false,
    contested: [],
  };

  it("is silent for a project with no attached repositories", () => {
    expect(resolveMemberGuardState({ ...base, hasMembers: false, hasAnswer: false })).toEqual({
      kind: "silent",
    });
  });

  it("is silent once the check has come back clean", () => {
    expect(resolveMemberGuardState(base)).toEqual({ kind: "silent" });
  });

  it("says so while the check is still running, rather than reading as clean", () => {
    expect(resolveMemberGuardState({ ...base, hasAnswer: false })).toEqual({
      kind: "unknown",
      reason: "checking",
    });
  });

  it("distinguishes disconnected from merely slow", () => {
    expect(
      resolveMemberGuardState({ ...base, hasAnswer: false, isEnvironmentUnavailable: true }),
    ).toEqual({ kind: "unknown", reason: "offline" });
  });

  it("says so when the check failed", () => {
    expect(resolveMemberGuardState({ ...base, hasError: true })).toEqual({
      kind: "unknown",
      reason: "failed",
    });
  });

  it("prefers a stale warning over reporting the refresh failure", () => {
    expect(
      resolveMemberGuardState({
        ...base,
        hasError: true,
        contested: [contested("api", "t3code/one")],
      }),
    ).toEqual({ kind: "contested" });
  });
});

describe("describeUnknownMemberGuard", () => {
  it.each(["checking", "offline", "failed"] as const)("has a line for %s", (reason) => {
    expect(describeUnknownMemberGuard(reason)).toMatch(/attached repositories/);
  });
});

describe("describeContestedMembers", () => {
  it("is null with nothing to describe", () => {
    expect(describeContestedMembers([])).toBeNull();
  });

  it("returns the branch separately so it can be set as code", () => {
    expect(describeContestedMembers([contested("api", "t3code/one")])).toMatchInlineSnapshot(`
      {
        "afterBranch": ". Anything you send now is written there, on that branch, mixed in with the other thread's work.",
        "beforeBranch": "It is on ",
        "branch": "t3code/one",
        "kind": "one",
        "title": "api is on another thread's branch",
      }
    `);
  });

  it("does not claim a single owner when several repositories are contested", () => {
    const described = describeContestedMembers([
      contested("api", "t3code/one"),
      contested("web", "t3code/two"),
    ]);
    expect(described?.title).toBe("2 repositories are on other threads' branches");
    expect(described?.kind === "many" ? described.description : null).toBe(
      "api and web are on branches other threads are working in. Anything you send now is written there, mixed in with that work.",
    );
  });

  it("counts the rest rather than enumerating them", () => {
    const described = describeContestedMembers([
      contested("api", "t3code/one"),
      contested("web", "t3code/two"),
      contested("jobs", "t3code/three"),
    ]);
    expect(described?.title).toBe("3 repositories are on other threads' branches");
    expect(described?.kind === "many" ? described.description : null).toBe(
      "api, web and 1 more are on branches other threads are working in. Anything you send now is written there, mixed in with that work.",
    );
  });
});
