import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import { ExternalLauncherError, LaunchEditorInput } from "./editor.ts";
import {
  AuthAccessStreamError,
  AuthAccessStreamEvent,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import {
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  FilesystemBrowseError,
} from "./filesystem.ts";
import { AssetAccessError, AssetCreateUrlInput, AssetCreateUrlResult } from "./assets.ts";
import {
  GitActionProgressEvent,
  VcsSwitchRefInput,
  VcsSwitchRefResult,
  GitCommandError,
  VcsCreateRefInput,
  VcsCreateRefResult,
  VcsCreateWorktreeInput,
  VcsCreateWorktreeResult,
  VcsInitInput,
  VcsListRefsInput,
  VcsListRefsResult,
  GitManagerServiceError,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  VcsPullInput,
  GitPullRequestRefInput,
  VcsPullResult,
  VcsRemoveWorktreeInput,
  GitResolvePullRequestResult,
  GitRunStackedActionInput,
  VcsStatusInput,
  VcsStatusResult,
  VcsStatusStreamEvent,
} from "./git.ts";
import {
  ReviewDiffPreviewError,
  ReviewDiffPreviewInput,
  ReviewDiffPreviewResult,
} from "./review.ts";
import { KeybindingsConfigError } from "./keybindings.ts";
import {
  ClientOrchestrationCommand,
  ORCHESTRATION_WS_METHODS,
  OrchestrationDispatchCommandError,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetHistoryPageError,
  OrchestrationGetSnapshotError,
  OrchestrationGetTurnDiffError,
  OrchestrationGetTurnDiffInput,
  OrchestrationRpcSchemas,
} from "./orchestration.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  RelayClientInstallFailedError,
  RelayClientInstallProgressEventSchema,
  RelayClientStatusSchema,
} from "./relayClient.ts";
import {
  ProjectListEntriesError,
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectReadFileError,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectSearchEntriesError,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileError,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project.ts";
import {
  AttachmentUploadError,
  AttachmentUploadInput,
  AttachmentUploadResult,
} from "./attachment.ts";
import {
  TerminalAttachInput,
  TerminalAttachStreamEvent,
  TerminalClearInput,
  TerminalCloseInput,
  TerminalError,
  TerminalEvent,
  TerminalMetadataStreamEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./terminal.ts";
import {
  DiscoveredLocalServerList,
  PreviewCloseInput,
  PreviewError,
  PreviewEvent,
  PreviewListInput,
  PreviewListResult,
  PreviewNavigateInput,
  PreviewOpenInput,
  PreviewRefreshInput,
  PreviewReportStatusInput,
  PreviewResizeInput,
  PreviewSessionSnapshot,
} from "./preview.ts";
import {
  PreviewAutomationError,
  PreviewAutomationHost,
  PreviewAutomationHostFocus,
  PreviewAutomationResponse,
  PreviewAutomationStreamEvent,
} from "./previewAutomation.ts";
import {
  ServerConfigStreamEvent,
  ServerConfig,
  ServerProviderUpdateError,
  ServerProviderUpdateInput,
  ServerLifecycleStreamEvent,
  ServerRemoveKeybindingInput,
  ServerRemoveKeybindingResult,
  ServerProviderUpdatedPayload,
  ServerSelfUpdateError,
  ServerSelfUpdateInput,
  ServerSelfUpdateResult,
  ServerTraceDiagnosticsResult,
  ServerProcessDiagnosticsResult,
  ServerProcessResourceHistoryInput,
  ServerProcessResourceHistoryResult,
  ServerSignalProcessInput,
  ServerSignalProcessResult,
  ServerUpsertKeybindingInput,
  ServerUpsertKeybindingResult,
} from "./server.ts";
import { ServerSettings, ServerSettingsError, ServerSettingsPatch } from "./settings.ts";
import {
  SourceControlCloneRepositoryInput,
  SourceControlCloneRepositoryResult,
  SourceControlDiscoveryResult,
  SourceControlPublishRepositoryInput,
  SourceControlPublishRepositoryResult,
  SourceControlRepositoryError,
  SourceControlRepositoryInfo,
  SourceControlRepositoryLookupInput,
} from "./sourceControl.ts";
import { VcsError } from "./vcs.ts";

export const WS_METHODS = {
  // Project registry methods
  projectsList: "projects.list",
  projectsAdd: "projects.add",
  projectsRemove: "projects.remove",
  projectsListEntries: "projects.listEntries",
  projectsReadFile: "projects.readFile",
  projectsSearchEntries: "projects.searchEntries",
  projectsWriteFile: "projects.writeFile",

  // Attachment methods
  attachmentsUpload: "attachments.upload",

  // Shell methods
  shellOpenInEditor: "shell.openInEditor",

  // Filesystem methods
  filesystemBrowse: "filesystem.browse",
  assetsCreateUrl: "assets.createUrl",

  // VCS methods
  vcsPull: "vcs.pull",
  vcsRefreshStatus: "vcs.refreshStatus",
  vcsListRefs: "vcs.listRefs",
  vcsCreateWorktree: "vcs.createWorktree",
  vcsRemoveWorktree: "vcs.removeWorktree",
  vcsCreateRef: "vcs.createRef",
  vcsSwitchRef: "vcs.switchRef",
  vcsInit: "vcs.init",

  // Git workflow methods
  gitRunStackedAction: "git.runStackedAction",
  gitResolvePullRequest: "git.resolvePullRequest",
  gitPreparePullRequestThread: "git.preparePullRequestThread",

  // Review methods
  reviewGetDiffPreview: "review.getDiffPreview",

  // Terminal methods
  terminalOpen: "terminal.open",
  terminalAttach: "terminal.attach",
  terminalWrite: "terminal.write",
  terminalResize: "terminal.resize",
  terminalClear: "terminal.clear",
  terminalRestart: "terminal.restart",
  terminalClose: "terminal.close",

  // Preview methods
  previewOpen: "preview.open",
  previewNavigate: "preview.navigate",
  previewResize: "preview.resize",
  previewRefresh: "preview.refresh",
  previewClose: "preview.close",
  previewList: "preview.list",
  previewReportStatus: "preview.reportStatus",
  previewAutomationConnect: "previewAutomation.connect",
  previewAutomationRespond: "previewAutomation.respond",
  previewAutomationFocusHost: "previewAutomation.focusHost",

  // Server meta
  serverProbe: "server.probe",
  serverGetConfig: "server.getConfig",
  serverRefreshProviders: "server.refreshProviders",
  serverUpdateProvider: "server.updateProvider",
  serverUpdateServer: "server.updateServer",
  serverUpsertKeybinding: "server.upsertKeybinding",
  serverRemoveKeybinding: "server.removeKeybinding",
  serverGetSettings: "server.getSettings",
  serverUpdateSettings: "server.updateSettings",
  serverDiscoverSourceControl: "server.discoverSourceControl",
  serverGetTraceDiagnostics: "server.getTraceDiagnostics",
  serverGetProcessDiagnostics: "server.getProcessDiagnostics",
  serverGetProcessResourceHistory: "server.getProcessResourceHistory",
  serverSignalProcess: "server.signalProcess",

  // Account usage methods
  accountUsageRefresh: "account.usage.refresh",

  // Local-model manager actions (mlx-serve load/unload)
  llmServeLoad: "llmServe.load",
  llmServeUnload: "llmServe.unload",

  // Resource broker (resctl) — one-shot queue status read
  getResourceQueue: "resourceQueue.get",

  // Web Push — register this device's push subscription for background notifications
  pushSubscriptionsRegister: "pushSubscriptions.register",

  // Cloud environment methods
  cloudGetRelayClientStatus: "cloud.getRelayClientStatus",
  cloudInstallRelayClient: "cloud.installRelayClient",

  // Source control methods
  sourceControlLookupRepository: "sourceControl.lookupRepository",
  sourceControlCloneRepository: "sourceControl.cloneRepository",
  sourceControlPublishRepository: "sourceControl.publishRepository",

  // Streaming subscriptions
  subscribeVcsStatus: "subscribeVcsStatus",
  subscribeTerminalEvents: "subscribeTerminalEvents",
  subscribeTerminalMetadata: "subscribeTerminalMetadata",
  subscribePreviewEvents: "subscribePreviewEvents",
  subscribeDiscoveredLocalServers: "subscribeDiscoveredLocalServers",
  subscribeServerConfig: "subscribeServerConfig",
  subscribeServerLifecycle: "subscribeServerLifecycle",
  subscribeAuthAccess: "subscribeAuthAccess",
  subscribeHostMetrics: "subscribeHostMetrics",
  subscribeLlmModels: "subscribeLlmModels",
} as const;

export const WsServerUpsertKeybindingRpc = Rpc.make(WS_METHODS.serverUpsertKeybinding, {
  payload: ServerUpsertKeybindingInput,
  success: ServerUpsertKeybindingResult,
  error: Schema.Union([KeybindingsConfigError, EnvironmentAuthorizationError]),
});

export const WsServerRemoveKeybindingRpc = Rpc.make(WS_METHODS.serverRemoveKeybinding, {
  payload: ServerRemoveKeybindingInput,
  success: ServerRemoveKeybindingResult,
  error: Schema.Union([KeybindingsConfigError, EnvironmentAuthorizationError]),
});

export const WsServerProbeRpc = Rpc.make(WS_METHODS.serverProbe, {
  payload: Schema.Struct({}),
  success: Schema.Struct({}),
  error: EnvironmentAuthorizationError,
});

export const WsServerGetConfigRpc = Rpc.make(WS_METHODS.serverGetConfig, {
  payload: Schema.Struct({}),
  success: ServerConfig,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError, EnvironmentAuthorizationError]),
});

