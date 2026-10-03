/**
 * CrewService - dispatch, status, teardown, report, answer.
 *
 * The authority checks live here rather than in the MCP tools, because every one
 * of them keys on `McpInvocationContext.threadId` — server-resolved and absent
 * from every tool schema — and on rows, not on anything the caller supplies. The
 * tools are a thin schema-and-message layer over these methods.
 *
 * On orchestrator v2 crew owns only its rows and its policy. The machinery under
 * it is upstream's: a crewmate is launched by `ThreadLaunchService` (worktree,
 * setup script, first message), reports travel as ordinary v2 messages through
 * `ThreadManagementService` (see `CrewSweep`), and teardown is upstream operations
 * in a fixed order (see `CrewTeardown`).
 *
 * None of this is a security boundary. A crewmate runs with full access, Bash and
 * direct write access to the state database, so the cap is enforced by a table its
 * own subject can edit. These are controls against crew's own code and honest
 * mistakes.
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
  MessageId,
  ProviderInstanceId,
  ThreadId,
  type CrewReport,
  type CrewReportState,
  type CrewTask,
  type CrewTaskView,
  crewBranchFor,
  isCrewBranch,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ServerConfig } from "../config.ts";
import { randomUuidV4 } from "../orchestration-v2/RandomUuid.ts";
import { ThreadLaunchService } from "../orchestration-v2/ThreadLaunchService.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { CrewLog } from "./CrewLog.ts";
import { CrewRepository } from "./CrewRepository.ts";
import {
  byteLength,
  crewEnabled,
  isNoteWithinBound,
  isPromptWithinBound,
  isWritableReportState,
  normalizeNote,
  resolveCrewMaxConcurrentTasks,
} from "./CrewPolicy.ts";
import { makeCrewTeardown } from "./CrewTeardown.ts";
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

/**
 * Every method takes the calling thread explicitly.
 *
 * An MCP tool call's thread comes from `McpInvocationContext` and differs per
 * invocation, so a service pinned to one thread at construction would attribute
 * every crew call to whichever thread happened to build it.
 *
 * Deliberately a separate argument rather than a field on the tool input types:
 * those are the MCP `parameters` schemas, and a caller thread an agent could
 * pass is a caller thread an agent could forge. This one is server-resolved.
 */
export interface CrewServiceShape {
  readonly dispatch: (
    input: CrewDispatchInput,
    callerThreadId: ThreadId,
  ) => Effect.Effect<CrewDispatchResult, CrewDispatchRefusedError>;

  /**
   * Scoped per direction: a bridge sees the tasks it dispatched and their
   * reports, a crewmate sees its own task and the answers addressed to it. A
   * single `parentThreadId` scope returns nothing to a crewmate, which makes the
   * delivery nudge unreadable in the answer direction.
   */
  readonly status: (
    input: CrewStatusInput,
    callerThreadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<CrewTaskView>>;

  readonly teardown: (
    input: { readonly taskId: CrewTaskId },
    callerThreadId: ThreadId,
  ) => Effect.Effect<void, CrewTaskNotFoundError>;

  readonly report: (
    input: { readonly state: string; readonly note: string },
    callerThreadId: ThreadId,
  ) => Effect.Effect<CrewReportId, CrewTaskNotFoundError | CrewReportRefusedError>;

  readonly answer: (
    input: { readonly reportId: CrewReportId; readonly text: string },
    callerThreadId: ThreadId,
  ) => Effect.Effect<
    CrewReportId,
    CrewTaskNotFoundError | CrewAlreadyAnsweredError | CrewAnswerRefusedError
  >;

  /** Slots currently held. */
  readonly openSlots: () => Effect.Effect<{ readonly open: number; readonly limit: number }>;
}

export class CrewService extends Context.Service<CrewService, CrewServiceShape>()(
  "t3/crew/CrewService",
) {}

export interface CrewServiceOptions {
  readonly env?: Record<string, string | undefined>;
}

/** Missing, deleted and archived threads cannot receive a crew report. */
export const deliverabilityOf = (
  shell: OrchestrationV2ThreadShell | null,
): { readonly ok: true } | { readonly ok: false; readonly detail: string } =>
  shell === null
    ? { ok: false, detail: "missing" }
    : shell.deletedAt !== null
      ? { ok: false, detail: "deleted" }
      : shell.archivedAt !== null
        ? { ok: false, detail: "archived" }
        : { ok: true };

/** The panel's and `crew_status`'s row, from a task, its reports and its thread shell. */
export const crewTaskView = (
  task: CrewTask,
  reports: ReadonlyArray<CrewReport>,
  shell: OrchestrationV2ThreadShell | null,
): CrewTaskView => {
  // The sublabel skips `answer` rows: those are the bridge's replies, not the
  // crewmate's output, and showing one as the task's latest state would report
  // the operator's own words back to them.
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
      status: shell?.status ?? null,
      hasPendingRuntimeRequest: shell !== null && shell.pendingRuntimeRequest !== null,
      hasActionableProposedPlan: shell?.hasActionableProposedPlan === true,
    }),
    lastReportState: (lastReport?.state ?? null) as CrewReportState | null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    reports,
  };
};

