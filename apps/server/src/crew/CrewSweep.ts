/**
 * The delivery sweep: gets a crewmate's report into the bridge's transcript, and
 * the bridge's answer into the crewmate's, without starting a turn where it can
 * avoid one.
 *
 * Runs every 60s; a `crew_report` nudge runs the same loop.
 *
 * @module crew/CrewSweep
 */
import { CommandId, MessageId, ThreadId, type CrewReport, type CrewTask } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { forkParked } from "../serverActivation.ts";
import { CrewLog } from "./CrewLog.ts";
import { CrewRepository } from "./CrewRepository.ts";
import { boundNoteBytes, destinationOf, requiresTurn } from "./CrewPolicy.ts";

export const CREW_SWEEP_INTERVAL_MS = 60_000;

/** Attempts to stop one zombie per boot before crew gives up and just logs. */
export const CREW_ZOMBIE_STOP_ATTEMPTS = 3;

/**
 * Consecutive `listSessions()` failures after which the zombie fiber stops.
 *
 * The disagreement that kills that call does not heal while the offending
 * session lives, so an unbounded log would be 1,440 identical lines a day.
 */
export const CREW_ZOMBIE_SCAN_FAILURE_LIMIT = 3;

/** Bytes of prefix a wake payload spends before any note text. */
const WAKE_PREFIX = "Crew report: ";

