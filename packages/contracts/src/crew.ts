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
 * Why a thread is exempt from the provider session reaper, and for how long.
 *
 * A bridge is `bridge` only while it parents an `open` task, or it would stay exempt
 * forever after its first dispatch. A crewmate becomes `crewmate-closed` when its
 * task closes, so the reaper is still able to stop a crewmate whose teardown failed —
 * an unscoped exemption would turn §6's stated residual into a permanent leak.
 */
export const CrewRole = Schema.Literals(["bridge", "crewmate", "crewmate-closed"]);
export type CrewRole = typeof CrewRole.Type;

/** The two roles the session reaper skips. `crewmate-closed` is deliberately absent. */
export const isReaperExemptCrewRole = (role: CrewRole | null): boolean =>
  role === "bridge" || role === "crewmate";

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
 * `TaggedErrorClass` with no override yields `""`. An empty string is strictly
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
  "disk",
  "payload",
]);
export type CrewDispatchRefusalReason = typeof CrewDispatchRefusalReason.Type;

export class CrewDispatchRefusedError extends Schema.TaggedErrorClass<CrewDispatchRefusedError>()(
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
      case "disk":
        return `Free disk space is below the bound crew needs for a worktree (${this.detail ?? "unknown"}). Free space and retry.`;
      case "payload":
        return "The prompt is larger than the 8 KiB crew allows. Shorten it, or point the crewmate at a file.";
    }
  }
}

export class CrewTaskNotFoundError extends Schema.TaggedErrorClass<CrewTaskNotFoundError>()(
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

export class CrewAlreadyAnsweredError extends Schema.TaggedErrorClass<CrewAlreadyAnsweredError>()(
  "CrewAlreadyAnsweredError",
  { reportId: CrewReportId },
) {
  override get message(): string {
    return `Report ${this.reportId} was already answered. File a new report if there is more to say.`;
  }
}

export class CrewReportRefusedError extends Schema.TaggedErrorClass<CrewReportRefusedError>()(
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

export class CrewAnswerRefusedError extends Schema.TaggedErrorClass<CrewAnswerRefusedError>()(
  "CrewAnswerRefusedError",
  { reason: Schema.Literals(["text-too-large"]) },
) {
  override get message(): string {
    return `The answer is larger than the ${CREW_REPORT_NOTE_BYTE_LIMIT}-byte limit. Shorten it, or write the detail to a file and name the path.`;
  }
}

export const CrewError = Schema.Union([
  CrewDispatchRefusedError,
  CrewTaskNotFoundError,
  CrewAlreadyAnsweredError,
  CrewReportRefusedError,
  CrewAnswerRefusedError,
]);
export type CrewError = typeof CrewError.Type;

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
