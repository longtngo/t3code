import { assert, describe, it } from "@effect/vitest";
import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";

import {
  classifyMemberBranch,
  memberFeatureBranchName,
  memberOwnerConfigKey,
  memberPrBaseConfigKey,
  parseBranchCreationRecord,
  pickBranchAtCommit,
  resolveMemberPrBase,
} from "./MemberBranches.ts";

const base = {
  integrationBranch: "pickup-v2",
  threadId: "thread-a",
  ownerThreadId: null,
  hasTrackedChanges: false,
} as const;

describe("classifyMemberBranch", () => {
  it("is idle on a clean integration branch", () => {
    assert.strictEqual(classifyMemberBranch({ ...base, currentBranch: "pickup-v2" }), "idle");
  });

  it("needs a cut when a tracked file changed on the integration branch", () => {
    assert.strictEqual(
      classifyMemberBranch({ ...base, currentBranch: "pickup-v2", hasTrackedChanges: true }),
      "cut-needed",
    );
  });

  // A file the user left lying around is not evidence that a turn wrote here,
  // and acting on it would move their checkout onto a branch they never asked
  // for, on every turn, forever.
  it("stays idle for untracked files alone", () => {
    assert.strictEqual(
      classifyMemberBranch({ ...base, currentBranch: "pickup-v2", hasTrackedChanges: false }),
      "idle",
    );
  });

  it("recognizes a branch this thread owns", () => {
    assert.strictEqual(
      classifyMemberBranch({
        ...base,
        currentBranch: "t3code/demo-suite-abc12345",
        ownerThreadId: "thread-a",
      }),
      "owned-by-self",
    );
  });

  // Two threads cannot be isolated inside one shared checkout, so this state
  // exists to be shown, not to be silently worked around.
  it("recognizes a branch another thread owns", () => {
    assert.strictEqual(
      classifyMemberBranch({
        ...base,
        currentBranch: "t3code/other-work-99999999",
        ownerThreadId: "thread-b",
      }),
      "owned-by-other",
    );
  });

  it("leaves a hand-cut branch unmanaged", () => {
    assert.strictEqual(
      classifyMemberBranch({ ...base, currentBranch: "hotfix/urgent", hasTrackedChanges: true }),
      "unmanaged",
    );
  });

  // A detached HEAD has no branch to record ownership on, and cutting one
  // would move the user off whatever they were inspecting.
  it("leaves a detached HEAD unmanaged", () => {
    assert.strictEqual(
      classifyMemberBranch({ ...base, currentBranch: null, hasTrackedChanges: true }),
      "unmanaged",
    );
  });
});

describe("resolveMemberPrBase", () => {
  it("prefers an explicitly configured base", () => {
    assert.deepStrictEqual(
      resolveMemberPrBase({
        configuredBase: "release/2026-08",
        reflogCreatedFrom: "main",
        integrationBranch: "pickup-v2",
      }),
      { base: "release/2026-08", source: "configured" },
    );
  });

  // The case the ordering exists for: a hotfix cut from main in a repository
  // pinned to pickup-v2 must not open a pull request against pickup-v2.
  it("prefers the reflog record over the declared integration branch", () => {
    assert.deepStrictEqual(
      resolveMemberPrBase({
        configuredBase: null,
        reflogCreatedFrom: "main",
        integrationBranch: "pickup-v2",
      }),
      { base: "main", source: "reflog" },
    );
  });

  it("falls through to the integration branch when the reflog is gone", () => {
    assert.deepStrictEqual(
      resolveMemberPrBase({
        configuredBase: null,
        reflogCreatedFrom: null,
        integrationBranch: "pickup-v2",
      }),
      { base: "pickup-v2", source: "integration" },
    );
  });

  it("treats an empty configured value as absent", () => {
    assert.strictEqual(
      resolveMemberPrBase({
        configuredBase: "",
        reflogCreatedFrom: null,
        integrationBranch: "pickup-v2",
      }).source,
      "integration",
    );
  });
});

describe("memberFeatureBranchName", () => {
  it("combines a readable slug with the thread id", () => {
    assert.strictEqual(
      memberFeatureBranchName({ threadId: "abcd1234efgh", threadTitle: "Add demo suite" }),
      "t3code/add-demo-suite-abcd1234",
    );
  });

  it("collapses punctuation rather than emitting it", () => {
    assert.strictEqual(
      memberFeatureBranchName({ threadId: "abcd1234", threadTitle: "Fix: the __thing__!" }),
      "t3code/fix-the-thing-abcd1234",
    );
  });

  // The id suffix is what makes the name unique, so an unusable title must
  // still produce a valid branch rather than a trailing separator.
  it("still produces a branch for an unusable title", () => {
    assert.strictEqual(
      memberFeatureBranchName({ threadId: "abcd1234", threadTitle: "###" }),
      "t3code/member-abcd1234",
    );
  });

  it("still produces a branch with no title at all", () => {
    assert.strictEqual(
      memberFeatureBranchName({ threadId: "abcd1234", threadTitle: null }),
      "t3code/member-abcd1234",
    );
  });

  // `t3code/<8 hex>` is the shape other code recognises as a disposable
  // worktree placeholder it may rename. A member's branch is long-lived and
  // must never land in that space — which a titleless thread with a UUID id
  // otherwise would, every time.
  it("stays clear of the disposable-worktree branch shape", () => {
    const name = memberFeatureBranchName({
      threadId: "4d544e9e-0a3f-49f5-9699-951616e9da93",
      threadTitle: null,
    });
    assert.strictEqual(name, "t3code/member-4d544e9e");
    assert.isFalse(isTemporaryWorktreeBranch(name));
    // The shape it would have had, to show the test is not vacuous.
    assert.isTrue(isTemporaryWorktreeBranch("t3code/4d544e9e"));
  });

  it("does not leave a separator where the slug was truncated", () => {
    const name = memberFeatureBranchName({
      threadId: "abcd1234",
      threadTitle: "a".repeat(30) + " tail",
    });
    assert.isFalse(name.includes("--"));
    assert.isTrue(name.endsWith("-abcd1234"));
  });
});