export interface CrewSweepShape {
  /** Runs one pass. The 60s schedule and the `crew_report` nudge share it. */
  readonly runOnce: () => Effect.Effect<void>;
  /** Forks the 60s loop and the zombie fiber into the caller's scope. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class CrewSweep extends Context.Service<CrewSweep, CrewSweepShape>()("t3/crew/CrewSweep") {}

const makeCrewSweep = Effect.gen(function* () {
  const repository = yield* CrewRepository;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const crewLog = yield* CrewLog;
  const crypto = yield* Crypto.Crypto;

  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  /**
   * Crew's own turn guard. Deliberately **not** the in-repo guard's
   * `session.status === "ready"` conjunct, which is anti-correlated with the case
   * a wake exists for: a `stopped` or absent session is exactly when a turn is
   * required.
   *
   * There is no fourth "already woken this pass" conjunct. The projector runs
   * inside the append transaction, serially, before the dispatch returns, so the
   * instant a wake returns `getPendingTurnStartByThreadId` is `Some` and these
   * three conjuncts already serialise the pass.
   */
  const canStartTurn = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const shell = yield* projectionSnapshotQuery.getThreadShellById(threadId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.catchCause(() => Effect.succeed(undefined)),
      );
      if (shell === undefined) {
        return false;
      }
      if (shell.session?.activeTurnId != null) {
        return false;
      }
      if (shell.hasPendingApprovals || shell.hasPendingUserInput) {
        return false;
      }
      const pending = yield* projectionTurnRepository
        .getPendingTurnStartByThreadId({ threadId })
        .pipe(Effect.catchCause(() => Effect.succeed(Option.none())));
      return Option.isNone(pending);
    });

  /**
   * The three reasons a destination is undeliverable-to. All three terminate the
   * row on the first sweep — there is no grace period, because nothing in the
   * schema can count sweeps and both implementable substitutes are wrong in a
   * named way (an in-memory counter resets on restart; a `createdAt` window gives
   * zero grace to any row older than the window).
   */
  const deliverability = (threadId: ThreadId) =>
    projectionSnapshotQuery.getThreadShellById(threadId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.catchCause(() => Effect.succeed(undefined)),
      Effect.map((shell) =>
        shell === undefined
          ? ({ ok: false, reason: "missing" } as const)
          : shell.archivedAt !== null
            ? ({ ok: false, reason: "archived" } as const)
            : ({ ok: true } as const),
      ),
    );

  const wake = (threadId: ThreadId, payload: string | null) =>
    Effect.gen(function* () {
      yield* orchestrationEngine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`crew:wake:${yield* uuid}`),
        threadId,
        message: {
          messageId: MessageId.make(yield* uuid),
          role: "user",
          text:
            payload === null
              ? "A crew report is waiting. Read it with crew_status."
              : `${WAKE_PREFIX}${payload}`,
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: yield* nowIso,
      });
    }).pipe(
      Effect.catchCause(() => Effect.succeed(false)),
      Effect.as(true),
    );

  const runOnce: CrewSweepShape["runOnce"] = () =>
    Effect.gen(function* () {
      const reports = yield* repository
        .selectUnnoted()
        .pipe(Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<CrewReport>)));
      if (reports.length === 0) {
        return;
      }

      const tasks = yield* repository
        .listAllTasks()
        .pipe(Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<CrewTask>)));
      const taskById = new Map(tasks.map((task) => [task.taskId, task]));

      /**
       * Once a wake has been dispatched for a destination in this pass, the
       * remaining rows for that same destination append and stamp without
       * re-evaluating the guard — they ride the turn already coming.
       *
       * Keyed on the **destination**, not the bridge. Keyed on the bridge, an
       * answer sorts into the same pass as a report on the same task, rides the
       * turn that report dispatched to a *different* thread, appends `false` on a
       * non-Claude crewmate, and is stamped handled — the operator's answer
       * silently lost while the crewmate stays blocked holding a slot.
       */
      const wokenDestinations = new Set<string>();

      for (const report of reports) {
        const task = taskById.get(report.taskId);
        if (task === undefined) {
          yield* stamp(report, "crew.deliver.abandoned", "missing-task");
          continue;
        }

        const isAnswer = report.state === "answer";
        const destination = ThreadId.make(destinationOf(report, task));
        const family = isAnswer ? "crew.answer" : "crew.deliver";

        // Step 1: thread guard. Precedes everything because `appendSessionNote`
        // checks none of it.
        const reachable = yield* deliverability(destination);
        if (!reachable.ok) {
          yield* stamp(report, "crew.deliver.abandoned", reachable.reason);
          continue;
        }

        const rides = wokenDestinations.has(destination);
        const needsTurn = requiresTurn(report.state);

        // Step 2: turn guard, before the append, for a report that must be read.
        // Appending before you know you can wake buys nothing — a note is read on
        // the next turn or not at all.
        if (needsTurn && !rides) {
          const ready = yield* canStartTurn(destination);
          if (!ready) {
            yield* crewLog.record(`${family}.deferred.busy` as never, {
              taskId: task.taskId,
              reportId: report.reportId,
              destinationThreadId: destination,
              state: report.state,
            });
            continue;
          }
        }

        // Step 3: append.
        const appended = yield* providerService
          .appendSessionNote({
            threadId: destination,
            text: boundNoteBytes(report.note, 1024),
          })
          .pipe(Effect.catchCause(() => Effect.succeed(false)));

        if (!appended && !needsTurn && !rides) {
          // A `progress` report on a non-Claude bridge, or a Claude session that
          // is stopped or closed. Run the turn guard now.
          const ready = yield* canStartTurn(destination);
          if (!ready) {
            yield* crewLog.record("crew.deliver.deferred.no-session", {
              taskId: task.taskId,
              reportId: report.reportId,
              destinationThreadId: destination,
              state: report.state,
            });
            continue;
          }
        }

        // Step 4: wake, if the report must be read or the append did not land.
        let dispatched = rides;
        if (!rides && (needsTurn || !appended)) {
          // A wake carries a payload only for a report the append did not place.
          // Attaching one to text already in the transcript makes the destination
          // read the same report twice in one turn, unable to tell that from two
          // reports.
          dispatched = yield* wake(destination, appended ? null : report.note);
          if (dispatched) {
            wokenDestinations.add(destination);
          }
        } else if (!rides && appended && !needsTurn) {
          yield* crewLog.record("crew.deliver.no-turn", {
            taskId: task.taskId,
            reportId: report.reportId,
            destinationThreadId: destination,
            state: report.state,
          });
        }

        // Step 5: stamp last, and only once the work it records has succeeded —
        // the append on the no-wake path, the dispatch on the wake path, and the
        // already-dispatched wake for a report that rode one. Naming only the
        // dispatch leaves a `progress` report appended to a live Claude bridge
        // never stamped, re-selecting and re-appending every 60s forever.
        if (appended || dispatched) {
          yield* repository
            .stampNoted({ reportId: report.reportId, notedAt: yield* nowIso })
            .pipe(Effect.catchCause(() => Effect.succeed(false)));
        }
      }
    });

  const stamp = (report: CrewReport, code: "crew.deliver.abandoned", reason: string) =>
    Effect.gen(function* () {
      yield* repository
        .stampNoted({ reportId: report.reportId, notedAt: yield* nowIso })
        .pipe(Effect.catchCause(() => Effect.succeed(false)));
      yield* crewLog.record(code, {
        reportId: report.reportId,
        taskId: report.taskId,
        state: report.state,
        reason,
      });
    });

  /**
   * The zombie scan, in a fiber of its own.
   *
   * `listSessions()` has a `never` error channel hiding three `die` paths, so an
   * ordinary catch does not rescue it and one unguarded call would take delivery
   * down for the rest of the boot — every report undelivered, silently.
   */
  const zombieScan = Effect.gen(function* () {
    const attemptsByThread = new Map<string, number>();
    let consecutiveFailures = 0;

    const pass = Effect.gen(function* () {
      const sessions = yield* providerService
        .listSessions()
        .pipe(Effect.catchCause(() => Effect.succeed(null)));
      if (sessions === null) {
        consecutiveFailures += 1;
        if (consecutiveFailures === 1) {
          // Once per unbroken run of failures, not once per pass.
          yield* crewLog.record("crew.sweep.zombie-scan-failed", {
            count: consecutiveFailures,
          });
        }
        return consecutiveFailures < CREW_ZOMBIE_SCAN_FAILURE_LIMIT;
      }
      consecutiveFailures = 0;

      const tasks = yield* repository
        .listAllTasks()
        .pipe(Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<CrewTask>)));
      const closedCrewThreads = new Set(
        tasks.filter((task) => task.status === "closed").map((task) => task.crewThreadId),
      );

      for (const session of sessions) {
        const threadId = session.threadId;
        if (!closedCrewThreads.has(threadId)) {
          attemptsByThread.delete(threadId);
          continue;
        }
        const attempts = attemptsByThread.get(threadId) ?? 0;
        if (attempts >= CREW_ZOMBIE_STOP_ATTEMPTS) {
          continue;
        }
        attemptsByThread.set(threadId, attempts + 1);
        yield* providerService.stopSession({ threadId }).pipe(Effect.catchCause(() => Effect.void));
        yield* crewLog.record("crew.zombie.stopped", {
          threadId,
          attempt: attempts + 1,
        });
      }
      return true;
    });

    yield* pass.pipe(
      Effect.flatMap((keepGoing) => (keepGoing ? Effect.void : Effect.interrupt)),
      Effect.repeat(Schedule.spaced(`${CREW_SWEEP_INTERVAL_MS} millis`)),
      Effect.catchCause(() => Effect.void),
    );
  });

  const start: CrewSweepShape["start"] = () =>
    Effect.gen(function* () {
      yield* forkParked(
        runOnce().pipe(Effect.repeat(Schedule.spaced(`${CREW_SWEEP_INTERVAL_MS} millis`))),
      );
      yield* forkParked(zombieScan);
    });

  return { runOnce, start } satisfies CrewSweepShape;
});

export const CrewSweepLive = Layer.effect(CrewSweep)(makeCrewSweep);
