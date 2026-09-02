import { OrchestrationSessionStatus, type CrewRendering } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { derive, type CrewDeriveThread } from "./derive.ts";

const OPEN = { status: "open" } as const;
const CLOSED = { status: "closed" } as const;

const withStatus = (status: OrchestrationSessionStatus): CrewDeriveThread => ({
  session: { status },
});

/**
 * The mapping the ladder must produce, enumerated over the *input* enum.
 *
 * Asserting instead that every rendering is reachable ranges over outputs, so
 * `unknown` becoming reachable would make that property *more* satisfied. This
 * direction cannot be gamed that way: a status missing from the ladder shows up
 * as a specific wrong label.
 */
const BY_STATUS: Record<OrchestrationSessionStatus, CrewRendering> = {
  error: "errored",
  interrupted: "interrupted",
  running: "working",
  starting: "working",
  ready: "idle-no-report",
  idle: "idle-no-report",
  stopped: "idle-no-report",
};

/**
 * A ladder that forgot `stopped` — the single most tempting omission, because
 * `stopped` reads like a fault and is not one.
 */
const deriveWithoutStopped = (thread: CrewDeriveThread): CrewRendering => {
  const partial: Partial<Record<OrchestrationSessionStatus, CrewRendering>> = {
    error: "errored",
    interrupted: "interrupted",
    running: "working",
    starting: "working",
    ready: "idle-no-report",
    idle: "idle-no-report",
  };
  if (thread.session === null) {
    return "starting";
  }
  return partial[thread.session.status] ?? "unknown";
};

describe("crew derive", () => {
  it("covers every member of the real session enum", () => {
    // If a status is added to the contract and not to the table above, this fails
    // rather than the table silently drifting out of date.
    expect(Object.keys(BY_STATUS).sort()).toEqual([...OrchestrationSessionStatus.literals].sort());
  });

  for (const [status, expected] of Object.entries(BY_STATUS)) {
    it(`session ${status} renders ${expected}`, () => {
      expect(derive(OPEN, withStatus(status as OrchestrationSessionStatus))).toBe(expected);
    });
  }

  it("no session record renders starting, covering the whole setup window", () => {
    expect(derive(OPEN, { session: null })).toBe("starting");
  });

  it("unknown is produced by no real status", () => {
    const produced = OrchestrationSessionStatus.literals.map((status) =>
      derive(OPEN, withStatus(status)),
    );
    expect(produced.filter((rendering) => rendering === "unknown")).toEqual([]);
  });

  it("DEFECT ARM: a ladder missing stopped renders it unknown", () => {
    // The wrong value, asserted positively. `stopped` is what boot reconciliation
    // rewrites every live session to, so this defect would mislabel the entire
    // fleet after a restart.
    expect(deriveWithoutStopped(withStatus("stopped"))).toBe("unknown");
    expect(derive(OPEN, withStatus("stopped"))).toBe("idle-no-report");
  });

  it("stopped is not a fault", () => {
    // Guards the specific regression: treating it as one renders the fleet
    // `interrupted` after every restart.
    expect(derive(OPEN, withStatus("stopped"))).not.toBe("interrupted");
    expect(derive(OPEN, withStatus("stopped"))).not.toBe("errored");
  });

  it("closed outranks everything, including a live session", () => {
    for (const status of OrchestrationSessionStatus.literals) {
      expect(derive(CLOSED, withStatus(status))).toBe("closed");
    }
    expect(derive(CLOSED, { session: null, hasPendingApprovals: true })).toBe("closed");
  });

  it.each([
    ["approvals", { hasPendingApprovals: true }],
    ["user input", { hasPendingUserInput: true }],
    ["an actionable plan", { hasActionableProposedPlan: true }],
  ])("blocking on %s outranks a fault", (_label, blocking) => {
    // Rule 1 sits above rule 2: a crewmate waiting on a human while its session
    // also reports `error` is blocked, not errored — the human is the fix either
    // way, and the panel must say so.
    expect(derive(OPEN, { session: { status: "error" }, ...blocking })).toBe("blocked-on-human");
    expect(derive(OPEN, { session: { status: "running" }, ...blocking })).toBe("blocked-on-human");
  });

  it("blocking outranks the absent session record", () => {
    expect(derive(OPEN, { session: null, hasPendingUserInput: true })).toBe("blocked-on-human");
  });

  it("false flags do not block", () => {
    // Control: the blocking rule must key on true, not on the key being present.
    expect(
      derive(OPEN, {
        session: { status: "running" },
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
      }),
    ).toBe("working");
  });
});
