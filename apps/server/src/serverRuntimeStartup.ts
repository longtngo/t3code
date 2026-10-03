import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_SERVER_SETTINGS,
  type ModelSelection,
  type Project,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ServerConfig from "./config.ts";
import * as ServiceLauncherClient from "./cloud/serviceLauncherClient.ts";
import { flushCompileCache } from "./compileCache.ts";
import * as Keybindings from "./keybindings.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as EffectWorker from "./orchestration-v2/EffectWorker.ts";
import * as LegacyV1ThreadImporter from "./orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as ProviderRuntimeRecovery from "./orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import * as ThreadLaunch from "./orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "./project/ProjectService.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as AgentAwarenessRelay from "./relay/AgentAwarenessRelay.ts";
import * as WebPushRelay from "./push/WebPushRelay.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerSettings from "./serverSettings.ts";
import { EnvironmentThemeService } from "./environmentTheme.ts";
import { runWatchRescanBackstop, WATCH_RESCAN_INTERVAL } from "./watchRescanBackstop.ts";
import { parsePositiveIntEnv } from "./provider/Layers/parsePositiveIntEnv.ts";
import { forkParked, forkParkedFiber } from "./serverActivation.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import {
  formatHeadlessOpenAccessOutput,
  formatHeadlessServeOutput,
  formatHostForUrl,
  isWildcardHost,
  issueHeadlessServeAccessInfo,
  resolveHeadlessConnectionInfo,
} from "./startupAccess.ts";

export class ServerRuntimeStartupError extends Schema.TaggedError<ServerRuntimeStartupError>()(
  "ServerRuntimeStartupError",
  {
    mode: ServerConfig.RuntimeMode,
    host: Schema.NullOr(Schema.String),
    port: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Server runtime startup failed before command readiness.";
  }
}

export class ServerRuntimeStartup extends Context.Service<
  ServerRuntimeStartup,
  {
    readonly awaitCommandReady: Effect.Effect<void, ServerRuntimeStartupError>;
    readonly markHttpListening: Effect.Effect<void>;
    readonly enqueueCommand: <A, E>(
      effect: Effect.Effect<A, E>,
    ) => Effect.Effect<A, E | ServerRuntimeStartupError>;
  }
>()("t3/serverRuntimeStartup") {}

interface QueuedCommand {
  readonly run: Effect.Effect<void, never>;
}

type CommandReadinessState = "pending" | "ready" | ServerRuntimeStartupError;

