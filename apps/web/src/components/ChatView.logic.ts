import {
  ANTIGRAVITY_DEFAULT_MODEL,
  type AssetCreateUrlInput,
  type AssetCreateUrlResult,
  type ChatFileAttachment,
  type EnvironmentId,
  isProviderDriverKind,
  ProjectId,
  type MessageId,
  type ModelSelection,
  type ProviderInteractionMode,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
  type ScopedProjectRef,
  type ScopedThreadRef,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { videoMimeType } from "@t3tools/shared/video";
import {
  appendCodexArtifactTemplateUsePrompt,
  codexArtifactTemplateUsePrompt,
  type CodexArtifactTemplate,
} from "@t3tools/client-runtime/codex-artifact-templates";
import {
  type ChatMessage,
  isImageAttachment,
  type SessionPhase,
  type Thread,
  type ThreadShell,
  type TurnDiffSummary,
} from "../types";
import { type ComposerImageAttachment, type DraftThreadState } from "../composerDraftStore";
import * as Schema from "effect/Schema";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentThreadDetails } from "../state/threads";
import {
  filterTerminalContextsWithText,
  stripInlineTerminalContextPlaceholders,
  type TerminalContextDraft,
} from "../lib/terminalContext";
import type { DraftThreadEnvMode } from "../composerDraftStore";
import type { ComposerSubmissionIntent } from "../composer-logic";
import type { TimelineEntry } from "../session-logic";
import type { DesktopPreviewOverlay } from "../previewStateStore";
import type { RightPanelSurface } from "../rightPanelStore";
import {
  NO_PROVIDER_MODEL_SELECTION,
  resolveSelectableProviderInstanceEntry,
  type ProviderInstanceEntry,
} from "../providerInstances";

export const LAST_INVOKED_SCRIPT_BY_PROJECT_KEY = "t3code:last-invoked-script-by-project";
export const MAX_HIDDEN_MOUNTED_TERMINAL_THREADS = 10;
export const MAX_HIDDEN_MOUNTED_PREVIEW_THREADS = 3;
export const ENVIRONMENT_RECONNECT_WARNING_GRACE_MS = 2_000;

export const LastInvokedScriptByProjectSchema = Schema.Record(ProjectId, Schema.String);

export function agentControlledBrowserCloseConfirmation(
  surfaces: readonly RightPanelSurface[],
  desktopByTabId: Readonly<Record<string, Pick<DesktopPreviewOverlay, "controller"> | undefined>>,
): string | null {
  const activeBrowserCount = surfaces.filter(
    (surface) =>
      surface.kind === "preview" &&
      surface.resourceId !== null &&
      desktopByTabId[surface.resourceId]?.controller === "agent",
  ).length;
  if (activeBrowserCount === 0) return null;
  if (activeBrowserCount === 1) {
    return [
      "Close browser while the agent is using it?",
      "The agent is actively controlling this browser. Closing it may interrupt the current browser action.",
    ].join("\n");
  }
  return [
    `Close ${activeBrowserCount} browsers while the agent is using them?`,
    "The agent is actively controlling these browsers. Closing them may interrupt the current browser actions.",
  ].join("\n");
}

export function shouldRenderPreviewMiniPlayer(
  miniPlayerTabId: string | null,
  renderedRightPanelSurface: RightPanelSurface | null,
): boolean {
  return (
    miniPlayerTabId !== null &&
    !(
      renderedRightPanelSurface?.kind === "preview" &&
      renderedRightPanelSurface.resourceId === miniPlayerTabId
    )
  );
}

export function shouldOpenProactivePullRequest(
  previousTargetKey: string | null | undefined,
  targetKey: string | null,
): boolean {
  return previousTargetKey !== undefined && targetKey !== null && targetKey !== previousTargetKey;
}

export function shouldOpenProactiveTurnDiff(input: {
  previousRunningTurnId: TurnId | null | undefined;
  runningTurnId: TurnId | null;
  settledTurnId: TurnId | null;
  turnCompleted: boolean;
}): boolean {
  return (
    input.previousRunningTurnId !== undefined &&
    input.previousRunningTurnId !== null &&
    input.runningTurnId === null &&
    input.turnCompleted &&
    input.settledTurnId === input.previousRunningTurnId
  );
}

export function codexArtifactTemplatePromptToAppend(
  currentDraft: string,
  template: CodexArtifactTemplate,
): string | null {
  return appendCodexArtifactTemplateUsePrompt(currentDraft, template) === currentDraft
    ? null
    : codexArtifactTemplateUsePrompt(template);
}

export function shouldDockDraftHeroForSubmission(input: {
  isDraftHeroState: boolean;
  activeThreadKey: string | null;
  submissionIntent: ComposerSubmissionIntent;
}): boolean {
  return (
    input.submissionIntent === "foreground" &&
    input.isDraftHeroState &&
    input.activeThreadKey !== null
  );
}

export function shouldReleaseTimelineAnchorForToolActivity(input: {
  anchorMessageId: MessageId | null;
  liveFollowEnabled: boolean;
  runningTurnId: TurnId | null;
  timelineEntries: ReadonlyArray<TimelineEntry>;
}): boolean {
  if (input.anchorMessageId === null || !input.liveFollowEnabled || input.runningTurnId === null) {
    return false;
  }

  return input.timelineEntries.some((timelineEntry) => {
    if (timelineEntry.kind !== "work" || timelineEntry.entry.turnId !== input.runningTurnId) {
      return false;
    }

    const entry = timelineEntry.entry;
    return (
      entry.tone === "tool" ||
      entry.itemType !== undefined ||
      entry.requestKind !== undefined ||
      (entry.command?.trim().length ?? 0) > 0
    );
  });
}

