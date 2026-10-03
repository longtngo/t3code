/**
 * The five crew MCP tools.
 *
 * A thin schema-and-description layer: every authority check lives in
 * `CrewService`, keyed on `McpInvocationContext.threadId`, which is
 * server-resolved and deliberately absent from every schema below. `projectId` is
 * resolved from the calling thread and never supplied, which is why there is no
 * cross-project refusal — there is no cross-project input.
 *
 * There is no `McpCapability` gate. It would be circular: a thread becomes a
 * bridge by calling the very tool the capability would gate. Widening
 * `McpCapability` also breaks `requireMcpCapability`, whose error type pins
 * `Schema.Literal("preview")` and travels on an RPC error union.
 *
 * @module mcp/toolkits/crew/tools
 */
import {
  CREW_PROMPT_BYTE_LIMIT,
  CREW_REPORT_NOTE_BYTE_LIMIT,
  CREW_STATUS_ROWS_PER_TASK,
  CrewAlreadyAnsweredError,
  CrewAnswerRefusedError,
  CrewDispatchRefusedError,
  CrewReportId,
  CrewReportRefusedError,
  CrewTaskId,
  CrewTaskNotFoundError,
  CrewTaskView,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import { CrewService } from "../../../crew/CrewService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, CrewService];

const CrewDispatchInput = Schema.Struct({
  prompt: Schema.String.annotate({
    description: `What the crewmate should do, in full. At most ${CREW_PROMPT_BYTE_LIMIT} bytes; point at a file for anything longer.`,
  }),
  baseRef: Schema.optional(
    Schema.String.annotate({
      description: "Ref the crewmate's worktree branches from. Defaults to the project's HEAD.",
    }),
  ),
  provider: Schema.optional(
    Schema.String.annotate({
      description:
        "Provider instance for the crewmate. Defaults to this thread's. OpenCode is not supported yet.",
    }),
  ),
});

const CrewDispatchResult = Schema.Struct({
  taskId: CrewTaskId,
  crewThreadId: Schema.String,
  branch: Schema.String,
  worktreePath: Schema.String,
});

const CrewStatusInput = Schema.Struct({
  unreadOnly: Schema.optional(
    Schema.Boolean.annotate({
      description: "Return only reports that have not been delivered yet.",
    }),
  ),
  limit: Schema.optional(
    Schema.Int.annotate({
      description: `Reports per task, most recent first. Capped at ${CREW_STATUS_ROWS_PER_TASK}.`,
    }),
  ),
});

const CrewStatusResult = Schema.Struct({ tasks: Schema.Array(CrewTaskView) });

const CrewTeardownInput = Schema.Struct({
  taskId: CrewTaskId.annotate({ description: "The task to close and clean up." }),
});

const CrewAnswerInput = Schema.Struct({
  reportId: CrewReportId.annotate({ description: "The report being answered." }),
  text: Schema.String.annotate({
    description: `The answer, at most ${CREW_REPORT_NOTE_BYTE_LIMIT} bytes.`,
  }),
});

const CrewReportInput = Schema.Struct({
  state: Schema.Literals(["progress", "needs-decision", "done", "failed"]).annotate({
    description:
      "progress for an update that needs no reply; needs-decision when you are blocked on a human; done or failed when the task is over.",
  }),
  note: Schema.String.annotate({
    description: `What to tell the thread that dispatched you, at most ${CREW_REPORT_NOTE_BYTE_LIMIT} bytes.`,
  }),
});

const CrewReportResult = Schema.Struct({ reportId: CrewReportId });

const CrewAck = Schema.Record(Schema.String, Schema.Never).annotate({
  description: "The crew action completed.",
});

export const CrewDispatchTool = Tool.make("crew_dispatch", {
  description:
    "Dispatch a crewmate into its own git worktree to work on a task in parallel. It reports back with crew_report; you read those with crew_status and close it with crew_teardown.",
  parameters: CrewDispatchInput,
  success: CrewDispatchResult,
  failure: CrewDispatchRefusedError,
  dependencies,
})
  .annotate(Tool.Title, "Dispatch a crewmate")
  .annotate(Tool.Destructive, false);

export const CrewStatusTool = Tool.make("crew_status", {
  description:
    "List your crew: the tasks you dispatched and their reports, or — if you are a crewmate — your own task and the answers addressed to you.",
  parameters: CrewStatusInput,
  success: CrewStatusResult,
  failure: Schema.Never,
  dependencies,
})
  .annotate(Tool.Title, "Read crew status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const CrewTeardownTool = Tool.make("crew_teardown", {
  description:
    "Close a task you dispatched and clean up after its crewmate. Frees the slot. The worktree and branch are left on disk for you to inspect.",
  parameters: CrewTeardownInput,
  success: CrewAck,
  failure: CrewTaskNotFoundError,
  dependencies,
}).annotate(Tool.Title, "Tear down a crew task");

export const CrewAnswerTool = Tool.make("crew_answer", {
  description:
    "Answer a crewmate's needs-decision report. Queues the answer; the crewmate receives it on its next turn.",
  parameters: CrewAnswerInput,
  success: CrewReportResult,
  failure: Schema.Union([CrewTaskNotFoundError, CrewAlreadyAnsweredError, CrewAnswerRefusedError]),
  dependencies,
})
  .annotate(Tool.Title, "Answer a crew report")
  .annotate(Tool.Destructive, false);

export const CrewReportTool = Tool.make("crew_report", {
  description:
    "Report back to the thread that dispatched you. Use needs-decision when you are blocked on a human, and done or failed when your task is over.",
  parameters: CrewReportInput,
  success: CrewReportResult,
  failure: Schema.Union([CrewTaskNotFoundError, CrewReportRefusedError]),
  dependencies,
})
  .annotate(Tool.Title, "File a crew report")
  .annotate(Tool.Destructive, false);

export const CrewToolkit = Toolkit.make(
  CrewDispatchTool,
  CrewStatusTool,
  CrewTeardownTool,
  CrewAnswerTool,
  CrewReportTool,
);
