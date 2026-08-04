import { assert, describe, it } from "vite-plus/test";

import {
  addMember,
  memberTitleFromPath,
  removeMember,
  validateNewMember,
} from "./WorkspaceMembersControl.logic";

const existing = [
  { id: "m1", path: "/srv/prm_portal_api", title: "prm_portal_api", integrationBranch: "pickup-v2" },
];

describe("memberTitleFromPath", () => {
  it("uses the final path segment", () => {
    assert.strictEqual(memberTitleFromPath("/srv/uni/warehouse"), "warehouse");
  });

  it("ignores a trailing separator", () => {
    assert.strictEqual(memberTitleFromPath("/srv/uni/warehouse/"), "warehouse");
  });
});

describe("validateNewMember", () => {
  it("rejects a relative path", () => {
    assert.strictEqual(
      validateNewMember({ path: "../warehouse", integrationBranch: "main" }, existing),
      "Enter an absolute path.",
    );
  });

  it("rejects a blank branch", () => {
    assert.strictEqual(
      validateNewMember({ path: "/srv/warehouse", integrationBranch: "  " }, existing),
      "Enter the branch this repository integrates into.",
    );
  });

  it("rejects a duplicate path", () => {
    assert.strictEqual(
      validateNewMember(
        { path: "/srv/prm_portal_api", integrationBranch: "pickup-v2" },
        existing,
      ),
      "That repository is already attached.",
    );
  });

  it("accepts a valid member", () => {
    assert.strictEqual(
      validateNewMember({ path: "/srv/warehouse", integrationBranch: "pickup-v2" }, existing),
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

  it("does not mutate the input array", () => {
    addMember(existing, { id: "m2", path: "/srv/warehouse", integrationBranch: "pickup-v2" });
    assert.strictEqual(existing.length, 1);
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