interface CommandGate {
  readonly awaitCommandReady: Effect.Effect<void, ServerRuntimeStartupError>;
  readonly signalCommandReady: Effect.Effect<void>;
  readonly failCommandReady: (error: ServerRuntimeStartupError) => Effect.Effect<void>;
  readonly enqueueCommand: <A, E>(
    effect: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | ServerRuntimeStartupError>;
}

const settleQueuedCommand = <A, E>(deferred: Deferred.Deferred<A, E>, exit: Exit.Exit<A, E>) =>
  Exit.isSuccess(exit)
    ? Deferred.succeed(deferred, exit.value)
    : Deferred.failCause(deferred, exit.cause);

export const makeCommandGate = Effect.gen(function* () {
  const commandReady = yield* Deferred.make<void, ServerRuntimeStartupError>();
  const commandQueue = yield* Queue.unbounded<QueuedCommand>();
  const commandReadinessState = yield* Ref.make<CommandReadinessState>("pending");

  const commandWorker = Effect.forever(
    Queue.take(commandQueue).pipe(Effect.flatMap((command) => command.run)),
  );
  yield* Effect.forkScoped(commandWorker);

  return {
    awaitCommandReady: Deferred.await(commandReady),
    signalCommandReady: Effect.gen(function* () {
      yield* Ref.set(commandReadinessState, "ready");
      yield* Deferred.succeed(commandReady, undefined).pipe(Effect.orDie);
    }),
    failCommandReady: (error) =>
      Effect.gen(function* () {
        yield* Ref.set(commandReadinessState, error);
        yield* Deferred.fail(commandReady, error).pipe(Effect.orDie);
      }),
    enqueueCommand: <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.gen(function* () {
        const readinessState = yield* Ref.get(commandReadinessState);
        if (readinessState === "ready") {
          return yield* effect;
        }
        if (readinessState !== "pending") {
          return yield* readinessState;
        }

        const result = yield* Deferred.make<A, E | ServerRuntimeStartupError>();
        yield* Queue.offer(commandQueue, {
          run: Deferred.await(commandReady).pipe(
            Effect.flatMap(() => effect),
            Effect.exit,
            Effect.flatMap((exit) => settleQueuedCommand(result, exit)),
          ),
        });
        return yield* Deferred.await(result);
      }),
  } satisfies CommandGate;
});

const recordStartupHeartbeat = Effect.gen(function* () {
  const analytics = yield* AnalyticsService.AnalyticsService;
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagement.ThreadManagementService;

  const { threadCount, projectCount } = yield* Effect.all({
    projects: projects.snapshot,
    threads: threads.getShellSnapshot(),
  }).pipe(
    Effect.map(({ projects: projectSnapshot, threads: shellSnapshot }) => ({
      projectCount: projectSnapshot.projects.length,
      threadCount: shellSnapshot.threads.length + shellSnapshot.archivedThreads.length,
    })),
    Effect.catch((cause) =>
      Effect.logWarning("failed to gather V2 startup counts for telemetry", {
        cause,
      }).pipe(
        Effect.as({
          threadCount: 0,
          projectCount: 0,
        }),
      ),
    ),
  );

  yield* analytics.record("server.boot.heartbeat", {
    threadCount,
    projectCount,
  });
});

export const getAutoBootstrapThreadModelSelection = (): ModelSelection => ({
  instanceId: ProviderInstanceId.make("codex"),
  model: DEFAULT_MODEL,
});

interface AutoBootstrapWelcomeTargets {
  readonly bootstrapProjectId?: ProjectId;
  readonly bootstrapThreadId?: ThreadId;
}

/**
 * How far the auto-pull phase got, readable while it is still running.
 *
 * The phase is bounded by an interrupting timeout, so when it is cut short nothing
 * it returns survives to say how much it did. `total` is set once the enabled roots
 * are known; `completed` counts roots the phase finished with, including ones it
 * skipped and ones whose pull failed.
 */
export interface AutoPullProgress {
  readonly total: number;
  readonly completed: number;
}

const AUTO_PULL_PROGRESS_START: AutoPullProgress = { total: 0, completed: 0 };

/** Interval for the event-hub health gauge (0 = disabled via T3CODE_HUB_GAUGE_MS=0). */
const DEFAULT_HUB_GAUGE_INTERVAL_MS = 60_000;

const hubGaugeIntervalMs =
  process.env.T3CODE_HUB_GAUGE_MS === "0"
    ? 0
    : (parsePositiveIntEnv("T3CODE_HUB_GAUGE_MS") ?? DEFAULT_HUB_GAUGE_INTERVAL_MS);

/**
 * How long the whole startup auto-pull phase may take before startup abandons it.
 *
 * Measured rather than guessed: a healthy phase over four real clones of this repo
 * (17k tracked files each, one commit behind, origin on local disk so no network at
 * all) takes ~5.0s. So this is roughly a 4x margin, not a generous one - a user with
 * a dozen enabled roots on a slow link will routinely be cut short. That is the
 * intended trade: partial progress is safe, and the point is to cap what a user waits
 * for, not to let every root finish.
 *
 * The real wall-clock cost is this budget PLUS `FORCE_KILL_AFTER`
 * (`vcs/GitVcsDriverCore.ts`), because interrupting a git command closes its scope and
 * the release finalizer awaits the child's exit before escalating to SIGKILL.
 */
const AUTO_PULL_STARTUP_BUDGET = Duration.seconds(20);

/**
 * Runs the auto-pull phase under its startup budget, reporting how far it got.
 *
 * Startup blocks on this phase, and `commandReadinessLayer` gates every route
 * including the `/ws` upgrade until startup finishes - so an unbounded phase is a
 * silent total outage, not a slow start.
 *
 * The bound must INTERRUPT, not merely stop waiting. `timeoutOption` awaits the
 * interruption, which closes each git command's scope and reaps the child process.
 * Do not replace it with `Effect.disconnect`, `Effect.fork`, or a hand-rolled race:
 * each would let git keep writing into a workspace root past the activation fence,
 * which is the defect the earlier fork of this phase was reverted for.
 *
 * The warning is annotated because it is the only thing this phase says at the
 * production log level - every per-root outcome below is `logDebug`.
 */
export const runBoundedAutoPull = <A, E, R>(
  phase: Effect.Effect<A, E, R>,
  progress: Ref.Ref<AutoPullProgress>,
  budget: Duration.Duration = AUTO_PULL_STARTUP_BUDGET,
): Effect.Effect<void, E, R> =>
  phase.pipe(
    Effect.timeoutOption(budget),
    Effect.tap((finished) =>
      Option.isNone(finished)
        ? Ref.get(progress).pipe(
            Effect.flatMap(({ total, completed }) =>
              Effect.logWarning("Automatic project pull did not finish within its startup budget", {
                budgetMs: Duration.toMillis(budget),
                totalRoots: total,
                completedRoots: completed,
              }),
            ),
          )
        : Effect.void,
    ),
    Effect.asVoid,
  );

export const autoPullProjects = Effect.fn("autoPullProjects")(function* (
  projects: ReadonlyArray<Pick<Project, "id" | "workspaceRoot" | "autoPull">>,
  settings = DEFAULT_SERVER_SETTINGS,
  progress?: Ref.Ref<AutoPullProgress>,
) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const workspaceRoots = [
    ...new Set(
      projects
        .filter((project) => resolveProjectSettings(settings, project.id).settings.defaultAutoPull)
        .map((project) => project.workspaceRoot),
    ),
  ];

  if (progress !== undefined) {
    yield* Ref.set(progress, { total: workspaceRoots.length, completed: 0 });
  }

  yield* Effect.forEach(
    workspaceRoots,
    (cwd) =>
      Effect.gen(function* () {
        const status = yield* git.statusDetails(cwd);
        if (
          !status.isRepo ||
          !status.isDefaultBranch ||
          !status.hasUpstream ||
          status.hasWorkingTreeChanges ||
          status.aheadCount > 0
        ) {
          yield* Effect.logDebug("Skipped automatic project pull", {
            cwd,
            reason: !status.isRepo
              ? "not-a-repository"
              : !status.isDefaultBranch
                ? "not-on-default-branch"
                : !status.hasUpstream
                  ? "no-upstream"
                  : status.hasWorkingTreeChanges
                    ? "working-tree-changes"
                    : "local-commits",
          });
          return;
        }

        if (status.behindCount <= 0) return;

        const result = yield* git.pullCurrentBranch(cwd);
        yield* Effect.logDebug("Automatic project pull completed", {
          cwd,
          status: result.status,
          refName: result.refName,
        });
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Automatic project pull failed", {
            cwd,
            cause,
          }),
        ),
        // After the catch, so a root that failed still counts as one the phase is
        // done with. Interruption skips this, which is what makes the count mean
        // "roots finished before the budget ran out".
        Effect.tap(() =>
          progress === undefined
            ? Effect.void
            : Ref.update(progress, (current) => ({
                ...current,
                completed: current.completed + 1,
              })),
        ),
      ),
    { concurrency: 4, discard: true },
  );
});

