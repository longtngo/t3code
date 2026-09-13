import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { wasBootstrapThreadDeleted } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { MessageId, ThreadId } from "@t3tools/contracts";

import { markPromotedDraftThreadByRef, useComposerDraftStore } from "../../composerDraftStore";
import {
  persistThreadSettingsForNextTurn,
  type ThreadSettingsCommands,
} from "./persistThreadSettingsForNextTurn";
import type { QueuedSendPlan, QueuedSendSnapshot } from "./queuedSend";

export type QueuedSendOutcome =
  | { readonly kind: "sent" }
  | { readonly kind: "empty" }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "failed"; readonly message: string };

export interface QueuedSendCommands extends ThreadSettingsCommands {
  startThreadTurn(value: {
    environmentId: QueuedSendSnapshot["environmentId"];
    input: Record<string, unknown>;
  }): Promise<AtomCommandResult<unknown, unknown>>;
}

/**
 * Dispatches a planned queued send the way Send does: clear the draft, bring the
 * thread's settings in line, start the turn, and on failure put the draft back.
 */
export async function executeQueuedSend(
  snapshot: QueuedSendSnapshot,
  plan: QueuedSendPlan,
  commands: QueuedSendCommands,
  ids: {
    readonly messageId: MessageId;
    readonly now: () => string;
    readonly newThreadId: () => ThreadId;
  },
): Promise<QueuedSendOutcome> {
  if (plan.kind !== "send") return plan;
  const store = useComposerDraftStore.getState();
  const target = snapshot.draftId ?? scopeThreadRef(snapshot.environmentId, snapshot.threadId);
  const draft = snapshot.draft;
  const createdAt = ids.now();

  store.clearComposerContent(target);

  let failure: AtomCommandResult<unknown, unknown> | null = null;
  if (!plan.isLocalDraftThread) {
    const settingsResult = await persistThreadSettingsForNextTurn(
      commands,
      snapshot.environmentId,
      plan.thread,
      {
        threadId: snapshot.threadId,
        createdAt,
        ...(plan.persistModelSelection ? { modelSelection: plan.modelSelection } : {}),
        ...(plan.persistBranch ? { branch: plan.persistBranch } : {}),
        runtimeMode: plan.runtimeMode,
        interactionMode: plan.interactionMode,
      },
    );
    if (settingsResult._tag === "Failure") failure = settingsResult;
  }

  if (failure === null) {
    const startResult = await commands.startThreadTurn({
      environmentId: snapshot.environmentId,
      input: {
        threadId: snapshot.threadId,
        message: {
          messageId: ids.messageId,
          role: "user",
          text: plan.outgoingMessageText,
          attachments: [],
        },
        modelSelection: plan.modelSelection,
        titleSeed: plan.title,
        runtimeMode: plan.runtimeMode,
        interactionMode: plan.interactionMode,
        ...(plan.bootstrap ? { bootstrap: plan.bootstrap } : {}),
        createdAt,
      },
    });
    if (startResult._tag === "Failure") failure = startResult;
  }

  if (failure === null) {
    if (plan.isLocalDraftThread) {
      markPromotedDraftThreadByRef(scopeThreadRef(snapshot.environmentId, snapshot.threadId));
    }
    return { kind: "sent" };
  }

  // Put the draft back unless the user has typed something new since.
  const current = useComposerDraftStore.getState().getComposerDraft(target);
  const untouched =
    (current?.prompt ?? "").length === 0 &&
    (current?.terminalContexts.length ?? 0) === 0 &&
    (current?.elementContexts.length ?? 0) === 0 &&
    (current?.previewAnnotations.length ?? 0) === 0 &&
    (current?.reviewComments.length ?? 0) === 0;
  if (draft && untouched) {
    store.setPrompt(target, draft.prompt);
    store.setTerminalContexts(target, draft.terminalContexts);
    store.setElementContexts(target, draft.elementContexts);
    store.setPreviewAnnotations(target, draft.previewAnnotations);
    store.setReviewComments(target, draft.reviewComments);
  }

  if (isAtomCommandInterrupted(failure)) {
    return { kind: "failed", message: "The send was interrupted." };
  }
  const error = squashAtomCommandFailure(failure);
  if (plan.isLocalDraftThread && snapshot.draftId && wasBootstrapThreadDeleted(error)) {
    const session = store.getDraftSession(snapshot.draftId);
    if (session?.threadId === snapshot.threadId) {
      store.setLogicalProjectDraftThreadId(
        session.logicalProjectKey,
        scopeProjectRef(session.environmentId, session.projectId),
        snapshot.draftId,
        { threadId: ids.newThreadId(), createdAt: ids.now() },
      );
    }
  }
  return {
    kind: "failed",
    message: error instanceof Error ? error.message : "Failed to send message.",
  };
}
