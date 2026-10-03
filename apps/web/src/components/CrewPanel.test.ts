import { describe, expect, it } from "vite-plus/test";

import { CrewReportId } from "@t3tools/contracts";
import type { CrewReport, CrewRendering, CrewTaskView } from "@t3tools/contracts";

import { crewActions, plainNote, unansweredDecision, unreadCount } from "./CrewPanel";

let tick = 0;
const report = (overrides: Partial<CrewReport> = {}): CrewReport => {
  tick += 1;
  return {
    reportId: CrewReportId.make(`report-${tick}`),
    taskId: "task-1",
    state: "progress",
    note: `note ${tick}`,
    createdAt: `2026-09-02T00:00:0${tick % 10}.000Z`,
    notedAt: null,
    replyTo: null,
    ...overrides,
  } as CrewReport;
};

const task = (overrides: Partial<CrewTaskView> = {}): CrewTaskView =>
  ({
    taskId: "task-1",
    parentThreadId: "bridge-1",
    crewThreadId: "crew-1",
    projectId: "project-1",
    branch: "crew/task-1",
    worktreePath: "/tmp/crew-task-1",
    provider: "claudeAgent",
    status: "open",
    rendering: "working",
    lastReportState: null,
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    reports: [],
    ...overrides,
  }) as CrewTaskView;

describe("crew action availability", () => {
  it.each([
    ["open + unanswered decision", "open", "blocked-on-human", true, true, false, false],
    ["open + no decision", "open", "working", false, true, false, false],
    ["closed + idle", "closed", "closed", false, false, true, false],
    ["closed + still running", "closed", "working", false, false, true, true],
  ] as const)(
    "%s",
    (_label, status, rendering, answer, teardown, forgetWorktree, rerunTeardown) => {
      const reports =
        answer || status === "open"
          ? [report({ state: "needs-decision", reportId: CrewReportId.make("decision-1") })]
          : [];
      const actions = crewActions(
        task({
          status: status as CrewTaskView["status"],
          rendering: rendering as CrewRendering,
          reports: answer ? reports : [],
        }),
      );

      expect(actions.answer).toBe(answer);
      expect(actions.teardown).toBe(teardown);
      expect(actions.forgetWorktree).toBe(forgetWorktree);
      expect(actions.rerunTeardown).toBe(rerunTeardown);
      // Navigation is always available, including for a task whose bridge is gone.
      expect(actions.openThread).toBe(true);
    },
  );

  it("Teardown and Forget worktree are never both offered", () => {
    // Forget worktree on an open task disables the worktree recreate while the
    // session keeps resuming into a cwd that is gone: every later turn fails as
    // "session not found", the slot stays held, and no rendering explains why.
    for (const status of ["open", "closed"] as const) {
      const actions = crewActions(task({ status, rendering: "idle-no-report" }));
      expect(actions.teardown && actions.forgetWorktree).toBe(false);
    }
  });

  it("Re-run teardown is offered only on a closed row whose thread is alive", () => {
    // Teardown is open-only, so without this the zombie budget is the only thing
    // that can stop a live bypassPermissions agent.
    expect(crewActions(task({ status: "closed", rendering: "working" })).rerunTeardown).toBe(true);
    expect(crewActions(task({ status: "closed", rendering: "closed" })).rerunTeardown).toBe(false);
    expect(crewActions(task({ status: "open", rendering: "working" })).rerunTeardown).toBe(false);
  });
});

describe("unansweredDecision", () => {
  it("skips a decision that already has an answer", () => {
    const decision = report({ state: "needs-decision", reportId: CrewReportId.make("decision-1") });
    const answer = report({ state: "answer", replyTo: CrewReportId.make("decision-1") });
    expect(unansweredDecision(task({ reports: [decision] }))?.reportId).toBe("decision-1");
    expect(unansweredDecision(task({ reports: [decision, answer] }))).toBeUndefined();
  });

  it("ignores progress and done reports", () => {
    const reports = [report({ state: "progress" }), report({ state: "done" })];
    expect(unansweredDecision(task({ reports }))).toBeUndefined();
  });
});

describe("unreadCount", () => {
  it("counts only rows the sweep has not stamped", () => {
    const reports = [
      report({ notedAt: null }),
      report({ notedAt: "2026-09-02T00:01:00.000Z" }),
      report({ notedAt: null }),
    ];
    expect(unreadCount(task({ reports }))).toBe(2);
  });
});

describe("plainNote", () => {
  it("collapses whitespace and clamps", () => {
    expect(plainNote("a\n\n  b  ")).toBe("a b");
    const long = "x".repeat(500);
    expect(plainNote(long).length).toBe(241);
    expect(plainNote(long).endsWith("…")).toBe(true);
  });

  it("does not interpret markdown or links", () => {
    // Crewmate text renders plain. Not because of dangerouslySetInnerHTML —
    // ChatMarkdown pairs rehypeRaw with rehypeSanitize — but because that
    // sanitize schema extends `protocols` with "file" for href and src.
    const hostile = "[click](file:///etc/passwd) ![img](file:///secret.png)";
    expect(plainNote(hostile)).toBe(hostile);
  });
});
