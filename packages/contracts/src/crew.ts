import * as Schema from "effect/Schema";

import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

export const CrewTaskId = TrimmedNonEmptyString.pipe(Schema.brand("CrewTaskId"));
export type CrewTaskId = typeof CrewTaskId.Type;

export const CrewReportId = TrimmedNonEmptyString.pipe(Schema.brand("CrewReportId"));
export type CrewReportId = typeof CrewReportId.Type;

/**
 * A task holds a concurrency slot for exactly as long as it is `open`. There is no
 * third state: everything a caller might want a third state for — the crewmate is
 * working, erroring, waiting on a human — is *derived* from the crew thread's live
 * session rather than stored, so it cannot go stale (design §4, "Derived renderings").
 */
export const CrewTaskStatus = Schema.Literals(["open", "closed"]);
export type CrewTaskStatus = typeof CrewTaskStatus.Type;

/**
 * `answer` is the bridge replying to a crewmate; every other state is the crewmate
 * reporting. `crew.report` refuses `answer` as an input state (§8) and the panel's
 * per-row sublabel skips `answer` rows, so the two directions share one table
 * without either being mistaken for the other.
 */
export const CrewReportState = Schema.Literals([
  "progress",
  "needs-decision",
  "done",
  "failed",
  "answer",
]);
export type CrewReportState = typeof CrewReportState.Type;

/** Reports whose state counts against {@link CREW_REPORTS_PER_TASK_LIMIT}. */
export const isCountedReportState = (state: CrewReportState): boolean => state !== "answer";

/**
 * Answers are exempt from the cap: they are the bridge's replies, not the crewmate's
 * output, and counting them would let a talkative bridge exhaust the budget its
 * crewmate needs in order to report `done`.
 */
export const CREW_REPORTS_PER_TASK_LIMIT = 200;

/** Bytes, not characters — the cap bounds what a note costs to store and to ship. */
export const CREW_REPORT_NOTE_BYTE_LIMIT = 1024;