export const resolveWelcomeBase = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const segments = serverConfig.cwd.split(/[/\\]/).filter(Boolean);
  const projectName = segments[segments.length - 1] ?? "project";

  return {
    cwd: serverConfig.cwd,
    projectName,
  } as const;
});

const resolveAutoBootstrapWelcomeTargets = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const threadLaunch = yield* ThreadLaunch.ThreadLaunchService;
  const path = yield* Path.Path;

  let bootstrapProjectId: ProjectId | undefined;
  let bootstrapThreadId: ThreadId | undefined;

  if (serverConfig.autoBootstrapProjectFromCwd) {
    // Project creation has no user model choice; only the bootstrap thread
    // gets an automatic selection, and an explicit project default wins.
    const threadModelSelection = getAutoBootstrapThreadModelSelection();
    const { project } = yield* projects.bootstrap({
      commandId: CommandId.make(yield* randomUUID),
      projectId: ProjectId.make(yield* randomUUID),
      title: path.basename(serverConfig.cwd) || "project",
      workspaceRoot: serverConfig.cwd,
    });
    const shell = yield* threads.getShellSnapshot();
    const existingThread = shell.threads.find(
      (thread) =>
        thread.projectId === project.id && thread.lineage.relationshipToParent !== "subagent",
    );
    if (existingThread === undefined) {
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const settings = yield* serverSettings.getSettings;
      const launched = yield* threadLaunch.launch({
        commandId: CommandId.make(yield* randomUUID),
        projectId: project.id,
        title: "New thread",
        modelSelection:
          resolveProjectSettings(settings, project.id, project).settings.defaultModelSelection ??
          threadModelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: resolveProjectSettings(settings, project.id, project).settings
          .defaultRuntimeMode,
        workspaceStrategy: { type: "root" },
        createdBy: "system",
        creationSource: "server",
      });
      bootstrapProjectId = project.id;
      bootstrapThreadId = launched.threadId;
    } else {
      bootstrapProjectId = project.id;
      bootstrapThreadId = existingThread.id;
    }
  }

  return {
    ...(bootstrapProjectId ? { bootstrapProjectId } : {}),
    ...(bootstrapThreadId ? { bootstrapThreadId } : {}),
  } satisfies AutoBootstrapWelcomeTargets;
});

