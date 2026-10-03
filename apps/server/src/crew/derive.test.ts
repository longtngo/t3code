import {
  OrchestrationV2RunStatus,
  type CrewRendering,
  type OrchestrationV2ShellThreadStatus,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { derive, type CrewDeriveThread } from "./derive.ts";

const OPEN = { status: "open" } as const;
const CLOSED = { status: "closed" } as const;

/** Every member of the v2 shell status: `idle` plus the run statuses. */
const ALL_STATUSES: ReadonlyArray<OrchestrationV2ShellThreadStatus> = [
  "idle",
  ...OrchestrationV2RunStatus.literals,
];

const withStatus = (status: OrchestrationV2ShellThreadStatus): CrewDeriveThread => ({ status });

/**
 * The mapping the ladder must produce, enumerated over the *input* enum.
 *
 * Asserting instead that every rendering is reachable ranges over outputs, so
 * `unknown` becoming reachable would make that property *more* satisfied. This
 * direction cannot be gamed that way: a status missing from the ladder shows up
 * as a specific wrong label.
 */
const BY_STATUS: Record<OrchestrationV2ShellThreadStatus, CrewRendering> = {
  failed: "errored",
  interrupted: "interrupted",
  cancelled: "interrupted",
  queued: "working",
  starting: "working",
  running: "working",
  waiting: "working",
  preparing: "starting",
  completed: "idle-no-report",
  rolled_back: "idle-no-report",
  idle: "idle-no-report",
};

/**
 * A ladder that forgot `completed` — the most tempting omission, because a v1 ladder had
 * no such status and a finished crewmate is the common resting state.
 */
const deriveWithoutCompleted = (thread: CrewDeriveThread): CrewRendering => {
  const partial: Partial<Record<OrchestrationV2ShellThreadStatus, CrewRendering>> = {
    ...BY_STATUS,
  };
  delete partial.completed;
  if (thread.status === null) {
    return "starting";
  }
  return partial[thread.status] ?? "unknown";
};

describe("crew derive", () => {
  it("covers every member of the real shell status enum", () => {
    // If a status is added to the contract and not to the table above, this fails
    // rather than the table silently drifting out of date.
    expect(Object.keys(BY_STATUS).sort()).toEqual([...ALL_STATUSES].sort());
  });

  it.each(Object.entries(BY_STATUS))("thread %s renders %s", (status, expected) => {
    expect(derive(OPEN, withStatus(status as OrchestrationV2ShellThreadStatus))).toBe(expected);
  });

  it("no shell renders starting", () => {
    expect(derive(OPEN, { status: null })).toBe("starting");
  });

  it("unknown is produced by no real status", () => {
    const produced = ALL_STATUSES.map((status) => derive(OPEN, withStatus(status)));
    expect(produced.filter((rendering) => rendering === "unknown")).toEqual([]);
  });

  it("DEFECT ARM: a ladder missing completed renders it unknown", () => {
    // The wrong value, asserted positively, next to the right one on the same input.
    expect(deriveWithoutCompleted(withStatus("completed"))).toBe("unknown");
    expect(derive(OPEN, withStatus("completed"))).toBe("idle-no-report");
  });

  it("a cancelled run is not a fault", () => {
    expect(derive(OPEN, withStatus("cancelled"))).not.toBe("errored");
  });

  it("closed outranks everything, including a live run", () => {
    for (const status of ALL_STATUSES) {
      expect(derive(CLOSED, withStatus(status))).toBe("closed");
    }
    expect(derive(CLOSED, { status: null, hasPendingRuntimeRequest: true })).toBe("closed");
  });

  it.each([
    ["a runtime request", { hasPendingRuntimeRequest: true }],
    ["an actionable plan", { hasActionableProposedPlan: true }],
  ])("blocking on %s outranks a fault", (_label, blocking) => {
    // Rule 1 sits above rule 2: a crewmate waiting on a human while its run also
    // failed is blocked, not errored — the human is the fix either way.
    expect(derive(OPEN, { status: "failed", ...blocking })).toBe("blocked-on-human");
    expect(derive(OPEN, { status: "running", ...blocking })).toBe("blocked-on-human");
  });

  it("blocking outranks the absent shell", () => {
    expect(derive(OPEN, { status: null, hasPendingRuntimeRequest: true })).toBe("blocked-on-human");
  });

  it("false flags do not block", () => {
    // Control: the blocking rule must key on true, not on the key being present.
    expect(
      derive(OPEN, {
        status: "running",
        hasPendingRuntimeRequest: false,
        hasActionableProposedPlan: false,
      }),
    ).toBe("working");
  });
});
