import {
  DEFAULT_MODEL,
  type ModelSelection,
  type PreviewAnnotationPayload,
  type ProjectId,
  type ProviderDriverKind,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ServerProvider,
} from "@t3tools/contracts";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import {
  applyClaudePromptEffortPrefix,
  createModelSelection,
  resolvePromptInjectedEffort,
} from "@t3tools/shared/model";
import { truncate } from "@t3tools/shared/String";

import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "../../components/chat/composerPromptHistory";
import type {
  ComposerFileAttachment,
  ComposerImageAttachment,
  DraftThreadEnvMode,
} from "../../composerDraftStore";
import { getProviderModelCapabilities } from "../../providerModels";
import {
  appendReviewCommentsToPrompt,
  type ReviewCommentContext,
} from "../../reviewCommentContext";
import {
  appendElementContextsToPrompt,
  type ElementContextDraft,
  formatElementContextLabel,
} from "../elementContext";
import { appendPreviewAnnotationPrompt } from "../previewAnnotation";
import {
  appendTerminalContextsToPrompt,
  formatTerminalContextLabel,
  type TerminalContextDraft,
} from "../terminalContext";

/** The model-facing text: Claude effort prefixes ride in the prompt itself. */
export function formatOutgoingPrompt(params: {
  provider: ProviderDriverKind;
  model: string | null;
  models: ReadonlyArray<ServerProvider["models"][number]>;
  effort: string | null;
  text: string;
}): string {
  const caps = getProviderModelCapabilities(params.models, params.model, params.provider);
  const promptEffort = resolvePromptInjectedEffort(caps, params.effort);
  return applyClaudePromptEffortPrefix(params.text, promptEffort);
}

export interface ComposeTurnStartInput {
  /** The prompt as typed, and its trimmed form from `deriveComposerSendState`. */
  readonly prompt: string;
  readonly trimmedPrompt: string;
  readonly images: ReadonlyArray<ComposerImageAttachment>;
  readonly files: ReadonlyArray<ComposerFileAttachment>;
  /** Only the terminal contexts that are still sendable. */
  readonly terminalContexts: ReadonlyArray<TerminalContextDraft>;
  readonly elementContexts: ReadonlyArray<ElementContextDraft>;
  readonly previewAnnotations: ReadonlyArray<PreviewAnnotationPayload>;
  readonly reviewComments: ReadonlyArray<ReviewCommentContext>;
  readonly provider: ProviderDriverKind;
  readonly model: string | null;
  readonly models: ReadonlyArray<ServerProvider["models"][number]>;
  readonly effort: string | null;
  readonly modelSelection: ModelSelection;
  readonly projectDefaultModel: string | null;
  readonly project: { readonly id: ProjectId; readonly workspaceRoot: string };
  readonly thread: { readonly createdAt: string; readonly worktreePath: string | null };
  readonly isLocalDraftThread: boolean;
  readonly isFirstMessage: boolean;
  readonly sendEnvMode: DraftThreadEnvMode;
  readonly branch: string | null;
  readonly startFromOrigin: boolean;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly randomHex: (length: number) => string;
}

export interface ComposedTurnStart {
  readonly outgoingMessageText: string;
  readonly title: string;
  /** In worktree mode a first message needs a base branch; send must refuse without one. */
  readonly missingWorktreeBaseBranch: boolean;
  readonly baseBranchForWorktree: string | null;
  readonly bootstrap: TurnStartBootstrap | undefined;
}

export interface TurnStartBootstrap {
  readonly createThread?: {
    readonly projectId: ProjectId;
    readonly title: string;
    readonly modelSelection: ModelSelection;
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode: ProviderInteractionMode;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly createdAt: string;
  };
  readonly prepareWorktree?: {
    readonly projectCwd: string;
    readonly baseBranch: string;
    readonly branch: string;
    readonly startFromOrigin?: true;
  };
  readonly runSetupScript?: true;
}

/**
 * Decides what a send dispatches: the message text, the title seed, and the
 * bootstrap for a draft or a first worktree message. Shared by the composer's
 * Send and the thread queue's background send so the two cannot drift.
 */
export function composeTurnStart(input: ComposeTurnStartInput): ComposedTurnStart {
  const shouldCreateWorktree =
    input.isFirstMessage && input.sendEnvMode === "worktree" && !input.thread.worktreePath;
  const baseBranchForWorktree = shouldCreateWorktree ? input.branch : null;

  const messageTextWithContexts = appendElementContextsToPrompt(
    appendTerminalContextsToPrompt(input.prompt, [...input.terminalContexts]),
    [...input.elementContexts],
  );
  const messageTextWithPreviewAnnotations = input.previewAnnotations.reduce(
    (text, annotation) => appendPreviewAnnotationPrompt(text, annotation),
    messageTextWithContexts,
  );
  const messageTextForSend = appendReviewCommentsToPrompt(messageTextWithPreviewAnnotations, [
    ...input.reviewComments,
  ]);
  const outgoingMessageText = formatOutgoingPrompt({
    provider: input.provider,
    model: input.model,
    models: input.models,
    effort: input.effort,
    text: messageTextForSend || ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
  });

  let titleSeed = assistantCitationsToPlainText(input.trimmedPrompt);
  if (!titleSeed) {
    const firstImage = input.images[0];
    const firstFile = input.files[0];
    const firstTerminalContext = input.terminalContexts[0];
    const firstElementContext = input.elementContexts[0];
    if (firstImage) {
      titleSeed = `Image: ${firstImage.name}`;
    } else if (firstFile) {
      titleSeed = `File: ${firstFile.name}`;
    } else if (firstTerminalContext) {
      titleSeed = formatTerminalContextLabel(firstTerminalContext);
    } else if (firstElementContext) {
      titleSeed = formatElementContextLabel(firstElementContext);
    } else {
      titleSeed = "New thread";
    }
  }
  const title = truncate(titleSeed);

  const bootstrap: TurnStartBootstrap | undefined =
    input.isLocalDraftThread || baseBranchForWorktree
      ? {
          ...(input.isLocalDraftThread
            ? {
                createThread: {
                  projectId: input.project.id,
                  title,
                  modelSelection: createModelSelection(
                    input.modelSelection.instanceId,
                    input.model || input.projectDefaultModel || DEFAULT_MODEL,
                    input.modelSelection.options,
                  ),
                  runtimeMode: input.runtimeMode,
                  interactionMode: input.interactionMode,
                  branch: input.branch,
                  worktreePath: input.thread.worktreePath,
                  createdAt: input.thread.createdAt,
                },
              }
            : {}),
          ...(baseBranchForWorktree
            ? {
                prepareWorktree: {
                  projectCwd: input.project.workspaceRoot,
                  baseBranch: baseBranchForWorktree,
                  branch: buildTemporaryWorktreeBranchName(input.randomHex),
                  ...(input.startFromOrigin ? { startFromOrigin: true as const } : {}),
                },
                runSetupScript: true as const,
              }
            : {}),
        }
      : undefined;

  return {
    outgoingMessageText,
    title,
    missingWorktreeBaseBranch: shouldCreateWorktree && !input.branch,
    baseBranchForWorktree,
    bootstrap,
  };
}