export function toolGroupConsumesUpwardNavigation(target: EventTarget | null): boolean {
  const elementTarget = target instanceof Element ? target : null;
  const group = elementTarget?.closest<HTMLElement>("[data-tool-group-scroll]");
  if (!group) return false;

  // A nested result or the group itself can consume an upward scroll.
  for (let element = elementTarget; element; element = element.parentElement) {
    if (element.scrollTop > 0) {
      const overflowY = getComputedStyle(element).overflowY;
      if (overflowY === "auto" || overflowY === "scroll") return true;
    }
    if (element === group) break;
  }
  return false;
}

export function resolveDraftHeroState(input: {
  isLocalDraftThread: boolean;
  hasTimelineEntries: boolean;
  isWorking: boolean;
  draftHeroDockRequested: boolean;
  backgroundSubmissionPending: boolean;
}): boolean {
  if (input.backgroundSubmissionPending) {
    return true;
  }
  return (
    input.isLocalDraftThread &&
    !input.hasTimelineEntries &&
    !input.isWorking &&
    !input.draftHeroDockRequested
  );
}

export function resolveDraftPromotionNavigationTarget(input: {
  serverThreadRef: ScopedThreadRef | null;
  serverThread: Pick<Thread, "latestTurn" | "session"> | null | undefined;
  backgroundSubmissionPending: boolean;
}): ScopedThreadRef | null {
  if (input.backgroundSubmissionPending) {
    return null;
  }
  const sessionStatus = input.serverThread?.session?.status;
  const turnStarted = input.serverThread?.latestTurn?.startedAt != null;
  const startupStopped =
    sessionStatus === "error" || sessionStatus === "stopped" || sessionStatus === "interrupted";
  // Keep local preparation feedback mounted until the server can render the
  // running turn or its startup error on the canonical thread route.
  return turnStarted || startupStopped ? input.serverThreadRef : null;
}

export function scheduleEnvironmentReconnectWarning(showWarning: () => void): () => void {
  const timeoutId = globalThis.setTimeout(showWarning, ENVIRONMENT_RECONNECT_WARNING_GRACE_MS);
  return () => globalThis.clearTimeout(timeoutId);
}

export function hasEnvironmentReconnectWarningGraceElapsed(
  activeEnvironmentId: EnvironmentId | null,
  elapsedEnvironmentId: EnvironmentId | null,
): boolean {
  return activeEnvironmentId !== null && activeEnvironmentId === elapsedEnvironmentId;
}

export function startNewThreadForProject(
  projectRef: ScopedProjectRef | null,
  handleNewThread: (projectRef: ScopedProjectRef) => Promise<unknown>,
): boolean {
  if (projectRef === null) return false;
  void handleNewThread(projectRef);

  return true;
}

export function resolveThreadMetadataUpdateForNextTurn(input: {
  currentModelSelection: ModelSelection;
  nextModelSelection?: ModelSelection;
  currentBranch: string | null;
  nextBranch?: string;
}): {
  modelSelection?: ModelSelection;
  branch?: string;
  worktreePath?: null;
} | null {
  const nextModelSelection = input.nextModelSelection;
  const modelSelectionChanged =
    nextModelSelection !== undefined &&
    (nextModelSelection.model !== input.currentModelSelection.model ||
      nextModelSelection.instanceId !== input.currentModelSelection.instanceId ||
      JSON.stringify(nextModelSelection.options ?? null) !==
        JSON.stringify(input.currentModelSelection.options ?? null));
  const branchChanged = input.nextBranch !== undefined && input.nextBranch !== input.currentBranch;
  if (!modelSelectionChanged && !branchChanged) {
    return null;
  }
  return {
    ...(modelSelectionChanged ? { modelSelection: nextModelSelection } : {}),
    ...(branchChanged ? { branch: input.nextBranch, worktreePath: null } : {}),
  };
}

export function buildLocalDraftThread(
  threadId: ThreadId,
  draftThread: DraftThreadState,
  fallbackModelSelection: ModelSelection,
): Thread {
  return {
    id: threadId,
    environmentId: draftThread.environmentId,
    projectId: draftThread.projectId,
    title: "New thread",
    modelSelection: fallbackModelSelection,
    runtimeMode: draftThread.runtimeMode,
    interactionMode: draftThread.interactionMode,
    session: null,
    messages: [],
    createdAt: draftThread.createdAt,
    updatedAt: draftThread.createdAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    latestTurn: null,
    branch: draftThread.branch,
    worktreePath: draftThread.worktreePath,
    checkpoints: [],
    activities: [],
    proposedPlans: [],
  };
}

export function buildLoadingThreadFromShell(shell: ThreadShell): Thread {
  return {
    ...shell,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    deletedAt: null,
  };
}

export function shouldWriteThreadErrorToCurrentServerThread(input: {
  activeServerThread:
    | {
        environmentId: EnvironmentId;
        id: ThreadId;
      }
    | null
    | undefined;
  routeThreadRef: ScopedThreadRef;
  targetThreadId: ThreadId;
}): boolean {
  return Boolean(
    input.activeServerThread &&
    input.targetThreadId === input.routeThreadRef.threadId &&
    input.activeServerThread.environmentId === input.routeThreadRef.environmentId &&
    input.activeServerThread.id === input.targetThreadId,
  );
}

export function buildThreadTurnInterruptInput(thread: Pick<Thread, "id" | "session">): {
  threadId: ThreadId;
  turnId?: TurnId;
} {
  const runningTurnId = thread.session?.status === "running" ? thread.session.activeTurnId : null;
  return {
    threadId: thread.id,
    ...(runningTurnId !== null ? { turnId: runningTurnId } : {}),
  };
}

