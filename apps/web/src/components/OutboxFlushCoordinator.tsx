import { useEffect, useRef } from "react";
import { clearOutbox, flushOutbox, getQueuedCommands } from "../rpc/commandOutbox";
import { getWsConnectionUiState, useWsConnectionStatus } from "../rpc/wsConnectionState";
import { readEnvironmentApi } from "../environmentApi";
import { usePrimaryEnvironmentId } from "../environments/primary";
import { shouldClearOutboxOnPrimaryChange } from "./ChatView.logic";
import { stackedThreadToast, toastManager } from "./ui/toast";

/**
 * Mounts at app root (next to WebSocketConnectionCoordinator).
 * When the connection transitions to "connected" and the outbox has
 * queued commands, flushes them sequentially via the primary environment's
 * dispatchCommand.  The flushingRef guards against re-entrancy across
 * React re-renders.
 */
export function OutboxFlushCoordinator() {
  const status = useWsConnectionStatus();
  const uiState = getWsConnectionUiState(status);
  const flushingRef = useRef(false);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  // Track the previous primary environment id to detect transitions (env switch / logout).
  // Initialised to a sentinel so the first render is treated as the initial undefined→value
  // mount transition and does NOT trigger a clear.
  const prevPrimaryEnvironmentIdRef = useRef<string | null | undefined>(undefined);

  // Clear the outbox when the primary environment changes or the user logs out.
  // This prevents stale queued commands from flushing to a new session or environment.
  // Do NOT clear on the initial mount (undefined → first value).
  useEffect(() => {
    const prev = prevPrimaryEnvironmentIdRef.current;
    prevPrimaryEnvironmentIdRef.current = primaryEnvironmentId;
    if (shouldClearOutboxOnPrimaryChange(prev, primaryEnvironmentId)) {
      clearOutbox();
    }
  }, [primaryEnvironmentId]);

  useEffect(() => {
    if (uiState !== "connected") return;
    if (getQueuedCommands().length === 0) return; // no-op when empty
    if (flushingRef.current) return;
    if (!primaryEnvironmentId) return;

    const api = readEnvironmentApi(primaryEnvironmentId);
    if (!api) return;

    flushingRef.current = true;
    void flushOutbox(
      (command) => api.orchestration.dispatchCommand(command as never),
      {
        onTerminalError: (_queued) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Queued message failed",
              description:
                "A message queued while offline could not be sent and was dropped.",
            }),
          );
        },
      },
    ).finally(() => {
      flushingRef.current = false;
    });
  }, [uiState, status.connectedAt, primaryEnvironmentId]);

  return null;
}