export const WsServerRefreshProvidersRpc = Rpc.make(WS_METHODS.serverRefreshProviders, {
  payload: Schema.Struct({
    /**
     * When supplied, only refresh this specific provider instance. When
     * omitted, refresh all configured instances — the legacy `refresh()`
     * behaviour retained for transports that still dispatch untargeted
     * refreshes.
     */
    instanceId: Schema.optional(ProviderInstanceId),
  }),
  success: ServerProviderUpdatedPayload,
  error: EnvironmentAuthorizationError,
});

export const WsServerUpdateProviderRpc = Rpc.make(WS_METHODS.serverUpdateProvider, {
  payload: ServerProviderUpdateInput,
  success: ServerProviderUpdatedPayload,
  error: Schema.Union([ServerProviderUpdateError, EnvironmentAuthorizationError]),
});

export const WsServerUpdateServerRpc = Rpc.make(WS_METHODS.serverUpdateServer, {
  payload: ServerSelfUpdateInput,
  success: ServerSelfUpdateResult,
  error: Schema.Union([ServerSelfUpdateError, EnvironmentAuthorizationError]),
});

export const WsServerGetSettingsRpc = Rpc.make(WS_METHODS.serverGetSettings, {
  payload: Schema.Struct({}),
  success: ServerSettings,
  error: Schema.Union([ServerSettingsError, EnvironmentAuthorizationError]),
});