/** Use the same enabled instance for the composer, provider status, and chat actions. */
export function resolveComposerProviderSelection(input: {
  entries: ReadonlyArray<ProviderInstanceEntry>;
  candidateInstanceIds: ReadonlyArray<ProviderInstanceId | null | undefined>;
  lockedProvider: ProviderDriverKind | null;
  lockedInstanceId: ProviderInstanceId | null | undefined;
}) {
  const requestedInstanceId = input.candidateInstanceIds.find(
    (candidate) => candidate != null && candidate !== NO_PROVIDER_MODEL_SELECTION.instanceId,
  );
  const requestedDriverKind =
    input.lockedProvider ??
    input.entries.find((entry) => entry.instanceId === requestedInstanceId)?.driverKind ??
    input.entries[0]?.driverKind ??
    ProviderDriverKind.make("unconfigured");
  const lockedContinuationGroupKey = input.lockedProvider
    ? (input.entries.find((entry) => entry.instanceId === input.lockedInstanceId)
        ?.continuationGroupKey ?? null)
    : null;
  // Missing metadata must not move Antigravity history into another Google profile.
  const requiresExactInstance =
    input.lockedProvider === "antigravity" &&
    input.lockedInstanceId != null &&
    lockedContinuationGroupKey === null;
  const compatibleEntries = input.entries.filter(
    (entry) =>
      (!input.lockedProvider || entry.driverKind === input.lockedProvider) &&
      (!lockedContinuationGroupKey || entry.continuationGroupKey === lockedContinuationGroupKey) &&
      (!requiresExactInstance || entry.instanceId === input.lockedInstanceId),
  );
  const selectedProviderEntry =
    input.candidateInstanceIds
      .map((candidate) =>
        compatibleEntries.find(
          (entry) => entry.instanceId === candidate && entry.enabled && entry.isAvailable,
        ),
      )
      .find((entry) => entry !== undefined) ??
    resolveSelectableProviderInstanceEntry(
      compatibleEntries.filter((entry) => entry.driverKind === requestedDriverKind),
      undefined,
    ) ??
    resolveSelectableProviderInstanceEntry(compatibleEntries, undefined);
  const unavailableProviderInstanceId = selectedProviderEntry
    ? undefined
    : input.lockedProvider
      ? (input.lockedInstanceId ?? requestedInstanceId)
      : requestedInstanceId;
  return {
    selectedProviderEntry,
    requestedDriverKind,
    lockedContinuationGroupKey,
    unavailableProviderInstanceId,
  };
}

/** Keep restored drafts and every plan control on the selected instance's supported mode. */
export function resolveComposerInteractionMode(input: {
  planModeEnabled: boolean;
  provider: Pick<ServerProvider, "showInteractionModeToggle"> | null | undefined;
  interactionMode: ProviderInteractionMode;
}): { enabled: boolean; interactionMode: ProviderInteractionMode } {
  const enabled =
    input.planModeEnabled &&
    input.provider != null &&
    input.provider.showInteractionModeToggle !== false;
  return {
    enabled,
    interactionMode: enabled ? input.interactionMode : "default",
  };
}

export function getAntigravitySendBlockReason(
  provider:
    | Pick<ServerProvider, "driver" | "installed" | "auth" | "models" | "status">
    | null
    | undefined,
  model: string,
): string | null {
  if (provider?.driver !== "antigravity") return null;
  if (!provider.installed) {
    return "Install Antigravity in provider settings before sending.";
  }
  if (provider.auth.status === "unauthenticated") {
    return "Sign in to Antigravity in provider settings before sending.";
  }
  const slug = model.trim();
  if (slug.length === 0) return "Choose an Antigravity model before sending.";
  // A restart clears the account status and catalog. Session startup checks
  // saved credentials and validates the model before sending the prompt.
  if (provider.auth.status === "unknown") return null;
  if (provider.models.length === 0) {
    return "Refresh Antigravity models in provider settings before sending.";
  }
  // A saved model that left the catalog is kept in the picker as unavailable
  // so the user sees what the thread used. The server rejects it at turn
  // start, so block here unless the provider is in an error state, where a
  // retry with the same model is the right move.
  if (
    provider.status === "ready" &&
    slug !== ANTIGRAVITY_DEFAULT_MODEL &&
    !provider.models.some((entry) => entry.slug === slug || entry.aliases?.includes(slug))
  ) {
    return "That Antigravity model is no longer available. Choose another model.";
  }
  return null;
}

export function buildRevertTurnCountByUserMessageId(input: {
  supportsConversationRollback: boolean;
  timelineEntries: ReadonlyArray<TimelineEntry>;
  turnDiffSummaryByAssistantMessageId: ReadonlyMap<MessageId, TurnDiffSummary>;
  inferredCheckpointTurnCountByTurnId: Readonly<Record<string, number | undefined>>;
}) {
  const byUserMessageId = new Map<MessageId, number>();
  if (!input.supportsConversationRollback) {
    return byUserMessageId;
  }
  for (let index = 0; index < input.timelineEntries.length; index += 1) {
    const entry = input.timelineEntries[index];
    if (!entry || entry.kind !== "message" || entry.message.role !== "user") {
      continue;
    }

    for (let nextIndex = index + 1; nextIndex < input.timelineEntries.length; nextIndex += 1) {
      const nextEntry = input.timelineEntries[nextIndex];
      if (!nextEntry || nextEntry.kind !== "message") {
        continue;
      }
      if (nextEntry.message.role === "user") {
        break;
      }
      const summary = input.turnDiffSummaryByAssistantMessageId.get(nextEntry.message.id);
      if (!summary) {
        continue;
      }
      const turnCount =
        summary.checkpointTurnCount ?? input.inferredCheckpointTurnCountByTurnId[summary.turnId];
      if (typeof turnCount !== "number") {
        break;
      }
      byUserMessageId.set(entry.message.id, Math.max(0, turnCount - 1));
      break;
    }
  }
  return byUserMessageId;
}

