/**
 * Test harness for crew on orchestrator v2: a real `CrewRepository` over in-memory SQLite,
 * a recording `CrewLog`, and recording doubles of the upstream services crew is built on
 * (thread management, launch, MCP credentials, terminals, provider sessions).
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  type CrewTask,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { McpSessionRegistry } from "../mcp/McpSessionRegistry.ts";
import {
  OrchestratorCommandPreviouslyRejectedError,
  type OrchestratorV2Error,
} from "../orchestration-v2/Orchestrator.ts";
import { ProviderSessionManagerV2 } from "../orchestration-v2/ProviderSessionManager.ts";
import {
  ThreadLaunchError,
  ThreadLaunchService,
  type ThreadLaunchInput,
} from "../orchestration-v2/ThreadLaunchService.ts";
import {
  ThreadManagementNoSteerableRunError,
  ThreadManagementService,
  ThreadManagementThreadArchivedError,
  type ThreadManagementError,
  type ThreadManagementSendInput,
} from "../orchestration-v2/ThreadManagementService.ts";
import { toPersistenceSqlError } from "../persistence/Errors.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { layerTest as serverSettingsLayerTest } from "../serverSettings.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { CrewLog, type CrewLogCode, type CrewLogFields } from "./CrewLog.ts";
import { CrewRepository, CrewRepositoryLive } from "./CrewRepository.ts";

export const PROJECT = ProjectId.make("project-1");
export const BRIDGE = ThreadId.make("bridge-1");
/** `makeTask()`'s branch: the exact `crew/<uuid>` shape `crew_dispatch` gives a crewmate. */
export const CREW_BRANCH = "crew/00000000-0000-4000-8000-000000000001";

export const shellOf = (
  id: ThreadId,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell =>
  ({
    id,
    projectId: PROJECT,
    modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "opus" },
    runtimeMode: "full-access",
    interactionMode: "default",
    status: "idle",
    pendingRuntimeRequest: null,
    hasActionableProposedPlan: false,
    archivedAt: null,
    deletedAt: null,
    branch: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    ...overrides,
  }) as unknown as OrchestrationV2ThreadShell;

export const makeTask = (overrides: Partial<CrewTask> = {}): CrewTask => ({
  taskId: "task-1" as CrewTask["taskId"],
  parentThreadId: BRIDGE,
  crewThreadId: ThreadId.make("crew-1"),
  projectId: PROJECT,
  baseRef: null,
  branch: CREW_BRANCH,
  worktreePath: "/tmp/crew-task-1",
  provider: "claudeAgent" as CrewTask["provider"],
  status: "open",
  createdAt: "2026-09-02T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
  ...overrides,
});

/**
 * `reject` models v2's receipt store: the command is rejected and its id holds a rejected
 * receipt, so any later command with that id fails `PreviouslyRejected`. `late-steer` is
 * upstream turning a steer that missed its run into a new turn.
 */
export type SendBehaviour = "ok" | "no-steerable-run" | "fail" | "reject" | "late-steer";

export interface CrewHarnessOptions {
  /** Shells by thread id; absent ids read as missing. */
  readonly shells?: Map<string, OrchestrationV2ThreadShell>;
  /** Per-call launch outcome; default "ok". */
  readonly launch?: () => "ok" | "fail";
  /** How `sendToThread` answers, per destination; default "ok". */
  readonly send?: (input: ThreadManagementSendInput) => SendBehaviour;
  /** Teardown steps whose upstream call fails. */
  readonly failSteps?: ReadonlySet<number>;
  /** Called on every `getThreadShell`, before it answers; may change `shells`. */
  readonly onShellRead?: (
    threadId: string,
    reads: number,
    shells: Map<string, OrchestrationV2ThreadShell>,
  ) => void;
  /** `command_execution` turn items per thread, for the setup-failure check. */
  readonly turnItems?: Map<string, ReadonlyArray<unknown>>;
  /**
   * Repository calls that fail, for failure-injection tests. Called per call; return true to
   * fail that one call.
   */
  readonly failRepository?: (
    method: "insertReportIfAbsent" | "closeTask",
    taskId: string,
  ) => boolean;
  /** Teardown dispatches (6, 7) that are rejected, leaving a rejected receipt. */
  readonly rejectStep?: (step: number) => boolean;
  readonly settings?: { readonly enableCrew?: boolean; readonly browserAccess?: boolean };
}

