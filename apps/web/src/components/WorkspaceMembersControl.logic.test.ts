import { assert, describe, it } from "vite-plus/test";

import {
  addMember,
  canAutofillBranch,
  memberTitleFromPath,
  normalizeMemberPath,
  removeMember,
  resolveBranchHint,
  resolveBranchOptions,
  resolveMemberCwd,
  splitMemberPath,
  updateMember,
  validateMemberDraft,
} from "./WorkspaceMembersControl.logic";

const existing = [
  {
    id: "m1",
    path: "/srv/prm_portal_api",
    title: "prm_portal_api",
    integrationBranch: "pickup-v2",
  },
];

describe("normalizeMemberPath", () => {
  it("strips a trailing separator", () => {
    assert.strictEqual(normalizeMemberPath("/srv/uni/warehouse/"), "/srv/uni/warehouse");
  });

  it("keeps the filesystem root", () => {
    assert.strictEqual(normalizeMemberPath("/"), "/");
  });

  it("leaves a blank path blank", () => {
    assert.strictEqual(normalizeMemberPath("   "), "");
  });
});

describe("memberTitleFromPath", () => {
  it("uses the final path segment", () => {
    assert.strictEqual(memberTitleFromPath("/srv/uni/warehouse"), "warehouse");
  });

  it("ignores a trailing separator", () => {
    assert.strictEqual(memberTitleFromPath("/srv/uni/warehouse/"), "warehouse");
  });
});

describe("splitMemberPath", () => {
  it("separates the parent directories from the repository name", () => {
    assert.deepStrictEqual(splitMemberPath("~/src/uni/warehouse"), {
      parent: "~/src/uni/",
      name: "warehouse",
    });
  });

  it("reports no parent for a bare segment", () => {
    assert.deepStrictEqual(splitMemberPath("warehouse"), { parent: "", name: "warehouse" });
  });
});

describe("validateMemberDraft", () => {
  it("rejects a relative path", () => {
    assert.strictEqual(
      validateMemberDraft({ path: "../warehouse", integrationBranch: "main" }, existing),
      "Enter an absolute path, or one starting with ~/.",
    );
  });

  it("rejects a bare tilde", () => {
    assert.strictEqual(
      validateMemberDraft({ path: "~", integrationBranch: "main" }, existing),
      "Enter an absolute path, or one starting with ~/.",
    );
  });

  // The server expands `~` through the same normalization it applies to a
  // project's workspace root, and the design doc's own examples use this form,
  // so the client must not turn it away.
  it("accepts a home-relative path", () => {
    assert.strictEqual(
      validateMemberDraft(
        { path: "~/src/uni/warehouse", integrationBranch: "pickup-v2" },
        existing,
      ),
      null,
    );
  });

  it("rejects a blank branch", () => {
    assert.strictEqual(
      validateMemberDraft({ path: "/srv/warehouse", integrationBranch: "  " }, existing),
      "Enter the branch this repository integrates into.",
    );
  });

  it("rejects a duplicate path", () => {
    assert.strictEqual(
      validateMemberDraft(
        { path: "/srv/prm_portal_api", integrationBranch: "pickup-v2" },
        existing,
      ),
      "That repository is already attached.",
    );
  });

  // The picker appends a separator to whatever folder you click, so the same
  // repository reaches this check in two spellings.
  it("rejects a duplicate that differs only by a trailing separator", () => {
    assert.strictEqual(
      validateMemberDraft(
        { path: "/srv/prm_portal_api/", integrationBranch: "pickup-v2" },
        existing,
      ),
      "That repository is already attached.",
    );
  });

  it("does not treat the member being edited as its own duplicate", () => {
    assert.strictEqual(
      validateMemberDraft(
        { path: "/srv/prm_portal_api", integrationBranch: "release" },
        existing,
        "m1",
      ),
      null,
    );
  });

  it("still rejects an edit onto another member's path", () => {
    const twoMembers = [
      ...existing,
      { id: "m2", path: "/srv/warehouse", title: "warehouse", integrationBranch: "pickup-v2" },
    ];
    assert.strictEqual(
      validateMemberDraft(
        { path: "/srv/prm_portal_api", integrationBranch: "pickup-v2" },
        twoMembers,
        "m2",
      ),
      "That repository is already attached.",
    );
  });

  it("accepts a valid member", () => {
    assert.strictEqual(
      validateMemberDraft({ path: "/srv/warehouse", integrationBranch: "pickup-v2" }, existing),
      null,
    );
  });
});

describe("addMember", () => {
  it("appends a member with a generated id and derived title", () => {
    const next = addMember(existing, {
      id: "m2",
      path: "/srv/warehouse",
      integrationBranch: "pickup-v2",
    });
    assert.strictEqual(next.length, 2);
    assert.strictEqual(next[1]?.title, "warehouse");
    assert.strictEqual(next[1]?.id, "m2");
  });

  it("stores the path without a trailing separator", () => {
    const next = addMember(existing, {
      id: "m2",
      path: "/srv/warehouse/",
      integrationBranch: "pickup-v2",
    });
    assert.strictEqual(next[1]?.path, "/srv/warehouse");
  });

  it("does not mutate the input array", () => {
    addMember(existing, { id: "m2", path: "/srv/warehouse", integrationBranch: "pickup-v2" });
    assert.strictEqual(existing.length, 1);
  });
});