/** Ancestors `crew_dispatch` walks looking for a crewmate; real chains are a few deep. */
const MAX_LINEAGE_DEPTH = 32;

const makeCrewService = (options?: CrewServiceOptions) =>
  Effect.gen(function* () {
    const repository = yield* CrewRepository;
    const threads = yield* ThreadManagementService;
    const launches = yield* ThreadLaunchService;
    const serverSettings = yield* ServerSettingsService;
    const { worktreesDir } = yield* ServerConfig;
    const crewLog = yield* CrewLog;
    const runTeardown = yield* makeCrewTeardown;

    const limit = resolveCrewMaxConcurrentTasks(options?.env ?? process.env);
    const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

    const shellOf = (threadId: ThreadId) =>
      threads.getThreadShell(threadId).pipe(Effect.catchCause(() => Effect.succeed(null)));

    /**
     * `nested` is computed over rows of **every** status, not just open ones.
     * Scoped to open rows, a torn-down crewmate silently becomes a bridge.
     */
    const isCrewmate = (threadId: ThreadId) =>
      repository.getTaskByCrewThreadId({ crewThreadId: threadId }).pipe(
        Effect.map(Option.isSome),
        Effect.catchCause(() => Effect.succeed(false)),
      );

    /** The branch is a crewmate's: the exact `crew/<taskId>` shape AND a crew row has it. */
    const isCrewmateBranch = (branch: string | null) =>
      isCrewBranch(branch)
        ? repository.listAllTasks().pipe(
            Effect.map((tasks) => tasks.some((task) => task.branch === branch)),
            Effect.catchCause(() => Effect.succeed(false)),
          )
        : Effect.succeed(false);

    /**
     * A thread a crewmate created through upstream's own tools (`delegate_task`,
     * `create_threads`, a fork) has no crew row of its own, so the row check alone lets it
     * dispatch. Every one of those copies the creator's branch, and delegated and forked
     * threads also record their parent in `lineage`; either, confirmed by a crew row,
     * marks the caller as inside a crewmate. A user's own `crew/my-feature` is not refused.
     *
     * Accepted evasions, not closed: a chain deeper than `MAX_LINEAGE_DEPTH`, and a thread
     * a crewmate created with no lineage whose branch was then changed — both need an agent
     * deliberately working around crew, and crew's cap still bounds what it can start.
     */
    const descendsFromCrewmate = (caller: OrchestrationV2ThreadShell) =>
      Effect.gen(function* () {
        if (yield* isCrewmateBranch(caller.branch)) {
          return true;
        }
        let parentId = caller.lineage.parentThreadId;
        for (let depth = 0; parentId !== null && depth < MAX_LINEAGE_DEPTH; depth += 1) {
          if (yield* isCrewmate(parentId)) {
            return true;
          }
          const parent = yield* shellOf(parentId);
          if (parent === null) {
            return false;
          }
          if (yield* isCrewmateBranch(parent.branch)) {
            return true;
          }
          parentId = parent.lineage.parentThreadId;
        }
        return false;
      });

    const refuseDispatch = (error: CrewDispatchRefusedError, callerThreadId: ThreadId) =>
      crewLog
        .record(`crew.dispatch.refused.${error.reason}` as const, {
          threadId: callerThreadId,
          ...(error.openTasks === undefined ? {} : { count: error.openTasks }),
          ...(error.limit === undefined ? {} : { limit: error.limit }),
        })
        .pipe(Effect.andThen(Effect.fail(error)));

    const dispatch: CrewServiceShape["dispatch"] = (input, callerThreadId) =>
      Effect.gen(function* () {
        yield* crewLog.record("crew.tool.invoked.crew_dispatch", { threadId: callerThreadId });

        // Both settings in one read, per call, so the Settings toggle takes effect on
        // the next dispatch with no restart. Fails closed as a pair; the master switch
        // is checked first so a failed read refuses as `disabled`.
        const settings = yield* serverSettings.getRawSettings.pipe(
          Effect.map((value) => ({
            enabled: crewEnabled(value),
            browserAccess: value.enableAgentBrowserAccess,
          })),
          Effect.catchCause(() => Effect.succeed({ enabled: false, browserAccess: false })),
        );

        if (!settings.enabled) {
          return yield* refuseDispatch(
            new CrewDispatchRefusedError({ reason: "disabled" }),
            callerThreadId,
          );
        }

        if (!isPromptWithinBound(input.prompt)) {
          return yield* refuseDispatch(
            new CrewDispatchRefusedError({
              reason: "payload",
              detail: `${byteLength(input.prompt)} bytes`,
            }),
            callerThreadId,
          );
        }

        if (yield* isCrewmate(callerThreadId)) {
          return yield* refuseDispatch(
            new CrewDispatchRefusedError({ reason: "nested" }),
            callerThreadId,
          );
        }

        const caller = yield* shellOf(callerThreadId);
        if (caller !== null && (yield* descendsFromCrewmate(caller))) {
          return yield* refuseDispatch(
            new CrewDispatchRefusedError({ reason: "nested" }),
            callerThreadId,
          );
        }
        const deliverable = deliverabilityOf(caller);
        if (caller === null || !deliverable.ok) {
          return yield* refuseDispatch(
            new CrewDispatchRefusedError({
              reason: "thread",
              detail: deliverable.ok ? "missing" : deliverable.detail,
            }),
            callerThreadId,
          );
        }

        const provider = input.provider ?? caller.modelSelection.instanceId;
        if (CREW_UNSUPPORTED_PROVIDERS.some((name) => provider.includes(name))) {
          return yield* refuseDispatch(
            new CrewDispatchRefusedError({ reason: "provider" }),
            callerThreadId,
          );
        }

        // Fail closed: an explicit "off" silently becoming "on" would violate the
        // operator's stated choice. Checked here so the refusal precedence holds.
        if (!settings.browserAccess) {
          return yield* refuseDispatch(
            new CrewDispatchRefusedError({ reason: "browser-access" }),
            callerThreadId,
          );
        }

        const open = yield* repository
          .countOpenTasks()
          .pipe(Effect.catchCause(() => Effect.succeed(0)));
        if (open >= limit) {
          return yield* refuseDispatch(
            new CrewDispatchRefusedError({ reason: "cap", openTasks: open, limit }),
            callerThreadId,
          );
        }

        const taskId = CrewTaskId.make(yield* randomUuidV4);
        const crewThreadId = ThreadId.make(yield* randomUuidV4);
        // Derived from the task id, never from the prompt, so no prompt-derived text
        // reaches a path, the panel, or a log line. Unique by construction.
        const branch = crewBranchFor(taskId);
        const worktreePath = `${worktreesDir}/crew/${taskId}`;
        const createdAt = yield* nowIso;

        // Reserve before the launch: the row is what makes the slot observable to a
        // concurrent dispatch, and crew knows the thread id first.
        yield* repository
          .insertTask({
            taskId,
            parentThreadId: callerThreadId,
            crewThreadId,
            projectId: caller.projectId,
            baseRef: input.baseRef ?? null,
            branch,
            worktreePath,
            provider: provider as CrewTask["provider"],
            status: "open",
            createdAt,
            updatedAt: createdAt,
          })
          .pipe(Effect.catchCause(() => Effect.void));

        // Upstream's launch provisions the worktree, runs the setup script and starts
        // the crewmate's first run. Crew never deletes a file, a directory, or a branch:
        // a failed launch closes its row and leaves whatever git created.
        const launched = yield* Effect.result(
          launches.launch({
            commandId: CommandId.make(`crew:dispatch:${taskId}`),
            threadId: crewThreadId,
            projectId: caller.projectId,
            title: `Crew ${taskId.slice(0, 8)}`,
            modelSelection:
              input.provider === undefined
                ? caller.modelSelection
                : {
                    ...caller.modelSelection,
                    instanceId: ProviderInstanceId.make(input.provider),
                  },
            runtimeMode: caller.runtimeMode,
            interactionMode: caller.interactionMode,
            workspaceStrategy: {
              type: "worktree",
              // The project's HEAD unless the bridge names a ref.
              baseRef: input.baseRef ?? "HEAD",
              branch,
              path: worktreePath,
            },
            initialMessage: {
              messageId: MessageId.make(`crew:dispatch:${taskId}`),
              senderThreadId: callerThreadId,
              text: input.prompt,
              attachments: [],
            },
            createdBy: "agent",
            creationSource: "mcp",
          }),
        );

        if (launched._tag === "Failure") {
          yield* repository
            .closeTask({ taskId, updatedAt: yield* nowIso })
            .pipe(Effect.catchCause(() => Effect.void));
          yield* crewLog.record("crew.dispatch.compensate.skipped", {
            taskId,
            threadId: crewThreadId,
          });
          return yield* new CrewDispatchRefusedError({ reason: "thread", detail: "setup failed" });
        }

        return { taskId, crewThreadId, branch, worktreePath };
      });

    const readReports = (taskId: CrewTaskId) =>
      repository
        .listReportsByTaskId({ taskId })
        .pipe(Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<CrewReport>)));

    const status: CrewServiceShape["status"] = (input, callerThreadId) =>
      Effect.gen(function* () {
        yield* crewLog.record("crew.tool.invoked.crew_status", { threadId: callerThreadId });

        const rows = yield* repository
          .getTasksByParentThreadId({ parentThreadId: callerThreadId })
          .pipe(Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<CrewTask>)));

        // The other direction: a crewmate reading its own task and the answers
        // addressed to it.
        const own = yield* repository
          .getTaskByCrewThreadId({ crewThreadId: callerThreadId })
          .pipe(Effect.catchCause(() => Effect.succeed(Option.none<CrewTask>())));

        const tasks = [...rows, ...Option.toArray(own)];
        // Bounded output: unbounded this is 4 x 200 x 1 KiB = 0.78 MiB per call.
        const perTask = Math.min(
          input.limit ?? CREW_STATUS_ROWS_PER_TASK,
          CREW_STATUS_ROWS_PER_TASK,
        );

        const unnotedByTask = new Map<string, ReadonlyArray<CrewReport>>();
        if (input.unreadOnly === true) {
          const unnoted = yield* repository
            .selectUnnoted()
            .pipe(Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<CrewReport>)));
          for (const report of unnoted) {
            unnotedByTask.set(report.taskId, [...(unnotedByTask.get(report.taskId) ?? []), report]);
          }
        }

        return yield* Effect.forEach(tasks, (task) =>
          Effect.gen(function* () {
            const reports =
              input.unreadOnly === true
                ? (unnotedByTask.get(task.taskId) ?? []).slice(-perTask)
                : (yield* readReports(task.taskId)).slice(-perTask);
            return crewTaskView(task, reports, yield* shellOf(task.crewThreadId));
          }),
        );
      });

    const teardown: CrewServiceShape["teardown"] = (input, callerThreadId) =>
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
          return yield* new CrewTaskNotFoundError({ direction: "parent", taskId: input.taskId });
        }
        yield* runTeardown(task);
      });

    const report: CrewServiceShape["report"] = (input, callerThreadId) =>
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
          return yield* new CrewTaskNotFoundError({ direction: "crew" });
        }

        if (!isWritableReportState(input.state)) {
          yield* crewLog.record("crew.tool.refused.crew_report.bad-state", {
            threadId: callerThreadId,
            taskId: task.taskId,
            state: input.state,
          });
          return yield* new CrewReportRefusedError({ reason: "bad-state" });
        }

        const note = normalizeNote(input.note);
        if (!isNoteWithinBound(note)) {
          return yield* new CrewReportRefusedError({ reason: "note-too-large" });
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
          return yield* new CrewReportRefusedError({ reason: "cap", count });
        }

        const reportId = CrewReportId.make(yield* randomUuidV4);
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

    const answer: CrewServiceShape["answer"] = (input, callerThreadId) =>
      Effect.gen(function* () {
        yield* crewLog.record("crew.tool.invoked.crew_answer", {
          threadId: callerThreadId,
          reportId: input.reportId,
        });

        const text = normalizeNote(input.text);
        if (!isNoteWithinBound(text)) {
          return yield* new CrewAnswerRefusedError({ reason: "text-too-large" });
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
          return yield* new CrewTaskNotFoundError({ direction: "parent" });
        }

        if (all.some((candidate) => candidate.replyTo === input.reportId)) {
          yield* crewLog.record("crew.tool.refused.crew_answer.already-answered", {
            threadId: callerThreadId,
            reportId: input.reportId,
          });
          return yield* new CrewAlreadyAnsweredError({ reportId: input.reportId });
        }

        const reportId = CrewReportId.make(yield* randomUuidV4);
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

export const CrewServiceLive = (options?: CrewServiceOptions) =>
  Layer.effect(CrewService)(makeCrewService(options));
