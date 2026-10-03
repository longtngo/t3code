/**
 * The delivery sweep: gets a crewmate's report to the bridge, and the bridge's answer to
 * the crewmate, as ordinary v2 messages.
 *
 * On `personal` this guarded turn starts itself (busy, pending turn-start, a per-pass woken
 * set) and placed `progress` text into a live Claude session with `appendSessionNote`. V2's
 * server-native queue makes all of that upstream's job: a message sent with mode `queue`
 * starts a run on an idle thread and waits behind active work on a busy one, durably, and
 * `steer` places text into a run already in progress without starting a turn. So per pass
 * and per destination thread:
 *
 *  - any report that must be read (`needs-decision`, `done`, `failed`, `answer`) → ONE
 *    `queue` message carrying every unnoted report for that destination;
 *  - only `progress` reports → ONE `steer` message if the destination has a steerable run
 *    (no turn started, `crew.deliver.no-turn`), otherwise nothing: the rows stay unnoted
 *    and ride the next message to that thread, and `crew_status` and the panel show them.
 *
 * `notedAt` is stamped only after the send was accepted, so an undelivered row is
 * re-selected next pass. The command and message ids derive from the report ids in the
 * message, so a retry of the same set replays its receipt instead of sending twice.
 *
 * Runs every 60s; `runOnce` is also the seam the tests drive directly.
 *
 * @module crew/CrewSweep
 */
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  MessageId,
  ThreadId,
  type CrewReport,
  type CrewTask,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import {
  ThreadManagementNoSteerableRunError,
  ThreadManagementService,
} from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { CrewLog } from "./CrewLog.ts";
import { CrewRepository } from "./CrewRepository.ts";
import { boundNoteBytes, crewEnabled, destinationOf, requiresTurn } from "./CrewPolicy.ts";
import { deliverabilityOf } from "./CrewService.ts";

export const CREW_SWEEP_INTERVAL_MS = 60_000;

/**
 * Bytes of report text one delivery message quotes. Each note is already bounded to
 * 1 KiB at insert; past this, further reports are named rather than quoted and the
 * destination reads them with `crew_status`.
 */
export const CREW_DELIVERY_QUOTED_BYTE_LIMIT = 8 * 1024;

export interface CrewSweepShape {
  /** Runs one delivery pass. The 60s schedule is its only production caller. */
  readonly runOnce: () => Effect.Effect<void>;
  /** Closes `open` rows whose crew thread is gone. Boot only; see `start`. */
  readonly reapOrphans: () => Effect.Effect<void>;
  /** Reaps once, then forks the 60s loop into the caller's scope, after activation. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class CrewSweep extends Context.Service<CrewSweep, CrewSweepShape>()("t3/crew/CrewSweep") {}

const isNoSteerableRun = Schema.is(ThreadManagementNoSteerableRunError);

/** One line per report, quoted until the byte budget is spent, then named. */
export function renderDelivery(
  rows: ReadonlyArray<{ readonly report: CrewReport; readonly task: CrewTask }>,
): string {
  const encoder = new TextEncoder();
  const lines: Array<string> = [];
  let spent = 0;
  let unquoted = 0;
  for (const { report, task } of rows) {
    const label =
      report.state === "answer"
        ? `Crew answer to report ${report.replyTo ?? "?"}`
        : `Crew report (${report.state}) from task ${task.taskId}, report ${report.reportId}`;
    const line = `${label}:\n${boundNoteBytes(report.note, 1024)}`;
    const cost = encoder.encode(line).length;
    if (spent + cost > CREW_DELIVERY_QUOTED_BYTE_LIMIT) {
      unquoted += 1;
      continue;
    }
    spent += cost;
    lines.push(line);
  }
  if (unquoted > 0) {
    lines.push(
      `…and ${unquoted} more crew ${unquoted === 1 ? "report" : "reports"}. Read them with crew_status.`,
    );
  }
  return lines.join("\n\n");
}

/** Stable for a given set of reports, so a retried send replays instead of repeating. */
const deliveryKey = (reportIds: ReadonlyArray<string>) =>
  NodeCrypto.createHash("sha256").update(reportIds.join("\n")).digest("hex").slice(0, 32);

const makeCrewSweep = Effect.gen(function* () {
  const repository = yield* CrewRepository;
  const threads = yield* ThreadManagementService;
  const crewLog = yield* CrewLog;
  const serverSettings = yield* ServerSettingsService;
  const bootIso = DateTime.formatIso(yield* DateTime.now);

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const shellOf = (threadId: ThreadId) =>
    threads.getThreadShell(threadId).pipe(Effect.catchCause(() => Effect.succeed(null)));

  /**
   * Destinations whose last send failed. A failure is logged once per unbroken run, not
   * once per pass: a destination that keeps refusing would otherwise write 1,440 identical
   * lines a day.
   */
  const failingDestinations = new Set<string>();

  const stampAll = (reports: ReadonlyArray<CrewReport>) =>
    Effect.forEach(
      reports,
      (report) =>
        Effect.gen(function* () {
          yield* repository
            .stampNoted({ reportId: report.reportId, notedAt: yield* nowIso })
            .pipe(Effect.catchCause(() => Effect.succeed(false)));
        }),
      { discard: true },
    );

  const abandon = (report: CrewReport, reason: string) =>
    Effect.gen(function* () {
      yield* stampAll([report]);
      yield* crewLog.record("crew.deliver.abandoned", {
        reportId: report.reportId,
        taskId: report.taskId,
        state: report.state,
        reason,
      });
    });

  const deliverTo = (
    destination: ThreadId,
    shell: OrchestrationV2ThreadShell,
    rows: ReadonlyArray<{ readonly report: CrewReport; readonly task: CrewTask }>,
  ) =>
    Effect.gen(function* () {
      const needsTurn = rows.some(({ report }) => requiresTurn(report.state));
      const reportIds = rows.map(({ report }) => report.reportId);
      const key = deliveryKey(reportIds);
      const senders = new Set(
        rows.map(({ report, task }) =>
          report.state === "answer" ? task.parentThreadId : task.crewThreadId,
        ),
      );
      const sent = yield* Effect.result(
        threads.sendToThread({
          projectId: shell.projectId,
          commandId: CommandId.make(`crew:deliver:${key}`),
          threadId: destination,
          messageId: MessageId.make(`crew:deliver:${key}`),
          text: renderDelivery(rows),
          attachments: [],
          mode: needsTurn ? "queue" : "steer",
          ...(senders.size === 1 ? { senderThreadId: [...senders][0]! } : {}),
          createdBy: "agent",
          creationSource: "server",
        }),
      );

      if (sent._tag === "Success") {
        failingDestinations.delete(destination);
        yield* stampAll(rows.map(({ report }) => report));
        if (!needsTurn) {
          yield* Effect.forEach(
            rows,
            ({ report }) =>
              crewLog.record("crew.deliver.no-turn", {
                taskId: report.taskId,
                reportId: report.reportId,
                destinationThreadId: destination,
                state: report.state,
              }),
            { discard: true },
          );
        }
        return;
      }

      // Positively classified: only "no run to steer" on a progress-only send means
      // "not now". Every other failure is a failed delivery, retried next pass.
      if (!needsTurn && isNoSteerableRun(sent.failure)) {
        return;
      }
      if (!failingDestinations.has(destination)) {
        failingDestinations.add(destination);
        yield* crewLog.record("crew.deliver.failed", {
          destinationThreadId: destination,
          count: rows.length,
          reason: sent.failure._tag,
        });
      }
    });

  const runOnce: CrewSweepShape["runOnce"] = () =>
    Effect.gen(function* () {
      // Per pass, not at start-up, so turning crew off takes effect within one cycle.
      const enabled = yield* serverSettings.getRawSettings.pipe(
        Effect.map(crewEnabled),
        Effect.catchCause(() => Effect.succeed(false)),
      );

      const unnoted = yield* repository
        .selectUnnoted()
        .pipe(Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<CrewReport>)));

      // While off the sweep still delivers answers, and only answers: an answer frees a
      // crewmate already blocked holding a slot, and the panel offers no retry once the
      // row is written. Everything else starts work on the operator's own thread; it
      // stays unnoted and delivers when crew is turned back on.
      const reports = enabled ? unnoted : unnoted.filter((report) => report.state === "answer");
      if (reports.length === 0) {
        return;
      }

      const tasks = yield* repository
        .listAllTasks()
        .pipe(Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<CrewTask>)));
      const taskById = new Map(tasks.map((task) => [task.taskId, task]));