export type PendingRevertRestore = {
  readonly messageId: MessageId;
  readonly text: string;
  readonly attachmentCount: number;
  readonly threadKey: string;
  readonly targetTurnCount: number;
  readonly requestedAt: string;
};

/**
 * Decides what to do with a revert whose text is waiting to go back in the composer.
 *
 * The message leaving the thread is the signal that the revert landed, but absence alone is not
 * enough: a re-window, a reconnect, a cold subscribe or a withdraw can all empty the message list
 * without a revert. The checkpoint check is what separates them - only a landed revert removes the
 * checkpoints newer than the target.
 */
export function resolvePendingRevertRestore(input: {
  readonly pending: PendingRevertRestore | null;
  readonly activeThreadKey: string | null;
  readonly hasMessage: boolean;
  readonly maxCheckpointTurnCount: number | null;
  /**
   * True while the thread detail is loading. The placeholder thread the client renders in that
   * window spreads the shell, so it keeps the thread's key while reporting no messages and no
   * checkpoints - which is indistinguishable from a completed revert unless it is named here.
   */
  readonly isThreadLoading: boolean;
  /**
   * Set when this revert's target has a recorded failure newer than the request. A revert can be
   * accepted and then fail silently long after the RPC returned, so an armed entry would otherwise
   * wait forever.
   */
  readonly hasRevertFailure: boolean;
}): "idle" | "wait" | "restore" | "discard" {
  const { pending } = input;
  if (pending === null) return "idle";
  // No active thread is a transient teardown frame, not a switch away; discarding here would
  // silently lose a restore that was about to land.
  if (input.activeThreadKey === null || input.isThreadLoading) return "wait";
  if (input.activeThreadKey !== pending.threadKey) return "discard";
  if (input.hasRevertFailure) return "discard";
  if (input.hasMessage) return "wait";
  if (
    input.maxCheckpointTurnCount !== null &&
    input.maxCheckpointTurnCount > pending.targetTurnCount
  ) {
    return "wait";
  }
  // Only reverting to turn 0 legitimately leaves a thread with no checkpoints at all. Anything
  // else with none has not loaded them yet.
  if (input.maxCheckpointTurnCount === null && pending.targetTurnCount > 0) return "wait";
  return "restore";
}

export function reconcileMountedTerminalThreadIds(input: {
  currentThreadIds: ReadonlyArray<string>;
  openThreadIds: ReadonlyArray<string>;
  activeThreadId: string | null;
  activeThreadTerminalOpen: boolean;
  maxHiddenThreadCount?: number;
}): string[] {
  return reconcileRetainedMountedThreadIds({
    currentThreadIds: input.currentThreadIds,
    openThreadIds: input.openThreadIds,
    activeThreadId: input.activeThreadId,
    activeThreadOpen: input.activeThreadTerminalOpen,
    maxHiddenThreadCount: input.maxHiddenThreadCount ?? MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  });
}

export function reconcileRetainedMountedThreadIds(input: {
  currentThreadIds: ReadonlyArray<string>;
  openThreadIds: ReadonlyArray<string>;
  activeThreadId: string | null;
  activeThreadOpen: boolean;
  maxHiddenThreadCount: number;
  retainInactiveActiveThread?: boolean;
}): string[] {
  const openThreadIdSet = new Set(input.openThreadIds);
  const hiddenThreadIds = input.currentThreadIds.filter(
    (threadId) =>
      (threadId !== input.activeThreadId || input.retainInactiveActiveThread === true) &&
      openThreadIdSet.has(threadId),
  );
  const maxHiddenThreadCount = Math.max(0, input.maxHiddenThreadCount);
  const nextThreadIds =
    hiddenThreadIds.length > maxHiddenThreadCount
      ? hiddenThreadIds.slice(-maxHiddenThreadCount)
      : hiddenThreadIds;

  if (
    input.activeThreadId &&
    input.activeThreadOpen &&
    !nextThreadIds.includes(input.activeThreadId)
  ) {
    nextThreadIds.push(input.activeThreadId);
  }

  return nextThreadIds;
}

export function revokeBlobPreviewUrl(previewUrl: string | undefined): void {
  if (!previewUrl || typeof URL === "undefined" || !previewUrl.startsWith("blob:")) {
    return;
  }
  URL.revokeObjectURL(previewUrl);
}

/** Signs an attachment URL without reading its bytes, so video playback can request byte ranges. */
export async function resolveFileAttachmentUrl(input: {
  attachment: ChatFileAttachment;
  environmentId: EnvironmentId;
  httpBaseUrl: string;
  createAssetUrl: (input: {
    environmentId: EnvironmentId;
    input: AssetCreateUrlInput;
  }) => Promise<AtomCommandResult<AssetCreateUrlResult, unknown>>;
}): Promise<string> {
  const { attachment } = input;
  const result = await input.createAssetUrl({
    environmentId: input.environmentId,
    input: {
      resource: {
        _tag: "attachment",
        attachmentId: attachment.id,
        fileName: attachment.name,
        mimeType: videoMimeType(attachment) ?? attachment.mimeType,
      },
    },
  });
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  const url = resolveAssetUrl(input.httpBaseUrl, result.value.relativeUrl);
  if (url === null) throw new Error("The environment returned an invalid attachment URL.");
  return url;
}

export function revokeUserMessagePreviewUrls(message: ChatMessage): void {
  if (message.role !== "user" || !message.attachments) {
    return;
  }
  for (const attachment of message.attachments) {
    if (!isImageAttachment(attachment)) {
      continue;
    }
    revokeBlobPreviewUrl(attachment.previewUrl);
  }
}

