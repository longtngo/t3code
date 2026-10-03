/**
 * The delivery sweep: gets a crewmate's report to the bridge, and the bridge's answer to
 * the crewmate, as ordinary v2 messages.
 *
 * On `personal` this guarded turn starts itself (busy, pending turn-start, a per-pass woken
 * set) and placed `progress` text into a live Claude session with `appendSessionNote`. V2's
 * server-native queue makes all of that upstream's job: a message sent with mode `queue`
 * starts a run on an idle thread and waits behind active work on a busy one, durably, and
 * `steer` places text into a run already in progress without starting a turn (upstream
 * turns a steer that arrives just after its run ended into a new turn, and then
 * `no-turn` is not logged). So per pass and per destination thread:
 *
 *  - any report that must be read (`needs-decision`, `done`, `failed`, `answer`) → ONE
 *    `queue` message carrying every unnoted report for that destination;
 *  - only `progress` reports → ONE `steer` message if the destination has a steerable run
 *    (no turn started, `crew.deliver.no-turn`), otherwise nothing: the rows stay unnoted
 *    and ride the next message to that thread, and `crew_status` and the panel show them.
 *
 * `notedAt` is stamped only after the send was accepted, so an undelivered row is
 * re-selected next pass. The command and message ids derive from the report ids in the
 * message plus an attempt number: a retry of the same set replays an accepted receipt
 * instead of sending twice, and moves past a rejected one, which v2 never re-runs.
 *
 * Each pass first settles tasks whose worktree setup failed (`settleFailedSetups`).
 *
 * Runs every 60s; `runOnce` is also the seam the tests drive directly.
 *
 * @module crew/CrewSweep
 */
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  CrewReportId,
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
  OrchestratorCommandPreviouslyRejectedError,
  WORKSPACE_PREPARATION_INPUT,
} from "../orchestration-v2/Orchestrator.ts";
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

type DeliveryRow = { readonly report: CrewReport; readonly task: CrewTask };

/** Task ids the tail names before it stops listing. */
const TAIL_TASK_LIMIT = 10;

/**
 * One block per report, quoted in order until the byte budget is spent. A report that does
 * not fit is NOT in this message: it is left out of `quoted`, stays unnoted, and goes out
 * in the next pass. The tail names the tasks still waiting so the reader knows more is
 * coming.
 */
export function renderDelivery(rows: ReadonlyArray<DeliveryRow>): {
  readonly text: string;
  readonly quoted: ReadonlyArray<DeliveryRow>;
} {
  const encoder = new TextEncoder();
  const lines: Array<string> = [];
  const quoted: Array<DeliveryRow> = [];
  const waiting: Array<DeliveryRow> = [];
  let spent = 0;
  for (const row of rows) {
    const { report, task } = row;
    const label =
      report.state === "answer"
        ? `Crew answer to report ${report.replyTo ?? "?"}`
        : `Crew report (${report.state}) from task ${task.taskId}, report ${report.reportId}`;
    const line = `${label}:\n${boundNoteBytes(report.note, 1024)}`;
    const cost = encoder.encode(line).length;
    if (spent + cost > CREW_DELIVERY_QUOTED_BYTE_LIMIT) {
      waiting.push(row);
      continue;
    }
    spent += cost;
    lines.push(line);
    quoted.push(row);
  }
  if (waiting.length > 0) {
    const taskIds = [...new Set(waiting.map(({ task }) => task.taskId as string))];
    const named = taskIds.slice(0, TAIL_TASK_LIMIT).join(", ");
    const more =
      taskIds.length > TAIL_TASK_LIMIT ? ` and ${taskIds.length - TAIL_TASK_LIMIT} more` : "";
    lines.push(
      `…${waiting.length} more crew ${waiting.length === 1 ? "report is" : "reports are"} waiting (task ${named}${more}) and will arrive in the next message.`,
    );
  }
  return { text: lines.join("\n\n"), quoted };
}

/** Stable for a given set of reports, so a retried send replays instead of repeating. */
const deliveryKey = (reportIds: ReadonlyArray<string>) =>
  NodeCrypto.createHash("sha256").update(reportIds.join("\n")).digest("hex").slice(0, 32);

/**
 * The command and message id of one delivery attempt. Attempt 0 is the bare key; a later
 * attempt exists only because every earlier id holds a REJECTED receipt, which v2 never
 * re-runs, so retrying under the same id could not deliver.
 */
export const deliveryId = (key: string, attempt: number) =>
  attempt === 0 ? `crew:deliver:${key}` : `crew:deliver:${key}:${attempt}`;

const isPreviouslyRejected = Schema.is(OrchestratorCommandPreviouslyRejectedError);

/** How the latest run's "Preparing workspace" item ends when setup never finished. */
const SETTLED_PREPARATION_STATUSES: ReadonlySet<string> = new Set(["failed", "cancelled"]);

/** One setup-failure report per task, however many passes retry the settle step. */
export const setupFailedReportId = (taskId: string) =>
  CrewReportId.make(`crew:setup-failed:${taskId}`);

