import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthReviewWriteScope,
  AuthRelayWriteScope,
  AuthTerminalOperateScope,
  AuthAccessReadScope,
  AuthAccessStreamError,
  type AuthAccessStreamEvent,
  type AuthEnvironmentScope,
  AuthSessionId,
  CommandId,
  EventId,
  type OrchestrationCommand,
  type GitActionProgressEvent,
  type GitManagerServiceError,
  OrchestrationDispatchCommandError,
  type OrchestrationEvent,
  type OrchestrationShellStreamEvent,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetHistoryPageError,
  OrchestrationGetSnapshotError,
  OrchestrationGetTurnDiffError,
  ORCHESTRATION_WS_METHODS,
  ProjectSearchEntriesError,
  ProjectWriteFileError,
  ProjectReadFileError,
  ProjectRenderMarkdownHtmlError,
  RelayClientInstallFailedError,
  type RelayClientInstallProgressEvent,
  FilesystemBrowseError,
  EnvironmentAuthorizationError,
  ThreadId,
  type TerminalAttachStreamEvent,
  type TerminalError,
  type TerminalEvent,
  type TerminalMetadataStreamEvent,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/unstable/http";
import { RpcServer } from "effect/unstable/rpc";

import { CheckpointDiffQuery } from "./checkpointing/Services/CheckpointDiffQuery.ts";
import { writeUploadedAttachment } from "./attachmentUpload.ts";
import { ServerConfig } from "./config.ts";
import { Keybindings } from "./keybindings.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import { normalizeDispatchCommand } from "./orchestration/Normalizer.ts";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  observeRpcEffect as instrumentRpcEffect,
  observeRpcStream as instrumentRpcStream,
  observeRpcStreamEffect as instrumentRpcStreamEffect,
} from "./observability/RpcInstrumentation.ts";
import { increment, wsConnectionsTotal } from "./observability/Metrics.ts";
import { ProviderRegistry } from "./provider/Services/ProviderRegistry.ts";
import { ProviderService } from "./provider/Services/ProviderService.ts";
import * as ProviderMaintenanceRunner from "./provider/providerMaintenanceRunner.ts";
import { ServerLifecycleEvents } from "./serverLifecycleEvents.ts";
import { ServerRuntimeStartup } from "./serverRuntimeStartup.ts";
import { redactServerSettingsForClient, ServerSettingsService } from "./serverSettings.ts";
import { TerminalManager } from "./terminal/Services/Manager.ts";
import { WorkspaceEntries } from "./workspace/Services/WorkspaceEntries.ts";
import { WorkspaceFileSystem } from "./workspace/Services/WorkspaceFileSystem.ts";
import { WorkspacePathOutsideRootError } from "./workspace/Services/WorkspacePaths.ts";
import { VcsStatusBroadcaster } from "./vcs/VcsStatusBroadcaster.ts";
import { VcsProvisioningService } from "./vcs/VcsProvisioningService.ts";
import { GitWorkflowService } from "./git/GitWorkflowService.ts";
import { ReviewService } from "./review/ReviewService.ts";
import { ProjectSetupScriptRunner } from "./project/Services/ProjectSetupScriptRunner.ts";
import { ServerEnvironment } from "./environment/Services/ServerEnvironment.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import type { AuthenticatedSession } from "./auth/EnvironmentAuth.ts";
import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";
import * as HostMetrics from "./diagnostics/HostMetrics.ts";
import * as LlmModels from "./diagnostics/LlmModels.ts";
import * as ResourceQueue from "./diagnostics/ResourceQueue.ts";
import * as WebPushRelay from "./push/WebPushRelay.ts";
import { registerPushSubscription } from "./push/register.ts";
import { LlmServeManager } from "./llm/LlmServeManager.ts";
import * as ProcessResourceMonitor from "./diagnostics/ProcessResourceMonitor.ts";
import * as TraceDiagnostics from "./diagnostics/TraceDiagnostics.ts";
import * as SourceControlDiscoveryLayer from "./sourceControl/SourceControlDiscovery.ts";
import { SourceControlRepositoryService } from "./sourceControl/SourceControlRepositoryService.ts";
import * as AzureDevOpsCli from "./sourceControl/AzureDevOpsCli.ts";
import * as BitbucketApi from "./sourceControl/BitbucketApi.ts";
import * as GitHubCli from "./sourceControl/GitHubCli.ts";
import * as GitLabCli from "./sourceControl/GitLabCli.ts";
import * as SourceControlProviderRegistry from "./sourceControl/SourceControlProviderRegistry.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "./vcs/VcsDriverRegistry.ts";
import * as VcsProjectConfig from "./vcs/VcsProjectConfig.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";
import * as PairingGrantStore from "./auth/PairingGrantStore.ts";
import * as SessionStore from "./auth/SessionStore.ts";
import { failEnvironmentAuthInvalid, failEnvironmentInternal } from "./auth/http.ts";
import * as RelayClient from "@t3tools/shared/relayClient";
import {
  serializationLayerForWireFormat,
  SUPPORTED_WIRE_FORMATS,
  WIRE_FORMAT_JSON,
  WIRE_FORMAT_MSGPACK_DEFLATE_STREAM,
  WIRE_FORMAT_QUERY_PARAM,
  WS_CAPABILITIES_PATH,
} from "@t3tools/shared/rpcSerialization";
import {
  recycleSubscriptionStream,
  resolveSubscriptionRecycleLimit,
} from "./recycleSubscriptionStream.ts";
import { batchWithinStackSafe } from "./orchestration/Layers/batchWithinStackSafe.ts";
import { toHttpEffectWebsocketOrdered } from "./wsRpcServerProtocol.ts";
const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);
const isWorkspacePathOutsideRootError = Schema.is(WorkspacePathOutsideRootError);

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/**
 * Incremental-reconnect resume serves the events a client missed instead of a full
 * snapshot, but only when that window is small enough to be read completely. Kept
 * safely below the event store's read cap (1000) so the resume can never silently
 * truncate; a larger/older gap falls back to a full snapshot.
 */
const RESUME_MAX_MISSED_EVENTS = 500;

/**
 * Activity batching: coalesce a burst of thread events into one wire frame (up to
 * {@link ACTIVITY_BATCH_MAX_EVENTS}), cutting the frame count on long agentic
 * turns. Batching is backpressure-driven (see {@link batchWithinStackSafe}):
 * events coalesce exactly when they arrive faster than they can be sent to the
 * client and flush immediately otherwise. {@link ACTIVITY_BATCH_BUFFER_CAPACITY}
 * bounds the hand-off buffer so a stalled socket backpressures into the
 * subscriber-buffer drop+resync path rather than growing unbounded.
 *
 * NOTE: the previous `Stream.groupedWithin` implementation drove this with a
 * perpetual `Schedule.spaced` timer whose effect `aggregateWithin` schedule loop
 * is NOT stack-safe — every idle 20ms tick pinned continuation frames on the
 * subscription fiber's `_stack` forever, the confirmed server OOM. Do NOT
 * reintroduce `Stream.groupedWithin`/`aggregate` here.
 */
const ACTIVITY_BATCH_MAX_EVENTS = 64;
const ACTIVITY_BATCH_BUFFER_CAPACITY = 4096;

/**
 * Default thread-load window applied to the live `subscribeThread` snapshot when
 * the client sends no explicit bounds. Without this, an un-windowed subscribe of a
 * long thread decodes the ENTIRE thread (every activity/message/checkpoint blob)
 * and serializes it into a single wire frame — the "99MB single frame" that, once
 * msgpack-packed + deflated + framed, transiently allocates hundreds of MB to >1GB
 * of external buffers and OOMs the server. The windowing machinery already exists
 * in {@link ProjectionSnapshotQuery.getThreadDetailById}; this just makes the
 * bounded path the default for the live subscription instead of opt-in. Older
 * history is still reachable via `getThreadHistoryPage`. Applied ONLY when the
 * client sends neither bound, so an explicit request is always honored verbatim.
 */
const DEFAULT_SUBSCRIBE_WINDOW_TURNS = 15;
const DEFAULT_SUBSCRIBE_WINDOW_MAX_ROWS = 2000;

/**
 * Recycle a long-lived WS subscription stream after this many emitted elements:
 * end it cleanly so the effect `RpcServer` request fiber completes and frees its
 * accumulated continuation `_stack` (one frame per streamed element — an unbounded
 * ~1.7 GB/hr heap leak on long sessions), then the client resubscribes-and-resyncs.
 * See {@link ./recycleSubscriptionStream}. Env `T3CODE_WS_SUBSCRIPTION_MAX_EVENTS`
 * tunes it; `"0"` disables. Read once at module scope (env is static per process).
 */
