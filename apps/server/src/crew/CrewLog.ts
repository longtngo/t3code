/**
 * The crew log: crew's own closed set of record codes, written through the
 * server's logger.
 *
 * `CrewLogLive` calls `Effect.logInfo` and annotates each line with
 * `crewLogCode`, so records land wherever `serverLogger.ts` sends everything
 * else — `Logger.consolePretty()` plus the tracer. There is no separate crew
 * file, no crew directory, and no crew retention sweep. "Durable" here means
 * only as durable as whatever supervises the server and captures its output.
 * A dedicated store is a Phase 2 question with its own design; do not read this
 * module as evidence that one exists.
 *
 * Codes are a closed set (see `CrewLogCode`), not a cross product of tool ×
 * reason. The cross product yields 20 codes of which authority can produce 6,
 * and the correspondence test then fails on the 14 that no path emits.
 *
 * Allowed fields, positively: taskId, threadId, reportId, state, counts,
 * durations, byte counts, reason codes. Never `prompt`, `note`, `text`, wake
 * payload text, or raw git stdio. The branch is `crew/<taskId>`, so nothing
 * derived from a prompt reaches a path, the panel, or a line here.
 *
 * @module crew/CrewLog
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * Every code crew can emit, enumerated. The cross-reference gate compares this
 * set against the design's §9 list, so a code added here without a spec entry —
 * or promised there and never emitted — fails `pnpm verify`.
 */
export const CREW_LOG_CODES = [
  "crew.dispatch.refused.cap",
  "crew.dispatch.refused.nested",
  "crew.dispatch.refused.thread",
  "crew.dispatch.refused.provider",
  "crew.dispatch.refused.browser-access",
  "crew.dispatch.refused.disk",
  "crew.dispatch.refused.payload",
  "crew.dispatch.compensate.skipped",
  "crew.deliver.deferred.thread",
  "crew.deliver.deferred.no-session",
  "crew.deliver.deferred.busy",
  "crew.deliver.no-turn",
  "crew.deliver.abandoned",
  "crew.answer.deferred.thread",
  "crew.answer.deferred.busy",
  "crew.tool.refused.crew_teardown.no-row",
  "crew.tool.refused.crew_answer.no-row",
  "crew.tool.refused.crew_answer.already-answered",
  "crew.tool.refused.crew_report.no-row",
  "crew.tool.refused.crew_report.cap",
  "crew.tool.refused.crew_report.bad-state",
  "crew.notification.suppressed.web-push",
  "crew.notification.suppressed.agent-awareness",
  "crew.notification.suppressed.web",
  "crew.tool.invoked.crew_dispatch",
  "crew.tool.invoked.crew_status",
  "crew.tool.invoked.crew_teardown",
  "crew.tool.invoked.crew_answer",
  "crew.tool.invoked.crew_report",
  "crew.teardown.step-failed.1",
  "crew.teardown.step-failed.2",
  "crew.teardown.step-failed.3",
  "crew.teardown.step-failed.4",
  "crew.teardown.step-failed.5",
  "crew.teardown.step-failed.6",
  "crew.teardown.step-failed.7",
  "crew.zombie.stopped",
  "crew.sweep.zombie-scan-failed",
  "crew.reap.orphan",
] as const;

export type CrewLogCode = (typeof CREW_LOG_CODES)[number];

/** Fields a crew log line may carry. Deliberately no free-text field. */
export interface CrewLogFields {
  readonly taskId?: string;
  readonly threadId?: string;
  readonly destinationThreadId?: string;
  readonly reportId?: string;
  readonly state?: string;
  readonly reason?: string;
  readonly count?: number;
  readonly limit?: number;
  readonly attempt?: number;
  readonly durationMs?: number;
  readonly byteCount?: number;
  readonly step?: number;
}

export interface CrewLogShape {
  readonly record: (code: CrewLogCode, fields?: CrewLogFields) => Effect.Effect<void>;
}

export class CrewLog extends Context.Service<CrewLog, CrewLogShape>()("t3/crew/CrewLog") {}

/**
 * Writes through Effect's logger, which `serverLogger.ts` routes to the console
 * logger and the tracer. Tests substitute a capturing layer.
 */
export const CrewLogLive = Layer.succeed(CrewLog, {
  record: (code, fields) =>
    Effect.logInfo(code, { ...fields, crew: true, code }).pipe(
      Effect.annotateLogs("crewLogCode", code),
    ),
});

/** Collects records in memory. Used by tests and by the acceptance harness. */
export const makeRecordingCrewLog = () => {
  const records: Array<{ readonly code: CrewLogCode; readonly fields: CrewLogFields }> = [];
  const layer = Layer.succeed(CrewLog, {
    record: (code, fields) => Effect.sync(() => void records.push({ code, fields: fields ?? {} })),
  });
  return { records, layer };
};
