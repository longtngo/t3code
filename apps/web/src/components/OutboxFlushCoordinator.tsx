import { useCallback, useEffect, useRef, useState } from "react";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import {
  expireQueuedTurns,
  flushOutbox,
  getQueuedTurns,
  markTurnDelivered,
  subscribeToCrossTabOutboxUpdates,
  useCommandOutbox,
} from "~/rpc/commandOutbox";
import { readThreadShell } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { stackedThreadToast, toastManager } from "./ui/toast";

/** First backoff before re-attempting turns left queued by a transport failure. */
const FLUSH_RETRY_BASE_DELAY_MS = 3_000;
/** Ceiling for the exponential backoff, so a wedged environment idles quietly. */
const FLUSH_RETRY_MAX_DELAY_MS = 60_000;

/**
 * Drains the offline outbox once an environment is reachable again.
 *
 * Mounted once at the app root. Queued turns carry a stable `commandId`, and the
 * server returns the original result for an already-accepted command, so a replay
 * that races an earlier attempt cannot start the turn twice.
 */
export function OutboxFlushCoordinator() {
  const { presentationById } = useEnvironments();
  const queue = useCommandOutbox((state) => state.queue);
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const flushingRef = useRef(false);
  // A ref clears without re-rendering, so a flush that ends with turns still
  // queued would never be retried if no connection phase changed afterwards.
  // Bumping this state (on a timer, so it cannot spin) re-runs the effect.
  const [flushEpoch, setFlushEpoch] = useState(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const retryAttemptRef = useRef(0);

  // Retire turns that have aged out, and tell the user which text was dropped.
  //
  // Deliberately age-based rather than "prune turns whose environment is absent
  // from the catalog": the catalog reports ready as soon as persisted targets
  // load, while platform-managed environments (including the primary) arrive
  // later, so absence cannot be told apart from not-loaded-yet — and pruning on
  // it would delete live queued messages on every cold start.
  const retireExpiredTurns = useCallback(() => {
    for (const turn of expireQueuedTurns()) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Queued message expired",
          description: `${describeQueuedText(turn.input)} waited too long to send and was discarded.`,
        }),
      );
    }
  }, []);

  useEffect(() => retireExpiredTurns(), [queue, retireExpiredTurns]);

  // Another tab may have flushed a turn; without this we keep a stale copy,
  // show its bubble forever, and write it back to storage on our next update.
  useEffect(() => subscribeToCrossTabOutboxUpdates(), []);

  useEffect(() => {
    if (queue.length === 0 || flushingRef.current) return;
    // Also check here, not just on the queue-keyed effect above: a reconnect
    // changes `presentationById`, not `queue`, so a tab that never reloaded
    // would otherwise replay a turn that has long since aged out.
    retireExpiredTurns();
    const isConnected = (environmentId: string) =>
      presentationById.get(environmentId as never)?.connection.phase === "connected";
    // Nothing to do until at least one queued turn's environment is reachable.
    if (!queue.some((turn) => isConnected(turn.environmentId))) return;

    // flushOutbox keeps a turn queued only for transport-shaped failures, so
    // "not yet sendable" conditions must be reported in that shape.
    const keepQueued = (environmentId: string) =>
      new Error(`${environmentId} is not connected.`);

    flushingRef.current = true;
    void flushOutbox(
      async (turn) => {
        if (!isConnected(turn.environmentId)) throw keepQueued(turn.environmentId);
        const result = await startThreadTurn({
          environmentId: turn.environmentId,
          // `createdAt` is required on the command, so send a fresh one rather
          // than the enqueue-time value. (The server canonicalizes it to its own
          // receive time anyway — see canonicalizeClientCommandTimestamps — so
          // this only keeps the payload honest; dedupe keys on `commandId`.)
          input: { ...turn.input, createdAt: new Date().toISOString() } as never,
        });
        if (result._tag === "Failure") {
          // An interrupted command never reached a verdict — retry it later
          // rather than dropping the user's message.
          if (isAtomCommandInterrupted(result)) throw keepQueued(turn.environmentId);
          throw squashAtomCommandFailure(result);
        }
      },
      {
        // The queued modes were compared against a thread row that was stale by
        // definition — the environment was unreachable at the time. Re-check
        // against the row we have now, which the reconnect has just synced.
        rejectBeforeSend: (turn) => {
          const thread = readThreadShell({
            environmentId: turn.environmentId,
            threadId: turn.threadId,
          });
          // A thread we cannot read yet is not evidence of a mismatch, and
          // dropping the user's message on "I don't know" is the failure mode
          // this codebase keeps rediscovering. The server still validates.
          if (thread === null) return null;
          if (
            turn.input.runtimeMode === thread.runtimeMode &&
            turn.input.interactionMode === thread.interactionMode
          ) {
            return null;
          }
          return "the thread's modes changed while it was queued.";
        },
        onDelivered: markTurnDelivered,
        onTerminalError: (turn, error) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Queued message failed",
              description: `${describeQueuedText(turn.input)} — ${
                error instanceof Error ? error.message : "could not be sent."
              }`,
            }),
          );
        },
      },
    ).finally(() => {
      flushingRef.current = false;
      if (getQueuedTurns().length > 0) {
        // Exponential, capped: a phase that reads "connected" while every send
        // fails would otherwise re-issue real RPCs every 3s forever.
        const delay = Math.min(
          FLUSH_RETRY_BASE_DELAY_MS * 2 ** retryAttemptRef.current,
          FLUSH_RETRY_MAX_DELAY_MS,
        );
        retryAttemptRef.current += 1;
        // Held in a ref, not a closure local: this runs after an await, by which
        // point this effect pass may already have been cleaned up.
        retryTimerRef.current = setTimeout(() => setFlushEpoch((epoch) => epoch + 1), delay);
      } else {
        retryAttemptRef.current = 0;
      }
    });

    return () => {
      if (retryTimerRef.current !== undefined) clearTimeout(retryTimerRef.current);
    };
    // flushOutbox re-reads the live queue each iteration; `queue` only gates entry.
  }, [queue, presentationById, startThreadTurn, flushEpoch]);

  return null;
}

/** A short quote of the dropped message so the toast names what was lost. */
function describeQueuedText(input: Record<string, unknown>): string {
  const text = (input.message as { text?: unknown } | undefined)?.text;
  if (typeof text !== "string" || text.length === 0) return "A queued message";
  // Split by code point so a surrogate pair cannot become a replacement glyph.
  const points = [...text];
  return `"${points.length > 60 ? `${points.slice(0, 60).join("")}…` : text}"`;
}