describe("parseBranchCreationRecord", () => {
  it("reads the branch a reflog says the branch came from", () => {
    const reflog = [
      "91352dc79 pickup-v2-prm2.0@{16}: Branch: renamed refs/heads/x to refs/heads/y",
      "33935d34a pickup-v2-prm2.0@{18}: branch: Created from pickup-v2",
    ].join("\n");
    assert.deepStrictEqual(parseBranchCreationRecord(reflog), {
      createdFrom: "pickup-v2",
      sha: "33935d34a",
    });
  });

  // `HEAD` is not a base. It is returned verbatim so the caller can resolve it
  // through the sha on the same line, which is where the branch started.
  it("reports HEAD with the commit it was created at", () => {
    assert.deepStrictEqual(
      parseBranchCreationRecord("abc1234 t3code/x@{0}: branch: Created from HEAD"),
      { createdFrom: "HEAD", sha: "abc1234" },
    );
  });

  // The reflog is local-only and expires, so an absent record is ordinary.
  it("is null when the reflog carries no creation record", () => {
    assert.strictEqual(parseBranchCreationRecord("abc main@{0}: commit: work\n"), null);
  });

  it("is null for empty output", () => {
    assert.strictEqual(parseBranchCreationRecord(""), null);
  });
});

// These take the refnames `git branch --all --format=%(refname)` really prints.
// The previous version of this suite invented a `remotes/origin/main` shape git
// never emits, so it agreed with the code while both were wrong about the input.
describe("pickBranchAtCommit", () => {
  const at = (refNames: ReadonlyArray<string>, branch = "hotfix") =>
    pickBranchAtCommit(refNames, { integrationBranch: "pickup-v2", branch });

  it("prefers the declared integration branch", () => {
    assert.strictEqual(
      at(["refs/heads/chore/seed", "refs/heads/pickup-v2", "refs/heads/main"]),
      "pickup-v2",
    );
  });

  // The case the reflog step exists for: a branch cut from `main` in a
  // repository pinned to `pickup-v2` must compare against `main`.
  it("resolves the one branch left at the commit", () => {
    assert.strictEqual(at(["refs/heads/hotfix", "refs/heads/main"]), "main");
  });

  it("counts a branch and its remote-tracking ref as one candidate", () => {
    assert.strictEqual(
      at(["refs/heads/main", "refs/remotes/origin/main", "refs/remotes/origin/HEAD"]),
      "main",
    );
  });

  // The defect this rewrite fixes. `git switch -c` records "Created from HEAD",
  // so every branch cut while sitting on the same commit lands here together,
  // and the old rule returned whichever came first — basing a pull request on
  // another in-flight feature branch.
  it("refuses to choose between siblings at the same commit", () => {
    assert.strictEqual(at(["refs/heads/hotfix", "refs/heads/hotfix-2", "refs/heads/main"]), null);
  });

  it("never treats a branch T3 Code cut as a base", () => {
    assert.strictEqual(at(["refs/heads/t3code/other-thread-abc12345", "refs/heads/main"]), "main");
  });

  it("ignores the branch being resolved", () => {
    assert.strictEqual(at(["refs/heads/hotfix"]), null);
  });

  it("reads a remote branch when only remote refs are left", () => {
    assert.strictEqual(at(["refs/remotes/origin/main"]), "main");
  });

  // A tag at the same commit is not a branch and cannot be a pull-request base.
  it("ignores refs that are not branches", () => {
    assert.strictEqual(at(["refs/tags/v1.0.0", "refs/heads/main"]), "main");
  });

  it("is null when nothing points at the commit", () => {
    assert.strictEqual(at([]), null);
  });
});

describe("config keys", () => {
  // resolveBaseBranch reads this exact key before upstream tracking or the
  // provider default, and it is gh's own convention, so a hand-run
  // `gh pr create` in that repository targets the same base.
  it("uses gh's merge-base key", () => {
    assert.strictEqual(memberPrBaseConfigKey("t3code/x"), "branch.t3code/x.gh-merge-base");
  });

  it("namespaces the ownership key", () => {
    assert.strictEqual(memberOwnerConfigKey("t3code/x"), "branch.t3code/x.t3code-thread");
  });
});
