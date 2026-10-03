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
import { runMigrations } from "../persistence/Migrations.ts";
import { layerTest as serverSettingsLayerTest } from "../serverSettings.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { CrewLog, type CrewLogCode, type CrewLogFields } from "./CrewLog.ts";
import { CrewRepository, CrewRepositoryLive } from "./CrewRepository.ts";

export const PROJECT = ProjectId.make("project-1");
export const BRIDGE = ThreadId.make("bridge-1");

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
    ...overrides,
  }) as unknown as OrchestrationV2ThreadShell;

export const makeTask = (overrides: Partial<CrewTask> = {}): CrewTask => ({
  taskId: "task-1" as CrewTask["taskId"],
  parentThreadId: BRIDGE,
  crewThreadId: ThreadId.make("crew-1"),
  projectId: PROJECT,
  baseRef: null,
  branch: "crew/task-1",
  worktreePath: "/tmp/crew-task-1",
  provider: "claudeAgent" as CrewTask["provider"],
  status: "open",
  createdAt: "2026-09-02T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
  ...overrides,
});

export type SendBehaviour = "ok" | "no-steerable-run" | "fail";

export interface CrewHarnessOptions {
  /** Shells by thread id; absent ids read as missing. */
  readonly shells?: Map<string, OrchestrationV2ThreadShell>;
  /** Per-call launch outcome; default "ok". */
  readonly launch?: () => "ok" | "fail";
  /** How `sendToThread` answers, per destination; default "ok". */
  readonly send?: (input: ThreadManagementSendInput) => SendBehaviour;
  /** Teardown steps whose upstream call fails. */
  readonly failSteps?: ReadonlySet<number>;
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
  const shells = options.shells ?? new Map<string, OrchestrationV2ThreadShell>();
  const fails = (step: number) => options.failSteps?.has(step) === true;

  const threads = Layer.mock(ThreadManagementService)({
    getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
    sendToThread: (input) =>
      Effect.suspend((): Effect.Effect<never, ThreadManagementError> => {
        attempts.push(input);
        const behaviour = options.send?.(input) ?? "ok";
        if (behaviour === "no-steerable-run") {
          return Effect.fail(
            new ThreadManagementNoSteerableRunError({ threadId: input.threadId, mode: "steer" }),
          );
        }
        if (behaviour === "fail") {
          return Effect.fail(new ThreadManagementThreadArchivedError({ threadId: input.threadId }));
        }
        sends.push(input);
        return Effect.succeed({} as never);
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
        providerSessions: [
          { id: `session-${threadId}`, status: "ready" },
          { id: `stopped-${threadId}`, status: "stopped" },
        ],
      })) as never,
    dispatch: (command) =>
      Effect.suspend(() => {
        const index = command.type === "thread.archive" ? 7 : 6;
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

  const layer = Layer.mergeAll(
    CrewRepositoryLive,
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
  return { records, codes, launches, sends, attempts, calls, shells, layer };
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
