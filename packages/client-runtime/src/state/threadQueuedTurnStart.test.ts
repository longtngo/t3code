import { EnvironmentId, RunId, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { presentThreadShell } from "./models.ts";
import { v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { hasQueuedTurnStart, QUEUED_TURN_START_GRACE_MS } from "./threadSettled.ts";

/**
 * `hasQueuedTurnStart` read through the v2 shell the clients actually hold: the server's
 * `OrchestrationV2ThreadShell` presented by `presentThreadShell`, never a hand-built V1 shape.
 * The fork's sidebar Queue and the snooze guard both key on it.
 */
const environmentId = EnvironmentId.make("env-1");
const MESSAGE_AT = "2026-06-20T12:00:00.000Z";
const JUST_AFTER = { now: "2026-06-20T12:00:30.000Z" };

function present(overrides: Partial<OrchestrationV2ThreadShell>) {
  return presentThreadShell(environmentId, { ...v2ThreadShell, ...overrides });
}

function at(iso: string) {
  return DateTime.makeUnsafe(iso);
}

describe("hasQueuedTurnStart on v2 shells", () => {
  it("reads a run that is queued, preparing or starting as a pending start", () => {
    const runId = RunId.make("run-2");
    const queued = present({ latestRunId: runId, status: "queued" });
    const preparing = present({
      latestRunId: runId,
      activeRunId: runId,
      status: "running",
      activityRunStatus: "preparing",
    });
    const starting = present({
      latestRunId: runId,
      activeRunId: runId,
      status: "running",
      activityRunStatus: "starting",
    });
    for (const shell of [queued, preparing, starting]) {
      expect(hasQueuedTurnStart(shell, JUST_AFTER)).toBe(true);
    }
    // A run that reached the provider is working, not pending.
    const running = present({ latestRunId: runId, activeRunId: runId, status: "running" });
    expect(hasQueuedTurnStart(running, JUST_AFTER)).toBe(false);
  });

  it("flags a message newer than the latest run, inside the grace window only", () => {
    const shell = present({
      latestRunId: RunId.make("run-1"),
      status: "completed",
      latestRunRequestedAt: at("2026-06-20T11:00:00.000Z"),
      latestRunCompletedAt: at("2026-06-20T11:05:00.000Z"),
      latestUserMessageAt: at(MESSAGE_AT),
    });
    expect(hasQueuedTurnStart(shell, JUST_AFTER)).toBe(true);
    const later = DateTime.add(at(MESSAGE_AT), { milliseconds: QUEUED_TURN_START_GRACE_MS + 1 });
    expect(hasQueuedTurnStart(shell, { now: DateTime.formatIso(later) })).toBe(false);
  });

  it("clears once the run that carries the message exists", () => {
    const adopted = present({
      latestRunId: RunId.make("run-2"),
      status: "completed",
      latestRunRequestedAt: at(MESSAGE_AT),
      latestUserMessageAt: at(MESSAGE_AT),
    });
    expect(hasQueuedTurnStart(adopted, JUST_AFTER)).toBe(false);
  });

  it("does not read a thread whose last run failed as busy", () => {
    const failed = present({
      latestRunId: RunId.make("run-1"),
      status: "failed",
      lastError: "provider exited",
      latestRunRequestedAt: at(MESSAGE_AT),
      latestUserMessageAt: at(MESSAGE_AT),
    });
    expect(hasQueuedTurnStart(failed, JUST_AFTER)).toBe(false);
  });

  it("is false for a thread that never ran", () => {
    expect(hasQueuedTurnStart(present({}), JUST_AFTER)).toBe(false);
  });
});