export const WsServerUpdateSettingsRpc = Rpc.make(WS_METHODS.serverUpdateSettings, {
  payload: Schema.Struct({ patch: ServerSettingsPatch }),
  success: ServerSettings,
  error: Schema.Union([ServerSettingsError, EnvironmentAuthorizationError]),
});

export const WsServerDiscoverSourceControlRpc = Rpc.make(WS_METHODS.serverDiscoverSourceControl, {
  payload: Schema.Struct({}),
  success: SourceControlDiscoveryResult,
  error: EnvironmentAuthorizationError,
});

export const WsServerGetTraceDiagnosticsRpc = Rpc.make(WS_METHODS.serverGetTraceDiagnostics, {
  payload: Schema.Struct({}),
  success: ServerTraceDiagnosticsResult,
  error: EnvironmentAuthorizationError,
});

export const WsServerGetProcessDiagnosticsRpc = Rpc.make(WS_METHODS.serverGetProcessDiagnostics, {
  payload: Schema.Struct({}),
  success: ServerProcessDiagnosticsResult,
  error: EnvironmentAuthorizationError,
});

export const WsServerGetProcessResourceHistoryRpc = Rpc.make(
  WS_METHODS.serverGetProcessResourceHistory,
  {
    payload: ServerProcessResourceHistoryInput,
    success: ServerProcessResourceHistoryResult,
    error: EnvironmentAuthorizationError,
  },
);

export const WsServerSignalProcessRpc = Rpc.make(WS_METHODS.serverSignalProcess, {
  payload: ServerSignalProcessInput,
  success: ServerSignalProcessResult,
  error: EnvironmentAuthorizationError,
});

/**
 * Force an immediate account-usage poll. Account usage is otherwise emitted
 * only by a 60s background poller; this lets the client trigger an on-demand
 * refresh (e.g. a "force refresh" button). The poll fans the fresh snapshot
 * out to active sessions as `account.usage.updated` activities, so the success
 * value is just an acknowledgement — the updated data arrives via the event
 * stream, not this response.
 */
export const WsAccountUsageRefreshRpc = Rpc.make(WS_METHODS.accountUsageRefresh, {
  payload: Schema.Struct({}),
  success: Schema.Struct({ ok: Schema.Literal(true) }),
  error: EnvironmentAuthorizationError,
});

export const WsCloudGetRelayClientStatusRpc = Rpc.make(WS_METHODS.cloudGetRelayClientStatus, {
  payload: Schema.Struct({}),
  success: RelayClientStatusSchema,
  error: EnvironmentAuthorizationError,
});