describe("updateMember", () => {
  it("replaces the path and branch and re-derives the title", () => {
    const next = updateMember(existing, "m1", {
      path: "/srv/uni/warehouse/",
      integrationBranch: "release ",
    });
    assert.deepStrictEqual(next[0], {
      id: "m1",
      path: "/srv/uni/warehouse",
      title: "warehouse",
      integrationBranch: "release",
    });
  });

  it("leaves other members untouched", () => {
    const twoMembers = [
      ...existing,
      { id: "m2", path: "/srv/warehouse", title: "warehouse", integrationBranch: "pickup-v2" },
    ];
    const next = updateMember(twoMembers, "m1", {
      path: "/srv/other",
      integrationBranch: "main",
    });
    assert.deepStrictEqual(next[1], twoMembers[1]);
  });

  it("is a no-op for an unknown id", () => {
    assert.deepStrictEqual(
      updateMember(existing, "nope", { path: "/srv/other", integrationBranch: "main" }),
      existing,
    );
  });
});

describe("removeMember", () => {
  it("removes by id", () => {
    assert.deepStrictEqual(removeMember(existing, "m1"), []);
  });

  it("is a no-op for an unknown id", () => {
    assert.deepStrictEqual(removeMember(existing, "nope"), existing);
  });
});

describe("resolveMemberCwd", () => {
  it("normalizes a browsable path", () => {
    assert.strictEqual(resolveMemberCwd("~/src/uni/warehouse/"), "~/src/uni/warehouse");
  });

  it("is null for a half-typed path", () => {
    assert.strictEqual(resolveMemberCwd("src/uni"), null);
  });

  it("is null for an empty field", () => {
    assert.strictEqual(resolveMemberCwd("  "), null);
  });
});

describe("resolveBranchOptions", () => {
  const refs = ["main", "pickup-v2", "pickup-v2-prm2.0"];

  it("offers every branch for an empty query", () => {
    assert.deepStrictEqual(resolveBranchOptions(refs, ""), refs);
  });

  // Autofill leaves an exact branch name in the field. Filtering on it would
  // reduce the list to the branch already chosen, with no way to switch.
  it("offers every branch when the field already holds one", () => {
    assert.deepStrictEqual(resolveBranchOptions(refs, "pickup-v2"), refs);
  });

  it("filters on a partial name", () => {
    assert.deepStrictEqual(resolveBranchOptions(refs, "prm"), ["pickup-v2-prm2.0", "prm"]);
  });

  it("keeps a branch that does not exist yet selectable", () => {
    assert.deepStrictEqual(resolveBranchOptions(refs, "brand-new"), ["brand-new"]);
  });
});

describe("canAutofillBranch", () => {
  it("fills an empty field", () => {
    assert.strictEqual(canAutofillBranch("", null), true);
  });

  it("replaces a value a previous autofill wrote", () => {
    assert.strictEqual(canAutofillBranch("pickup-v2", "pickup-v2"), true);
  });

  it("never overwrites what the user typed", () => {
    assert.strictEqual(canAutofillBranch("my-branch", "pickup-v2"), false);
  });
});

describe("resolveBranchHint", () => {
  const answered = {
    branchCwd: "/srv/api",
    hasRefsAnswer: true,
    isRepository: true,
    currentBranch: "pickup-v2",
    branch: "",
  };

  it("asks for a repository before one is chosen", () => {
    assert.strictEqual(
      resolveBranchHint({ ...answered, branchCwd: null }),
      "Choose a repository to list its branches.",
    );
  });

  it("says it is still reading rather than saying nothing", () => {
    // This is the flicker. Returning nothing here removed the line from the
    // DOM, and a vertically centred dialog moves by half the height it loses —
    // so every keystroke jumped the modal up and back down.
    assert.strictEqual(
      resolveBranchHint({ ...answered, hasRefsAnswer: false }),
      "Reading branches…",
    );
  });

  it("prefers the in-flight message over a stale answer's verdict", () => {
    // A previous directory's refs must not be reported as this one's: while the
    // query has not answered for the current path, "not a git repository" would
    // be a confident claim about a directory nothing has looked at.
    assert.strictEqual(
      resolveBranchHint({ ...answered, hasRefsAnswer: false, isRepository: false }),
      "Reading branches…",
    );
  });

  it("names a folder that is not a repository", () => {
    assert.strictEqual(
      resolveBranchHint({ ...answered, isRepository: false }),
      "That folder is not a git repository.",
    );
  });

  it("confirms when the typed branch is the one checked out", () => {
    assert.strictEqual(
      resolveBranchHint({ ...answered, branch: " pickup-v2 " }),
      "pickup-v2 is checked out in that repository.",
    );
  });

  it("has nothing to say for a branch that is not checked out", () => {
    assert.strictEqual(resolveBranchHint({ ...answered, branch: "other" }), null);
  });
});
