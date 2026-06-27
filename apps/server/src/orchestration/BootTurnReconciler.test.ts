import {
  type OrchestrationSessionStatus,
  type OrchestrationThreadShell,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { planBootReconciliation } from "./BootTurnReconciler.ts";

const NOW = "2026-06-23T12:00:00.000Z";

const shell = (
  id: string,
  sessionStatus: OrchestrationSessionStatus | null,
  activeTurnId: string | null = null,
): OrchestrationThreadShell =>
  ({
    id: ThreadId.make(id),
    session:
      sessionStatus === null
        ? null
        : {
            threadId: ThreadId.make(id),
            status: sessionStatus,
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: activeTurnId === null ? null : TurnId.make(activeTurnId),
            lastError: null,
            updatedAt: NOW,
          },
  }) as unknown as OrchestrationThreadShell;

describe("planBootReconciliation", () => {
  it("clears each live-status session to stopped with activeTurnId null", () => {
    const commands = planBootReconciliation([shell("t1", "running")], NOW);
    const setCmd = commands.find((c) => c.type === "thread.session.set");
    expect(setCmd).toBeDefined();
    if (setCmd?.type === "thread.session.set") {
      expect(setCmd.session.status).toBe("stopped");
      expect(setCmd.session.activeTurnId).toBeNull();
      expect(setCmd.session.providerName).toBe("claudeAgent");
      expect(setCmd.threadId).toBe("t1");
    }
  });

  it("interrupts the active turn when one was running", () => {
    const commands = planBootReconciliation([shell("t1", "running", "turn-1")], NOW);
    const interrupt = commands.find((c) => c.type === "thread.turn.interrupt");
    expect(interrupt).toBeDefined();
    if (interrupt?.type === "thread.turn.interrupt") {
      expect(interrupt.turnId).toBe("turn-1");
      expect(interrupt.threadId).toBe("t1");
    }
  });

  it("emits no interrupt when there is no active turn", () => {
    const commands = planBootReconciliation([shell("t1", "ready", null)], NOW);
    expect(commands.some((c) => c.type === "thread.turn.interrupt")).toBe(false);
    expect(commands.some((c) => c.type === "thread.session.set")).toBe(true);
  });

  it("reconciles every live status (idle/starting/running/ready)", () => {
    const live: OrchestrationSessionStatus[] = ["idle", "starting", "running", "ready"];
    const commands = planBootReconciliation(
      live.map((s, i) => shell(`t${i}`, s)),
      NOW,
    );
    expect(commands.filter((c) => c.type === "thread.session.set")).toHaveLength(live.length);
  });

  it("ignores already-resting sessions (stopped/error/interrupted) and missing sessions", () => {
    const resting: Array<OrchestrationSessionStatus | null> = [
      "stopped",
      "error",
      "interrupted",
      null,
    ];
    const commands = planBootReconciliation(
      resting.map((s, i) => shell(`t${i}`, s)),
      NOW,
    );
    expect(commands).toHaveLength(0);
  });

  it("uses the provided timestamp for createdAt and updatedAt", () => {
    const commands = planBootReconciliation([shell("t1", "running", "turn-1")], NOW);
    for (const command of commands) {
      expect(command.createdAt).toBe(NOW);
    }
  });
});