const WS_SUBSCRIPTION_MAX_EVENTS = resolveSubscriptionRecycleLimit(
  process.env.T3CODE_WS_SUBSCRIPTION_MAX_EVENTS,
);

/**
 * Server-side ceiling for a single {@link ORCHESTRATION_WS_METHODS.getThreadHistoryPage}
 * response. The subscribe-window clamp above points clients at this RPC as the safe way
 * to load older history, so it must itself be bounded — otherwise a hostile/runaway
 * request (`maxTurns`/`maxRows` = 1e9) materializes the whole thread in one page, the
 * same OOM the subscribe clamp prevents. Set generously above the real client's backfill
 * request (25 turns / 3000 rows) so legitimate paging is never clipped; only a runaway
 * request is capped.
 */
const HISTORY_PAGE_MAX_TURNS = 100;
const HISTORY_PAGE_MAX_ROWS = 5000;

/**
 * Server-internal byte budget for a windowed snapshot and each history page: the
 * third window bound alongside turns/rows, capping frame size for the "few turns,
 * heavy payloads" thread that slips under the turn/row caps yet still ships
 * megabytes. One shared value (the ≥1-turn floor removes any need for per-path
 * tuning); not client-tunable. See the byte-bound design doc for the rationale.
 */
const WINDOW_MAX_BYTES = 4 * 1024 * 1024;

function isThreadDetailEvent(event: OrchestrationEvent): event is Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.message-sent"
      | "thread.proposed-plan-upserted"
      | "thread.activity-appended"
      | "thread.turn-diff-completed"
      | "thread.reverted"
      | "thread.session-set";
  }
> {
  return (
    event.type === "thread.message-sent" ||
    event.type === "thread.proposed-plan-upserted" ||
    event.type === "thread.activity-appended" ||
    event.type === "thread.turn-diff-completed" ||
    event.type === "thread.reverted" ||
    event.type === "thread.session-set"
  );
}

const PROVIDER_STATUS_DEBOUNCE_MS = 200;

const RPC_REQUIRED_SCOPE = new Map<string, AuthEnvironmentScope>([
  [ORCHESTRATION_WS_METHODS.dispatchCommand, AuthOrchestrationOperateScope],
  [ORCHESTRATION_WS_METHODS.getTurnDiff, AuthOrchestrationReadScope],
  [ORCHESTRATION_WS_METHODS.getFullThreadDiff, AuthOrchestrationReadScope],
  [ORCHESTRATION_WS_METHODS.subscribeShell, AuthOrchestrationReadScope],
  [ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot, AuthOrchestrationReadScope],
  [ORCHESTRATION_WS_METHODS.subscribeThread, AuthOrchestrationReadScope],
  [ORCHESTRATION_WS_METHODS.getThreadHistoryPage, AuthOrchestrationReadScope],
  [WS_METHODS.serverGetConfig, AuthOrchestrationReadScope],
  [WS_METHODS.serverRefreshProviders, AuthOrchestrationOperateScope],
  [WS_METHODS.serverUpdateProvider, AuthOrchestrationOperateScope],
  [WS_METHODS.serverUpsertKeybinding, AuthOrchestrationOperateScope],
  [WS_METHODS.serverRemoveKeybinding, AuthOrchestrationOperateScope],
  [WS_METHODS.serverGetSettings, AuthOrchestrationReadScope],
  [WS_METHODS.serverUpdateSettings, AuthOrchestrationOperateScope],
  [WS_METHODS.serverDiscoverSourceControl, AuthOrchestrationReadScope],
  [WS_METHODS.serverGetTraceDiagnostics, AuthOrchestrationReadScope],
  [WS_METHODS.serverGetProcessDiagnostics, AuthOrchestrationReadScope],
  [WS_METHODS.serverGetProcessResourceHistory, AuthOrchestrationReadScope],
  [WS_METHODS.serverSignalProcess, AuthOrchestrationOperateScope],
  [WS_METHODS.accountUsageRefresh, AuthOrchestrationReadScope],
  [WS_METHODS.cloudGetRelayClientStatus, AuthRelayWriteScope],
  [WS_METHODS.cloudInstallRelayClient, AuthRelayWriteScope],
  [WS_METHODS.sourceControlLookupRepository, AuthOrchestrationReadScope],
  [WS_METHODS.sourceControlCloneRepository, AuthOrchestrationOperateScope],
  [WS_METHODS.sourceControlPublishRepository, AuthOrchestrationOperateScope],
  [WS_METHODS.projectsSearchEntries, AuthOrchestrationReadScope],
  [WS_METHODS.projectsWriteFile, AuthOrchestrationOperateScope],
  [WS_METHODS.attachmentsUpload, AuthOrchestrationOperateScope],
  [WS_METHODS.projectsReadFile, AuthOrchestrationReadScope],
  [WS_METHODS.projectsRenderMarkdownHtml, AuthOrchestrationReadScope],
  [WS_METHODS.shellOpenInEditor, AuthOrchestrationOperateScope],
  [WS_METHODS.filesystemBrowse, AuthOrchestrationReadScope],
  [WS_METHODS.subscribeVcsStatus, AuthOrchestrationReadScope],
  [WS_METHODS.vcsRefreshStatus, AuthOrchestrationReadScope],
  [WS_METHODS.vcsPull, AuthOrchestrationOperateScope],
  [WS_METHODS.gitRunStackedAction, AuthOrchestrationOperateScope],
  [WS_METHODS.gitResolvePullRequest, AuthOrchestrationOperateScope],
  [WS_METHODS.gitPreparePullRequestThread, AuthOrchestrationOperateScope],
  [WS_METHODS.vcsListRefs, AuthOrchestrationReadScope],
  [WS_METHODS.vcsCreateWorktree, AuthOrchestrationOperateScope],
  [WS_METHODS.vcsRemoveWorktree, AuthOrchestrationOperateScope],
  [WS_METHODS.vcsCreateRef, AuthOrchestrationOperateScope],
  [WS_METHODS.vcsSwitchRef, AuthOrchestrationOperateScope],
  [WS_METHODS.vcsInit, AuthOrchestrationOperateScope],
  [WS_METHODS.reviewGetDiffPreview, AuthReviewWriteScope],
  [WS_METHODS.terminalOpen, AuthTerminalOperateScope],
  [WS_METHODS.terminalAttach, AuthTerminalOperateScope],
  [WS_METHODS.terminalWrite, AuthTerminalOperateScope],
  [WS_METHODS.terminalResize, AuthTerminalOperateScope],
  [WS_METHODS.terminalClear, AuthTerminalOperateScope],
  [WS_METHODS.terminalRestart, AuthTerminalOperateScope],
  [WS_METHODS.terminalClose, AuthTerminalOperateScope],
  [WS_METHODS.subscribeTerminalEvents, AuthTerminalOperateScope],
  [WS_METHODS.subscribeTerminalMetadata, AuthTerminalOperateScope],
  [WS_METHODS.subscribeServerConfig, AuthOrchestrationReadScope],
  [WS_METHODS.subscribeServerLifecycle, AuthOrchestrationReadScope],
  [WS_METHODS.subscribeAuthAccess, AuthAccessReadScope],
  [WS_METHODS.subscribeHostMetrics, AuthOrchestrationReadScope],
  [WS_METHODS.subscribeLlmModels, AuthOrchestrationReadScope],
  [WS_METHODS.getResourceQueue, AuthOrchestrationReadScope],
  [WS_METHODS.pushSubscriptionsRegister, AuthOrchestrationOperateScope],
  [WS_METHODS.llmServeLoad, AuthOrchestrationOperateScope],
  [WS_METHODS.llmServeUnload, AuthOrchestrationOperateScope],
]);

function toAuthAccessStreamEvent(
  change: PairingGrantStore.BootstrapCredentialChange | SessionStore.SessionCredentialChange,
  revision: number,
  currentSessionId: AuthSessionId,
): AuthAccessStreamEvent {
  switch (change.type) {
    case "pairingLinkUpserted":
      return {
        version: 1,
        revision,
        type: "pairingLinkUpserted",
        payload: change.pairingLink,
      };
    case "pairingLinkRemoved":
      return {
        version: 1,
        revision,
        type: "pairingLinkRemoved",
        payload: { id: change.id },
      };
    case "clientUpserted":
      return {
        version: 1,
        revision,
        type: "clientUpserted",
        payload: {
          ...change.clientSession,
          current: change.clientSession.sessionId === currentSessionId,
        },
      };
    case "clientRemoved":
      return {
        version: 1,
        revision,
        type: "clientRemoved",
        payload: { sessionId: change.sessionId },
      };
  }
}

