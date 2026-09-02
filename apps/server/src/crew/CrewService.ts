/**
 * CrewService - dispatch, status, teardown, report, answer.
 *
 * The authority checks live here rather than in the MCP tools, because every one
 * of them keys on `McpInvocationContext.threadId` — server-resolved and absent
 * from every tool schema — and on rows, not on anything the caller supplies. The
 * tools are a thin schema-and-message layer over these five methods.
 *
 * None of this is a security boundary. A crewmate runs `bypassPermissions` with
 * Bash and direct write access to `state.sqlite`, so the cap is enforced by a
 * table its own subject can edit. These are controls against crew's own code and
 * honest mistakes.
 *
 * @module crew/CrewService
 */
import {
  CREW_REPORTS_PER_TASK_LIMIT,
  CREW_STATUS_ROWS_PER_TASK,
  CREW_UNSUPPORTED_PROVIDERS,
  CommandId,
  CrewAlreadyAnsweredError,
  CrewAnswerRefusedError,
  CrewDispatchRefusedError,
  CrewReportId,
  CrewReportRefusedError,
  CrewTaskId,
  CrewTaskNotFoundError,
  CrewTaskNotFoundError as CrewTaskNotFound,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  type CrewReport,
  type CrewReportState,
  type CrewTask,
  type CrewTaskView,
  type ModelSelection,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { CrewLog } from "./CrewLog.ts";
import { CrewRepository } from "./CrewRepository.ts";
import {
  byteLength,
  destinationOf,
  isNoteWithinBound,
  isPromptWithinBound,
  isWritableReportState,
  normalizeNote,
  resolveCrewMaxConcurrentTasks,
} from "./CrewPolicy.ts";
import { derive } from "./derive.ts";

export interface CrewDispatchInput {
  readonly prompt: string;
  readonly baseRef?: string | undefined;
  readonly provider?: string | undefined;
}

export interface CrewDispatchResult {
  readonly taskId: CrewTaskId;
  readonly crewThreadId: ThreadId;
  readonly branch: string;
  readonly worktreePath: string;
}

export interface CrewStatusInput {
  readonly unreadOnly?: boolean | undefined;
  readonly limit?: number | undefined;
}

export interface CrewServiceShape {
  readonly dispatch: (
    input: CrewDispatchInput,
  ) => Effect.Effect<CrewDispatchResult, CrewDispatchRefusedError>;

  /**
   * Scoped per direction: a bridge sees the tasks it dispatched and their
   * reports, a crewmate sees its own task and the answers addressed to it. A
   * single `parentThreadId` scope returns nothing to a crewmate, which makes the
   * delivery nudge unreadable in the answer direction.
   */
  readonly status: (input: CrewStatusInput) => Effect.Effect<ReadonlyArray<CrewTaskView>>;

  readonly teardown: (input: {
    readonly taskId: CrewTaskId;
  }) => Effect.Effect<void, CrewTaskNotFoundError>;

  readonly report: (input: {
    readonly state: string;
    readonly note: string;
  }) => Effect.Effect<CrewReportId, CrewTaskNotFoundError | CrewReportRefusedError>;

  readonly answer: (input: {
    readonly reportId: CrewReportId;
    readonly text: string;
  }) => Effect.Effect<
    CrewReportId,
    CrewTaskNotFoundError | CrewAlreadyAnsweredError | CrewAnswerRefusedError
  >;

  /** Slots currently held. Exposed so the acceptance run can read it directly. */
  readonly openSlots: () => Effect.Effect<{ readonly open: number; readonly limit: number }>;
}

export class CrewService extends Context.Service<CrewService, CrewServiceShape>()(
  "t3/crew/CrewService",
) {}

/**
 * Why a hook's failure has to be expressible.
 *
 * The caller wraps every teardown step in a `catchCause` that records
 * `crew.teardown.step-failed.<n>`. With an uninhabited error channel those codes
 * are unreachable by construction, so §9 would promise log records no path could
 * emit — and a hook that swallows its own failure is indistinguishable from one
 * that worked, which is the state teardown most needs to be able to report.
 *
 * Crew's own error type rather than the terminal and provider error unions, so
 * this interface does not have to name types from the layers it deliberately
 * cannot depend on.
 */
export class CrewTeardownHookError extends Schema.TaggedErrorClass<CrewTeardownHookError>()(
  "CrewTeardownHookError",
  { step: Schema.Number, threadId: Schema.String },
) {
  override get message() {
    return `Crew teardown step ${this.step} failed for thread ${this.threadId}.`;
  }
}

/** Teardown hooks the service cannot reach directly without a dependency cycle. */
export interface CrewTeardownHooks {
  readonly clearRecoveryRecord: (threadId: ThreadId) => Effect.Effect<void, CrewTeardownHookError>;
  readonly revokeActiveMcpThread: (
    threadId: ThreadId,
  ) => Effect.Effect<void, CrewTeardownHookError>;
  readonly closeTerminals: (threadId: ThreadId) => Effect.Effect<void, CrewTeardownHookError>;
  readonly stopSession: (threadId: ThreadId) => Effect.Effect<void, CrewTeardownHookError>;
}

export class CrewTeardownHooksService extends Context.Service<
  CrewTeardownHooksService,
  CrewTeardownHooks
>()("t3/crew/CrewService/CrewTeardownHooksService") {}

/** Hooks that do nothing, for wiring that has no provider attached yet. */
export const CrewTeardownHooksNoop = Layer.succeed(CrewTeardownHooksService, {
  clearRecoveryRecord: () => Effect.void,
  revokeActiveMcpThread: () => Effect.void,
  closeTerminals: () => Effect.void,
  stopSession: () => Effect.void,
});

export interface CrewServiceOptions {
  readonly env?: Record<string, string | undefined>;
  /** Directory worktrees are created under. Defaults beside the workspace root. */
  readonly worktreeRoot?: string;
}

const threadIsDeliverable = (
  shell: OrchestrationThreadShell | undefined,
): { readonly ok: true } | { readonly ok: false; readonly detail: string } => {
  if (shell === undefined) {
    return { ok: false, detail: "missing" };
  }
  if (shell.archivedAt !== null) {
    return { ok: false, detail: "archived" };
  }
  return { ok: true };
};

const makeCrewService = (options?: CrewServiceOptions) =>
  Effect.gen(function* () {
    const repository = yield* CrewRepository;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const gitWorkflow = yield* GitWorkflowService;
    const serverSettings = yield* ServerSettingsService;
    const crewLog = yield* CrewLog;
    const hooks = yield* CrewTeardownHooksService;
    const crypto = yield* Crypto.Crypto;
    const callerThreadId = yield* CrewCallerThread;

    const limit = resolveCrewMaxConcurrentTasks(options?.env ?? process.env);

    const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
    /**
     * `randomUUIDv4` carries a `PlatformError`. Crew has no useful recovery from a
     * failed UUID draw, and widening four public error unions for it would push
     * that non-choice onto every caller — so it dies here instead.
     */
    const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);

    const commandId = (tag: string) =>
      uuid.pipe(Effect.map((value) => CommandId.make(`crew:${tag}:${value}`)));

    const shellOf = (threadId: ThreadId) =>
      projectionSnapshotQuery.getThreadShellById(threadId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.catchCause(() => Effect.succeed(undefined)),
      );

    /**
     * `nested` is computed over rows of **every** status, not just open ones.
     * Scoped to open rows, a torn-down crewmate silently becomes a bridge.
     */
    const isCrewmate = (threadId: ThreadId) =>
      repository.getTaskByCrewThreadId({ crewThreadId: threadId }).pipe(
        Effect.map(Option.isSome),
        Effect.catchCause(() => Effect.succeed(false)),
      );

    const refuseDispatch = (error: CrewDispatchRefusedError) =>
      crewLog
        .record(`crew.dispatch.refused.${error.reason}` as const, {
          threadId: callerThreadId,
          ...(error.openTasks === undefined ? {} : { count: error.openTasks }),
          ...(error.limit === undefined ? {} : { limit: error.limit }),
        })
        .pipe(Effect.andThen(Effect.fail(error)));

    const dispatch: CrewServiceShape["dispatch"] = (input) =>
      Effect.gen(function* () {
        yield* crewLog.record("crew.tool.invoked.crew_dispatch", { threadId: callerThreadId });

        if (!isPromptWithinBound(input.prompt)) {
          return yield* refuseDispatch(
            new CrewDispatchRefusedError({
              reason: "payload",
              detail: `${byteLength(input.prompt)} bytes`,
            }),
          );
        }

        if (yield* isCrewmate(callerThreadId)) {
          return yield* refuseDispatch(new CrewDispatchRefusedError({ reason: "nested" }));
        }

        const caller = yield* shellOf(callerThreadId);
        const deliverable = threadIsDeliverable(caller);
        if (!deliverable.ok) {
          return yield* refuseDispatch(
            new CrewDispatchRefusedError({ reason: "thread", detail: deliverable.detail }),
          );
        }

        const provider = input.provider ?? caller!.modelSelection.instanceId;
        if (CREW_UNSUPPORTED_PROVIDERS.some((name) => provider.includes(name))) {
          return yield* refuseDispatch(new CrewDispatchRefusedError({ reason: "provider" }));
        }

        const browserAccess = yield* serverSettings.getSettings.pipe(
          Effect.map((settings) => settings.enableAgentBrowserAccess),
          // Fail closed, matching ProviderService: an explicit "off" silently
          // becoming "on" would violate the operator's stated choice.
          Effect.catchCause(() => Effect.succeed(false)),
        );
        if (!browserAccess) {
          return yield* refuseDispatch(new CrewDispatchRefusedError({ reason: "browser-access" }));
        }

        const open = yield* repository
          .countOpenTasks()
          .pipe(Effect.catchCause(() => Effect.succeed(0)));
        if (open >= limit) {
          return yield* refuseDispatch(
            new CrewDispatchRefusedError({ reason: "cap", openTasks: open, limit }),
          );
        }

        const taskId = CrewTaskId.make(yield* uuid);
        const crewThreadId = ThreadId.make(yield* uuid);
        // The branch is derived from the task id, never from the prompt, so no
        // prompt-derived text reaches a path, the panel, or a log line.
        const branch = `crew/${taskId}`;
        const project = yield* projectionSnapshotQuery.getProjectShellById(caller!.projectId).pipe(
          Effect.map(Option.getOrUndefined),
          Effect.catchCause(() => Effect.succeed(undefined)),
        );
        const workspaceRoot = project?.workspaceRoot ?? process.cwd();
        const worktreePath =
          options?.worktreeRoot === undefined
            ? `${workspaceRoot}/.t3/crew/${taskId}`
            : `${options.worktreeRoot}/${taskId}`;

        const createdAt = yield* nowIso;

        // Reserve in a short crew_tasks-only transaction and commit before taking
        // any other lock. crew knows the thread id first, so the row can be
        // written before `createWorktree` — which is what makes the slot
        // observable to a concurrent dispatch.
        yield* repository
          .insertTask({
            taskId,
            parentThreadId: callerThreadId,
            crewThreadId,
            projectId: caller!.projectId,
            baseRef: input.baseRef ?? null,
            branch,
            worktreePath,
            provider: provider as CrewTask["provider"],
            status: "open",
            createdAt,
            updatedAt: createdAt,
          })
          .pipe(Effect.catchCause(() => Effect.void));

        // Crew never deletes a file, a directory, or a branch — not on dispatch
        // failure, not at boot, not on teardown. A failed dispatch closes its row
        // and leaves whatever git created for the operator to look at.
        const setup = yield* Effect.result(
          Effect.gen(function* () {
            yield* gitWorkflow.pruneWorktrees({ cwd: workspaceRoot });
            yield* gitWorkflow.createWorktree({
              cwd: workspaceRoot,
              refName: branch,
              newRefName: branch,
              ...(input.baseRef === undefined ? {} : { baseRefName: input.baseRef }),
              path: worktreePath,
            });

            yield* orchestrationEngine.dispatch({
              type: "thread.create",
              commandId: yield* commandId("thread-create"),
              threadId: crewThreadId,
              projectId: caller!.projectId,
              title: `Crew ${taskId.slice(0, 8)}`,
              modelSelection: {
                ...caller!.modelSelection,
                ...(input.provider === undefined
                  ? {}
                  : { instanceId: ProviderInstanceId.make(input.provider) }),
              } as ModelSelection,
              runtimeMode: caller!.runtimeMode,
              interactionMode: caller!.interactionMode,
              branch,
              worktreePath,
              createdAt,
            });

            yield* orchestrationEngine.dispatch({
              type: "thread.turn.start",
              commandId: yield* commandId("turn-start"),
              threadId: crewThreadId,
              message: {
                messageId: MessageId.make(yield* uuid),
                role: "user",
                text: input.prompt,
                attachments: [],
              },
              runtimeMode: caller!.runtimeMode,
              interactionMode: caller!.interactionMode,
              createdAt: yield* nowIso,
            });
          }),
        );

        if (setup._tag === "Failure") {
          yield* repository
            .closeTask({ taskId, updatedAt: yield* nowIso })
            .pipe(Effect.catchCause(() => Effect.void));
          yield* crewLog.record("crew.dispatch.compensate.skipped", {
            taskId,
            threadId: crewThreadId,
          });
          return yield* Effect.fail(
            new CrewDispatchRefusedError({ reason: "thread", detail: "setup failed" }),
          );
        }

        return { taskId, crewThreadId, branch, worktreePath };
      });

    const viewOf = (task: CrewTask, reports: ReadonlyArray<CrewReport>) =>
      Effect.gen(function* () {
        const shell = yield* shellOf(task.crewThreadId);
        const lastReport = reports.toReversed().find((report) => report.state !== "answer");
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
          reports,
        } satisfies CrewTaskView;
      });

    const status: CrewServiceShape["status"] = (input) =>
      Effect.gen(function* () {
        yield* crewLog.record("crew.tool.invoked.crew_status", { threadId: callerThreadId });

        const rows = yield* repository
          .getTasksByParentThreadId({ parentThreadId: callerThreadId })
          .pipe(Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<CrewTask>)));

        // The other direction: a crewmate reading its own task and the answers
        // addressed to it. Without this the delivery nudge is unreadable to the
        // thread the answer was written for.
        const own = yield* repository
          .getTaskByCrewThreadId({ crewThreadId: callerThreadId })
          .pipe(Effect.catchCause(() => Effect.succeed(Option.none<CrewTask>())));

        const tasks = [...rows, ...Option.toArray(own)];
        // Bounded output. Unbounded this returns 4 x 200 x 1 KiB = 0.78 MiB, the
        // magnitude the coalesced wake payload was deleted for, one hop
        // downstream.
        const perTask = Math.min(
          input.limit ?? CREW_STATUS_ROWS_PER_TASK,
          CREW_STATUS_ROWS_PER_TASK,
        );

        const unnoted = yield* repository
          .selectUnnoted()
          .pipe(Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<CrewReport>)));
        const unnotedByTask = new Map<string, ReadonlyArray<CrewReport>>();
        for (const report of unnoted) {
          unnotedByTask.set(report.taskId, [...(unnotedByTask.get(report.taskId) ?? []), report]);
        }

        return yield* Effect.forEach(tasks, (task) =>
          Effect.gen(function* () {
            const all = input.unreadOnly === true ? (unnotedByTask.get(task.taskId) ?? []) : [];
            const reports =
              input.unreadOnly === true
                ? all.slice(-perTask)
                : (yield* readReports(task.taskId)).slice(-perTask);
            return yield* viewOf(task, reports);
          }),
        );
      });

    const readReports = (taskId: CrewTaskId) =>
      repository
        .listReportsByTaskId({ taskId })
        .pipe(Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<CrewReport>)));

    const teardown: CrewServiceShape["teardown"] = (input) =>
      Effect.gen(function* () {
        yield* crewLog.record("crew.tool.invoked.crew_teardown", {
          threadId: callerThreadId,
          taskId: input.taskId,
        });

        const tasks = yield* repository
          .getTasksByParentThreadId({ parentThreadId: callerThreadId })
          .pipe(Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<CrewTask>)));
        const task = tasks.find(
          (candidate) => candidate.taskId === input.taskId && candidate.status === "open",
        );
        if (task === undefined) {
          yield* crewLog.record("crew.tool.refused.crew_teardown.no-row", {
            threadId: callerThreadId,
            taskId: input.taskId,
          });
          return yield* Effect.fail(
            new CrewTaskNotFound({ direction: "parent", taskId: input.taskId }),
          );
        }

        /**
         * Seven steps, close first, none latching. Steps 3-7 commute; the one
         * ordering constraint is that step 1 runs first and step 2 precedes step
         * 5.
         *
         * Step 2 does not *arm* a resurrection, it *completes* one the watchdog
         * already armed: step 5 makes `activeTurnId` null, and the watchdog's
         * resume branch has no archival check, so a stop already pending fires
         * against the torn-down thread on the next sweep.
         *
         * Holding the slot on a `stopSession` error is what revision 11 did, and
         * that call fails deterministically — Retry re-ran it forever and the cap
         * reached zero. So every step is best-effort and only logs.
         */
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

        yield* step(1, repository.closeTask({ taskId: task.taskId, updatedAt: yield* nowIso }));
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

        const shell = yield* shellOf(task.crewThreadId);
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

    const report: CrewServiceShape["report"] = (input) =>
      Effect.gen(function* () {
        yield* crewLog.record("crew.tool.invoked.crew_report", { threadId: callerThreadId });

        const own = yield* repository
          .getTaskByCrewThreadId({ crewThreadId: callerThreadId })
          .pipe(Effect.catchCause(() => Effect.succeed(Option.none<CrewTask>())));
        const task = Option.getOrUndefined(own);
        if (task === undefined || task.status !== "open") {
          yield* crewLog.record("crew.tool.refused.crew_report.no-row", {
            threadId: callerThreadId,
          });
          return yield* Effect.fail(new CrewTaskNotFound({ direction: "crew" }));
        }

        if (!isWritableReportState(input.state)) {
          yield* crewLog.record("crew.tool.refused.crew_report.bad-state", {
            threadId: callerThreadId,
            taskId: task.taskId,
            state: input.state,
          });
          return yield* Effect.fail(new CrewReportRefusedError({ reason: "bad-state" }));
        }

        const note = normalizeNote(input.note);
        if (!isNoteWithinBound(note)) {
          return yield* Effect.fail(new CrewReportRefusedError({ reason: "note-too-large" }));
        }

        const count = yield* repository
          .countNonAnswerReports({ taskId: task.taskId })
          .pipe(Effect.catchCause(() => Effect.succeed(0)));
        if (count >= CREW_REPORTS_PER_TASK_LIMIT) {
          yield* crewLog.record("crew.tool.refused.crew_report.cap", {
            threadId: callerThreadId,
            taskId: task.taskId,
            count,
          });
          return yield* Effect.fail(new CrewReportRefusedError({ reason: "cap", count }));
        }

        const reportId = CrewReportId.make(yield* uuid);
        yield* repository
          .insertReport({
            reportId,
            taskId: task.taskId,
            state: input.state,
            note,
            createdAt: yield* nowIso,
            notedAt: null,
            replyTo: null,
          })
          .pipe(Effect.catchCause(() => Effect.void));
        return reportId;
      });

    const answer: CrewServiceShape["answer"] = (input) =>
      Effect.gen(function* () {
        yield* crewLog.record("crew.tool.invoked.crew_answer", {
          threadId: callerThreadId,
          reportId: input.reportId,
        });

        const text = normalizeNote(input.text);
        if (!isNoteWithinBound(text)) {
          return yield* Effect.fail(new CrewAnswerRefusedError({ reason: "text-too-large" }));
        }

        const tasks = yield* repository
          .getTasksByParentThreadId({ parentThreadId: callerThreadId })
          .pipe(Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<CrewTask>)));
        const openTaskIds = new Set(
          tasks.filter((task) => task.status === "open").map((task) => task.taskId),
        );

        const all = yield* repository
          .listReports()
          .pipe(Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<CrewReport>)));
        const target = all.find((candidate) => candidate.reportId === input.reportId);
        if (target === undefined || !openTaskIds.has(target.taskId)) {
          yield* crewLog.record("crew.tool.refused.crew_answer.no-row", {
            threadId: callerThreadId,
            reportId: input.reportId,
          });
          return yield* Effect.fail(new CrewTaskNotFound({ direction: "parent" }));
        }

        if (all.some((candidate) => candidate.replyTo === input.reportId)) {
          yield* crewLog.record("crew.tool.refused.crew_answer.already-answered", {
            threadId: callerThreadId,
            reportId: input.reportId,
          });
          return yield* Effect.fail(new CrewAlreadyAnsweredError({ reportId: input.reportId }));
        }

        const reportId = CrewReportId.make(yield* uuid);
        yield* repository
          .insertReport({
            reportId,
            taskId: target.taskId,
            state: "answer",
            note: text,
            createdAt: yield* nowIso,
            notedAt: null,
            replyTo: input.reportId,
          })
          .pipe(Effect.catchCause(() => Effect.void));
        return reportId;
      });

    const openSlots: CrewServiceShape["openSlots"] = () =>
      repository.countOpenTasks().pipe(
        Effect.map((open) => ({ open, limit })),
        Effect.catchCause(() => Effect.succeed({ open: 0, limit })),
      );

    return { dispatch, status, teardown, report, answer, openSlots } satisfies CrewServiceShape;
  });

/**
 * The calling thread, resolved by the MCP layer and never supplied by the caller.
 *
 * A separate service rather than a parameter because every authority check keys
 * on it, and threading it through each signature invites a call site that passes
 * an id from the tool input instead.
 */
export class CrewCallerThread extends Context.Service<CrewCallerThread, ThreadId>()(
  "t3/crew/CrewService/CrewCallerThread",
) {}

export const CrewServiceLive = (options?: CrewServiceOptions) =>
  Layer.effect(CrewService)(makeCrewService(options));

export { destinationOf };