      // Grouped by DESTINATION, not by bridge: an answer and a report on the same task
      // go to two different threads, and keying on the bridge would send the answer to
      // the bridge while the crewmate stays blocked.
      const byDestination = new Map<
        string,
        Array<{ readonly report: CrewReport; readonly task: CrewTask }>
      >();
      for (const report of reports) {
        const task = taskById.get(report.taskId);
        if (task === undefined) {
          yield* abandon(report, "missing-task");
          continue;
        }
        const destination = destinationOf(report, task);
        byDestination.set(destination, [
          ...(byDestination.get(destination) ?? []),
          { report, task },
        ]);
      }

      for (const [destinationId, rows] of byDestination) {
        const destination = ThreadId.make(destinationId);
        const shell = yield* shellOf(destination);
        const deliverable = deliverabilityOf(shell);
        // Every undeliverable reason terminates the row on the first pass; nothing in
        // the schema can count passes, so there is no grace period.
        if (shell === null || !deliverable.ok) {
          yield* Effect.forEach(
            rows,
            ({ report }) => abandon(report, deliverable.ok ? "missing" : deliverable.detail),
            { discard: true },
          );
          continue;
        }
        yield* deliverTo(destination, shell, rows);
      }
    });

  const reapOrphans: CrewSweepShape["reapOrphans"] = () =>
    Effect.gen(function* () {
      const open = yield* repository
        .listOpenTasks()
        .pipe(Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<CrewTask>)));
      for (const task of open) {
        // Only rows that predate this process: a dispatch in flight has reserved its row
        // before the launch creates the thread, and must not read as an orphan.
        if (task.createdAt >= bootIso) {
          continue;
        }
        const shell = yield* shellOf(task.crewThreadId);
        if (shell !== null && shell.deletedAt === null) {
          continue;
        }
        yield* repository
          .closeTask({ taskId: task.taskId, updatedAt: yield* nowIso })
          .pipe(Effect.catchCause(() => Effect.void));
        yield* crewLog.record("crew.reap.orphan", {
          taskId: task.taskId,
          threadId: task.crewThreadId,
          reason: shell === null ? "missing" : "deleted",
        });
      }
    });

  const start: CrewSweepShape["start"] = () =>
    forkParked(
      reapOrphans().pipe(
        Effect.andThen(
          runOnce().pipe(
            // A defect in one pass must not end delivery for the rest of the boot.
            Effect.catchCause((cause) => Effect.logWarning("crew.sweep pass failed", { cause })),
            Effect.repeat(Schedule.spaced(`${CREW_SWEEP_INTERVAL_MS} millis`)),
          ),
        ),
      ),
    );

  return { runOnce, reapOrphans, start } satisfies CrewSweepShape;
});

export const CrewSweepLive = Layer.effect(CrewSweep)(makeCrewSweep);
