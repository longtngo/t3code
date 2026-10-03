/**
 * The panel's read and the operator's actions: every crew task in this environment, with
 * its derived rendering and its reports.
 *
 * Separate from `CrewService` because it has no caller thread. `CrewService` is scoped to
 * `McpInvocationContext.threadId` — every one of its methods is an authority check keyed
 * on that thread — whereas the panel shows the environment's crew to an operator who is
 * not a thread at all. Authority here is the RPC scope.
 *
 * @module crew/CrewDirectory
 */
import {
  CommandId,
  CrewReportId,
  type CrewReport,
  type CrewTask,
  type CrewTaskId,
  type CrewTaskView,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { randomUuidV4 } from "../orchestration-v2/RandomUuid.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { CrewLog } from "./CrewLog.ts";
import { boundNoteBytes, normalizeNote } from "./CrewPolicy.ts";
import { CrewRepository } from "./CrewRepository.ts";
import { crewTaskView } from "./CrewService.ts";
import { makeCrewTeardown } from "./CrewTeardown.ts";

export interface CrewDirectoryShape {
  readonly list: () => Effect.Effect<ReadonlyArray<CrewTaskView>>;

  /**
   * Run the seven teardown steps on the operator's behalf. Idempotent, so `Re-run
   * teardown` on an already-`closed` row whose thread still runs is safe.
   */
  readonly teardown: (input: { readonly taskId: CrewTaskId }) => Effect.Effect<void>;

  /** Queue an answer to a crewmate's report. Delivered by the sweep. */
  readonly answer: (input: {
    readonly reportId: CrewReportId;
    readonly text: string;
  }) => Effect.Effect<void>;

  /**
   * Clear `worktreePath` and `branch` from a crew thread. Closed rows only: on an open
   * task it would strand a running crewmate on a cwd it no longer owns.
   */
  readonly forgetWorktree: (input: { readonly taskId: CrewTaskId }) => Effect.Effect<void>;
}

export class CrewDirectory extends Context.Service<CrewDirectory, CrewDirectoryShape>()(
  "t3/crew/CrewDirectory",
) {}

const makeCrewDirectory = Effect.gen(function* () {
  const repository = yield* CrewRepository;
  const threads = yield* ThreadManagementService;
  const crewLog = yield* CrewLog;
  const runTeardown = yield* makeCrewTeardown;

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

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
        if (bucket === undefined) reportsByTask.set(report.taskId, [report]);
        else bucket.push(report);
      }
      return yield* Effect.forEach(tasks, (task) =>
        threads.getThreadShell(task.crewThreadId).pipe(
          Effect.catchCause(() => Effect.succeed(null)),
          Effect.map((shell) => crewTaskView(task, reportsByTask.get(task.taskId) ?? [], shell)),
        ),
      );
    });

  const teardown: CrewDirectoryShape["teardown"] = ({ taskId }) =>
    Effect.gen(function* () {
      const task = yield* findTask(taskId);
      if (task !== undefined) {
        yield* runTeardown(task);
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
      // One answer per report, matching `crew_answer`.
      if (reports.some((report) => report.replyTo === reportId)) {
        yield* crewLog.record("crew.tool.refused.crew_answer.already-answered", { reportId });
        return;
      }
      yield* repository
        .insertReport({
          reportId: CrewReportId.make(yield* randomUuidV4),
          taskId: target.taskId,
          state: "answer",
          // The same 1 KiB bound `crew_answer` enforces; the panel cuts rather than
          // refuses, because its RPC has no refusal to show.
          note: boundNoteBytes(normalizeNote(text), 1024),
          createdAt: yield* nowIso,
          notedAt: null,
          replyTo: reportId,
        })
        .pipe(Effect.catchCause(() => Effect.void));
    });

  const forgetWorktree: CrewDirectoryShape["forgetWorktree"] = ({ taskId }) =>
    Effect.gen(function* () {
      const task = yield* findTask(taskId);
      if (task === undefined || task.status !== "closed") {
        return;
      }
      yield* threads
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`crew:forget-worktree:${yield* randomUuidV4}`),
          threadId: task.crewThreadId,
          // The `crew/` branch stays as the shell's crew marker (see CrewTeardown step 6).
          worktreePath: null,
        })
        .pipe(Effect.catchCause(() => Effect.void));
    });

  return { list, teardown, answer, forgetWorktree } satisfies CrewDirectoryShape;
});

export const CrewDirectoryLive = Layer.effect(CrewDirectory)(makeCrewDirectory);
