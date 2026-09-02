/**
 * The panel's read: every crew task in this environment, with its derived
 * rendering and its reports.
 *
 * Separate from `CrewService` because it has no caller. `CrewService` is scoped
 * to `McpInvocationContext.threadId` — every one of its methods is an authority
 * check keyed on that thread — whereas the panel shows the environment's crew to
 * an operator who is not a thread at all. Routing the panel through the
 * caller-scoped service would need a fake caller id, and a fake caller id is
 * exactly the input the authority checks exist to refuse.
 *
 * @module crew/CrewDirectory
 */
import {
  CommandId,
  CrewReportId,
  type CrewReport,
  type CrewReportState,
  type CrewTask,
  type CrewTaskId,
  type CrewTaskView,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { CrewLog } from "./CrewLog.ts";
import { CrewRepository } from "./CrewRepository.ts";
import { CrewTeardownHooksService } from "./CrewService.ts";
import { normalizeNote } from "./CrewPolicy.ts";
import { derive } from "./derive.ts";

export interface CrewDirectoryShape {
  readonly list: () => Effect.Effect<ReadonlyArray<CrewTaskView>>;

  /**
   * Close a task on the operator's behalf and run the same seven steps
   * `crew_teardown` runs.
   *
   * Authority here is the RPC scope, not a thread: the operator is not a thread,
   * and the panel is scoped to the environment so that a task whose bridge was
   * deleted is still visible and still tearable-down.
   *
   * Idempotent, which is what makes `Re-run teardown` safe on an already-`closed`
   * row whose thread is somehow still in a session — without it the zombie budget
   * is the only thing that can stop a live `bypassPermissions` agent.
   */
  readonly teardown: (input: { readonly taskId: CrewTaskId }) => Effect.Effect<void>;

  /** Queue an answer to a crewmate's report. Delivered by the sweep. */
  readonly answer: (input: {
    readonly reportId: CrewReportId;
    readonly text: string;
  }) => Effect.Effect<void>;

  /**
   * Clear `worktreePath` and `branch` from a crew thread's meta.
   *
   * Closed rows only. On an `open` task this disables `ensureThreadWorktree`'s
   * recreate while the session keeps resuming into a cwd that is gone: every
   * later turn fails as "session not found", the slot stays held, and no
   * rendering explains why.
   */
  readonly forgetWorktree: (input: { readonly taskId: CrewTaskId }) => Effect.Effect<void>;
}

export class CrewDirectory extends Context.Service<CrewDirectory, CrewDirectoryShape>()(
  "t3/crew/CrewDirectory",
) {}

const makeCrewDirectory = Effect.gen(function* () {
  const repository = yield* CrewRepository;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const crewLog = yield* CrewLog;
  const hooks = yield* CrewTeardownHooksService;
  const crypto = yield* Crypto.Crypto;

  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const commandId = (tag: string) =>
    uuid.pipe(Effect.map((value) => CommandId.make(`crew:${tag}:${value}`)));

  const findTask = (taskId: CrewTaskId) =>
    repository.listAllTasks().pipe(
      Effect.map((tasks) => tasks.find((task) => task.taskId === taskId)),
      Effect.catchCause(() => Effect.succeed(undefined)),
    );

  const list: CrewDirectoryShape["list"] = () =>
    Effect.gen(function* () {
      const tasks = yield* repository
        .listAllTasks()
        .pipe(Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<CrewTask>)));
      const reports = yield* repository
        .listReports()
        .pipe(Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<CrewReport>)));

      const reportsByTask = new Map<string, Array<CrewReport>>();
      for (const report of reports) {
        const bucket = reportsByTask.get(report.taskId);
        if (bucket === undefined) {
          reportsByTask.set(report.taskId, [report]);
        } else {
          bucket.push(report);
        }
      }

      return yield* Effect.forEach(tasks, (task) =>
        Effect.gen(function* () {
          const shell = yield* projectionSnapshotQuery.getThreadShellById(task.crewThreadId).pipe(
            Effect.map(Option.getOrUndefined),
            Effect.catchCause(() => Effect.succeed(undefined)),
          );
          const taskReports = reportsByTask.get(task.taskId) ?? [];
          // The sublabel skips `answer` rows: those are the bridge's replies, not
          // the crewmate's output, and showing one as the task's latest state
          // would report the operator's own words back to them.
          const lastReport = taskReports.toReversed().find((report) => report.state !== "answer");

          return {
            taskId: task.taskId,
            parentThreadId: task.parentThreadId,
            crewThreadId: task.crewThreadId,
            projectId: task.projectId,
            branch: task.branch,
            worktreePath: task.worktreePath,
            provider: task.provider,
            status: task.status,
            rendering: derive(task, {
              session: shell?.session ?? null,
              ...(shell === undefined
                ? {}
                : {
                    hasPendingApprovals: shell.hasPendingApprovals,
                    hasPendingUserInput: shell.hasPendingUserInput,
                    hasActionableProposedPlan: shell.hasActionableProposedPlan,
                  }),
            }),
            lastReportState: (lastReport?.state ?? null) as CrewReportState | null,
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
            reports: taskReports,
          } satisfies CrewTaskView;
        }),
      );
    });

  const teardown: CrewDirectoryShape["teardown"] = ({ taskId }) =>
    Effect.gen(function* () {
      const task = yield* findTask(taskId);
      if (task === undefined) {
        return;
      }

      // The same seven steps `crew_teardown` runs, and for the same reasons: step
      // 1 first so the slot is freed whatever else fails, step 2 before step 5 so
      // the stall watchdog cannot complete a stop it already armed against a
      // thread that is about to be archived.
      const step = <A, E>(index: number, effect: Effect.Effect<A, E>) =>
        effect.pipe(
          Effect.catchCause(() =>
            crewLog.record(`crew.teardown.step-failed.${index}` as never, {
              taskId: task.taskId,
              threadId: task.crewThreadId,
              step: index,
            }),
          ),
        );

      yield* step(1, repository.closeTask({ taskId, updatedAt: yield* nowIso }));
      yield* step(2, hooks.clearRecoveryRecord(task.crewThreadId));
      yield* step(3, hooks.revokeActiveMcpThread(task.crewThreadId));
      yield* step(4, hooks.closeTerminals(task.crewThreadId));
      yield* step(5, hooks.stopSession(task.crewThreadId));
      yield* step(
        6,
        orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: yield* commandId("teardown-meta"),
          threadId: task.crewThreadId,
          branch: null,
          worktreePath: null,
        }),
      );

      const shell = yield* projectionSnapshotQuery.getThreadShellById(task.crewThreadId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.catchCause(() => Effect.succeed(undefined)),
      );
      if (shell !== undefined && shell.archivedAt === null) {
        yield* step(
          7,
          orchestrationEngine.dispatch({
            type: "thread.archive",
            commandId: yield* commandId("teardown-archive"),
            threadId: task.crewThreadId,
          }),
        );
      }
    });

  const answer: CrewDirectoryShape["answer"] = ({ reportId, text }) =>
    Effect.gen(function* () {
      const reports = yield* repository
        .listReports()
        .pipe(Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<CrewReport>)));
      const target = reports.find((report) => report.reportId === reportId);
      if (target === undefined) {
        return;
      }
      // One answer per report, matching `crew_answer`. A second would have no
      // terminal state of its own and would re-select forever.
      if (reports.some((report) => report.replyTo === reportId)) {
        yield* crewLog.record("crew.tool.refused.crew_answer.already-answered", { reportId });
        return;
      }
      yield* repository
        .insertReport({
          reportId: CrewReportId.make(yield* uuid),
          taskId: target.taskId,
          state: "answer",
          note: normalizeNote(text),
          createdAt: yield* nowIso,
          notedAt: null,
          replyTo: reportId,
        })
        .pipe(Effect.catchCause(() => Effect.void));
    });

  const forgetWorktree: CrewDirectoryShape["forgetWorktree"] = ({ taskId }) =>
    Effect.gen(function* () {
      const task = yield* findTask(taskId);
      // Closed rows only. On an open task this disables the worktree recreate
      // while the session keeps resuming into a cwd that is gone.
      if (task === undefined || task.status !== "closed") {
        return;
      }
      yield* orchestrationEngine
        .dispatch({
          type: "thread.meta.update",
          commandId: yield* commandId("forget-worktree"),
          threadId: task.crewThreadId,
          branch: null,
          worktreePath: null,
        })
        .pipe(Effect.catchCause(() => Effect.void));
    });

  return { list, teardown, answer, forgetWorktree } satisfies CrewDirectoryShape;
});

export const CrewDirectoryLive = Layer.effect(CrewDirectory)(makeCrewDirectory);