export const makeCrewHarness = (options: CrewHarnessOptions = {}) => {
  const records: Array<{ readonly code: CrewLogCode; readonly fields: CrewLogFields }> = [];
  const launches: Array<ThreadLaunchInput> = [];
  /** Messages the destination accepted. */
  const sends: Array<ThreadManagementSendInput> = [];
  /** Every send, accepted or refused. */
  const attempts: Array<ThreadManagementSendInput> = [];
  const calls: Array<string> = [];
  /** Every command passed to `ThreadManagementService.dispatch`. */
  const commands: Array<Record<string, unknown>> = [];
  const shells = options.shells ?? new Map<string, OrchestrationV2ThreadShell>();
  const fails = (step: number) => options.failSteps?.has(step) === true;
  const shellReads = new Map<string, number>();
  /** Command ids holding a rejected receipt. */
  const rejectedIds = new Set<string>();
  const previouslyRejected = (commandId: string, commandType: string) =>
    new OrchestratorCommandPreviouslyRejectedError({
      commandId: CommandId.make(commandId),
      commandType,
      detail: "Previously rejected.",
    });

  const threads = Layer.mock(ThreadManagementService)({
    getThreadShell: (threadId) =>
      Effect.sync(() => {
        const reads = (shellReads.get(threadId) ?? 0) + 1;
        shellReads.set(threadId, reads);
        options.onShellRead?.(threadId, reads, shells);
        return shells.get(threadId) ?? null;
      }),
    sendToThread: (input) =>
      Effect.suspend((): Effect.Effect<never, ThreadManagementError | OrchestratorV2Error> => {
        attempts.push(input);
        if (rejectedIds.has(input.commandId)) {
          return Effect.fail(previouslyRejected(input.commandId, "message.dispatch"));
        }
        const behaviour = options.send?.(input) ?? "ok";
        if (behaviour === "reject") {
          rejectedIds.add(input.commandId);
          return Effect.fail(new ThreadManagementThreadArchivedError({ threadId: input.threadId }));
        }
        if (behaviour === "no-steerable-run") {
          return Effect.fail(
            new ThreadManagementNoSteerableRunError({ threadId: input.threadId, mode: "steer" }),
          );
        }
        if (behaviour === "fail") {
          return Effect.fail(new ThreadManagementThreadArchivedError({ threadId: input.threadId }));
        }
        sends.push(input);
        const delivery =
          input.mode === "steer" && behaviour !== "late-steer" ? "steered" : "queued";
        return Effect.succeed({ delivery } as never);
      }),
    interruptThread: (input) =>
      Effect.suspend(() => {
        calls.push(`2:interrupt:${input.threadId}`);
        return fails(2)
          ? Effect.die("interrupt failed")
          : Effect.succeed({ type: "no_active_run" as const });
      }),
    getThreadRecords: ((threadId: ThreadId) =>
      Effect.succeed({
        thread: {},
        turnItems: options.turnItems?.get(threadId) ?? [],
        providerSessions: [
          { id: `session-${threadId}`, status: "ready" },
          { id: `stopped-${threadId}`, status: "stopped" },
        ],
      })) as never,
    dispatch: (command) =>
      Effect.suspend(() => {
        const index = command.type === "thread.archive" ? 7 : 6;
        commands.push(command as unknown as Record<string, unknown>);
        if (rejectedIds.has(command.commandId)) {
          return Effect.fail(previouslyRejected(command.commandId, command.type));
        }
        if (options.rejectStep?.(index) === true) {
          rejectedIds.add(command.commandId);
          return Effect.die(`${command.type} rejected`);
        }
        calls.push(`${index}:${command.type}:${"threadId" in command ? command.threadId : ""}`);
        return fails(index) ? Effect.die(`${command.type} failed`) : Effect.succeed({} as never);
      }),
  });

  const launchLayer = Layer.mock(ThreadLaunchService)({
    launch: (input) =>
      Effect.suspend(() => {
        launches.push(input);
        if (options.launch?.() === "fail") {
          return Effect.fail(
            new ThreadLaunchError({
              operation: "create-thread",
              commandId: input.commandId,
              projectId: input.projectId,
              cause: "launch refused",
            }),
          );
        }
        if (input.threadId !== undefined) {
          shells.set(input.threadId, shellOf(input.threadId, { status: "preparing" }));
        }
        return Effect.succeed({} as never);
      }),
  });

  const mcp = Layer.mock(McpSessionRegistry)({
    revokeThread: (threadId) =>
      Effect.suspend(() => {
        calls.push(`3:revoke:${threadId}`);
        return fails(3) ? Effect.die("revoke failed") : Effect.void;
      }),
  });
  const terminals = Layer.mock(TerminalManager)({
    close: (input) =>
      Effect.suspend(() => {
        calls.push(`4:terminals:${input.threadId}`);
        return fails(4) ? Effect.die("terminals failed") : Effect.void;
      }),
  });
  const sessions = Layer.mock(ProviderSessionManagerV2)({
    detach: (input) =>
      Effect.suspend(() => {
        calls.push(`5:detach:${input.providerSessionId}`);
        return fails(5) ? Effect.die("detach failed") : Effect.void;
      }),
  });

  const crewLog = Layer.succeed(CrewLog, {
    record: (code, fields) => Effect.sync(() => void records.push({ code, fields: fields ?? {} })),
  });

  const failRepository = options.failRepository;
  const repository =
    failRepository === undefined
      ? CrewRepositoryLive
      : Layer.effect(
          CrewRepository,
          Effect.gen(function* () {
            const live = yield* CrewRepository;
            const injected = (method: string, taskId: string) =>
              Effect.fail(toPersistenceSqlError(`${method}:${taskId}`)("injected"));
            return {
              ...live,
              insertReportIfAbsent: (report) =>
                failRepository("insertReportIfAbsent", report.taskId)
                  ? injected("insertReportIfAbsent", report.taskId)
                  : live.insertReportIfAbsent(report),
              closeTask: (input) =>
                failRepository("closeTask", input.taskId)
                  ? injected("closeTask", input.taskId)
                  : live.closeTask(input),
            };
          }),
        ).pipe(Layer.provide(CrewRepositoryLive));

  const layer = Layer.mergeAll(
    repository,
    crewLog,
    threads,
    launchLayer,
    mcp,
    terminals,
    sessions,
    serverSettingsLayerTest({
      enableCrew: options.settings?.enableCrew ?? true,
      enableAgentBrowserAccess: options.settings?.browserAccess ?? true,
    }),
    ServerConfig.layerTest("/tmp", { prefix: "crew-test-" }),
  ).pipe(
    Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
    Layer.provideMerge(NodeServices.layer),
  );

  const codes = () => records.map((record) => record.code);
  return { records, codes, launches, sends, attempts, calls, commands, shells, layer };
};

/** Runs `body` with migrations applied, under the harness's layer. */
export const withCrew = <A, E, R>(
  harness: ReturnType<typeof makeCrewHarness>,
  body: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    yield* runMigrations({});
    return yield* body;
  }).pipe(Effect.scoped, Effect.provide(harness.layer));

export { CommandId, CrewRepository };