export const WsCloudInstallRelayClientRpc = Rpc.make(WS_METHODS.cloudInstallRelayClient, {
  payload: Schema.Struct({}),
  success: RelayClientInstallProgressEventSchema,
  error: Schema.Union([RelayClientInstallFailedError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsSourceControlLookupRepositoryRpc = Rpc.make(
  WS_METHODS.sourceControlLookupRepository,
  {
    payload: SourceControlRepositoryLookupInput,
    success: SourceControlRepositoryInfo,
    error: Schema.Union([SourceControlRepositoryError, EnvironmentAuthorizationError]),
  },
);

export const WsSourceControlCloneRepositoryRpc = Rpc.make(WS_METHODS.sourceControlCloneRepository, {
  payload: SourceControlCloneRepositoryInput,
  success: SourceControlCloneRepositoryResult,
  error: Schema.Union([SourceControlRepositoryError, EnvironmentAuthorizationError]),
});

export const WsSourceControlPublishRepositoryRpc = Rpc.make(
  WS_METHODS.sourceControlPublishRepository,
  {
    payload: SourceControlPublishRepositoryInput,
    success: SourceControlPublishRepositoryResult,
    error: Schema.Union([SourceControlRepositoryError, EnvironmentAuthorizationError]),
  },
);

export const WsProjectsSearchEntriesRpc = Rpc.make(WS_METHODS.projectsSearchEntries, {
  payload: ProjectSearchEntriesInput,
  success: ProjectSearchEntriesResult,
  error: Schema.Union([ProjectSearchEntriesError, EnvironmentAuthorizationError]),
});

export const WsProjectsListEntriesRpc = Rpc.make(WS_METHODS.projectsListEntries, {
  payload: ProjectListEntriesInput,
  success: ProjectListEntriesResult,
  error: Schema.Union([ProjectListEntriesError, EnvironmentAuthorizationError]),
});

export const WsProjectsReadFileRpc = Rpc.make(WS_METHODS.projectsReadFile, {
  payload: ProjectReadFileInput,
  success: ProjectReadFileResult,
  error: Schema.Union([ProjectReadFileError, EnvironmentAuthorizationError]),
});

export const WsProjectsWriteFileRpc = Rpc.make(WS_METHODS.projectsWriteFile, {
  payload: ProjectWriteFileInput,
  success: ProjectWriteFileResult,
  error: Schema.Union([ProjectWriteFileError, EnvironmentAuthorizationError]),
});

export const WsAttachmentsUploadRpc = Rpc.make(WS_METHODS.attachmentsUpload, {
  payload: AttachmentUploadInput,
  success: AttachmentUploadResult,
  error: Schema.Union([AttachmentUploadError, EnvironmentAuthorizationError]),
});

export const WsShellOpenInEditorRpc = Rpc.make(WS_METHODS.shellOpenInEditor, {
  payload: LaunchEditorInput,
  error: Schema.Union([ExternalLauncherError, EnvironmentAuthorizationError]),
});

export const WsFilesystemBrowseRpc = Rpc.make(WS_METHODS.filesystemBrowse, {
  payload: FilesystemBrowseInput,
  success: FilesystemBrowseResult,
  error: Schema.Union([FilesystemBrowseError, EnvironmentAuthorizationError]),
});

export const WsAssetsCreateUrlRpc = Rpc.make(WS_METHODS.assetsCreateUrl, {
  payload: AssetCreateUrlInput,
  success: AssetCreateUrlResult,
  error: Schema.Union([AssetAccessError, EnvironmentAuthorizationError]),
});

export const WsSubscribeVcsStatusRpc = Rpc.make(WS_METHODS.subscribeVcsStatus, {
  payload: VcsStatusInput,
  success: VcsStatusStreamEvent,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsVcsPullRpc = Rpc.make(WS_METHODS.vcsPull, {
  payload: VcsPullInput,
  success: VcsPullResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

export const WsVcsRefreshStatusRpc = Rpc.make(WS_METHODS.vcsRefreshStatus, {
  payload: VcsStatusInput,
  success: VcsStatusResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

export const WsGitRunStackedActionRpc = Rpc.make(WS_METHODS.gitRunStackedAction, {
  payload: GitRunStackedActionInput,
  success: GitActionProgressEvent,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsGitResolvePullRequestRpc = Rpc.make(WS_METHODS.gitResolvePullRequest, {
  payload: GitPullRequestRefInput,
  success: GitResolvePullRequestResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

export const WsGitPreparePullRequestThreadRpc = Rpc.make(WS_METHODS.gitPreparePullRequestThread, {
  payload: GitPreparePullRequestThreadInput,
  success: GitPreparePullRequestThreadResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

export const WsVcsListRefsRpc = Rpc.make(WS_METHODS.vcsListRefs, {
  payload: VcsListRefsInput,
  success: VcsListRefsResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

export const WsVcsCreateWorktreeRpc = Rpc.make(WS_METHODS.vcsCreateWorktree, {
  payload: VcsCreateWorktreeInput,
  success: VcsCreateWorktreeResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

export const WsVcsRemoveWorktreeRpc = Rpc.make(WS_METHODS.vcsRemoveWorktree, {
  payload: VcsRemoveWorktreeInput,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

export const WsVcsCreateRefRpc = Rpc.make(WS_METHODS.vcsCreateRef, {
  payload: VcsCreateRefInput,
  success: VcsCreateRefResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

export const WsVcsSwitchRefRpc = Rpc.make(WS_METHODS.vcsSwitchRef, {
  payload: VcsSwitchRefInput,
  success: VcsSwitchRefResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

export const WsVcsInitRpc = Rpc.make(WS_METHODS.vcsInit, {
  payload: VcsInitInput,
  error: Schema.Union([VcsError, EnvironmentAuthorizationError]),
});

/**
 * Ephemeral live diff preview for compact/mobile surfaces.
 * Not the persisted T3 Review model. Future review sessions should use
 * review.open* + review.getSnapshot.
 */
export const WsReviewGetDiffPreviewRpc = Rpc.make(WS_METHODS.reviewGetDiffPreview, {
  payload: ReviewDiffPreviewInput,
  success: ReviewDiffPreviewResult,
  error: Schema.Union([ReviewDiffPreviewError, EnvironmentAuthorizationError]),
});

export const WsTerminalOpenRpc = Rpc.make(WS_METHODS.terminalOpen, {
  payload: TerminalOpenInput,
  success: TerminalSessionSnapshot,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsTerminalAttachRpc = Rpc.make(WS_METHODS.terminalAttach, {
  payload: TerminalAttachInput,
  success: TerminalAttachStreamEvent,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsTerminalWriteRpc = Rpc.make(WS_METHODS.terminalWrite, {
  payload: TerminalWriteInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsTerminalResizeRpc = Rpc.make(WS_METHODS.terminalResize, {
  payload: TerminalResizeInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsTerminalClearRpc = Rpc.make(WS_METHODS.terminalClear, {
  payload: TerminalClearInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsTerminalRestartRpc = Rpc.make(WS_METHODS.terminalRestart, {
  payload: TerminalRestartInput,
  success: TerminalSessionSnapshot,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsTerminalCloseRpc = Rpc.make(WS_METHODS.terminalClose, {
  payload: TerminalCloseInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsPreviewOpenRpc = Rpc.make(WS_METHODS.previewOpen, {
  payload: PreviewOpenInput,
  success: PreviewSessionSnapshot,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

export const WsPreviewNavigateRpc = Rpc.make(WS_METHODS.previewNavigate, {
  payload: PreviewNavigateInput,
  success: PreviewSessionSnapshot,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

export const WsPreviewResizeRpc = Rpc.make(WS_METHODS.previewResize, {
  payload: PreviewResizeInput,
  success: PreviewSessionSnapshot,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

export const WsPreviewRefreshRpc = Rpc.make(WS_METHODS.previewRefresh, {
  payload: PreviewRefreshInput,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

export const WsPreviewCloseRpc = Rpc.make(WS_METHODS.previewClose, {
  payload: PreviewCloseInput,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

export const WsPreviewListRpc = Rpc.make(WS_METHODS.previewList, {
  payload: PreviewListInput,
  success: PreviewListResult,
  error: EnvironmentAuthorizationError,
});

export const WsPreviewReportStatusRpc = Rpc.make(WS_METHODS.previewReportStatus, {
  payload: PreviewReportStatusInput,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

export const WsPreviewAutomationConnectRpc = Rpc.make(WS_METHODS.previewAutomationConnect, {
  payload: PreviewAutomationHost,
  success: PreviewAutomationStreamEvent,
  error: Schema.Union([PreviewAutomationError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsPreviewAutomationRespondRpc = Rpc.make(WS_METHODS.previewAutomationRespond, {
  payload: PreviewAutomationResponse,
  error: Schema.Union([PreviewAutomationError, EnvironmentAuthorizationError]),
});

export const WsPreviewAutomationFocusHostRpc = Rpc.make(WS_METHODS.previewAutomationFocusHost, {
  payload: PreviewAutomationHostFocus,
  error: EnvironmentAuthorizationError,
});

export const WsSubscribePreviewEventsRpc = Rpc.make(WS_METHODS.subscribePreviewEvents, {
  payload: Schema.Struct({}),
  success: PreviewEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsSubscribeDiscoveredLocalServersRpc = Rpc.make(
  WS_METHODS.subscribeDiscoveredLocalServers,
  {
    payload: Schema.Struct({}),
    success: DiscoveredLocalServerList,
    error: EnvironmentAuthorizationError,
    stream: true,
  },
);

export const WsOrchestrationDispatchCommandRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.dispatchCommand,
  {
    payload: ClientOrchestrationCommand,
    success: OrchestrationRpcSchemas.dispatchCommand.output,
    error: Schema.Union([OrchestrationDispatchCommandError, EnvironmentAuthorizationError]),
  },
);

export const WsOrchestrationGetTurnDiffRpc = Rpc.make(ORCHESTRATION_WS_METHODS.getTurnDiff, {
  payload: OrchestrationGetTurnDiffInput,
  success: OrchestrationRpcSchemas.getTurnDiff.output,
  error: Schema.Union([OrchestrationGetTurnDiffError, EnvironmentAuthorizationError]),
});

export const WsOrchestrationGetFullThreadDiffRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getFullThreadDiff,
  {
    payload: OrchestrationGetFullThreadDiffInput,
    success: OrchestrationRpcSchemas.getFullThreadDiff.output,
    error: Schema.Union([OrchestrationGetFullThreadDiffError, EnvironmentAuthorizationError]),
  },
);


export const WsOrchestrationGetArchivedShellSnapshotRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
  {
    payload: OrchestrationRpcSchemas.getArchivedShellSnapshot.input,
    success: OrchestrationRpcSchemas.getArchivedShellSnapshot.output,
    error: Schema.Union([OrchestrationGetSnapshotError, EnvironmentAuthorizationError]),
  },
);

export const WsOrchestrationSubscribeShellRpc = Rpc.make(ORCHESTRATION_WS_METHODS.subscribeShell, {
  payload: OrchestrationRpcSchemas.subscribeShell.input,
  success: OrchestrationRpcSchemas.subscribeShell.output,
  error: Schema.Union([OrchestrationGetSnapshotError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsOrchestrationSubscribeThreadRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.subscribeThread,
  {
    payload: OrchestrationRpcSchemas.subscribeThread.input,
    success: OrchestrationRpcSchemas.subscribeThread.output,
    error: Schema.Union([OrchestrationGetSnapshotError, EnvironmentAuthorizationError]),
    stream: true,
  },
);

export const WsOrchestrationGetThreadHistoryPageRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getThreadHistoryPage,
  {
    payload: OrchestrationRpcSchemas.getThreadHistoryPage.input,
    success: OrchestrationRpcSchemas.getThreadHistoryPage.output,
    error: Schema.Union([OrchestrationGetHistoryPageError, EnvironmentAuthorizationError]),
  },
);

export const WsSubscribeTerminalEventsRpc = Rpc.make(WS_METHODS.subscribeTerminalEvents, {
  payload: Schema.Struct({}),
  success: TerminalEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsSubscribeTerminalMetadataRpc = Rpc.make(WS_METHODS.subscribeTerminalMetadata, {
  payload: Schema.Struct({}),
  success: TerminalMetadataStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsSubscribeServerConfigRpc = Rpc.make(WS_METHODS.subscribeServerConfig, {
  payload: Schema.Struct({}),
  success: ServerConfigStreamEvent,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsSubscribeServerLifecycleRpc = Rpc.make(WS_METHODS.subscribeServerLifecycle, {
  payload: Schema.Struct({}),
  success: ServerLifecycleStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsSubscribeAuthAccessRpc = Rpc.make(WS_METHODS.subscribeAuthAccess, {
  payload: Schema.Struct({}),
  success: AuthAccessStreamEvent,
  error: Schema.Union([AuthAccessStreamError, EnvironmentAuthorizationError]),
  stream: true,
});

/** Instantaneous CPU utilization of the host running the server. */
export const HostMetricsCpu = Schema.Struct({
  /** Aggregate busy percentage across all logical cores, 0–100. */
  pct: Schema.Number,
  /** Per-logical-core busy percentage, 0–100. */
  perCore: Schema.Array(Schema.Number),
  /** 1/5/15-minute load averages (0 on platforms that don't report it). */
  loadAvg: Schema.Array(Schema.Number),
});

/** Host physical memory utilization. */
export const HostMetricsMem = Schema.Struct({
  usedBytes: Schema.Number,
  totalBytes: Schema.Number,
  /** usedBytes / totalBytes, 0–100. */
  pct: Schema.Number,
});

/** Host GPU utilization, when the platform exposes it (else the sample's gpu is null). */
export const HostMetricsGpu = Schema.Struct({
  /** Device utilization percentage, 0–100. */
  pct: Schema.Number,
  name: Schema.optional(Schema.String),
  vramUsedBytes: Schema.optional(Schema.Number),
});

/** Static host descriptor, sent once on the first sample of a subscription. */
export const HostMetricsHost = Schema.Struct({
  platform: Schema.String,
  arch: Schema.String,
  cores: Schema.Number,
});

/** One push from the host-metrics subscription, emitted roughly every 1–2s. */
export const HostMetricsSample = Schema.Struct({
  /** Sample wall-clock time (epoch ms). */
  ts: Schema.Number,
  cpu: HostMetricsCpu,
  mem: HostMetricsMem,
  /** null when the host/platform doesn't expose GPU utilization. */
  gpu: Schema.NullOr(HostMetricsGpu),
  /** Static host descriptor; sent on every sample so the client never loses it. */
  host: Schema.optional(HostMetricsHost),
});
export type HostMetricsSample = typeof HostMetricsSample.Type;

/**
 * Streaming subscription for live host-machine CPU/GPU/memory utilization. The
 * server samples only while a subscriber is attached; unsubscribing stops the
 * sampling and the stream — this is the client-side "save bandwidth" toggle.
 */
export const WsSubscribeHostMetricsRpc = Rpc.make(WS_METHODS.subscribeHostMetrics, {
  payload: Schema.Struct({ intervalMs: Schema.optional(Schema.Number) }),
  success: HostMetricsSample,
  error: EnvironmentAuthorizationError,
  stream: true,
});

/**
 * One locally-served model reported by a provider's `/v1/models` probe. Fields
 * beyond `id`/`loaded` are best-effort enrichment (mlx-serve carries them; generic
 * OpenAI-compatible providers may not) and are omitted when the provider doesn't
 * report them.
 */
export const LlmModel = Schema.Struct({
  id: Schema.String,
  /** Resident in memory. mlx-serve reports `loaded`; for providers that don't, a
   *  served/listed model is treated as loaded. */
  loaded: Schema.Boolean,
  /** Lifecycle hint, e.g. "ready" (mlx-serve). */
  state: Schema.optional(Schema.String),
  /** Resident size in bytes, when the provider reports a plausible value. */
  sizeBytes: Schema.optional(Schema.Number),
  /** e.g. "4-bit". */
  quantization: Schema.optional(Schema.String),
  /** Max context length in tokens. */
  contextLength: Schema.optional(Schema.Number),
  /** Mixture-of-experts architecture. */
  isMoe: Schema.optional(Schema.Boolean),
  capabilities: Schema.optional(Schema.Array(Schema.String)),
  /**
   * Manager state. Optional for back-compat with the read-only path; when present it
   * is the source of truth for the UI (it distinguishes loading/stopping/error from a
   * bare loaded/offline). `loaded` stays as `status === "online"`.
   */
  status: Schema.optional(
    Schema.Literals(["online", "offline", "loading", "stopping", "error"]),
  ),
  /** PID of the mlx-serve process serving this model (online/loading/stopping). */
  pid: Schema.optional(Schema.Number),
  /** Port the serving process is bound to. */
  port: Schema.optional(Schema.Number),
  /** True when t3code launched (and thus supervises) this process. */
  managed: Schema.optional(Schema.Boolean),
  /** Catalog model id this row is for (mlx dir basename / ds4 GGUF / catalog id). */
  modelId: Schema.optional(Schema.String),
  /** Stable id of the model config (LocalLlmModelConfig.id); load/unload address this. */
  configId: Schema.optional(Schema.String),
  /** User-given config name, for display. */
  configName: Schema.optional(Schema.String),
  /** Failure detail when `status === "error"`. */
  loadError: Schema.optional(Schema.String),
  /** Owning local engine (display/labelling only; load resolves the engine server-side). */
  engine: Schema.optional(Schema.Literals(["mlx-serve", "ds4"])),
});
export type LlmModel = typeof LlmModel.Type;

/** A configured local-model provider and the result of probing it this tick. */
export const LlmProvider = Schema.Struct({
  /** Display name from settings, e.g. "mlx-serve". */
  name: Schema.String,
  /** Probed base URL, e.g. "http://127.0.0.1:8765". */
  baseUrl: Schema.String,
  /** False when the endpoint didn't respond (then `models` is empty). */
  reachable: Schema.Boolean,
  /** Short failure reason when `reachable` is false. */
  error: Schema.optional(Schema.String),
  models: Schema.Array(LlmModel),
});
export type LlmProvider = typeof LlmProvider.Type;

/**
 * One push from the local-LLM subscription: every configured provider with its
 * current probe result. The server probes only while a subscriber is attached.
 */
export const LlmModelsSample = Schema.Struct({
  /** Sample wall-clock time (epoch ms). */
  ts: Schema.Number,
  providers: Schema.Array(LlmProvider),
  /** Configured RAM budget for managed loads, in bytes (omitted if unknown). */
  ramBudgetBytes: Schema.optional(Schema.Number),
  /** Sum of resident bytes across online managed/external models. */
  ramUsedBytes: Schema.optional(Schema.Number),
});
export type LlmModelsSample = typeof LlmModelsSample.Type;

/** Why a load/unload action failed (non-authorization). */
export class LlmServeError extends Schema.TaggedErrorClass<LlmServeError>()("LlmServeError", {
  kind: Schema.Literals([
    "budget_exceeded",
    "already_online",
    "no_free_port",
    "not_found",
    "spawn_failed",
    "not_managed_process",
    // Attempted to load a config whose provider is external/probe-only (not spawnable).
    "external_not_managed",
  ]),
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

/** Payload for loading/unloading a local model config (addressed by config id). */
export const LlmServeLoadPayload = Schema.Struct({ configId: Schema.String });
export const LlmServeUnloadPayload = Schema.Struct({ configId: Schema.String });

/** Load (spawn) the managed model config identified by `configId`. */
export const WsLlmServeLoadRpc = Rpc.make(WS_METHODS.llmServeLoad, {
  payload: LlmServeLoadPayload,
  success: Schema.Struct({ pid: Schema.Number, port: Schema.Number }),
  error: Schema.Union([LlmServeError, EnvironmentAuthorizationError]),
});

/** Unload (kill) the managed model config identified by `configId`. */
export const WsLlmServeUnloadRpc = Rpc.make(WS_METHODS.llmServeUnload, {
  payload: LlmServeUnloadPayload,
  success: Schema.Struct({ ok: Schema.Literal(true) }),
  error: Schema.Union([LlmServeError, EnvironmentAuthorizationError]),
});

/**
 * Streaming subscription for locally-loaded LLMs across the configured providers.
 * Mirrors `subscribeHostMetrics`: the server probes only while subscribed, and a
 * slow/unreachable provider degrades to `reachable:false` inside the sample rather
 * than failing the stream.
 */
export const WsSubscribeLlmModelsRpc = Rpc.make(WS_METHODS.subscribeLlmModels, {
  payload: Schema.Struct({ intervalMs: Schema.optional(Schema.Number) }),
  success: LlmModelsSample,
  error: EnvironmentAuthorizationError,
  stream: true,
});

/** One job in the resource broker — either holding a lease ("running") or queued ("waiting"). */
export const ResourceQueueItem = Schema.Struct({
  /** Resource pool: "gpu" | "cpu" | "ram" | "machine" (kept as a string for forward-compat). */
  resource: Schema.String,
  /** "running" = currently holding the resource; "waiting" = queued behind the holders. */
  state: Schema.Literals(["running", "waiting"]),
  /** Scheduling priority, e.g. "interactive" | "normal" | "background". */
  priority: Schema.String,
  /** The human "what & rough ETA" the job supplied when it requested the resource. */
  reason: Schema.String,
  /** Owning project. */
  project: Schema.String,
  /** Owning agent label (often equal to project); omitted when the broker doesn't report it. */
  agent: Schema.optional(Schema.String),
  /** OS process id of the job, when known. */
  pid: Schema.optional(Schema.Number),
  /** Units of the resource requested (e.g. CPU cores); 1 for indivisible pools like the GPU. */
  amount: Schema.Number,
  /** Epoch ms the job started holding (running) or was enqueued (waiting); the client derives a live elapsed from it. */
  sinceMs: Schema.Number,
  /** 1-based position within its resource's queue (waiting only). */
  pos: Schema.optional(Schema.Number),
  /** Broker ETA estimate in seconds, when available (usually absent). */
  etaSec: Schema.optional(Schema.Number),
});
export type ResourceQueueItem = typeof ResourceQueueItem.Type;

/** Capacity/usage of one resource pool at snapshot time. */
export const ResourceQueueResource = Schema.Struct({
  /** Pool name, e.g. "gpu". */
  name: Schema.String,
  /** Total units the pool can grant. */
  capacity: Schema.Number,
  /** Units currently leased out. */
  inUse: Schema.Number,
  /** Advisory pools (e.g. RAM) are tracked but not hard-enforced by the broker; true marks them. */
  advisory: Schema.optional(Schema.Boolean),
});
export type ResourceQueueResource = typeof ResourceQueueResource.Type;

/**
 * A point-in-time snapshot of the local resource broker (`resctl status`). When the broker
 * CLI is missing or unreachable the read still succeeds with `available:false` and empty
 * collections, so the UI degrades quietly instead of erroring.
 */
export const ResourceQueueSnapshot = Schema.Struct({
  /** Snapshot wall-clock time (epoch ms). */
  ts: Schema.Number,
  /** False when `resctl` could not be run or its output parsed. */
  available: Schema.Boolean,
  /** Broker is in maintenance (draining; rejecting new work). */
  maintenance: Schema.Boolean,
  /** Per-pool capacity/usage; fully-idle pools the client doesn't need are omitted. */
  resources: Schema.Array(ResourceQueueResource),
  /** Jobs holding a lease, leaders first. */
  running: Schema.Array(ResourceQueueItem),
  /** Jobs waiting in queues, ordered by resource then queue position. */
  waiting: Schema.Array(ResourceQueueItem),
});
export type ResourceQueueSnapshot = typeof ResourceQueueSnapshot.Type;

/**
 * One-shot read of the local resource-broker queue. The client polls this (slowly in the
 * background, faster while the popover is open); it is not a server push, because the two
 * cadences map cleanly onto a client-controlled interval. Never fails for an absent broker
 * — see `available`.
 */
export const WsGetResourceQueueRpc = Rpc.make(WS_METHODS.getResourceQueue, {
  payload: Schema.Struct({}),
  success: ResourceQueueSnapshot,
  error: EnvironmentAuthorizationError,
});

/**
 * A browser Web Push subscription, as produced by `PushManager.subscribe(...)`
 * `.toJSON()`. The server stores these and sends VAPID-signed pushes to the FCM
 * (etc.) `endpoint` so background thread notifications reach the device even when the
 * PWA tab is frozen (screen off). `p256dh`/`auth` are the client's public encryption
 * material — not secrets — used by the Web Push message-encryption scheme.
 */
export const PushSubscriptionInput = Schema.Struct({
  endpoint: Schema.String,
  keys: Schema.Struct({
    p256dh: Schema.String,
    auth: Schema.String,
  }),
});
export type PushSubscriptionInput = typeof PushSubscriptionInput.Type;

/**
 * Register (idempotently, keyed by `endpoint`) this device's Web Push subscription.
 * Enabling the per-device notification toggle calls this. Unregistering is handled
 * client-side (`pushManager.unsubscribe()`) plus server-side pruning when a later send
 * returns 404/410, so there is deliberately no `unregister` method in v1.
 */
export const WsPushSubscriptionsRegisterRpc = Rpc.make(WS_METHODS.pushSubscriptionsRegister, {
  payload: Schema.Struct({ subscription: PushSubscriptionInput }),
  success: Schema.Struct({ ok: Schema.Boolean }),
  error: EnvironmentAuthorizationError,
});

export const WsRpcGroup = RpcGroup.make(
  WsServerProbeRpc,
  WsServerGetConfigRpc,
  WsServerRefreshProvidersRpc,
  WsServerUpdateProviderRpc,
  WsServerUpdateServerRpc,
  WsServerUpsertKeybindingRpc,
  WsServerRemoveKeybindingRpc,
  WsServerGetSettingsRpc,
  WsServerUpdateSettingsRpc,
  WsServerDiscoverSourceControlRpc,
  WsServerGetTraceDiagnosticsRpc,
  WsServerGetProcessDiagnosticsRpc,
  WsServerGetProcessResourceHistoryRpc,
  WsServerSignalProcessRpc,
  WsAccountUsageRefreshRpc,
  WsCloudGetRelayClientStatusRpc,
  WsCloudInstallRelayClientRpc,
  WsSourceControlLookupRepositoryRpc,
  WsSourceControlCloneRepositoryRpc,
  WsSourceControlPublishRepositoryRpc,
  WsProjectsListEntriesRpc,
  WsProjectsReadFileRpc,
  WsProjectsSearchEntriesRpc,
  WsProjectsWriteFileRpc,
  WsAttachmentsUploadRpc,
  WsShellOpenInEditorRpc,
  WsFilesystemBrowseRpc,
  WsAssetsCreateUrlRpc,
  WsSubscribeVcsStatusRpc,
  WsVcsPullRpc,
  WsVcsRefreshStatusRpc,
  WsGitRunStackedActionRpc,
  WsGitResolvePullRequestRpc,
  WsGitPreparePullRequestThreadRpc,
  WsVcsListRefsRpc,
  WsVcsCreateWorktreeRpc,
  WsVcsRemoveWorktreeRpc,
  WsVcsCreateRefRpc,
  WsVcsSwitchRefRpc,
  WsVcsInitRpc,
  WsReviewGetDiffPreviewRpc,
  WsTerminalOpenRpc,
  WsTerminalAttachRpc,
  WsTerminalWriteRpc,
  WsTerminalResizeRpc,
  WsTerminalClearRpc,
  WsTerminalRestartRpc,
  WsTerminalCloseRpc,
  WsSubscribeTerminalEventsRpc,
  WsSubscribeTerminalMetadataRpc,
  WsPreviewOpenRpc,
  WsPreviewNavigateRpc,
  WsPreviewResizeRpc,
  WsPreviewRefreshRpc,
  WsPreviewCloseRpc,
  WsPreviewListRpc,
  WsPreviewReportStatusRpc,
  WsPreviewAutomationConnectRpc,
  WsPreviewAutomationRespondRpc,
  WsPreviewAutomationFocusHostRpc,
  WsSubscribePreviewEventsRpc,
  WsSubscribeDiscoveredLocalServersRpc,
  WsSubscribeServerConfigRpc,
  WsSubscribeServerLifecycleRpc,
  WsSubscribeAuthAccessRpc,
  WsSubscribeHostMetricsRpc,
  WsSubscribeLlmModelsRpc,
  WsLlmServeLoadRpc,
  WsLlmServeUnloadRpc,
  WsGetResourceQueueRpc,
  WsPushSubscriptionsRegisterRpc,
  WsOrchestrationDispatchCommandRpc,
  WsOrchestrationGetTurnDiffRpc,
  WsOrchestrationGetFullThreadDiffRpc,
  WsOrchestrationGetArchivedShellSnapshotRpc,
  WsOrchestrationSubscribeShellRpc,
  WsOrchestrationSubscribeThreadRpc,
  WsOrchestrationGetThreadHistoryPageRpc,
);