export function collectUserMessageBlobPreviewUrls(message: ChatMessage): string[] {
  if (message.role !== "user" || !message.attachments) {
    return [];
  }
  const previewUrls: string[] = [];
  for (const attachment of message.attachments) {
    if (!isImageAttachment(attachment)) continue;
    if (!attachment.previewUrl || !attachment.previewUrl.startsWith("blob:")) continue;
    previewUrls.push(attachment.previewUrl);
  }
  return previewUrls;
}

export interface PullRequestDialogState {
  initialReference: string | null;
  key: number;
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Could not read image data."));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Failed to read image."));
    });
    reader.readAsDataURL(file);
  });
}

/**
 * Ignore a second press landing this soon after the first. At this range it is a reflexive
 * double-click on a button that appeared to do nothing, not a decision to force-kill a session —
 * and the armed styling has not been on screen long enough for anyone to have read it.
 */
export {
  STOP_ESCALATION_MIN_MS,
  STOP_ESCALATION_WINDOW_MS,
  nextStopAction,
} from "@t3tools/client-runtime/state/stop-ladder";
export type { ArmedStopEscalation, StopAction } from "@t3tools/client-runtime/state/stop-ladder";

/**
 * What an Escape press in the chat surface should do.
 *
 * The rungs run recall -> stop -> force-stop, and Escape only ever supplies the
 * press. Deciding between stop and force-stop stays with `nextStopAction`, so
 * the keyboard and the Stop button share one ladder and one 500ms floor: two
 * deliberate presses force-stop, an accidental double-tap does not, and Escape
 * held down (which auto-repeats) cannot reach the destructive rung at all.
 *
 * Recall comes first because it is the reversible rung. A message still waiting
 * has not cost the agent anything yet, so taking it back is a cheaper answer to
 * "I did not mean that" than killing the turn - and once the queue is empty the
 * next press stops, exactly as if the queue had never been there.
 */
/**
 * Whether an Escape press belongs to the chat rather than to something layered
 * over it.
 *
 * Decided by FOCUS, not by an inventory of overlays. Every control that owns
 * Escape - dialog, menu, model picker, terminal pane - takes focus into a DOM
 * subtree that is not the composer's, and portalled content is never inside it.
 * So "focus is in the composer, or nowhere" is exactly the set of presses the
 * chat should answer, and it stays correct as overlays are added.
 *
 * Nowhere means `document.body`: clicking the transcript leaves focus there,
 * and Escape should still stop the turn you were reading.
 *
 * `hasOpenDialog` covers the single gap focus alone leaves - a modal that is
 * open while focus has not landed inside it yet.
 */
export function isChatSurfaceFocused(input: {
  readonly activeElement: Node | null;
  readonly bodyElement: Node | null;
  readonly composerRoot: { readonly contains: (node: Node) => boolean } | null;
  readonly hasOpenDialog: boolean;
}): boolean {
  if (input.hasOpenDialog) return false;
  if (input.activeElement === null) return true;
  if (input.bodyElement !== null && input.activeElement === input.bodyElement) return true;
  return input.composerRoot?.contains(input.activeElement) ?? false;
}

export type EscapeAction = "recall" | "stop" | "none";

export function nextEscapeAction(input: {
  /**
   * Whether the chat is what the keypress belongs to. False whenever an overlay
   * owns Escape: this is what keeps Escape from stopping a turn while the user
   * is dismissing a dialog or a menu.
   */
  readonly isChatSurfaceActive: boolean;
  /** `event.defaultPrevented` - another handler already claimed this press. */
  readonly alreadyHandled: boolean;
  /** `event.repeat` - the key is being held, not pressed again. */
  readonly isAutoRepeat: boolean;
  /** `event.isComposing` - Escape is cancelling an IME candidate, not a turn. */
  readonly isComposing: boolean;
  readonly hasRunningTurn: boolean;
  /**
   * The agent is waiting on an approval or a question. The composer replaces
   * Stop with Cancel there, and Cancel is deliberately NOT on this ladder - it
   * dispatches a cooperative decline and never arms the force-stop. Escape
   * stays out of it rather than arming, invisibly, a rung the visible UI is not
   * even offering.
   */
  readonly hasPendingQuestion: boolean;
  readonly heldMessageCount: number;
  /** False for a provider whose adapter cannot take a queued message back. */
  readonly recallSupported: boolean;
}): EscapeAction {
  if (
    !input.isChatSurfaceActive ||
    input.alreadyHandled ||
    input.isAutoRepeat ||
    input.isComposing ||
    input.hasPendingQuestion
  ) {
    return "none";
  }
  if (input.heldMessageCount > 0 && input.recallSupported) {
    return "recall";
  }
  // Nothing running and nothing recallable: leave the press alone rather than
  // firing an interrupt at a thread that is already idle.
  return input.hasRunningTurn ? "stop" : "none";
}

export function resolveSendEnvMode(input: {
  requestedEnvMode: DraftThreadEnvMode;
  isGitRepo: boolean;
}): DraftThreadEnvMode {
  return input.isGitRepo ? input.requestedEnvMode : "local";
}

export function resolveBackgroundDraftWorkspaceOptions(input: {
  envMode: DraftThreadEnvMode;
  branch: string | null;
  startFromOrigin: boolean;
}): {
  envMode: DraftThreadEnvMode;
  branch: string | null;
  worktreePath: null;
  startFromOrigin: boolean;
} {
  return {
    envMode: input.envMode,
    branch: input.branch,
    worktreePath: null,
    startFromOrigin: input.envMode === "worktree" && input.startFromOrigin,
  };
}

export function cloneComposerImageForRetry(
  image: ComposerImageAttachment,
): ComposerImageAttachment {
  if (typeof URL === "undefined" || !image.previewUrl.startsWith("blob:")) {
    return image;
  }
  try {
    return {
      ...image,
      previewUrl: URL.createObjectURL(image.file),
    };
  } catch {
    return image;
  }
}