/** Rejected receipts one pass walks past for one delivery before giving up until the next. */
const MAX_ATTEMPTS_PER_PASS = 64;

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

  /**
   * The attempt to start from per delivery key, so a destination that keeps rejecting does
   * not re-walk its rejected receipts every pass. Lost on restart, when the walk below
   * finds the first id without a rejected receipt again.
   */
  const nextAttempt = new Map<string, number>();
  /** Keys a pass attempted; any other `nextAttempt` entry is dropped when the pass ends. */
  let keysThisPass = new Set<string>();

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
    candidates: ReadonlyArray<DeliveryRow>,
  ) =>
    Effect.gen(function* () {
      // Only the rows the message quotes are in it: everything below — mode, ids, sender,
      // stamping — is about those rows. The rest stay unnoted for the next pass.
      const { text, quoted: rows } = renderDelivery(candidates);
      const needsTurn = rows.some(({ report }) => requiresTurn(report.state));
      const reportIds = rows.map(({ report }) => report.reportId);
      const key = deliveryKey(reportIds);
      keysThisPass.add(key);
      const senders = new Set(
        rows.map(({ report, task }) =>
          report.state === "answer" ? task.parentThreadId : task.crewThreadId,
        ),
      );
      const send = (attempt: number) =>
        threads.sendToThread({
          projectId: shell.projectId,
          commandId: CommandId.make(deliveryId(key, attempt)),
          threadId: destination,
          messageId: MessageId.make(deliveryId(key, attempt)),
          text,
          attachments: [],
          mode: needsTurn ? "queue" : "steer",
          ...(senders.size === 1 ? { senderThreadId: [...senders][0]! } : {}),
          createdBy: "agent",
          creationSource: "server",
        });
      // An accepted receipt replays as success, so a lost stamp is re-stamped without a
      // second message. A rejected receipt is final for its id: move to the next attempt.
      // Bounded per pass in case a fresh id is ever reported as previously rejected; the
      // walk resumes from `nextAttempt` on the next pass.
      let attempt = nextAttempt.get(key) ?? 0;
      const lastAttempt = attempt + MAX_ATTEMPTS_PER_PASS;
      let sent = yield* Effect.result(send(attempt));
      while (
        sent._tag === "Failure" &&
        isPreviouslyRejected(sent.failure) &&
        attempt < lastAttempt
      ) {
        attempt += 1;
        nextAttempt.set(key, attempt);
        sent = yield* Effect.result(send(attempt));
      }

      if (sent._tag === "Success") {
        nextAttempt.delete(key);
        failingDestinations.delete(destination);
        yield* stampAll(rows.map(({ report }) => report));
        // Upstream turns a steer that arrives after its run finished into a new turn, so
        // `no-turn` is logged only for a delivery that actually steered.
        if (!needsTurn && sent.success.delivery === "steered") {
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

  /**
   * Closes open tasks whose worktree setup never finished. Launch provisions in the
   * background, so dispatch has already returned success; upstream records the outcome on
   * the "Preparing workspace" item of the crewmate's run. Settled, positively, when that
   * item in the thread's LATEST run ended `failed` (setup failed) or `cancelled` (startup
   * recovery cancels a preparation the server died during) — being in the latest run means
   * no run started after it. An old failed item followed by later runs settles nothing.
   *
   * The slot is freed and the bridge is told through an ordinary `failed` report. The report
   * goes in first, under an id derived from the task, insert-or-ignore, and the row closes
   * second: whichever step fails, the task is still open next pass and the retry ends with
   * exactly one report. Read from durable state, so a failure that landed while the server
   * was down is caught.
   */
  const settleFailedSetups = Effect.gen(function* () {
    const open = yield* repository
      .listOpenTasks()
      .pipe(Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<CrewTask>)));
    for (const task of open) {
      const latestRunId = (yield* shellOf(task.crewThreadId))?.latestRunId ?? null;
      if (latestRunId === null) {
        continue;
      }
      const records = yield* threads
        .getThreadRecords(task.crewThreadId, ["turnItems"], {
          turnItemTypes: ["command_execution"],
          turnItemRunId: latestRunId,
        })
        .pipe(Effect.catchCause(() => Effect.succeed(null)));
      const preparation = records?.turnItems.find(
        (item) =>
          item.type === "command_execution" &&
          item.runId === latestRunId &&
          item.input === WORKSPACE_PREPARATION_INPUT,
      );
      if (
        preparation === undefined ||
        preparation.type !== "command_execution" ||
        !SETTLED_PREPARATION_STATUSES.has(preparation.status)
      ) {
        continue;
      }
      const now = yield* nowIso;
      const filed = yield* repository
        .insertReportIfAbsent({
          reportId: setupFailedReportId(task.taskId),
          taskId: task.taskId,
          state: "failed",
          note: boundNoteBytes(
            (preparation.status === "cancelled"
              ? "Worktree setup was cancelled (the server stopped during it), so the crewmate never started and its slot is free."
              : `Worktree setup failed, so the crewmate never started and its slot is free. ${preparation.output ?? ""}`
            ).trim(),
            1024,
          ),
          createdAt: now,
          notedAt: null,
          replyTo: null,
        })
        .pipe(Effect.result);
      if (filed._tag === "Failure") {
        continue;
      }
      const closed = yield* repository
        .closeTask({ taskId: task.taskId, updatedAt: now })
        .pipe(Effect.result);
      if (closed._tag === "Failure") {
        continue;
      }
      yield* crewLog.record("crew.dispatch.compensate.skipped", {
        taskId: task.taskId,
        threadId: task.crewThreadId,
        reason: `setup-${preparation.status}`,
      });
    }
  });

  const runOnce: CrewSweepShape["runOnce"] = () =>
    Effect.gen(function* () {
      keysThisPass = new Set();
      yield* deliverPass;
      // A key no pass sends any more (its rows were stamped, abandoned or regrouped) will
      // never be looked up again.
      for (const key of nextAttempt.keys()) {
        if (!keysThisPass.has(key)) nextAttempt.delete(key);
      }
    });

  const deliverPass = Effect.gen(function* () {
    // Before delivery, so the failure report it files goes out in this pass. Cleanup,
    // like teardown: it runs whatever the master switch says.
    yield* settleFailedSetups;

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
      byDestination.set(destination, [...(byDestination.get(destination) ?? []), { report, task }]);
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
