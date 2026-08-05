import { assert, describe, it } from "vite-plus/test";

import {
  isWorkspaceProject,
  PRIMARY_REPO_ID,
  resolveActiveRepo,
  resolveVisibleFilePath,
  resolveWorkspaceRepos,
} from "./useWorkspaceRepos.logic";

const project = {
  title: "pickup-v2",
  workspaceRoot: "/Users/me/src/uni/pickup-v2",
  members: [
    {
      id: "m1",
      path: "/Users/me/src/uni/warehouse",
      title: "warehouse",
      integrationBranch: "pickup-v2",
    },
    {
      id: "m2",
      path: "/Users/me/src/uni/uniuni_api_prm",
      title: "uniuni_api_prm",
      integrationBranch: "pickup-v2-prm2.0",
    },
  ],
};

describe("resolveWorkspaceRepos", () => {
  it("is empty without a project", () => {
    assert.deepStrictEqual(resolveWorkspaceRepos({ project: null }), []);
  });

  it("puts the project workspace root first", () => {
    const repos = resolveWorkspaceRepos({ project });
    assert.deepStrictEqual(repos[0], {
      id: PRIMARY_REPO_ID,
      kind: "primary",
      cwd: "/Users/me/src/uni/pickup-v2",
      title: "pickup-v2",
      integrationBranch: null,
    });
  });

  // This is the behavior every panel had before the hook existed. A worktree
  // thread must keep running against its worktree, not the project root.
  it("prefers the thread worktree as the primary repository", () => {
    const repos = resolveWorkspaceRepos({
      project,
      threadWorktreePath: "/Users/me/src/uni/pickup-v2-worktrees/t3code-abc",
    });
    assert.strictEqual(repos[0]?.cwd, "/Users/me/src/uni/pickup-v2-worktrees/t3code-abc");
  });

  it("keeps members in their declared order after the primary", () => {
    const repos = resolveWorkspaceRepos({ project });
    assert.deepStrictEqual(
      repos.map((repo) => repo.id),
      [PRIMARY_REPO_ID, "m1", "m2"],
    );
    assert.strictEqual(repos[2]?.integrationBranch, "pickup-v2-prm2.0");
  });

  it("returns only the primary repository when no members are attached", () => {
    const repos = resolveWorkspaceRepos({ project: { ...project, members: [] } });
    assert.strictEqual(repos.length, 1);
  });

  it("tolerates a project from a server that predates members", () => {
    const repos = resolveWorkspaceRepos({
      project: { title: "solo", workspaceRoot: "/srv/solo" },
    });
    assert.strictEqual(repos.length, 1);
  });

  it("drops a member that repeats the workspace root", () => {
    const repos = resolveWorkspaceRepos({
      project: {
        ...project,
        members: [
          {
            id: "m0",
            path: "/Users/me/src/uni/pickup-v2/",
            title: "pickup-v2",
            integrationBranch: "main",
          },
          ...project.members,
        ],
      },
    });
    assert.deepStrictEqual(
      repos.map((repo) => repo.id),
      [PRIMARY_REPO_ID, "m1", "m2"],
    );
  });

  it("drops a member that repeats an earlier member", () => {
    const repos = resolveWorkspaceRepos({
      project: {
        ...project,
        members: [
          ...project.members,
          {
            id: "m3",
            path: "/Users/me/src/uni/warehouse",
            title: "warehouse again",
            integrationBranch: "main",
          },
        ],
      },
    });
    assert.strictEqual(repos.length, 3);
  });
});

describe("resolveActiveRepo", () => {
  const repos = resolveWorkspaceRepos({ project });

  it("is null with no repositories", () => {
    assert.strictEqual(resolveActiveRepo([], "m1"), null);
  });

  it("falls back to the primary repository with no selection", () => {
    assert.strictEqual(resolveActiveRepo(repos, null)?.id, PRIMARY_REPO_ID);
  });

  it("returns the selected member", () => {
    assert.strictEqual(resolveActiveRepo(repos, "m2")?.title, "uniuni_api_prm");
  });

  // A selection made on another thread, or on a member since detached, must
  // not leave a panel pointed at a repository that is no longer in the list.
  it("falls back to the primary repository for an unknown selection", () => {
    assert.strictEqual(resolveActiveRepo(repos, "detached-member")?.id, PRIMARY_REPO_ID);
  });
});

describe("isWorkspaceProject", () => {
  it("is false for a project with only its own repository", () => {
    assert.strictEqual(
      isWorkspaceProject(resolveWorkspaceRepos({ project: { ...project, members: [] } })),
      false,
    );
  });

  it("is true once a member is attached", () => {
    assert.strictEqual(isWorkspaceProject(resolveWorkspaceRepos({ project })), true);
  });
});

describe("resolveVisibleFilePath", () => {
  it("shows the open file when nothing is parked", () => {
    assert.strictEqual(resolveVisibleFilePath("app/Http/Kernel.php", null), "app/Http/Kernel.php");
  });

  it("hides the file the root switch parked", () => {
    assert.strictEqual(
      resolveVisibleFilePath("app/Http/Kernel.php", "app/Http/Kernel.php"),
      null,
    );
  });

  it("shows a file opened after the switch", () => {
    assert.strictEqual(resolveVisibleFilePath("routes/web.php", "app/Http/Kernel.php"), "routes/web.php");
  });

  it("stays empty when no file is open", () => {
    assert.strictEqual(resolveVisibleFilePath(null, "app/Http/Kernel.php"), null);
  });
});