export function deriveComposerSendState(options: {
  prompt: string;
  imageCount: number;
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
  /**
   * Optional element-pick attachment count. Element contexts contribute to
   * "sendable content" exactly like images and (text-bearing) terminal
   * contexts do: a prompt of just element chips is still a valid send.
   */
  elementContextCount?: number;
}): {
  trimmedPrompt: string;
  sendableTerminalContexts: TerminalContextDraft[];
  expiredTerminalContextCount: number;
  hasSendableContent: boolean;
} {
  const trimmedPrompt = stripInlineTerminalContextPlaceholders(options.prompt).trim();
  const sendableTerminalContexts = filterTerminalContextsWithText(options.terminalContexts);
  const expiredTerminalContextCount =
    options.terminalContexts.length - sendableTerminalContexts.length;
  const elementContextCount = options.elementContextCount ?? 0;
  return {
    trimmedPrompt,
    sendableTerminalContexts,
    expiredTerminalContextCount,
    hasSendableContent:
      trimmedPrompt.length > 0 ||
      options.imageCount > 0 ||
      sendableTerminalContexts.length > 0 ||
      elementContextCount > 0,
  };
}

export function buildExpiredTerminalContextToastCopy(
  expiredTerminalContextCount: number,
  variant: "omitted" | "empty",
): { title: string; description: string } {
  const count = Math.max(1, Math.floor(expiredTerminalContextCount));
  const noun = count === 1 ? "Expired terminal context" : "Expired terminal contexts";
  if (variant === "empty") {
    return {
      title: `${noun} won't be sent`,
      description: "Remove it or re-add it to include terminal output.",
    };
  }
  return {
    title: `${noun} omitted from message`,
    description: "Re-add it if you want that terminal output included.",
  };
}

export function branchMismatchKey(
  threadId: string | null,
  mismatch: { threadBranch: string; currentBranch: string } | null,
): string | null {
  if (!threadId || !mismatch) {
    return null;
  }
  return `${threadId}:${mismatch.threadBranch}:${mismatch.currentBranch}`;
}

// A composer banner that warns about what *sending* will do only matters when
// the user is about to send: passive reading of an old thread carries no risk,
// and the ambient surfaces (the branch picker tint, the repository bar) already
// cover awareness. Draft content is the intent signal — composer focus is
// useless here because ChatView autofocuses the composer on every thread open.
// `wasShownForCurrentCondition` keeps the banner mounted once revealed so it
// doesn't flicker away when the draft is cleared.
//
// Shared by the branch-mismatch banner and the workspace-member guard, which
// gate on the same intent for the same reason.
export function shouldShowComposerIntentBanner(input: {
  hasCondition: boolean;
  isDismissed: boolean;
  composerHasContent: boolean;
  wasShownForCurrentCondition: boolean;
}): boolean {
  if (!input.hasCondition || input.isDismissed) {
    return false;
  }
  return input.composerHasContent || input.wasShownForCurrentCondition;
}

export function shouldShowPlanFollowUpPrompt(input: {
  pendingUserInputCount: number;
  interactionMode: ProviderInteractionMode;
  latestTurnSettled: boolean;
  hasActionableProposedPlan: boolean;
  hasComposerAttachments: boolean;
}): boolean {
  return (
    input.pendingUserInputCount === 0 &&
    input.interactionMode === "plan" &&
    input.latestTurnSettled &&
    input.hasActionableProposedPlan &&
    !input.hasComposerAttachments
  );
}

// Session-scoped (module-level so it survives ChatView remounts, e.g. route
// changes). Durable cross-device dismissal is planned as a server-side ack.
const sessionDismissedBranchMismatchKeys = new Set<string>();

export function dismissBranchMismatchForSession(key: string): void {
  sessionDismissedBranchMismatchKeys.add(key);
}

export function isBranchMismatchDismissedForSession(key: string | null): boolean {
  return key !== null && sessionDismissedBranchMismatchKeys.has(key);
}

export function threadHasStarted(thread: Thread | null | undefined): boolean {
  return Boolean(
    thread && (thread.latestTurn !== null || thread.messages.length > 0 || thread.session !== null),
  );
}

// `threadProvider` is the open branded driver kind carried by the session.
// Unknown driver kinds degrade to `null` (i.e. "unlocked"), which is the safe
// rollback / fork behavior — the routing layer is the right place to surface
// "driver not installed" errors, not the lock state.
//
// `selectedProvider` takes the same open-string shape because the composer
// now tracks the picker selection as a `ProviderInstanceId` (e.g.
// `codex_personal`). Custom instance ids that don't directly match a
// registered driver resolve to `null` here, which matches the existing
// "unknown driver -> unlocked" semantics. Callers that want the lock to track
// a custom instance's underlying driver kind should resolve the instance id
// upstream and pass the correlated kind.
export function deriveLockedProvider(input: {
  thread: Thread | null | undefined;
  selectedProvider: string | null;
  threadProvider: string | null;
}): ProviderDriverKind | null {
  if (!threadHasStarted(input.thread)) {
    return null;
  }
  const sessionProvider = input.thread?.session?.providerName ?? null;
  if (sessionProvider && isProviderDriverKind(sessionProvider)) {
    return sessionProvider;
  }
  const narrowedThreadProvider =
    input.threadProvider && isProviderDriverKind(input.threadProvider)
      ? input.threadProvider
      : null;
  const narrowedSelectedProvider =
    input.selectedProvider && isProviderDriverKind(input.selectedProvider)
      ? input.selectedProvider
      : null;
  return narrowedThreadProvider ?? narrowedSelectedProvider ?? null;
}

