import {
  AUTO_COMPACT_COMMAND,
  AUTO_COMPACT_CONTINUE,
  type AutoCompactHoldReason,
  type AutoCompactPhase,
  DEFAULT_AUTO_COMPACT_MAX_CYCLES,
  decideAutoCompact,
  initialAutoCompactBudget,
  noteAutoCompactCycleComplete,
  noteAutoCompactSend,
  noteAutoCompactSendFailed,
  reconcileAutoCompactBudget,
} from "@t3tools/client-runtime/context";
import { CommandId, type EnvironmentId, MessageId, type ThreadId } from "@t3tools/contracts";
import type { ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../components/ui/toast";

export interface UseAutoCompactInput {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly armed: boolean;
  readonly thresholdPercent: number;
  readonly usedPercentage: number | null;
  readonly threadBusy: boolean;
  readonly sessionReady: boolean;
  readonly archived: boolean;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly hasActionableProposedPlan: boolean;
  readonly hasComposerDraft: boolean;
  readonly providerSupportsCompact: boolean;
  readonly latestUserMessageAt: string | null;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

export interface AutoCompactRuntimeState {
  readonly phase: AutoCompactPhase;
  readonly cyclesUsed: number;
  readonly maxCycles: number;
  readonly lastHold: AutoCompactHoldReason | null;
}

/**
 * Runs the compact→continue sequence for the open thread.
 *
 * The rules live in `decideAutoCompact`; this hook is wiring. It watches the thread, asks the
 * decider what to do, and issues the same two messages the user would type — no timers, no
 * polling. Each step waits on the previous turn settling, which is the receipt the user waits
 * for by hand.
 */
export function useAutoCompact(input: UseAutoCompactInput): AutoCompactRuntimeState {
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });

  const [phase, setPhase] = useState<AutoCompactPhase>("idle");
  const [lastHold, setLastHold] = useState<AutoCompactHoldReason | null>(null);
  const [budget, setBudget] = useState(initialAutoCompactBudget);

  // A send is a promise; renders keep arriving while it is open. Without this latch the same
  // decision would be acted on several times before the phase state caught up.
  const inFlightRef = useRef(false);
  // Fullness captured before `/compact`, so the settled turn can be judged on whether it
  // actually freed room rather than assumed to have worked.
  const beforeCompactRef = useRef<number | null>(null);
  // The sequence belongs to one thread; switching threads must not carry its phase across.
  const threadRef = useRef<ThreadId | null>(null);

  const { environmentId, threadId } = input;

  useEffect(() => {
    if (threadRef.current === threadId) return;
    threadRef.current = threadId;
    inFlightRef.current = false;
    beforeCompactRef.current = null;
    setPhase("idle");
    setLastHold(null);
    setBudget(initialAutoCompactBudget);
  }, [threadId]);

  useEffect(() => {
    setBudget((current) => reconcileAutoCompactBudget(current, input.latestUserMessageAt));
  }, [input.latestUserMessageAt]);

  const send = useCallback(
    async (kind: "compact" | "continue", cycle: number): Promise<boolean> => {
      if (environmentId === null || threadId === null) return false;
      // Deterministic, so two clients armed on the same thread cannot start the turn twice:
      // the server upserts command receipts by id and replays the original result.
      const tag = `auto-${kind}:${threadId}:${cycle}`;
      const result = await startThreadTurn({
        environmentId,
        input: {
          commandId: CommandId.make(tag),
          threadId,
          message: {
            messageId: MessageId.make(tag),
            role: "user",
            text: kind === "compact" ? AUTO_COMPACT_COMMAND : AUTO_COMPACT_CONTINUE,
            attachments: [],
          },
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          createdAt: new Date().toISOString(),
        },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "warning",
              title: "Auto-compact stopped",
              description:
                error instanceof Error
                  ? error.message
                  : "The thread could not be compacted automatically.",
            }),
          );
        }
        return false;
      }
      return true;
    },
    [environmentId, threadId, input.runtimeMode, input.interactionMode, startThreadTurn],
  );

  useEffect(() => {
    if (inFlightRef.current) return;
    if (environmentId === null || threadId === null) return;

    const action = decideAutoCompact({
      armed: input.armed,
      phase,
      usedPercentage: input.usedPercentage,
      thresholdPercent: input.thresholdPercent,
      threadBusy: input.threadBusy,
      sessionReady: input.sessionReady,
      archived: input.archived,
      hasPendingApprovals: input.hasPendingApprovals,
      hasPendingUserInput: input.hasPendingUserInput,
      hasActionableProposedPlan: input.hasActionableProposedPlan,
      hasComposerDraft: input.hasComposerDraft,
      providerSupportsCompact: input.providerSupportsCompact,
      cyclesUsed: budget.cyclesUsed,
      maxCycles: DEFAULT_AUTO_COMPACT_MAX_CYCLES,
      usedPercentageBeforeCompact: beforeCompactRef.current,
    });

    if (action.kind === "hold") {
      setLastHold(action.reason);
      return;
    }
    if (action.kind === "abandon") {
      beforeCompactRef.current = null;
      setPhase("idle");
      setLastHold(action.reason);
      return;
    }

    const cycle = budget.cyclesUsed;
    inFlightRef.current = true;
    if (action.kind === "compact") {
      beforeCompactRef.current = input.usedPercentage;
      setPhase("compacting");
    } else {
      setPhase("continuing");
    }
    setBudget(noteAutoCompactSend);
    setLastHold(null);

    void send(action.kind, cycle).then((ok) => {
      inFlightRef.current = false;
      if (!ok) {
        beforeCompactRef.current = null;
        setPhase("idle");
        setBudget(noteAutoCompactSendFailed);
        return;
      }
      if (action.kind === "continue") {
        // The round is only spent once its continue actually went out, so a sequence that
        // abandoned before continuing does not consume budget it never used.
        beforeCompactRef.current = null;
        setPhase("idle");
        setBudget(noteAutoCompactCycleComplete);
      }
    });
  }, [
    budget,
    environmentId,
    input.archived,
    input.armed,
    input.hasActionableProposedPlan,
    input.hasComposerDraft,
    input.hasPendingApprovals,
    input.hasPendingUserInput,
    input.providerSupportsCompact,
    input.sessionReady,
    input.threadBusy,
    input.thresholdPercent,
    input.usedPercentage,
    phase,
    send,
    threadId,
  ]);

  return {
    phase,
    cyclesUsed: budget.cyclesUsed,
    maxCycles: DEFAULT_AUTO_COMPACT_MAX_CYCLES,
    lastHold,
  };
}