const resolveStartupBrowserTarget = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const localUrl = `http://localhost:${serverConfig.port}`;
  const bindUrl =
    serverConfig.host && !isWildcardHost(serverConfig.host)
      ? `http://${formatHostForUrl(serverConfig.host)}:${serverConfig.port}`
      : localUrl;
  const baseTarget = serverConfig.devUrl?.toString() ?? bindUrl;
  // Desktop authenticates via the bootstrap envelope; open-access mode needs
  // no credential at all. Both open the plain URL instead of a pairing URL.
  return serverConfig.mode === "desktop" || serverConfig.disableAuthentication
    ? baseTarget
    : yield* serverAuth.issueStartupPairingUrl(baseTarget);
});

const maybeOpenBrowser = (target: string) =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig.ServerConfig;
    if (serverConfig.noBrowser) {
      return;
    }
    const externalLauncher = yield* ExternalLauncher.ExternalLauncher;

    yield* externalLauncher.launchBrowser(target).pipe(
      Effect.catch(() =>
        Effect.logInfo("browser auto-open unavailable", {
          hint: `Open ${target} in your browser.`,
        }),
      ),
    );
  });

const runStartupPhase = <A, E, R>(phase: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.annotateSpans({ "startup.phase": phase }),
    Effect.withSpan(`server.startup.${phase}`),
  );

interface StartupOptions {
  readonly activate?: Effect.Effect<void>;
  readonly awaitAuxiliaryParked?: Effect.Effect<void>;
  readonly abort?: (error: ServerRuntimeStartupError) => Effect.Effect<void>;
}

/**
 * Shutdown cancels every run still in flight (and with `continueThreadsAfterServerUpdate`
 * resumes it after the restart). Those cancellations are not the user's work ending, so
 * notifications are silenced before any of it starts.
 */
export const shutdownWithNotificationsSilenced = <A, E, R>(input: {
  readonly silenceNotifications: Effect.Effect<void>;
  readonly shutdown: Effect.Effect<A, E, R>;
}) => input.silenceNotifications.pipe(Effect.andThen(input.shutdown));

export const startEffectWorkerWithRelay = Effect.fn(
  "ServerRuntimeStartup.startEffectWorkerWithRelay",
)(function* <WorkerContext, RelayContext>(input: {
  readonly runWorker: Effect.Effect<void, never, WorkerContext>;
  readonly startRelay: Effect.Effect<void, never, RelayContext>;
  readonly workerFiberRef: Ref.Ref<Fiber.Fiber<void, never> | null>;
}) {
  const workerFiber = yield* forkParkedFiber(input.runWorker);
  yield* Ref.set(input.workerFiberRef, workerFiber);
  yield* input.startRelay.pipe(
    Effect.onExit((exit) => {
      if (Exit.isSuccess(exit)) {
        return Effect.void;
      }
      return Ref.getAndSet(input.workerFiberRef, null).pipe(
        Effect.flatMap((ownedWorkerFiber) =>
          ownedWorkerFiber === null
            ? Effect.void
            : Fiber.interrupt(ownedWorkerFiber).pipe(Effect.asVoid),
        ),
      );
    }),
  );
});