const makeWsRpcLayer = (currentSession: AuthenticatedSession) =>
  WsRpcGroup.toLayer(
    Effect.gen(function* () {
      const currentSessionId = currentSession.sessionId;
      const crypto = yield* Crypto.Crypto;
      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

      // Workspace roots of the projects the server actually knows about. Used to
      // authorize file-preview reads outside `$HOME`/temp — derived from
      // server-side state, never from the client-supplied `cwd` (which would let
      // a caller pass `cwd: "/"` and read anything). Fails safe to no extra
      // roots if the read model can't be loaded.
      const trustedProjectRoots = projectionSnapshotQuery.getCommandReadModel().pipe(
        Effect.map((readModel) => readModel.projects.map((project) => project.workspaceRoot)),
        Effect.orElseSucceed(() => [] as string[]),
      );
      const orchestrationEngine = yield* OrchestrationEngineService;
      const checkpointDiffQuery = yield* CheckpointDiffQuery;
      const keybindings = yield* Keybindings;
      const externalLauncher = yield* ExternalLauncher.ExternalLauncher;
      const gitWorkflow = yield* GitWorkflowService;
      const review = yield* ReviewService;
      const vcsProvisioning = yield* VcsProvisioningService;
      const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
      const terminalManager = yield* TerminalManager;
      const providerRegistry = yield* ProviderRegistry;
      const providerService = yield* ProviderService;
      const providerMaintenanceRunner = yield* ProviderMaintenanceRunner.ProviderMaintenanceRunner;
      const config = yield* ServerConfig;
      const lifecycleEvents = yield* ServerLifecycleEvents;
      const serverSettings = yield* ServerSettingsService;
      const startup = yield* ServerRuntimeStartup;
      const workspaceEntries = yield* WorkspaceEntries;
      const workspaceFileSystem = yield* WorkspaceFileSystem;
      const projectSetupScriptRunner = yield* ProjectSetupScriptRunner;
      const serverEnvironment = yield* ServerEnvironment;
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sourceControlDiscovery = yield* SourceControlDiscoveryLayer.SourceControlDiscovery;
      const automaticGitFetchInterval = serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.automaticGitFetchInterval),
        Effect.catch((cause) =>
          Effect.logWarning("Failed to read automatic Git fetch interval setting", {
            detail: cause.message,
          }).pipe(Effect.as(DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL)),
        ),
      );
      const sourceControlRepositories = yield* SourceControlRepositoryService;
      const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
      const sessions = yield* SessionStore.SessionStore;
      const processDiagnostics = yield* ProcessDiagnostics.ProcessDiagnostics;
      const processResourceMonitor = yield* ProcessResourceMonitor.ProcessResourceMonitor;
      const llmServeManager = yield* LlmServeManager;
      const relayClient = yield* RelayClient.RelayClient;
      const webPushRelay = yield* WebPushRelay.WebPushRelay;
      const authorizationError = (requiredScope: AuthEnvironmentScope) =>
        new EnvironmentAuthorizationError({
          message: `The authenticated token is missing required scope: ${requiredScope}.`,
          requiredScope,
        });
      const authorizeEffect = <A, E, R>(
        requiredScope: AuthEnvironmentScope,
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E | EnvironmentAuthorizationError, R> =>
        currentSession.scopes.includes(requiredScope)
          ? effect
          : Effect.fail(authorizationError(requiredScope));
      const authorizeStream = <A, E, R>(
        requiredScope: AuthEnvironmentScope,
        stream: Stream.Stream<A, E, R>,
      ): Stream.Stream<A, E | EnvironmentAuthorizationError, R> =>
        currentSession.scopes.includes(requiredScope)
          ? stream
          : Stream.fail(authorizationError(requiredScope));
      const requiredScopeForMethod = (method: string): AuthEnvironmentScope => {
        const requiredScope = RPC_REQUIRED_SCOPE.get(method);
        if (requiredScope === undefined) {
          throw new Error(`RPC method ${method} has no declared authorization scope.`);
        }
        return requiredScope;
      };
      const observeRpcEffect = <A, E, R>(
        method: string,
        effect: Effect.Effect<A, E, R>,
        traceAttributes?: Readonly<Record<string, unknown>>,
      ) =>
        instrumentRpcEffect(
          method,
          authorizeEffect(requiredScopeForMethod(method), effect),
          traceAttributes,
        );
      const observeRpcStream = <A, E, R>(
        method: string,
        stream: Stream.Stream<A, E, R>,
        traceAttributes?: Readonly<Record<string, unknown>>,
      ) =>
        instrumentRpcStream(
          method,
          authorizeStream(requiredScopeForMethod(method), stream),
          traceAttributes,
        );
      const observeRpcStreamEffect = <A, StreamError, StreamContext, EffectError, EffectContext>(
        method: string,
        effect: Effect.Effect<
          Stream.Stream<A, StreamError, StreamContext>,
          EffectError,
          EffectContext
        >,
        traceAttributes?: Readonly<Record<string, unknown>>,
      ) =>
        instrumentRpcStreamEffect(
          method,
          authorizeEffect(requiredScopeForMethod(method), effect),
          traceAttributes,
        );
      const toDispatchCommandError = (cause: unknown, fallbackMessage: string) =>
        isOrchestrationDispatchCommandError(cause)
          ? cause
          : new OrchestrationDispatchCommandError({
              message: cause instanceof Error ? cause.message : fallbackMessage,
              cause,
            });
      const randomUUID = crypto.randomUUIDv4.pipe(
        Effect.mapError((cause) =>
          toDispatchCommandError(cause, "Failed to generate orchestration command identifier."),
        ),
      );
      const serverEventId = randomUUID.pipe(Effect.map(EventId.make));
      const serverCommandId = (tag: string) =>
        randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));

      const loadAuthAccessSnapshot = () =>
        Effect.all({
          pairingLinks: serverAuth.listPairingLinks(),
          clientSessions: serverAuth.listClientSessions(currentSessionId),
        }).pipe(
          Effect.mapError(
            (error) =>
              new AuthAccessStreamError({
                message: error.message,
              }),
          ),
        );

      const appendSetupScriptActivity = (input: {
        readonly threadId: ThreadId;
        readonly kind: "setup-script.requested" | "setup-script.started" | "setup-script.failed";
        readonly summary: string;
        readonly createdAt: string;
        readonly payload: Record<string, unknown>;
        readonly tone: "info" | "error";
      }) =>
        Effect.all({
          commandId: serverCommandId("setup-script-activity"),
          activityId: serverEventId,
        }).pipe(
          Effect.flatMap(({ commandId, activityId }) =>
            orchestrationEngine.dispatch({
              type: "thread.activity.append",
              commandId,
              threadId: input.threadId,
              activity: {
                id: activityId,
                tone: input.tone,
                kind: input.kind,
                summary: input.summary,
                payload: input.payload,
                turnId: null,
                createdAt: input.createdAt,
              },
              createdAt: input.createdAt,
            }),
          ),
        );

      const toBootstrapDispatchCommandCauseError = (cause: Cause.Cause<unknown>) => {
        const error = Cause.squash(cause);
        return isOrchestrationDispatchCommandError(error)
          ? error
          : new OrchestrationDispatchCommandError({
              message:
                error instanceof Error ? error.message : "Failed to bootstrap thread turn start.",
              cause,
            });
      };

      const toShellStreamEvent = (
        event: OrchestrationEvent,
      ): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, never, never> => {
        switch (event.type) {
          case "project.created":
          case "project.meta-updated":
            return projectionSnapshotQuery.getProjectShellById(event.payload.projectId).pipe(
              Effect.map((project) =>
                Option.map(project, (nextProject) => ({
                  kind: "project-upserted" as const,
                  sequence: event.sequence,
                  project: nextProject,
                })),
              ),
              Effect.orElseSucceed(() => Option.none()),
            );
          case "project.deleted":
            return Effect.succeed(
              Option.some({
                kind: "project-removed" as const,
                sequence: event.sequence,
                projectId: event.payload.projectId,
              }),
            );
          case "thread.deleted":
          case "thread.archived":
            return Effect.succeed(
              Option.some({
                kind: "thread-removed" as const,
                sequence: event.sequence,
                threadId: event.payload.threadId,
              }),
            );
          case "thread.unarchived":
            return projectionSnapshotQuery.getThreadShellById(event.payload.threadId).pipe(
              Effect.map((thread) =>
                Option.map(thread, (nextThread) => ({
                  kind: "thread-upserted" as const,
                  sequence: event.sequence,
                  thread: nextThread,
                })),
              ),
              Effect.orElseSucceed(() => Option.none()),
            );
          default:
            if (event.aggregateKind !== "thread") {
              return Effect.succeed(Option.none());
            }
            return projectionSnapshotQuery
              .getThreadShellById(ThreadId.make(event.aggregateId))
              .pipe(
                Effect.map((thread) =>
                  Option.map(thread, (nextThread) => ({
                    kind: "thread-upserted" as const,
                    sequence: event.sequence,
                    thread: nextThread,
                  })),
                ),
                Effect.orElseSucceed(() => Option.none()),
              );
        }
      };

      const dispatchBootstrapTurnStart = (
        command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
      ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> =>
        Effect.gen(function* () {
          const bootstrap = command.bootstrap;
          const { bootstrap: _bootstrap, ...finalTurnStartCommand } = command;
          let createdThread = false;
          let targetProjectId = bootstrap?.createThread?.projectId;
          let targetProjectCwd = bootstrap?.prepareWorktree?.projectCwd;
          let targetWorktreePath = bootstrap?.createThread?.worktreePath ?? null;

          const cleanupCreatedThread = () =>
            createdThread
              ? serverCommandId("bootstrap-thread-delete").pipe(
                  Effect.flatMap((commandId) =>
                    orchestrationEngine.dispatch({
                      type: "thread.delete",
                      commandId,
                      threadId: command.threadId,
                    }),
                  ),
                  Effect.ignoreCause({ log: true }),
                )
              : Effect.void;

          const recordSetupScriptLaunchFailure = (input: {
            readonly error: unknown;
            readonly requestedAt: string;
            readonly worktreePath: string;
          }) => {
            const detail =
              input.error instanceof Error ? input.error.message : "Unknown setup failure.";
            return appendSetupScriptActivity({
              threadId: command.threadId,
              kind: "setup-script.failed",
              summary: "Setup script failed to start",
              createdAt: input.requestedAt,
              payload: {
                detail,
                worktreePath: input.worktreePath,
              },
              tone: "error",
            }).pipe(
              Effect.ignoreCause({ log: false }),
              Effect.flatMap(() =>
                Effect.logWarning("bootstrap turn start failed to launch setup script", {
                  threadId: command.threadId,
                  worktreePath: input.worktreePath,
                  detail,
                }),
              ),
            );
          };

          const recordSetupScriptStarted = (input: {
            readonly requestedAt: string;
            readonly worktreePath: string;
            readonly scriptId: string;
            readonly scriptName: string;
            readonly terminalId: string;
          }) =>
            Effect.gen(function* () {
              const startedAt = yield* nowIso;
              const payload = {
                scriptId: input.scriptId,
                scriptName: input.scriptName,
                terminalId: input.terminalId,
                worktreePath: input.worktreePath,
              };
              yield* Effect.all([
                appendSetupScriptActivity({
                  threadId: command.threadId,
                  kind: "setup-script.requested",
                  summary: "Starting setup script",
                  createdAt: input.requestedAt,
                  payload,
                  tone: "info",
                }),
                appendSetupScriptActivity({
                  threadId: command.threadId,
                  kind: "setup-script.started",
                  summary: "Setup script started",
                  createdAt: startedAt,
                  payload,
                  tone: "info",
                }),
              ]).pipe(
                Effect.asVoid,
                Effect.catch((error) =>
                  Effect.logWarning(
                    "bootstrap turn start launched setup script but failed to record setup activity",
                    {
                      threadId: command.threadId,
                      worktreePath: input.worktreePath,
                      scriptId: input.scriptId,
                      terminalId: input.terminalId,
                      detail: error.message,
                    },
                  ),
                ),
              );
            });

          const runSetupProgram = () =>
            Effect.gen(function* () {
              if (!bootstrap?.runSetupScript || !targetWorktreePath) {
                return;
              }
              const worktreePath = targetWorktreePath;
              const requestedAt = yield* nowIso;
              yield* projectSetupScriptRunner
                .runForThread({
                  threadId: command.threadId,
                  ...(targetProjectId ? { projectId: targetProjectId } : {}),
                  ...(targetProjectCwd ? { projectCwd: targetProjectCwd } : {}),
                  worktreePath,
                })
                .pipe(
                  Effect.matchEffect({
                    onFailure: (error) =>
                      recordSetupScriptLaunchFailure({
                        error,
                        requestedAt,
                        worktreePath,
                      }),
                    onSuccess: (setupResult) => {
                      if (setupResult.status !== "started") {
                        return Effect.void;
                      }
                      return recordSetupScriptStarted({
                        requestedAt,
                        worktreePath,
                        scriptId: setupResult.scriptId,
                        scriptName: setupResult.scriptName,
                        terminalId: setupResult.terminalId,
                      });
                    },
                  }),
                );
            });

          const bootstrapProgram = Effect.gen(function* () {
            if (bootstrap?.createThread) {
              yield* orchestrationEngine.dispatch({
                type: "thread.create",
                commandId: yield* serverCommandId("bootstrap-thread-create"),
                threadId: command.threadId,
                projectId: bootstrap.createThread.projectId,
                title: bootstrap.createThread.title,
                modelSelection: bootstrap.createThread.modelSelection,
                runtimeMode: bootstrap.createThread.runtimeMode,
                interactionMode: bootstrap.createThread.interactionMode,
                branch: bootstrap.createThread.branch,
                worktreePath: bootstrap.createThread.worktreePath,
                createdAt: bootstrap.createThread.createdAt,
              });
              createdThread = true;
            }

            if (bootstrap?.prepareWorktree) {
              const worktree = yield* gitWorkflow.createWorktree({
                cwd: bootstrap.prepareWorktree.projectCwd,
                refName: bootstrap.prepareWorktree.baseBranch,
                newRefName: bootstrap.prepareWorktree.branch,
                path: null,
              });
              targetWorktreePath = worktree.worktree.path;
              yield* orchestrationEngine.dispatch({
                type: "thread.meta.update",
                commandId: yield* serverCommandId("bootstrap-thread-meta-update"),
                threadId: command.threadId,
                branch: worktree.worktree.refName,
                worktreePath: targetWorktreePath,
              });
              yield* refreshGitStatus(targetWorktreePath);
            }

            yield* runSetupProgram();

            return yield* orchestrationEngine.dispatch(finalTurnStartCommand);
          });

          return yield* bootstrapProgram.pipe(
            Effect.catchCause((cause) => {
              const dispatchError = toBootstrapDispatchCommandCauseError(cause);
              if (Cause.hasInterruptsOnly(cause)) {
                return Effect.fail(dispatchError);
              }
              return cleanupCreatedThread().pipe(Effect.flatMap(() => Effect.fail(dispatchError)));
            }),
          );
        });

      const dispatchNormalizedCommand = (
        normalizedCommand: OrchestrationCommand,
      ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> => {
        const dispatchEffect =
          normalizedCommand.type === "thread.turn.start" && normalizedCommand.bootstrap
            ? dispatchBootstrapTurnStart(normalizedCommand)
            : orchestrationEngine
                .dispatch(normalizedCommand)
                .pipe(
                  Effect.mapError((cause) =>
                    toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
                  ),
                );

        return startup
          .enqueueCommand(dispatchEffect)
          .pipe(
            Effect.mapError((cause) =>
              toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
            ),
          );
      };

      const loadServerConfig = Effect.gen(function* () {
        const keybindingsConfig = yield* keybindings.loadConfigState;
        const providers = yield* providerRegistry.getProviders;
        const settings = redactServerSettingsForClient(yield* serverSettings.getSettings);
        const environment = yield* serverEnvironment.getDescriptor;
        const auth = yield* serverAuth.getDescriptor();

        return {
          environment,
          auth,
          cwd: config.cwd,
          keybindingsConfigPath: config.keybindingsConfigPath,
          keybindings: keybindingsConfig.keybindings,
          issues: keybindingsConfig.issues,
          providers,
          availableEditors: ExternalLauncher.resolveAvailableEditors(),
          observability: {
            logsDirectoryPath: config.logsDir,
            localTracingEnabled: true,
            ...(config.otlpTracesUrl !== undefined ? { otlpTracesUrl: config.otlpTracesUrl } : {}),
            otlpTracesEnabled: config.otlpTracesUrl !== undefined,
            ...(config.otlpMetricsUrl !== undefined
              ? { otlpMetricsUrl: config.otlpMetricsUrl }
              : {}),
            otlpMetricsEnabled: config.otlpMetricsUrl !== undefined,
          },
          settings,
          webPushVapidPublicKey: webPushRelay.vapidPublicKey,
        };
      });

      const refreshGitStatus = (cwd: string) =>
        vcsStatusBroadcaster
          .refreshStatus(cwd)
          .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

      return WsRpcGroup.of({
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.dispatchCommand,
            Effect.gen(function* () {
              const normalizedCommand = yield* normalizeDispatchCommand(command);
              const shouldStopSessionAfterArchive =
                normalizedCommand.type === "thread.archive"
                  ? yield* projectionSnapshotQuery
                      .getThreadShellById(normalizedCommand.threadId)
                      .pipe(
                        Effect.map(
                          Option.match({
                            onNone: () => false,
                            onSome: (thread) =>
                              thread.session !== null && thread.session.status !== "stopped",
                          }),
                        ),
                        Effect.orElseSucceed(() => false),
                      )
                  : false;
              const result = yield* dispatchNormalizedCommand(normalizedCommand);
              if (normalizedCommand.type === "thread.archive") {
                if (shouldStopSessionAfterArchive) {
                  yield* Effect.gen(function* () {
                    const stopCommand = yield* normalizeDispatchCommand({
                      type: "thread.session.stop",
                      commandId: CommandId.make(
                        `session-stop-for-archive:${normalizedCommand.commandId}`,
                      ),
                      threadId: normalizedCommand.threadId,
                      createdAt: yield* nowIso,
                    });

                    yield* dispatchNormalizedCommand(stopCommand);
                  }).pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning("failed to stop provider session during archive", {
                        threadId: normalizedCommand.threadId,
                        cause,
                      }),
                    ),
                  );
                }

                yield* terminalManager.close({ threadId: normalizedCommand.threadId }).pipe(
                  Effect.catch((error) =>
                    Effect.logWarning("failed to close thread terminals after archive", {
                      threadId: normalizedCommand.threadId,
                      error: error.message,
                    }),
                  ),
                );
              }
              return result;
            }).pipe(
              Effect.mapError((cause) =>
                isOrchestrationDispatchCommandError(cause)
                  ? cause
                  : new OrchestrationDispatchCommandError({
                      message: "Failed to dispatch orchestration command",
                      cause,
                    }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getTurnDiff]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getTurnDiff,
            checkpointDiffQuery.getTurnDiff(input).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetTurnDiffError({
                    message: "Failed to load turn diff",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getFullThreadDiff]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getFullThreadDiff,
            checkpointDiffQuery.getFullThreadDiff(input).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetFullThreadDiffError({
                    message: "Failed to load full thread diff",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.subscribeShell]: (_input) =>
          observeRpcStreamEffect(
            ORCHESTRATION_WS_METHODS.subscribeShell,
            Effect.gen(function* () {
              // Subscribe to the live tail BEFORE reading the snapshot (eager
              // buffering), mirroring subscribeThread: an event committed *during*
              // the snapshot read still lands in the subscription and is replayed
              // after the snapshot, closing the read-then-live lost-event window
              // that could otherwise leave the sidebar stuck (e.g. on "Working").
              // The scope is the stream's; released when the client unsubscribes.
              const liveEvents = yield* orchestrationEngine.subscribeDomainEvents;

              const [snapshot, snapshotSequence] = yield* Effect.all([
                projectionSnapshotQuery.getShellSnapshot().pipe(
                  Effect.tapError((cause) =>
                    Effect.logError("orchestration shell snapshot load failed", { cause }),
                  ),
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationGetSnapshotError({
                        message: "Failed to load orchestration shell snapshot",
                        cause,
                      }),
                  ),
                ),
                projectionSnapshotQuery.getSnapshotSequence().pipe(
                  Effect.map(({ snapshotSequence }) => snapshotSequence),
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationGetSnapshotError({
                        message: "Failed to load orchestration snapshot sequence",
                        cause,
                      }),
                  ),
                ),
              ]);

              // Live frames strictly after the snapshot sequence dedup the read/live
              // overlap: an event captured in both the snapshot and the subscription
              // is delivered once (the snapshot already carries it).
              const liveStream = liveEvents.pipe(
                Stream.filter((event) => event.sequence > snapshotSequence),
                Stream.mapEffect(toShellStreamEvent),
                Stream.flatMap((event) =>
                  Option.isSome(event) ? Stream.succeed(event.value) : Stream.empty,
                ),
              );

              return Stream.concat(
                Stream.make({
                  kind: "snapshot" as const,
                  snapshot,
                }),
                liveStream,
              );
            }).pipe(
              // Recycle by event-count (see recycleSubscriptionStream); the
              // Effect.map covers every stream-return branch of the generator.
              Effect.map((stream) =>
                recycleSubscriptionStream(stream, WS_SUBSCRIPTION_MAX_EVENTS),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot]: (_input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
            projectionSnapshotQuery.getArchivedShellSnapshot().pipe(
              Effect.tapError((cause) =>
                Effect.logError("orchestration archived shell snapshot load failed", { cause }),
              ),
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetSnapshotError({
                    message: "Failed to load archived orchestration shell snapshot",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.subscribeThread]: (input) =>
          observeRpcStreamEffect(
            ORCHESTRATION_WS_METHODS.subscribeThread,
            Effect.gen(function* () {
              const isThisThreadEvent = (event: OrchestrationEvent) =>
                event.aggregateKind === "thread" &&
                event.aggregateId === input.threadId &&
                isThreadDetailEvent(event);

              // Subscribe to the live tail BEFORE reading any history/snapshot
              // below. The subscription starts buffering immediately (eager), so
              // an event committed *during* the read still lands in it and is
              // replayed after the history — closing the read-then-live lost-event
              // window. The scope is the stream's (Stream.unwrap ties it to the
              // subscription lifetime), so it is released when the client
              // unsubscribes. Consumed exactly once below.
              const liveEvents = yield* orchestrationEngine.subscribeDomainEvents;

              // Live frames for this thread strictly after `afterSequence`. That
              // bound dedups the read/live overlap: an event committed in the
              // subscribe→read window is in BOTH the history read and this
              // subscription, so we drop the ones the history already delivered.
              const liveStreamAfter = (afterSequence: number) =>
                batchWithinStackSafe(
                  liveEvents.pipe(
                    Stream.filter((event) => event.sequence > afterSequence),
                    Stream.filter(isThisThreadEvent),
                  ),
                  // Coalesce bursts into one batch frame by backpressure — no idle
                  // timer, stack-safe (replaces the leaking Stream.groupedWithin).
                  ACTIVITY_BATCH_MAX_EVENTS,
                  ACTIVITY_BATCH_BUFFER_CAPACITY,
                ).pipe(Stream.map((events) => ({ kind: "events" as const, events })));

              // Incremental reconnect: when the client sends its last-seen sequence,
              // stream only the thread events it missed instead of a full snapshot.
              // The events are materialized so we can tell a complete window from one
              // truncated at the store's read cap — a too-large window falls through
              // to the snapshot path rather than silently dropping the tail.
              if (input.fromSequenceExclusive !== undefined) {
                const missed = yield* Stream.runCollect(
                  orchestrationEngine.readEvents(input.fromSequenceExclusive),
                ).pipe(
                  Effect.map((chunk) => Array.from(chunk)),
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationGetSnapshotError({
                        message: `Failed to resume thread ${input.threadId}`,
                        cause,
                      }),
                  ),
                );
                if (missed.length < RESUME_MAX_MISSED_EVENTS) {
                  const missedThreadEvents = missed.filter(isThisThreadEvent);
                  // The read covered every event up to this sequence (events are
                  // returned in sequence order); the live tail resumes strictly
                  // after it so nothing is sent twice or skipped.
                  const readWatermark =
                    missed.length > 0
                      ? missed[missed.length - 1]!.sequence
                      : input.fromSequenceExclusive;
                  // Deliver all missed events in a single batch frame, then the live tail.
                  const resumeStream =
                    missedThreadEvents.length > 0
                      ? Stream.make({ kind: "events" as const, events: missedThreadEvents })
                      : Stream.empty;
                  return Stream.concat(resumeStream, liveStreamAfter(readWatermark));
                }
                // Window too large to serve completely — fall through to the snapshot.
              }

              // Defense-in-depth against a client that sends no bounds, a degenerate
              // (<= 0) bound, or an oversized row request: the snapshot is ALWAYS
              // windowed and the total row count is ALWAYS capped at the default
              // ceiling (a client may lower the row cap but never raise it; a huge
              // windowTurns is harmless because the row cap bounds total content).
              // Critically, `windowTurns: 0` is a schema-valid NonNegativeInt that
              // resolves to a null window boundary downstream and loads the ENTIRE
              // thread — the exact OOM this guards against — so a non-positive bound is
              // treated as "unset". TRADE-OFF: a bound-less client now receives only the
              // most recent window; older history must be paged via getThreadHistoryPage.
              // The web client does this (backfill loop); a client that does NOT page
              // (e.g. mobile today) sees only the recent window — an accepted regression
              // vs. the previous full-load, which was itself the OOM. (Follow-up: give
              // the shared client-runtime a backfill path so mobile can load older history.)
              const snapshotWindowTurns =
                input.windowTurns !== undefined && input.windowTurns > 0
                  ? input.windowTurns
                  : DEFAULT_SUBSCRIBE_WINDOW_TURNS;
              const snapshotMaxRows =
                input.maxRows !== undefined && input.maxRows > 0
                  ? Math.min(input.maxRows, DEFAULT_SUBSCRIBE_WINDOW_MAX_ROWS)
                  : DEFAULT_SUBSCRIBE_WINDOW_MAX_ROWS;

              const [threadDetail, snapshotSequence] = yield* Effect.all([
                projectionSnapshotQuery
                  .getThreadDetailById(input.threadId, {
                    windowTurns: snapshotWindowTurns,
                    maxRows: snapshotMaxRows,
                    maxBytes: WINDOW_MAX_BYTES,
                  })
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new OrchestrationGetSnapshotError({
                          message: `Failed to load thread ${input.threadId}`,
                          cause,
                        }),
                    ),
                  ),
                projectionSnapshotQuery.getSnapshotSequence().pipe(
                  Effect.map(({ snapshotSequence }) => snapshotSequence),
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationGetSnapshotError({
                        message: "Failed to load orchestration snapshot sequence",
                        cause,
                      }),
                  ),
                ),
              ]);

              if (Option.isNone(threadDetail)) {
                return yield* new OrchestrationGetSnapshotError({
                  message: `Thread ${input.threadId} was not found`,
                  cause: input.threadId,
                });
              }

              // The snapshot reflects state up to snapshotSequence; the live tail
              // resumes strictly after it. Because we subscribed above BEFORE this
              // read, any event committed while the snapshot loaded is in the
              // dequeue and is delivered here if it post-dates the snapshot.
              return Stream.concat(
                Stream.make({
                  kind: "snapshot" as const,
                  snapshot: {
                    snapshotSequence,
                    thread: threadDetail.value.value,
                    oldestLoaded: threadDetail.value.oldestLoaded,
                    hasMoreHistory: threadDetail.value.hasMoreHistory,
                  },
                }),
                liveStreamAfter(snapshotSequence),
              );
            }).pipe(
              // Recycle by event-count (see recycleSubscriptionStream); the
              // Effect.map covers both stream returns (resume + snapshot paths).
              Effect.map((stream) =>
                recycleSubscriptionStream(stream, WS_SUBSCRIPTION_MAX_EVENTS),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getThreadHistoryPage]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getThreadHistoryPage,
            projectionSnapshotQuery
              .getThreadHistoryPage({
                ...input,
                // Cap a single page so this "safe paging path" can't be turned into a
                // whole-thread load. Only the upper bound is a risk here (0 yields an
                // empty page, unlike subscribe's windowTurns:0), so a plain min suffices.
                maxTurns: Math.min(input.maxTurns, HISTORY_PAGE_MAX_TURNS),
                maxRows: Math.min(input.maxRows, HISTORY_PAGE_MAX_ROWS),
                // Server-internal byte bound (not on the wire): bounds a page's frame
                // size the same way as the subscribe snapshot. The ≥1-turn floor keeps
                // paging advancing even if the next-older turn alone exceeds it.
                maxBytes: WINDOW_MAX_BYTES,
              })
              .pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetHistoryPageError({
                    message: `Failed to load history page for thread ${input.threadId}`,
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [WS_METHODS.serverGetConfig]: (_input) =>
          observeRpcEffect(WS_METHODS.serverGetConfig, loadServerConfig, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverRefreshProviders]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverRefreshProviders,
            (input.instanceId !== undefined
              ? providerRegistry.refreshInstance(input.instanceId)
              : providerRegistry.refresh()
            ).pipe(Effect.map((providers) => ({ providers }))),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverUpdateProvider]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverUpdateProvider,
            providerMaintenanceRunner.updateProvider(input),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverUpsertKeybinding]: (rule) =>
          observeRpcEffect(
            WS_METHODS.serverUpsertKeybinding,
            Effect.gen(function* () {
              const keybindingsConfig = yield* keybindings.upsertKeybindingRule(rule);
              return { keybindings: keybindingsConfig, issues: [] };
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverRemoveKeybinding]: (rule) =>
          observeRpcEffect(
            WS_METHODS.serverRemoveKeybinding,
            Effect.gen(function* () {
              const keybindingsConfig = yield* keybindings.removeKeybindingRule(rule);
              return { keybindings: keybindingsConfig, issues: [] };
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverGetSettings]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverGetSettings,
            serverSettings.getSettings.pipe(Effect.map(redactServerSettingsForClient)),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverUpdateSettings]: ({ patch }) =>
          observeRpcEffect(
            WS_METHODS.serverUpdateSettings,
            serverSettings.updateSettings(patch).pipe(Effect.map(redactServerSettingsForClient)),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverDiscoverSourceControl]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverDiscoverSourceControl,
            sourceControlDiscovery.discover,
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverGetTraceDiagnostics]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverGetTraceDiagnostics,
            TraceDiagnostics.readTraceDiagnostics({
              traceFilePath: config.serverTracePath,
              maxFiles: config.traceMaxFiles,
            }),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverGetProcessDiagnostics]: (_input) =>
          observeRpcEffect(WS_METHODS.serverGetProcessDiagnostics, processDiagnostics.read, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverGetProcessResourceHistory]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverGetProcessResourceHistory,
            processResourceMonitor.readHistory(input),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverSignalProcess]: (input) =>
          observeRpcEffect(WS_METHODS.serverSignalProcess, processDiagnostics.signal(input), {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.accountUsageRefresh]: (_input) =>
          observeRpcEffect(
            WS_METHODS.accountUsageRefresh,
            providerService
              .refreshAccountUsage()
              .pipe(Effect.as({ ok: true as const })),
            { "rpc.aggregate": "account" },
          ),
        [WS_METHODS.cloudGetRelayClientStatus]: (_input) =>
          observeRpcEffect(WS_METHODS.cloudGetRelayClientStatus, relayClient.resolve, {
            "rpc.aggregate": "cloud",
          }),
        [WS_METHODS.cloudInstallRelayClient]: (_input) =>
          observeRpcStream(
            WS_METHODS.cloudInstallRelayClient,
            Stream.callback<RelayClientInstallProgressEvent, RelayClientInstallFailedError>(
              (queue) =>
                relayClient
                  .installWithProgress((event) => Queue.offer(queue, event).pipe(Effect.asVoid))
                  .pipe(
                    Effect.flatMap((status) =>
                      Queue.offer(queue, {
                        type: "complete",
                        status,
                      }),
                    ),
                    Effect.catchTag("RelayClientInstallError", (error) =>
                      Queue.fail(
                        queue,
                        new RelayClientInstallFailedError({
                          reason: error.reason,
                          message: error.message,
                        }),
                      ),
                    ),
                    Effect.andThen(Queue.end(queue)),
                    Effect.forkScoped,
                  ),
            ),
            { "rpc.aggregate": "cloud" },
          ),
        [WS_METHODS.sourceControlLookupRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlLookupRepository,
            sourceControlRepositories.lookupRepository(input),
            {
              "rpc.aggregate": "source-control",
            },
          ),
        [WS_METHODS.sourceControlCloneRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlCloneRepository,
            sourceControlRepositories.cloneRepository(input),
            {
              "rpc.aggregate": "source-control",
            },
          ),
        [WS_METHODS.sourceControlPublishRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlPublishRepository,
            sourceControlRepositories
              .publishRepository(input)
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            {
              "rpc.aggregate": "source-control",
            },
          ),
        [WS_METHODS.projectsSearchEntries]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsSearchEntries,
            workspaceEntries.search(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectSearchEntriesError({
                    message: `Failed to search workspace entries: ${cause.detail}`,
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsWriteFile]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsWriteFile,
            workspaceFileSystem.writeFile(input).pipe(
              Effect.mapError((cause) => {
                const message = isWorkspacePathOutsideRootError(cause)
                  ? "Workspace file path must stay within the project root."
                  : "Failed to write workspace file";
                return new ProjectWriteFileError({
                  message,
                  cause,
                });
              }),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsReadFile]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsReadFile,
            trustedProjectRoots.pipe(
              Effect.flatMap((roots) => workspaceFileSystem.readFile(input, roots)),
              Effect.mapError(
                (cause) =>
                  new ProjectReadFileError({
                    message: "Failed to read workspace file",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsRenderMarkdownHtml]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsRenderMarkdownHtml,
            trustedProjectRoots.pipe(
              Effect.flatMap((roots) => workspaceFileSystem.readFileAsHtml(input, roots)),
              Effect.mapError(
                (cause) =>
                  new ProjectRenderMarkdownHtmlError({
                    message: "Failed to render markdown file",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.attachmentsUpload]: (input) =>
          observeRpcEffect(
            WS_METHODS.attachmentsUpload,
            writeUploadedAttachment({
              attachmentsDir: config.attachmentsDir,
              threadId: input.threadId,
              fileName: input.fileName,
              dataBase64: input.dataBase64,
            }),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.shellOpenInEditor]: (input) =>
          observeRpcEffect(WS_METHODS.shellOpenInEditor, externalLauncher.launchEditor(input), {
            "rpc.aggregate": "workspace",
          }),
        [WS_METHODS.filesystemBrowse]: (input) =>
          observeRpcEffect(
            WS_METHODS.filesystemBrowse,
            workspaceEntries.browse(input).pipe(
              Effect.mapError(
                (cause) =>
                  new FilesystemBrowseError({
                    message: cause.detail,
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.subscribeVcsStatus]: (input) =>
          observeRpcStream(
            WS_METHODS.subscribeVcsStatus,
            // Recycle by event-count (see recycleSubscriptionStream). Safe: every
            // (re)subscribe leads with a full `snapshot` of current local+remote
            // status, which the client applies as a full replace, so a recycle
            // loses nothing.
            recycleSubscriptionStream(
              vcsStatusBroadcaster.streamStatus(input, {
                automaticRemoteRefreshInterval: automaticGitFetchInterval,
              }),
              WS_SUBSCRIPTION_MAX_EVENTS,
            ),
            {
              "rpc.aggregate": "vcs",
            },
          ),
        [WS_METHODS.vcsRefreshStatus]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsRefreshStatus,
            vcsStatusBroadcaster.refreshStatus(input.cwd),
            {
              "rpc.aggregate": "vcs",
            },
          ),
        [WS_METHODS.vcsPull]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsPull,
            gitWorkflow.pullCurrentBranch(input.cwd).pipe(
              Effect.matchCauseEffect({
                onFailure: (cause) => Effect.failCause(cause),
                onSuccess: (result) =>
                  refreshGitStatus(input.cwd).pipe(Effect.ignore({ log: true }), Effect.as(result)),
              }),
            ),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitRunStackedAction]: (input) =>
          observeRpcStream(
            WS_METHODS.gitRunStackedAction,
            Stream.callback<GitActionProgressEvent, GitManagerServiceError>((queue) =>
              gitWorkflow
                .runStackedAction(input, {
                  actionId: input.actionId,
                  progressReporter: {
                    publish: (event) => Queue.offer(queue, event).pipe(Effect.asVoid),
                  },
                })
                .pipe(
                  Effect.matchCauseEffect({
                    onFailure: (cause) => Queue.failCause(queue, cause),
                    onSuccess: () =>
                      refreshGitStatus(input.cwd).pipe(
                        Effect.andThen(Queue.end(queue).pipe(Effect.asVoid)),
                      ),
                  }),
                ),
            ),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.gitResolvePullRequest]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitResolvePullRequest,
            gitWorkflow.resolvePullRequest(input),
            {
              "rpc.aggregate": "git",
            },
          ),
        [WS_METHODS.gitPreparePullRequestThread]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitPreparePullRequestThread,
            gitWorkflow
              .preparePullRequestThread(input)
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.vcsListRefs]: (input) =>
          observeRpcEffect(WS_METHODS.vcsListRefs, gitWorkflow.listRefs(input), {
            "rpc.aggregate": "vcs",
          }),
        [WS_METHODS.vcsCreateWorktree]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsCreateWorktree,
            gitWorkflow.createWorktree(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsRemoveWorktree]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsRemoveWorktree,
            gitWorkflow.removeWorktree(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsCreateRef]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsCreateRef,
            gitWorkflow.createRef(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsSwitchRef]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsSwitchRef,
            gitWorkflow.switchRef(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsInit]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsInit,
            vcsProvisioning
              .initRepository(input)
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.reviewGetDiffPreview]: (input) =>
          observeRpcEffect(WS_METHODS.reviewGetDiffPreview, review.getDiffPreview(input), {
            "rpc.aggregate": "review",
          }),
        [WS_METHODS.terminalOpen]: (input) =>
          observeRpcEffect(WS_METHODS.terminalOpen, terminalManager.open(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalAttach]: (input) =>
          observeRpcStream(
            WS_METHODS.terminalAttach,
            Stream.callback<TerminalAttachStreamEvent, TerminalError>((queue) =>
              Effect.acquireRelease(
                terminalManager.attachStream(input, (event) => Queue.offer(queue, event)),
                (unsubscribe) => Effect.sync(unsubscribe),
              ),
            ),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.terminalWrite]: (input) =>
          observeRpcEffect(WS_METHODS.terminalWrite, terminalManager.write(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalResize]: (input) =>
          observeRpcEffect(WS_METHODS.terminalResize, terminalManager.resize(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalClear]: (input) =>
          observeRpcEffect(WS_METHODS.terminalClear, terminalManager.clear(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalRestart]: (input) =>
          observeRpcEffect(WS_METHODS.terminalRestart, terminalManager.restart(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalClose]: (input) =>
          observeRpcEffect(WS_METHODS.terminalClose, terminalManager.close(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.subscribeTerminalEvents]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeTerminalEvents,
            Stream.callback<TerminalEvent>((queue) =>
              Effect.acquireRelease(
                terminalManager.subscribe((event) => Queue.offer(queue, event)),
                (unsubscribe) => Effect.sync(unsubscribe),
              ),
            ),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.subscribeTerminalMetadata]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeTerminalMetadata,
            // Recycle by event-count (see recycleSubscriptionStream). The one
            // method gaining a genuinely-new mid-life clean completion (thread/shell
            // already recycle via boundedSubscriberStream); resync is idempotent —
            // a full metadata snapshot is re-emitted on every (re)subscribe.
            recycleSubscriptionStream(
              Stream.callback<TerminalMetadataStreamEvent>((queue) =>
                Effect.acquireRelease(
                  terminalManager.subscribeMetadata((event) => Queue.offer(queue, event)),
                  (unsubscribe) => Effect.sync(unsubscribe),
                ),
              ),
              WS_SUBSCRIPTION_MAX_EVENTS,
            ),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.subscribeServerConfig]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeServerConfig,
            Effect.gen(function* () {
              const keybindingsUpdates = keybindings.streamChanges.pipe(
                Stream.map((event) => ({
                  version: 1 as const,
                  type: "keybindingsUpdated" as const,
                  payload: {
                    keybindings: event.keybindings,
                    issues: event.issues,
                  },
                })),
              );
              const providerStatuses = providerRegistry.streamChanges.pipe(
                Stream.map((providers) => ({
                  version: 1 as const,
                  type: "providerStatuses" as const,
                  payload: { providers },
                })),
                Stream.debounce(Duration.millis(PROVIDER_STATUS_DEBOUNCE_MS)),
              );
              const settingsUpdates = serverSettings.streamChanges.pipe(
                Stream.map((settings) => redactServerSettingsForClient(settings)),
                Stream.map((settings) => ({
                  version: 1 as const,
                  type: "settingsUpdated" as const,
                  payload: { settings },
                })),
              );

              yield* providerRegistry
                .refresh()
                .pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);

              const liveUpdates = Stream.merge(
                keybindingsUpdates,
                Stream.merge(providerStatuses, settingsUpdates),
              );

              return Stream.concat(
                Stream.make({
                  version: 1 as const,
                  type: "snapshot" as const,
                  config: yield* loadServerConfig,
                }),
                liveUpdates,
              );
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.subscribeServerLifecycle]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeServerLifecycle,
            Effect.gen(function* () {
              const snapshot = yield* lifecycleEvents.snapshot;
              const snapshotEvents = Array.from(snapshot.events).toSorted(
                (left, right) => left.sequence - right.sequence,
              );
              const liveEvents = lifecycleEvents.stream.pipe(
                Stream.filter((event) => event.sequence > snapshot.sequence),
              );
              return Stream.concat(Stream.fromIterable(snapshotEvents), liveEvents);
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.subscribeHostMetrics]: (input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeHostMetrics,
            // Recycle by event-count (see recycleSubscriptionStream). Each tick is a
            // full independent sample the client full-replaces, so recycling is
            // seamless. This periodic (~1.5 s) stream crosses the default cap in
            // ~8 h, so it is a real slow contributor on long sessions.
            Effect.succeed(
              recycleSubscriptionStream(
                HostMetrics.hostMetricsStream(input.intervalMs ?? 1500),
                WS_SUBSCRIPTION_MAX_EVENTS,
              ),
            ),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.subscribeLlmModels]: (input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeLlmModels,
            // Recycle by event-count (see recycleSubscriptionStream). Each tick is a
            // full independent model snapshot the client full-replaces.
            Effect.succeed(
              recycleSubscriptionStream(
                LlmModels.llmModelsStream(input.intervalMs ?? 4000),
                WS_SUBSCRIPTION_MAX_EVENTS,
              ),
            ),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.getResourceQueue]: (_input) =>
          observeRpcEffect(WS_METHODS.getResourceQueue, ResourceQueue.readResourceQueue, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.pushSubscriptionsRegister]: (input) =>
          observeRpcEffect(
            WS_METHODS.pushSubscriptionsRegister,
            authorizeEffect(
              AuthOrchestrationOperateScope,
              // Shared with the HTTP route the service worker calls on
              // pushsubscriptionchange (SSRF guard + upsert live in one place). The
              // helper never fails; a non-"registered" outcome (disallowed endpoint
              // or persistence failure) collapses to ok:false, keeping this RPC's
              // error channel unchanged.
              registerPushSubscription(input.subscription).pipe(
                Effect.map((outcome) => ({ ok: outcome === "registered" })),
              ),
            ),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.llmServeLoad]: (input) =>
          observeRpcEffect(WS_METHODS.llmServeLoad, llmServeManager.load(input.configId), {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.llmServeUnload]: (input) =>
          observeRpcEffect(WS_METHODS.llmServeUnload, llmServeManager.unload(input.configId), {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.subscribeAuthAccess]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeAuthAccess,
            Effect.gen(function* () {
              const initialSnapshot = yield* loadAuthAccessSnapshot();
              const revisionRef = yield* Ref.make(1);
              const accessChanges: Stream.Stream<
                PairingGrantStore.BootstrapCredentialChange | SessionStore.SessionCredentialChange
              > = Stream.merge(bootstrapCredentials.streamChanges, sessions.streamChanges);

              const liveEvents: Stream.Stream<AuthAccessStreamEvent> = accessChanges.pipe(
                Stream.mapEffect((change) =>
                  Ref.updateAndGet(revisionRef, (revision) => revision + 1).pipe(
                    Effect.map((revision) =>
                      toAuthAccessStreamEvent(change, revision, currentSessionId),
                    ),
                  ),
                ),
              );

              return Stream.concat(
                Stream.make({
                  version: 1 as const,
                  revision: 1,
                  type: "snapshot" as const,
                  payload: initialSnapshot,
                }),
                liveEvents,
              );
            }),
            { "rpc.aggregate": "auth" },
          ),
      });
    }),
  );

// Unauthenticated capability probe. Advertises the wire formats this server can
// decode so a newer, separately-deployed client can confirm compressed-msgpack
// support BEFORE it opens the socket and commits to sending binary frames. An
// older server has no such route and 404s, which the client reads as "JSON only"
// — the safe fallback. Reveals nothing sensitive, so it needs no auth.
const wsCapabilitiesRouteLayer = HttpRouter.add(
  "GET",
  WS_CAPABILITIES_PATH,
  HttpServerResponse.jsonUnsafe({ wireFormats: [...SUPPORTED_WIRE_FORMATS] }),
);

export const websocketRpcRouteLayer = Layer.unwrap(
  Effect.succeed(
    HttpRouter.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;
        // Handshake negotiation: honor the client's advertised wire format, falling
        // back to JSON for clients that don't request compressed msgpack (e.g. a
        // lagging separately-deployed mobile build). JSON is a load-bearing
        // compatibility fallback, NOT deprecated-for-removal — it is what a client
        // drops to when it can't confirm msgpack support, and the only format the
        // browser test harness (msw) can carry. wsConnectionsTotal below records the
        // json-vs-msgpack split so any future removal is data-gated, not guessed.
        const requestUrl = HttpServerRequest.toURL(request);
        // Honor the client's advertised wire format; anything absent or unrecognized
        // falls back to JSON (the load-bearing compatibility floor). We only accept a
        // format this build actually supports, then build its codec via the SAME
        // helper the client uses — so `?fmt` and the decoder can never disagree.
        const requestedWireFormat = Option.isSome(requestUrl)
          ? (requestUrl.value.searchParams.get(WIRE_FORMAT_QUERY_PARAM) ?? WIRE_FORMAT_JSON)
          : WIRE_FORMAT_JSON;
        const negotiatedWireFormat = (SUPPORTED_WIRE_FORMATS as readonly string[]).includes(
          requestedWireFormat,
        )
          ? requestedWireFormat
          : WIRE_FORMAT_JSON;
        const serializationLayer = serializationLayerForWireFormat(negotiatedWireFormat);
        yield* increment(wsConnectionsTotal, { wireFormat: negotiatedWireFormat });
        const session = yield* serverAuth.authenticateWebSocketUpgrade(request).pipe(
          Effect.catchTags({
            ServerAuthInvalidCredentialError: (error) => failEnvironmentAuthInvalid(error.reason),
            ServerAuthInternalError: (error) => failEnvironmentInternal("internal_error", error),
          }),
        );
        // The context-takeover stream codec carries ONE deflate window per
        // connection, so its response frames must reach the wire in encode order
        // (see toHttpEffectWebsocketOrdered). JSON / per-frame connections are
        // order-independent and use the stock transport unchanged.
        const toWebSocketHttpEffect =
          negotiatedWireFormat === WIRE_FORMAT_MSGPACK_DEFLATE_STREAM
            ? toHttpEffectWebsocketOrdered
            : RpcServer.toHttpEffectWebsocket;
        const rpcWebSocketHttpEffect = yield* toWebSocketHttpEffect(WsRpcGroup, {
          disableTracing: true,
        }).pipe(
          Effect.provide(
            makeWsRpcLayer(session).pipe(
              Layer.provideMerge(serializationLayer),
              Layer.provide(ProviderMaintenanceRunner.layer),
              Layer.provide(
                SourceControlDiscoveryLayer.layer.pipe(
                  Layer.provide(
                    SourceControlProviderRegistry.layer.pipe(
                      Layer.provide(
                        Layer.mergeAll(
                          AzureDevOpsCli.layer,
                          BitbucketApi.layer,
                          GitHubCli.layer,
                          GitLabCli.layer,
                        ),
                      ),
                      Layer.provideMerge(GitVcsDriver.layer),
                      Layer.provide(
                        VcsDriverRegistry.layer.pipe(Layer.provide(VcsProjectConfig.layer)),
                      ),
                    ),
                  ),
                  Layer.provide(VcsProcess.layer),
                ),
              ),
            ),
          ),
        );
        return yield* Effect.acquireUseRelease(
          sessions.markConnected(session.sessionId),
          () => rpcWebSocketHttpEffect,
          () => sessions.markDisconnected(session.sessionId),
        );
      }).pipe(
        Effect.catchTags({
          EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
          EnvironmentInternalError: HttpServerRespondable.toResponse,
        }),
      ),
    ),
  ),
).pipe(Layer.merge(wsCapabilitiesRouteLayer));
