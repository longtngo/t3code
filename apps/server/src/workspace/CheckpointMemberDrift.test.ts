import { assert, describe, it } from "@effect/vitest";

import {
  describeCheckpointDrift,
  isCheckpointComplete,
  resolveCheckpointDrift,
} from "./CheckpointMemberDrift.ts";

const warehouse = { memberId: "m1", headSha: "aaa111", isDirty: false };
const api = { memberId: "m2", headSha: "bbb222", isDirty: false };

describe("resolveCheckpointDrift", () => {
  // A checkpoint captured before members were recorded cannot claim anything.
  // Treating it as complete is what it was captured under, so a revert of old
  // history keeps working exactly as it did.
  it("makes no claim for a checkpoint captured before member recording", () => {
    const drift = resolveCheckpointDrift(undefined, [warehouse]);
    assert.isFalse(drift.hasClaim);
    assert.isTrue(isCheckpointComplete(drift));
  });

  // An empty array is a real claim: the turn ran with no members attached.
  it("treats an empty record as a claim of no members", () => {
    const drift = resolveCheckpointDrift([], [warehouse]);
    assert.isTrue(drift.hasClaim);
    assert.isTrue(isCheckpointComplete(drift));
  });

  it("is complete when nothing moved", () => {
    const drift = resolveCheckpointDrift([warehouse, api], [warehouse, api]);
    assert.deepStrictEqual(drift.driftedMemberIds, []);
  });

  it("names a member whose head moved", () => {
    const drift = resolveCheckpointDrift(
      [warehouse, api],
      [{ ...warehouse, headSha: "ccc333" }, api],
    );
    assert.deepStrictEqual(drift.driftedMemberIds, ["m1"]);
  });

  it("names a member that became dirty", () => {
    const drift = resolveCheckpointDrift([warehouse, api], [warehouse, { ...api, isDirty: true }]);
    assert.deepStrictEqual(drift.driftedMemberIds, ["m2"]);
  });

  // Uncommitted work that has since been committed leaves the head moved and
  // the tree clean; either half alone is enough to make the revert incomplete.
  it("names a member that became clean", () => {
    const drift = resolveCheckpointDrift([{ ...warehouse, isDirty: true }], [warehouse]);
    assert.deepStrictEqual(drift.driftedMemberIds, ["m1"]);
  });

  // A detached member cannot be restored to what was recorded either.
  it("names a member that is no longer readable", () => {
    const drift = resolveCheckpointDrift([warehouse, api], [api]);
    assert.deepStrictEqual(drift.driftedMemberIds, ["m1"]);
  });

  it("ignores a member attached after the checkpoint", () => {
    const drift = resolveCheckpointDrift([warehouse], [warehouse, api]);
    assert.deepStrictEqual(drift.driftedMemberIds, []);
  });
});

describe("describeCheckpointDrift", () => {
  const title = (memberId: string) => (memberId === "m1" ? "warehouse" : "uniuni_api_prm");

  it("names one repository", () => {
    const message = describeCheckpointDrift({ driftedMemberIds: ["m1"], hasClaim: true }, title);
    assert.include(message, "warehouse has changed");
  });

  it("names several repositories", () => {
    const message = describeCheckpointDrift(
      { driftedMemberIds: ["m1", "m2"], hasClaim: true },
      title,
    );
    assert.include(message, "warehouse and uniuni_api_prm have changed");
  });
});
