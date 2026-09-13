/**
 * The thread queue's background send: what pressing Send in a thread would dispatch, computed
 * from stores alone so the thread need not be open. The rare branches Send handles with UI
 * (slash commands, plan follow-ups, pending questions, load balancing, attachments) are refused
 * with a reason; the queue pauses and the user finishes that send in the thread.
 */
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  type EnvironmentId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import { parseCodexFeedbackCommand } from "@t3tools/client-runtime/state/threads";
import { isUsageLimitsCommand } from "@t3tools/shared/usageLimits";

import {
  resolveEffectiveEnvMode,
  resolveLocalCheckoutBranchMismatch,
} from "../../components/BranchToolbar.logic";
import {
  deriveComposerSendState,
  deriveLockedProviderForThread,
  getAntigravitySendBlockReason,
  recallCheckoutIsRepo,
  resolveComposerInteractionMode,
  resolveComposerProviderSelection,
  resolveSendEnvMode,
  shouldShowPlanFollowUpPrompt,
} from "../../components/ChatView.logic";
import {
  getComposerPromptInjectionState,
  getComposerProviderState,
} from "../../components/chat/composerProviderState";
import { parseStandaloneComposerSlashCommand } from "../../composer-logic";
import { getComposerSubmissionValidationMessage } from "../../components/chat/composerSubmission";
import {
  deriveEffectiveComposerModelState,
  type ComposerThreadDraftState,
  type DraftSessionState,
  type DraftId,
} from "../../composerDraftStore";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  NO_PROVIDER_MODEL_SELECTION,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { isLatestTurnSettled } from "../../session-logic";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "../../types";
import { composeTurnStart, type TurnStartBootstrap } from "./composeTurnStart";

/** Everything a queued send reads, gathered from stores by the caller. */
export interface QueuedSendSnapshot {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly draftId: DraftId | null;
  readonly draft: ComposerThreadDraftState | null;
  /** Present while the thread is still a local draft. */
  readonly draftSession: DraftSessionState | null;
  /** Present once the server has the thread. */
  readonly shell: EnvironmentThreadShell | null;
  readonly project: {
    readonly id: EnvironmentThreadShell["projectId"];
    readonly workspaceRoot: string;
    readonly defaultModelSelection: ModelSelection | null;
  } | null;
  /** Null while the environment's server config has not loaded. */
  readonly providers: ReadonlyArray<ServerProvider> | null;
  readonly settings: UnifiedSettings;
  readonly environmentConnected: boolean;
  /** The project checkout's current branch, when its git status has loaded. */
  readonly currentGitBranch: string | null;
  readonly loadBalancingEnabled: boolean;
  readonly randomHex: (length: number) => string;
}

export type QueuedSendPlan =
  | { readonly kind: "empty" }
  | { readonly kind: "refused"; readonly reason: string }
  | {
      readonly kind: "send";
      readonly isLocalDraftThread: boolean;
      readonly isFirstMessage: boolean;
      readonly title: string;
      readonly outgoingMessageText: string;
      readonly bootstrap: TurnStartBootstrap | undefined;
      readonly modelSelection: ModelSelection;
      readonly persistModelSelection: boolean;
      /** The checkout moved off the thread's branch: the thread follows it, as Send does. */
      readonly persistBranch: string | null;
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
      readonly thread: {
        readonly modelSelection: ModelSelection;
        readonly branch: string | null;
        readonly runtimeMode: RuntimeMode;
        readonly interactionMode: ProviderInteractionMode;
      };
    };

const OPEN_TO_SEND = "Open the thread to send it.";