export function getStartedThreadModelChangeBlockReason(input: {
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "requiresNewThreadForModelChange">>;
  hasStartedSession: boolean;
  currentModelSelection: ModelSelection;
  currentProviderInstanceId?: ModelSelection["instanceId"] | null | undefined;
  nextModelSelection: ModelSelection;
}): { title: string; description: string } | null {
  if (!input.hasStartedSession) {
    return null;
  }
  const currentModelSelection = {
    ...input.currentModelSelection,
    instanceId: input.currentProviderInstanceId ?? input.currentModelSelection.instanceId,
  };
  if (
    currentModelSelection.instanceId === input.nextModelSelection.instanceId &&
    currentModelSelection.model === input.nextModelSelection.model
  ) {
    return null;
  }
  const currentProvider = input.providers.find(
    (snapshot) => snapshot.instanceId === currentModelSelection.instanceId,
  );
  const nextProvider = input.providers.find(
    (snapshot) => snapshot.instanceId === input.nextModelSelection.instanceId,
  );
  if (
    currentProvider?.requiresNewThreadForModelChange !== true &&
    nextProvider?.requiresNewThreadForModelChange !== true
  ) {
    return null;
  }
  return {
    title: "Start a new chat to change models",
    description: "This provider does not allow switching models after a conversation has started.",
  };
}

export async function waitForStartedServerThread(
  threadRef: ScopedThreadRef,
  timeoutMs = 1_000,
): Promise<boolean> {
  const threadAtom = environmentThreadDetails.detailAtom(threadRef);
  const getThread = () => appAtomRegistry.get(threadAtom);
  const thread = getThread();

  if (threadHasStarted(thread)) {
    return true;
  }

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
    const finish = (result: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId !== null) {
        globalThis.clearTimeout(timeoutId);
      }
      unsubscribe();
      resolve(result);
    };

    const unsubscribe = appAtomRegistry.subscribe(threadAtom, (thread) => {
      if (!threadHasStarted(thread)) {
        return;
      }
      finish(true);
    });

    if (threadHasStarted(getThread())) {
      finish(true);
      return;
    }

    timeoutId = globalThis.setTimeout(() => {
      finish(false);
    }, timeoutMs);
  });
}

export interface LocalDispatchSnapshot {
  startedAt: string;
  preparingWorktree: boolean;
  submissionIntent: ComposerSubmissionIntent;
  latestUserMessageId: ChatMessage["id"] | null;
  latestTurnTurnId: TurnId | null;
  latestTurnRequestedAt: string | null;
  latestTurnStartedAt: string | null;
  latestTurnCompletedAt: string | null;
  sessionStatus: NonNullable<Thread["session"]>["status"] | null;
  sessionUpdatedAt: string | null;
  latestTurnStartFailureId: string | null;
}

export function latestTurnStartFailureId(
  activeThread: Thread | undefined,
  latestUserMessageId: ChatMessage["id"] | null,
): string | null {
  if (latestUserMessageId === null) return null;
  return (
    activeThread?.activities.findLast((activity) => {
      if (activity.kind !== "provider.turn.start.failed") return false;
      const payload =
        typeof activity.payload === "object" && activity.payload !== null
          ? (activity.payload as { readonly requestId?: unknown })
          : null;
      return payload?.requestId === latestUserMessageId;
    })?.id ?? null
  );
}

export function createLocalDispatchSnapshot(
  activeThread: Thread | undefined,
  options?: {
    preparingWorktree?: boolean;
    submissionIntent?: ComposerSubmissionIntent;
  },
): LocalDispatchSnapshot {
  const latestTurn = activeThread?.latestTurn ?? null;
  const session = activeThread?.session ?? null;
  const latestUserMessage = activeThread?.messages.findLast((message) => message.role === "user");
  return {
    startedAt: new Date().toISOString(),
    preparingWorktree: Boolean(options?.preparingWorktree),
    submissionIntent: options?.submissionIntent ?? "foreground",
    latestUserMessageId: latestUserMessage?.id ?? null,
    latestTurnTurnId: latestTurn?.turnId ?? null,
    latestTurnRequestedAt: latestTurn?.requestedAt ?? null,
    latestTurnStartedAt: latestTurn?.startedAt ?? null,
    latestTurnCompletedAt: latestTurn?.completedAt ?? null,
    sessionStatus: session?.status ?? null,
    sessionUpdatedAt: session?.updatedAt ?? null,
    latestTurnStartFailureId: latestTurnStartFailureId(activeThread, latestUserMessage?.id ?? null),
  };
}

export function hasServerAcknowledgedLocalDispatch(input: {
  localDispatch: LocalDispatchSnapshot | null;
  phase: SessionPhase;
  latestTurn: Thread["latestTurn"] | null;
  latestUserMessageId: ChatMessage["id"] | null;
  session: Thread["session"] | null;
  hasPendingApproval: boolean;
  hasPendingUserInput: boolean;
  latestTurnStartFailureId?: string | null;
  threadError: string | null | undefined;
}): boolean {
  if (!input.localDispatch) {
    return false;
  }
  if (input.hasPendingApproval || input.hasPendingUserInput || Boolean(input.threadError)) {
    return true;
  }
  if (
    input.latestTurnStartFailureId !== undefined &&
    input.latestTurnStartFailureId !== null &&
    input.latestTurnStartFailureId !== input.localDispatch.latestTurnStartFailureId
  ) {
    return true;
  }
  if (input.phase === "connecting") {
    return false;
  }

  const latestTurn = input.latestTurn ?? null;
  const session = input.session ?? null;
  const latestUserMessageChanged =
    input.localDispatch.latestUserMessageId !== input.latestUserMessageId;
  const latestTurnChanged =
    input.localDispatch.latestTurnTurnId !== (latestTurn?.turnId ?? null) ||
    input.localDispatch.latestTurnRequestedAt !== (latestTurn?.requestedAt ?? null) ||
    input.localDispatch.latestTurnStartedAt !== (latestTurn?.startedAt ?? null) ||
    input.localDispatch.latestTurnCompletedAt !== (latestTurn?.completedAt ?? null);

  if (input.phase === "running") {
    // Steering adds a user message to the current running turn without
    // necessarily changing any of the turn timestamps. Treat that projected
    // message as the server acknowledgment so the composer does not remain
    // stuck in its local "Sending" state until the turn settles.
    if (latestUserMessageChanged) {
      return true;
    }
    if (!latestTurnChanged) {
      return false;
    }
    if (latestTurn?.startedAt === null || latestTurn === null) {
      return false;
    }
    if (
      session?.activeTurnId !== null &&
      session?.activeTurnId !== undefined &&
      latestTurn?.turnId !== session.activeTurnId
    ) {
      return false;
    }
    return true;
  }

  return (
    latestTurnChanged ||
    input.localDispatch.sessionStatus !== (session?.status ?? null) ||
    input.localDispatch.sessionUpdatedAt !== (session?.updatedAt ?? null)
  );
}