export const CrewTask = Schema.Struct({
  taskId: CrewTaskId,
  parentThreadId: ThreadId,
  crewThreadId: ThreadId,
  projectId: ProjectId,
  baseRef: Schema.NullOr(Schema.String),
  branch: TrimmedNonEmptyString,
  worktreePath: TrimmedNonEmptyString,
  provider: ProviderDriverKind,
  status: CrewTaskStatus,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type CrewTask = typeof CrewTask.Type;

export const CrewReport = Schema.Struct({
  reportId: CrewReportId,
  taskId: CrewTaskId,
  state: CrewReportState,
  note: Schema.String,
  createdAt: Schema.String,
  /**
   * NULL until the report has been fully handled — its text is in the transcript, or
   * a wake turn was dispatched for it. That NULL *is* the delivery queue, which is
   * what makes delivery idempotent across a restart.
   */
  notedAt: Schema.NullOr(Schema.String),
  /** Set only on `answer` rows: the report this one answers. */
  replyTo: Schema.NullOr(CrewReportId),
});
export type CrewReport = typeof CrewReport.Type;

/**
 * A crewmate's branch. Set on the thread before its first run, never renamed, and kept
 * through teardown, so it marks a crewmate's thread shell on every client and every
 * environment without a crew query.
 */
export const crewBranchFor = (taskId: string): string => `crew/${taskId}`;

/**
 * Exactly `crew/<taskId>`, where a task id is the lowercase UUIDv4 `crew_dispatch` mints.
 * A user's own `crew/my-feature` does not match. The name alone is still only a marker;
 * where a crew row is reachable (the server), confirm with it.
 */
const CREW_BRANCH_PATTERN =
  /^crew\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const isCrewBranch = (branch: string | null | undefined): boolean =>
  typeof branch === "string" && CREW_BRANCH_PATTERN.test(branch);

/**
 * A thread's relation to crew. A bridge is `bridge` only while it parents an `open`
 * task; a crewmate is `crewmate` while its task is open and `crewmate-closed` after.
 */
export const CrewRole = Schema.Literals(["bridge", "crewmate", "crewmate-closed"]);
export type CrewRole = typeof CrewRole.Type;

/**
 * How a task presents in the panel. `closed` is stored; everything else is derived
 * from the crew thread's live session, so it cannot go stale (design §4).
 */
export const CrewRendering = Schema.Literals([
  "closed",
  "blocked-on-human",
  "errored",
  "interrupted",
  "working",
  "idle-no-report",
  "starting",
  "unknown",
]);
export type CrewRendering = typeof CrewRendering.Type;

/**
 * Every crew error declares its `failure:` schema **and** overrides `message`.
 *
 * Declaring alone is not enough: the MCP server returns
 * `error instanceof Error ? error.message : INTERNAL_TOOL_ERROR_MESSAGE`, and a
 * `TaggedError` with no override yields `""`. An empty string is strictly
 * worse than the generic internal error it replaces — a refused crewmate learns
 * nothing and goes on holding its slot.
 *
 * The precedent is `PreviewAutomationUnavailableError` in previewAutomation.ts.
 */

export const CrewDispatchRefusalReason = Schema.Literals([
  "disabled",
  "cap",
  "nested",
  "thread",
  "provider",
  "browser-access",
  "payload",
]);
export type CrewDispatchRefusalReason = typeof CrewDispatchRefusalReason.Type;

export class CrewDispatchRefusedError extends Schema.TaggedError<CrewDispatchRefusedError>()(
  "CrewDispatchRefusedError",
  {
    reason: CrewDispatchRefusalReason,
    /** Open task count at the moment of refusal; only meaningful for `cap`. */
    openTasks: Schema.optional(Schema.Number),
    limit: Schema.optional(Schema.Number),
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "disabled":
        return "Crew is turned off. Turn it on in Settings under General before dispatching.";
      case "cap":
        return `Crew is at its cap of ${this.limit ?? 0} concurrent tasks (${this.openTasks ?? 0} open). Tear one down with crew_teardown before dispatching another.`;
      case "nested":
        return "This thread is already a crewmate, so it cannot dispatch its own crew. Ask the thread that dispatched you.";
      case "thread":
        return `This thread cannot receive crew reports (${this.detail ?? "missing"}), so dispatching from it would strand the crewmate. Dispatch from a live, unarchived thread.`;
      case "provider":
        return "OpenCode cannot run as a crewmate yet. Choose claudeAgent, codex, cursor, or grok.";
      case "browser-access":
        return "Crew needs agent browser access, which is disabled. Enable it in Settings before dispatching.";
      case "payload":
        return "The prompt is larger than the 8 KiB crew allows. Shorten it, or point the crewmate at a file.";
    }
  }
}

export class CrewTaskNotFoundError extends Schema.TaggedError<CrewTaskNotFoundError>()(
  "CrewTaskNotFoundError",
  {
    /** Which direction the caller was checked against. */
    direction: Schema.Literals(["parent", "crew"]),
    taskId: Schema.optional(CrewTaskId),
  },
) {
  override get message(): string {
    return this.direction === "parent"
      ? `There is no open task${this.taskId === undefined ? "" : ` ${this.taskId}`} dispatched by this thread.`
      : "There is no open task for this thread, so it cannot file a crew report.";
  }
}

export class CrewAlreadyAnsweredError extends Schema.TaggedError<CrewAlreadyAnsweredError>()(
  "CrewAlreadyAnsweredError",
  { reportId: CrewReportId },
) {
  override get message(): string {
    return `Report ${this.reportId} was already answered. File a new report if there is more to say.`;
  }
}

export class CrewReportRefusedError extends Schema.TaggedError<CrewReportRefusedError>()(
  "CrewReportRefusedError",
  {
    reason: Schema.Literals(["cap", "bad-state", "note-too-large"]),
    count: Schema.optional(Schema.Number),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "cap":
        return `This task already has ${this.count ?? CREW_REPORTS_PER_TASK_LIMIT} reports, the per-task limit of ${CREW_REPORTS_PER_TASK_LIMIT}. Summarise in a final report instead.`;
      case "bad-state":
        return "The `answer` state belongs to crew_answer and cannot be written with crew_report. Use progress, needs-decision, done, or failed.";
      case "note-too-large":
        return `The note is larger than the ${CREW_REPORT_NOTE_BYTE_LIMIT}-byte limit. Summarise it, or write the detail to a file and name the path.`;
    }
  }
}

export class CrewAnswerRefusedError extends Schema.TaggedError<CrewAnswerRefusedError>()(
  "CrewAnswerRefusedError",
  { reason: Schema.Literals(["text-too-large"]) },
) {
  override get message(): string {
    return `The answer is larger than the ${CREW_REPORT_NOTE_BYTE_LIMIT}-byte limit. Shorten it, or write the detail to a file and name the path.`;
  }
}

/** Prompt bound for `crew_dispatch`. Bytes, matching the note bound. */
export const CREW_PROMPT_BYTE_LIMIT = 8 * 1024;

/** `crew_status` returns at most this many reports per task, most recent first. */
export const CREW_STATUS_ROWS_PER_TASK = 50;

/** Providers a crewmate can run on. OpenCode is Phase 2. */
export const CREW_UNSUPPORTED_PROVIDERS: ReadonlyArray<string> = ["opencode"];

export const CrewTaskView = Schema.Struct({
  taskId: CrewTaskId,
  parentThreadId: ThreadId,
  crewThreadId: ThreadId,
  projectId: ProjectId,
  branch: TrimmedNonEmptyString,
  worktreePath: TrimmedNonEmptyString,
  provider: ProviderDriverKind,
  status: CrewTaskStatus,
  rendering: CrewRendering,
  /** The last non-`answer` report's state, which the panel shows as a sublabel. */
  lastReportState: Schema.NullOr(CrewReportState),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  reports: Schema.Array(CrewReport),
});
export type CrewTaskView = typeof CrewTaskView.Type;
