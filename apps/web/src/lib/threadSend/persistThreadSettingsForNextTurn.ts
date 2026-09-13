import type {
  EnvironmentId,
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import {
  mapAtomCommandResult,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/unstable/reactivity";

import { resolveThreadMetadataUpdateForNextTurn } from "../../components/ChatView.logic";

export interface ThreadSettingsCommands {
  updateThreadMetadata(value: {
    environmentId: EnvironmentId;
    input: {
      threadId: ThreadId;
      modelSelection?: ModelSelection;
      branch?: string;
      worktreePath?: null;
    };
  }): Promise<AtomCommandResult<unknown, unknown>>;
  setThreadRuntimeMode(value: {
    environmentId: EnvironmentId;
    input: { threadId: ThreadId; runtimeMode: RuntimeMode; createdAt: string };
  }): Promise<AtomCommandResult<unknown, unknown>>;
  setThreadInteractionMode(value: {
    environmentId: EnvironmentId;
    input: { threadId: ThreadId; interactionMode: ProviderInteractionMode; createdAt: string };
  }): Promise<AtomCommandResult<unknown, unknown>>;
}

/** The server thread's current settings, as the shell or detail carries them. */
export interface ThreadSettingsSnapshot {
  readonly modelSelection: ModelSelection;
  readonly branch: string | null;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

/**
 * Brings a started thread's model, branch and modes in line with what the next
 * turn is sent with, issuing only the commands whose value changed.
 */
export async function persistThreadSettingsForNextTurn(
  commands: ThreadSettingsCommands,
  environmentId: EnvironmentId,
  thread: ThreadSettingsSnapshot,
  input: {
    threadId: ThreadId;
    createdAt: string;
    modelSelection?: ModelSelection;
    branch?: string;
    runtimeMode: RuntimeMode;
    interactionMode: ProviderInteractionMode;
  },
): Promise<AtomCommandResult<void, unknown>> {
  let result: AtomCommandResult<void, unknown> = AsyncResult.success(undefined);
  const metadataUpdate = resolveThreadMetadataUpdateForNextTurn({
    currentModelSelection: thread.modelSelection,
    ...(input.modelSelection ? { nextModelSelection: input.modelSelection } : {}),
    currentBranch: thread.branch,
    ...(input.branch ? { nextBranch: input.branch } : {}),
  });
  if (metadataUpdate) {
    result = mapAtomCommandResult(
      await commands.updateThreadMetadata({
        environmentId,
        input: { threadId: input.threadId, ...metadataUpdate },
      }),
      () => undefined,
    );
    if (result._tag === "Failure") return result;
  }

  if (input.runtimeMode !== thread.runtimeMode) {
    result = mapAtomCommandResult(
      await commands.setThreadRuntimeMode({
        environmentId,
        input: {
          threadId: input.threadId,
          runtimeMode: input.runtimeMode,
          createdAt: input.createdAt,
        },
      }),
      () => undefined,
    );
    if (result._tag === "Failure") return result;
  }

  if (input.interactionMode !== thread.interactionMode) {
    result = mapAtomCommandResult(
      await commands.setThreadInteractionMode({
        environmentId,
        input: {
          threadId: input.threadId,
          interactionMode: input.interactionMode,
          createdAt: input.createdAt,
        },
      }),
      () => undefined,
    );
  }
  return result;
}