export function planQueuedSend(snapshot: QueuedSendSnapshot): QueuedSendPlan {
  const { draft, draftSession, shell, project, settings } = snapshot;
  const isLocalDraftThread = shell === null && draftSession !== null;
  if (!isLocalDraftThread && shell === null) {
    return { kind: "refused", reason: "The thread is no longer available." };
  }
  if (!snapshot.environmentConnected) {
    return { kind: "refused", reason: "Its environment is not connected." };
  }

  const prompt = draft?.prompt ?? "";
  const images = draft?.images ?? [];
  const files = draft?.files ?? [];
  const elementContexts = draft?.elementContexts ?? [];
  const previewAnnotations = draft?.previewAnnotations ?? [];
  const reviewComments = draft?.reviewComments ?? [];
  const sendState = deriveComposerSendState({
    prompt,
    imageCount: images.length + files.length,
    terminalContexts: draft?.terminalContexts ?? [],
    elementContextCount: elementContexts.length + previewAnnotations.length + reviewComments.length,
  });
  if (!sendState.hasSendableContent) return { kind: "empty" };

  if (images.length > 0 || files.length > 0) {
    return { kind: "refused", reason: `The message has attachments. ${OPEN_TO_SEND}` };
  }
  if (!project) {
    return { kind: "refused", reason: "The thread's project is no longer available." };
  }
  if (shell !== null && shell.latestUserMessageAt === null) {
    return { kind: "refused", reason: `The thread has no messages yet. ${OPEN_TO_SEND}` };
  }
  if (shell?.hasPendingUserInput) {
    return { kind: "refused", reason: `The thread is waiting on an answer. ${OPEN_TO_SEND}` };
  }
  if (
    isLocalDraftThread &&
    snapshot.loadBalancingEnabled &&
    draftSession.environmentSelection !== "manual" &&
    !draftSession.loadBalancedEnvironmentId &&
    !draftSession.branch &&
    !draftSession.worktreePath
  ) {
    return { kind: "refused", reason: `A machine has not been chosen yet. ${OPEN_TO_SEND}` };
  }
  if (snapshot.providers === null) {
    return { kind: "refused", reason: "The provider list has not loaded yet." };
  }

  const thread = isLocalDraftThread
    ? {
        modelSelection:
          project.defaultModelSelection ??
          settings.defaultModelSelection ??
          NO_PROVIDER_MODEL_SELECTION,
        branch: draftSession.branch,
        worktreePath: draftSession.worktreePath,
        runtimeMode: draftSession.runtimeMode,
        interactionMode: draftSession.interactionMode,
        createdAt: draftSession.createdAt,
        session: null,
      }
    : {
        modelSelection: shell!.modelSelection,
        branch: shell!.branch,
        worktreePath: shell!.worktreePath,
        runtimeMode: shell!.runtimeMode,
        interactionMode: shell!.interactionMode,
        createdAt: shell!.createdAt,
        session: shell!.session,
      };
  const projectDefaultModelSelection =
    project.defaultModelSelection ?? settings.defaultModelSelection;

  // Mirrors ChatView + ChatComposer's provider and model resolution.
  const providers = snapshot.providers;
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
  );
  const selectedProviderByThread = draft?.activeProvider ?? null;
  const lockedProvider = deriveLockedProviderForThread({
    started: !isLocalDraftThread,
    sessionProviderName: thread.session?.providerName ?? null,
    selectedProvider: selectedProviderByThread,
    threadProvider:
      thread.modelSelection.instanceId ?? projectDefaultModelSelection?.instanceId ?? null,
    providers,
  });
  const { selectedProviderEntry, requestedDriverKind } = resolveComposerProviderSelection({
    entries,
    candidateInstanceIds: [
      selectedProviderByThread,
      thread.session?.providerInstanceId,
      thread.modelSelection.instanceId,
      projectDefaultModelSelection?.instanceId,
    ],
    lockedProvider,
    lockedInstanceId: thread.session?.providerInstanceId ?? thread.modelSelection.instanceId,
  });
  if (!selectedProviderEntry) {
    return { kind: "refused", reason: `No provider is available for this thread. ${OPEN_TO_SEND}` };
  }
  const selectedProvider = selectedProviderEntry.driverKind ?? requestedDriverKind;
  const selectedInstanceId = selectedProviderEntry.instanceId;
  const { modelOptions, selectedModel } = deriveEffectiveComposerModelState({
    draft,
    providers,
    selectedProvider,
    selectedInstanceId,
    threadModelSelection: thread.modelSelection,
    projectModelSelection: projectDefaultModelSelection,
    settings,
  });
  const blockReason = getAntigravitySendBlockReason(selectedProviderEntry.snapshot, selectedModel);
  if (blockReason !== null) return { kind: "refused", reason: blockReason };
  const providerState = getComposerProviderState({
    provider: selectedProvider,
    model: selectedModel,
    models: selectedProviderEntry.models,
    promptInjectionState: getComposerPromptInjectionState(prompt),
    modelOptions: modelOptions?.[selectedInstanceId],
    planModeEnabled: settings.planModeEnabled,
  });
  const modelSelection = createModelSelection(
    selectedInstanceId,
    selectedModel,
    providerState.modelOptionsForDispatch,
  );
  const { enabled: interactionModeEnabled, interactionMode } = resolveComposerInteractionMode({
    planModeEnabled: settings.planModeEnabled,
    provider: selectedProviderEntry.snapshot,
    interactionMode: draft?.interactionMode ?? thread.interactionMode ?? DEFAULT_INTERACTION_MODE,
  });
  const runtimeMode = draft?.runtimeMode ?? thread.runtimeMode ?? DEFAULT_RUNTIME_MODE;

  const trimmed = sendState.trimmedPrompt;
  if (isUsageLimitsCommand(prompt) || parseCodexFeedbackCommand(trimmed) !== null) {
    return { kind: "refused", reason: `The message is a command. ${OPEN_TO_SEND}` };
  }
  if (interactionModeEnabled && parseStandaloneComposerSlashCommand(trimmed)) {
    return { kind: "refused", reason: `The message is a command. ${OPEN_TO_SEND}` };
  }
  if (
    shell !== null &&
    interactionModeEnabled &&
    shouldShowPlanFollowUpPrompt({
      pendingUserInputCount: 0,
      interactionMode,
      latestTurnSettled: isLatestTurnSettled(shell.latestTurn, shell.session),
      hasActionableProposedPlan: shell.hasActionableProposedPlan,
      hasComposerAttachments: false,
    })
  ) {
    return { kind: "refused", reason: `The thread has a plan to answer. ${OPEN_TO_SEND}` };
  }

  const sendEnvMode = isLocalDraftThread
    ? resolveSendEnvMode({
        requestedEnvMode: resolveEffectiveEnvMode({
          activeWorktreePath: draftSession.worktreePath,
          hasServerThread: false,
          draftThreadEnvMode: draftSession.envMode,
        }),
        isGitRepo:
          recallCheckoutIsRepo(
            snapshot.environmentId,
            draftSession.worktreePath ?? project.workspaceRoot,
          ) ?? true,
      })
    : "local";
  const composed = composeTurnStart({
    prompt,
    trimmedPrompt: trimmed,
    images: [],
    files: [],
    terminalContexts: sendState.sendableTerminalContexts,
    elementContexts,
    previewAnnotations,
    reviewComments,
    provider: selectedProvider,
    model: selectedModel,
    models: selectedProviderEntry.models,
    effort: providerState.promptEffort,
    modelSelection,
    projectDefaultModel: projectDefaultModelSelection?.model ?? null,
    project,
    thread,
    isLocalDraftThread,
    isFirstMessage: isLocalDraftThread,
    sendEnvMode,
    branch: thread.branch,
    startFromOrigin: isLocalDraftThread ? draftSession.startFromOrigin : false,
    runtimeMode,
    interactionMode,
    randomHex: snapshot.randomHex,
  });
  if (composed.missingWorktreeBaseBranch) {
    return { kind: "refused", reason: "Select a base branch before sending in New worktree mode." };
  }
  const validation = getComposerSubmissionValidationMessage({
    prompt,
    providerInput: composed.outgoingMessageText,
    submissionTarget: "provider-turn",
  });
  if (validation !== null) return { kind: "refused", reason: validation };

  return {
    kind: "send",
    isLocalDraftThread,
    isFirstMessage: isLocalDraftThread,
    title: composed.title,
    outgoingMessageText: composed.outgoingMessageText,
    bootstrap: composed.bootstrap,
    modelSelection,
    persistModelSelection: Boolean(selectedModel),
    persistBranch: isLocalDraftThread
      ? null
      : (resolveLocalCheckoutBranchMismatch({
          effectiveEnvMode: thread.worktreePath ? "worktree" : "local",
          activeWorktreePath: thread.worktreePath,
          activeThreadBranch: thread.branch,
          currentGitBranch: snapshot.currentGitBranch,
        })?.currentBranch ?? null),
    runtimeMode,
    interactionMode,
    thread,
  };
}