/**
 * Whether a send attempted while the environment is disconnected can be safely
 * queued for replay on reconnect.
 *
 * The full send pipeline does network work a queued turn cannot reproduce
 * offline (attachment upload, worktree preparation) and derives state a replay
 * would skip (auto-title on the first message). So v1 queues only the case that
 * actually matters day-to-day and is self-describing in a single command: a
 * plain-text follow-up on a thread the server already knows about.
 */
export function canQueueOfflineTurn(input: {
  readonly hasText: boolean;
  readonly isServerThread: boolean;
  readonly isFirstMessage: boolean;
  readonly attachmentCount: number;
  readonly contextCount: number;
  readonly needsWorktree: boolean;
  readonly hasPendingProgress: boolean;
  /**
   * Whether the composer's runtime/interaction modes already match the thread's
   * persisted ones. The server derives a turn's modes from the THREAD, not from
   * the turn-start command, and the online path keeps them in step by persisting
   * the composer's modes just before sending. A queued replay skips that step, so
   * a pending mode change would silently run the turn in the old mode — refuse to
   * queue instead, leaving the text in the composer.
   */
  readonly modesMatchThread: boolean;
  /**
   * Whether a turn is already queued for this thread. Only one is allowed:
   * replayed turn-starts are dispatched back to back on reconnect, and the
   * Cursor and Grok adapters fold a second turn-start into the turn already
   * running — so N queued messages would come back as one merged answer.
   */
  readonly alreadyQueuedForThread: boolean;
}): boolean {
  return (
    input.hasText &&
    input.isServerThread &&
    !input.isFirstMessage &&
    input.attachmentCount === 0 &&
    input.contextCount === 0 &&
    !input.needsWorktree &&
    !input.hasPendingProgress &&
    input.modesMatchThread &&
    !input.alreadyQueuedForThread
  );
}

export type OfflineQueueInput = Parameters<typeof canQueueOfflineTurn>[0];

/**
 * Whether `onSend` must return before it reaches the offline-queue branch.
 *
 * This exists as a named predicate rather than an inline `if` because an
 * unavailable environment is deliberately NOT a reason to bail: bailing is
 * exactly what the offline outbox exists to prevent, and the queue branch sits
 * further down the same function. An upstream reconcile silently re-added
 * `activeEnvironmentUnavailable` to that inline guard once (756b9c9af), which
 * made the whole outbox unreachable while every one of its unit tests kept
 * passing — the queue logic was covered, its REACHABILITY was not. The tests
 * on this function are that missing coverage.
 *
 * The one offline case that still bails is a direct annotation: it carries an
 * image and a preview payload that `canQueueOfflineTurn` refuses anyway, so it
 * stays attached to the draft and the caller explains that with a toast.
 */
export function shouldAbortSendBeforeOfflineQueue(input: {
  readonly hasActiveThread: boolean;
  readonly isSendBusy: boolean;
  readonly isConnecting: boolean;
  readonly threadDetailLoading: boolean;
  readonly sendInFlight: boolean;
  readonly environmentUnavailable: boolean;
  readonly hasDirectAnnotation: boolean;
  /** A Codex feedback upload already running for this thread (upstream #7949). */
  readonly feedbackUploadInFlight: boolean;
}): boolean {
  return (
    !input.hasActiveThread ||
    input.isSendBusy ||
    input.isConnecting ||
    input.threadDetailLoading ||
    input.sendInFlight ||
    input.feedbackUploadInFlight ||
    (input.environmentUnavailable && input.hasDirectAnnotation)
  );
}

/**
 * Why a disconnected send could not be queued, in the user's terms. The send
 * control stays enabled while offline so a message is never swallowed by a dead
 * button, which means every refusal has to explain itself.
 */
export function offlineQueueRefusalReason(input: OfflineQueueInput): string {
  const reconnectFirst = "Reconnect to send it.";
  if (input.alreadyQueuedForThread) {
    return `A message is already waiting to send on this thread. ${reconnectFirst}`;
  }
  if (input.attachmentCount > 0 || input.contextCount > 0) {
    return `Attachments and context can't be queued while disconnected. ${reconnectFirst}`;
  }
  if (!input.isServerThread || input.isFirstMessage) {
    return `The first message in a thread can't be queued while disconnected. ${reconnectFirst}`;
  }
  if (input.needsWorktree) {
    return `A new worktree can't be prepared while disconnected. ${reconnectFirst}`;
  }
  if (input.hasPendingProgress) {
    return `A plan follow-up can't be queued while disconnected. ${reconnectFirst}`;
  }
  if (!input.modesMatchThread) {
    return `A pending mode change can't be applied while disconnected. ${reconnectFirst}`;
  }
  return `This message can't be queued while disconnected. ${reconnectFirst}`;
}
