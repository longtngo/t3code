import { describe, expect, it } from "@effect/vitest";

import { crewBranchFor, isCrewBranch } from "./crew.ts";

const TASK_ID = "3f2b8c1e-9a4d-4e7f-b6a1-0c5d2e8f9a7b";

describe("isCrewBranch", () => {
  it("matches exactly the branch crew_dispatch gives a crewmate", () => {
    expect(isCrewBranch(crewBranchFor(TASK_ID))).toBe(true);
  });

  it.each([
    "crew/my-feature",
    `crew/${TASK_ID}/nested`,
    `crew/${TASK_ID}-suffix`,
    `xcrew/${TASK_ID}`,
    `feature/crew/${TASK_ID}`,
    `crew/${TASK_ID.toUpperCase()}`,
    "crew/3f2b8c1e-9a4d-1e7f-b6a1-0c5d2e8f9a7b",
    "crew/",
    "",
  ])("rejects %s", (branch) => {
    expect(isCrewBranch(branch)).toBe(false);
  });

  it("rejects no branch", () => {
    expect(isCrewBranch(null)).toBe(false);
    expect(isCrewBranch(undefined)).toBe(false);
  });
});