export function runOrderedV2StartupPhases<
  Import,
  Recovery,
  Bootstrap,
  ImportError,
  RecoveryError,
  WorkerError,
  BootstrapError,
  ImportContext,
  RecoveryContext,
  WorkerContext,
  BootstrapContext,
>(input: {
  readonly importLegacyShells: Effect.Effect<Import, ImportError, ImportContext>;
  readonly recover: Effect.Effect<Recovery, RecoveryError, RecoveryContext>;
  readonly startEffectWorker: Effect.Effect<void, WorkerError, WorkerContext>;
  readonly autoBootstrap: Effect.Effect<Bootstrap, BootstrapError, BootstrapContext>;
}) {
  return Effect.gen(function* () {
    yield* input.importLegacyShells;
    const recovery = yield* input.recover;
    yield* input.startEffectWorker;
    const bootstrap = yield* input.autoBootstrap;
    return { recovery, bootstrap } as const;
  });
}

const make = (options?: StartupOptions) =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig.ServerConfig;
    const keybindings = yield* Keybindings.Keybindings;
    const legacyV1ThreadImporter = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
    const providerRuntimeRecovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
    const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const agentAwarenessRelay = yield* AgentAwarenessRelay.AgentAwarenessRelay;
    const webPushRelay = yield* WebPushRelay.WebPushRelay;
    const lifecycleEvents = yield* ServerLifecycleEvents.ServerLifecycleEvents;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const environmentTheme = yield* EnvironmentThemeService;
    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
    const crypto = yield* Crypto.Crypto;
    const launcher = yield* ServiceLauncherClient.ServiceLauncherClient;

    const commandGate = yield* makeCommandGate;
    const httpListening = yield* Deferred.make<void>();
    const effectWorkerFiber = yield* Ref.make<Fiber.Fiber<void, never> | null>(null);
    const autoPullProgress = yield* Ref.make(AUTO_PULL_PROGRESS_START);

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* commandGate.failCommandReady(
          new ServerRuntimeStartupError({
            mode: serverConfig.mode,
            host: serverConfig.host ?? null,
            port: serverConfig.port,
            cause: "Server runtime is shutting down.",
          }),
        );
        yield* shutdownWithNotificationsSilenced({
          silenceNotifications: webPushRelay.stop,
          shutdown: Effect.gen(function* () {
            const workerFiber = yield* Ref.getAndSet(effectWorkerFiber, null);
            if (workerFiber !== null) {
              yield* Fiber.interrupt(workerFiber).pipe(Effect.ignore);
            }
            yield* providerRuntimeRecovery.prepareForShutdown.pipe(
              Effect.ensuring(providerSessions.shutdown),
            );
            const reconciliation = yield* providerRuntimeRecovery.reconcile("shutdown");
            yield* Effect.logInfo(
              "V2 orchestration shutdown reconciliation completed",
              reconciliation,
            );
          }),
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("V2 orchestration shutdown reconciliation failed", {
            cause: Cause.pretty(cause),
          }),
        ),
      ),
    );

    const startup = Effect.gen(function* () {
      yield* Effect.logDebug("startup phase: starting keybindings runtime");
      yield* runStartupPhase(
        "keybindings.start",
        keybindings.start.pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to start keybindings runtime", {
              path: error.configPath,
              detail: error.detail,
              cause: error.cause,
            }),
          ),
        ),
      );

      yield* Effect.logDebug("startup phase: starting server settings runtime");
      yield* runStartupPhase(
        "settings.start",
        serverSettings.start.pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to start server settings runtime", {
              path: error.settingsPath,
              operation: error.operation,
              providerInstanceId: error.providerInstanceId,
              environmentVariable: error.environmentVariable,
              cause: error.cause,
            }),
          ),
        ),
      );

      const welcomeBase = yield* resolveWelcomeBase;
      const environment = yield* serverEnvironment.getDescriptor;
      const legacyMigrationThreadCount = yield* legacyV1ThreadImporter.pendingThreadCount;
      if (legacyMigrationThreadCount > 0) {
        yield* lifecycleEvents.publish({
          version: 1,
          type: "legacyThreadMigration",
          payload: {
            status: "running",
            totalThreadCount: legacyMigrationThreadCount,
          },
        });
      }
      const { recovery, bootstrap: bootstrapTargets } = yield* runOrderedV2StartupPhases({
        importLegacyShells: runStartupPhase(
          "orchestration-v2.legacy-v1.import-shells",
          legacyV1ThreadImporter.reconcileShells.pipe(
            Effect.tap((summary) =>
              summary.importedThreadCount === 0
                ? Effect.void
                : Effect.logInfo("Imported legacy v1 thread shells", summary),
            ),
          ),
        ),
        recover: runStartupPhase("orchestration-v2.recovery", providerRuntimeRecovery.recover),
        startEffectWorker: runStartupPhase(
          "orchestration-v2.effect-worker.start",
          startEffectWorkerWithRelay({
            runWorker: EffectWorker.runDaemon,
            startRelay: agentAwarenessRelay.start(),
            workerFiberRef: effectWorkerFiber,
          }),
        ),
        autoBootstrap: (serverConfig.autoBootstrapProjectFromCwd
          ? runStartupPhase(
              "welcome.autobootstrap",
              resolveAutoBootstrapWelcomeTargets.pipe(Effect.provideService(Crypto.Crypto, crypto)),
            )
          : Effect.succeed({})
        ).pipe(Effect.map((targets): AutoBootstrapWelcomeTargets => targets)),
      });
      yield* Effect.logInfo("V2 orchestration recovery completed", recovery);
      // Awaited, deliberately, and bounded: startup blocks on it so git never pulls
      // into a root concurrently with work resumed past the activation fence. The
      // cost of awaiting it is capped by `runBoundedAutoPull` rather than left to
      // the remote - see there for why the bound has to interrupt.
      yield* runBoundedAutoPull(
        runStartupPhase(
          "projects.auto-pull",
          Effect.gen(function* () {
            const projects = yield* (yield* ProjectStore.ProjectStoreV2).listShells();
            const settings = yield* serverSettings.getSettings;
            yield* autoPullProjects(projects, settings, autoPullProgress);
          }),
        ),
        autoPullProgress,
      );

      const importPendingTranscripts = legacyV1ThreadImporter.importPendingTranscripts.pipe(
        Effect.tap((summary) =>
          summary.importedThreadCount === 0
            ? Effect.void
            : Effect.logInfo("Hydrated legacy v1 thread transcripts", summary),
        ),
      );
      yield* (
        legacyMigrationThreadCount > 0
          ? importPendingTranscripts.pipe(
              Effect.tap(() =>
                lifecycleEvents.publish({
                  version: 1,
                  type: "legacyThreadMigration",
                  payload: {
                    status: "complete",
                    totalThreadCount: legacyMigrationThreadCount,
                  },
                }),
              ),
            )
          : importPendingTranscripts
      ).pipe(forkParked);

      yield* forkParked(
        Effect.gen(function* () {
          yield* Effect.logDebug("startup phase: recording startup heartbeat");
          yield* recordStartupHeartbeat.pipe(
            Effect.annotateSpans({ "startup.phase": "heartbeat.record" }),
            Effect.withSpan("server.startup.heartbeat.record"),
            Effect.ignoreCause({ log: true }),
          );
          if (serverConfig.startupPresentation === "headless") {
            yield* Effect.logDebug("startup phase: headless access info");
            if (serverConfig.disableAuthentication) {
              // No pairing credential to mint or print — just the connection URL.
              const connectionString = yield* resolveHeadlessConnectionInfo();
              yield* runStartupPhase(
                "headless.output",
                Console.log(formatHeadlessOpenAccessOutput(connectionString)),
              );
            } else {
              const accessInfo = yield* issueHeadlessServeAccessInfo();
              yield* runStartupPhase(
                "headless.output",
                Console.log(formatHeadlessServeOutput(accessInfo)),
              );
            }
          } else {
            yield* Effect.logDebug("startup phase: browser open check");
            const startupBrowserTarget = yield* resolveStartupBrowserTarget;
            if (serverConfig.mode !== "desktop" && !serverConfig.disableAuthentication) {
              yield* Effect.logInfo(
                "Authentication required. Open T3 Code using the pairing URL.",
              ).pipe(Effect.annotateLogs({ pairingUrl: startupBrowserTarget }));
            }
            yield* runStartupPhase("browser.open", maybeOpenBrowser(startupBrowserTarget));
          }
        }),
      );

      yield* Effect.logDebug("startup phase: waiting for http listener");
      yield* runStartupPhase("http.wait", Deferred.await(httpListening));
      yield* runStartupPhase(
        "auxiliary-roots.parked",
        options?.awaitAuxiliaryParked ?? Effect.void,
      );

      const updateOutcome = yield* launcher.prepareTrial;

      yield* Effect.logDebug("startup phase: publishing welcome event", {
        environmentId: environment.environmentId,
        cwd: welcomeBase.cwd,
        projectName: welcomeBase.projectName,
        bootstrapProjectId: bootstrapTargets.bootstrapProjectId,
        bootstrapThreadId: bootstrapTargets.bootstrapThreadId,
      });
      yield* runStartupPhase(
        "welcome.publish",
        lifecycleEvents.publish({
          version: 1,
          type: "welcome",
          payload: {
            environment,
            ...welcomeBase,
            ...bootstrapTargets,
          },
        }),
      );

      yield* options?.activate ?? Effect.void;
      yield* Effect.logDebug("Accepting commands");
      yield* commandGate.signalCommandReady;
      yield* Effect.logDebug("startup phase: publishing ready event");
      yield* runStartupPhase(
        "ready.publish",
        lifecycleEvents.publish({
          version: 1,
          type: "ready",
          payload: {
            at: DateTime.formatIso(yield* DateTime.now),
            environment,
            ...(updateOutcome === undefined ? {} : { updateOutcome }),
          },
        }),
      );
      // Event-hub health gauge: the live-event backlog next to heap usage, so an internal
      // subscriber that stops taking from EventSink's unbounded hub shows up before it
      // becomes an OOM. Forked here rather than in the EventSink layer because an interval
      // fiber built with a layer starts at the test clock's epoch and replays once per
      // interval when a test warps the clock (docs/fork/README.md invariant 18).
      if (hubGaugeIntervalMs > 0) {
        const threads = yield* ThreadManagement.ThreadManagementService;
        yield* Effect.forkScoped(
          Effect.forever(
            Effect.gen(function* () {
              yield* Effect.sleep(Duration.millis(hubGaugeIntervalMs));
              const memory = process.memoryUsage();
              yield* Effect.logInfo("orchestration.hub.gauge", {
                hubBacklog: yield* threads.liveEventBacklog,
                heapUsedMb: Math.round(memory.heapUsed / 1_048_576),
                rssMb: Math.round(memory.rss / 1_048_576),
              });
            }),
          ),
        );
      }

      yield* Effect.logInfo(
        `watch rescan backstop started (${Duration.toSeconds(WATCH_RESCAN_INTERVAL)}s)`,
      );
      yield* Effect.forkScoped(
        runWatchRescanBackstop([
          serverSettings.rescan,
          keybindings.rescan,
          environmentTheme.current,
        ]),
      );

      yield* Effect.logDebug("startup phase: complete");
      yield* flushCompileCache;
    }).pipe(
      Effect.annotateSpans({
        "server.mode": serverConfig.mode,
        "server.port": serverConfig.port,
        "server.host": serverConfig.host ?? "default",
      }),
      Effect.withSpan("server.startup", { kind: "server", root: true }),
    );

    yield* Effect.forkScoped(
      Effect.exit(startup).pipe(
        Effect.flatMap((startupExit) => {
          if (Exit.isSuccess(startupExit)) return Effect.void;
          const error = new ServerRuntimeStartupError({
            mode: serverConfig.mode,
            host: serverConfig.host ?? null,
            port: serverConfig.port,
            cause: startupExit.cause,
          });
          return Effect.logError("server runtime startup failed", {
            cause: Cause.pretty(startupExit.cause),
          }).pipe(
            Effect.andThen(commandGate.failCommandReady(error)),
            Effect.andThen(options?.abort?.(error) ?? Effect.void),
          );
        }),
      ),
    );

    return {
      awaitCommandReady: commandGate.awaitCommandReady,
      markHttpListening: Deferred.succeed(httpListening, undefined),
      enqueueCommand: commandGate.enqueueCommand,
    } satisfies ServerRuntimeStartup["Service"];
  });

export const layerWithOptions = (options?: StartupOptions) =>
  Layer.effect(ServerRuntimeStartup, make(options));

const layer = layerWithOptions();
