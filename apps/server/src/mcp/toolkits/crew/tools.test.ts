import {
  CREW_REPORTS_PER_TASK_LIMIT,
  CrewAlreadyAnsweredError,
  CrewAnswerRefusedError,
  CrewDispatchRefusalReason,
  CrewDispatchRefusedError,
  CrewReportId,
  CrewReportRefusedError,
  CrewTaskId,
  CrewTaskNotFoundError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { CREW_LOG_CODES } from "../../../crew/CrewLog.ts";
import {
  CrewAnswerTool,
  CrewDispatchTool,
  CrewReportTool,
  CrewStatusTool,
  CrewTeardownTool,
} from "./tools.ts";

/**
 * The MCP server returns `error instanceof Error ? error.message : <generic>`.
 * A `TaggedErrorClass` that declares its `failure:` schema without overriding
 * `message` yields `""` — strictly worse than the generic error it replaces,
 * because a refused crewmate learns nothing and goes on holding its slot.
 */
class NoOverrideError extends Schema.TaggedErrorClass<NoOverrideError>()("NoOverrideError", {
  openTasks: Schema.Number,
}) {}

describe("crew tool refusal messages", () => {
  it("DEFECT ARM: a TaggedErrorClass with no message override yields the empty string", () => {
    // The wrong value, positively. This is what every crew error would produce if
    // the overrides below were dropped.
    expect(new NoOverrideError({ openTasks: 4 }).message).toBe("");
  });

  it.each([
    [
      "crew_dispatch.cap",
      new CrewDispatchRefusedError({ reason: "cap", openTasks: 4, limit: 4 }),
      /cap of 4/,
    ],
    [
      "crew_dispatch.nested",
      new CrewDispatchRefusedError({ reason: "nested" }),
      /already a crewmate/,
    ],
    [
      "crew_dispatch.thread",
      new CrewDispatchRefusedError({ reason: "thread", detail: "archived" }),
      /archived/,
    ],
    ["crew_dispatch.provider", new CrewDispatchRefusedError({ reason: "provider" }), /OpenCode/],
    [
      "crew_dispatch.browser-access",
      new CrewDispatchRefusedError({ reason: "browser-access" }),
      /browser access/,
    ],
    [
      "crew_dispatch.disk",
      new CrewDispatchRefusedError({ reason: "disk", detail: "12 MiB free" }),
      /Free disk space/,
    ],
    ["crew_dispatch.payload", new CrewDispatchRefusedError({ reason: "payload" }), /8 KiB/],
    [
      "crew_teardown.no-row",
      new CrewTaskNotFoundError({ direction: "parent", taskId: CrewTaskId.make("task-1") }),
      /no open task/,
    ],
    ["crew_answer.no-row", new CrewTaskNotFoundError({ direction: "parent" }), /no open task/],
    [
      "crew_answer.already-answered",
      new CrewAlreadyAnsweredError({ reportId: CrewReportId.make("report-1") }),
      /already answered/,
    ],
    ["crew_report.no-row", new CrewTaskNotFoundError({ direction: "crew" }), /no open task/],
    [
      "crew_report.cap",
      new CrewReportRefusedError({ reason: "cap", count: CREW_REPORTS_PER_TASK_LIMIT }),
      /200/,
    ],
    ["crew_report.bad-state", new CrewReportRefusedError({ reason: "bad-state" }), /answer/],
    [
      "crew_report.note-too-large",
      new CrewReportRefusedError({ reason: "note-too-large" }),
      /1024-byte/,
    ],
    [
      "crew_answer.text-too-large",
      new CrewAnswerRefusedError({ reason: "text-too-large" }),
      /1024-byte/,
    ],
  ])("%s names the reason in non-empty text", (_label, error, pattern) => {
    expect(error.message).not.toBe("");
    expect(error.message).toMatch(pattern);
  });

  it("every dispatch refusal reason has its own message", () => {
    // Enumerated over the reason union, so a reason added without a `case`
    // fails here rather than falling through to an empty string at runtime.
    // Derived from the union, not restated. A hardcoded list silently exempts
    // every reason added after it was written — which is exactly what happened
    // to `disabled`, and this test stayed green while blind to it.
    const reasons = CrewDispatchRefusalReason.literals;
    const messages = reasons.map((reason) => new CrewDispatchRefusedError({ reason }).message);
    // A reason with no `case` falls out of the switch as `undefined`, not `""`.
    // Asserting only on `""` is what let a caseless literal through a test whose
    // whole purpose was to catch one — measured, not assumed.
    expect(messages.filter((message) => typeof message !== "string" || message === "")).toEqual([]);
    expect(new Set(messages).size).toBe(reasons.length);
  });
});

describe("crew tool schemas", () => {
  it("no tool takes a thread id, project id, or task ownership from its caller", () => {
    // Authority is keyed on `McpInvocationContext.threadId`. A schema that
    // accepted a thread id would let a crewmate name someone else's thread, and
    // no amount of checking downstream could tell the two apart.
    const parameterKeys = [
      CrewDispatchTool,
      CrewStatusTool,
      CrewTeardownTool,
      CrewAnswerTool,
      CrewReportTool,
    ].flatMap((tool) => Object.keys((tool.parametersSchema as { fields: object }).fields));

    // Control: the introspection has to be reading real fields, or every
    // assertion below is vacuously true against an empty list.
    expect(parameterKeys).toEqual(
      expect.arrayContaining(["prompt", "unreadOnly", "taskId", "reportId", "state", "note"]),
    );

    expect(parameterKeys).not.toContain("threadId");
    expect(parameterKeys).not.toContain("projectId");
    expect(parameterKeys).not.toContain("parentThreadId");
    expect(parameterKeys).not.toContain("crewThreadId");
  });

  it("crew_status refuses never", () => {
    // §8's table has `never` in the refusal column for this one tool, and the
    // observability code set has no `crew.tool.refused.crew_status.*` entry.
    const statusCodes = CREW_LOG_CODES.filter((code) => code.includes("crew_status"));
    expect(statusCodes).toEqual(["crew.tool.invoked.crew_status"]);
  });

  it("the refusal codes are six literals, not a tool x reason cross product", () => {
    // Enumerating <tool> x <reason> yields 20 codes of which authority can
    // produce 6, and the correspondence test then fails on the 14 no path emits.
    const refusals = CREW_LOG_CODES.filter((code) => code.startsWith("crew.tool.refused."));
    expect(refusals).toEqual([
      "crew.tool.refused.crew_teardown.no-row",
      "crew.tool.refused.crew_answer.no-row",
      "crew.tool.refused.crew_answer.already-answered",
      "crew.tool.refused.crew_report.no-row",
      "crew.tool.refused.crew_report.cap",
      "crew.tool.refused.crew_report.bad-state",
    ]);
  });

  it("every tool has an invoked code", () => {
    for (const tool of [
      "crew_dispatch",
      "crew_status",
      "crew_teardown",
      "crew_answer",
      "crew_report",
    ]) {
      expect(CREW_LOG_CODES).toContain(`crew.tool.invoked.${tool}`);
    }
  });
});
