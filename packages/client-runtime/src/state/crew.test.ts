import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { crewRolesByThread } from "./crew.ts";

const task = (parent: string, crew: string, status: "open" | "closed") => ({
  parentThreadId: ThreadId.make(parent),
  crewThreadId: ThreadId.make(crew),
  status,
});

describe("crewRolesByThread", () => {
  it("names bridges of open tasks and crewmates of open and closed tasks", () => {
    const roles = crewRolesByThread([
      task("bridge-a", "crew-1", "open"),
      task("bridge-b", "crew-2", "closed"),
      task("crew-1", "crew-3", "open"),
    ]);
    expect(Object.fromEntries(roles)).toEqual({
      "bridge-a": "bridge",
      "crew-1": "crewmate",
      "crew-2": "crewmate-closed",
      "crew-3": "crewmate",
    });
    // A bridge whose only task closed is an ordinary thread again.
    expect(roles.has("bridge-b")).toBe(false);
  });
});
