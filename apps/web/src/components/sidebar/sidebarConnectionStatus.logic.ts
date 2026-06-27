import type { WsConnectionUiState } from "../../rpc/wsConnectionState";

export interface ConnectionDotTone {
  readonly colorClass: string;
  readonly pulse: boolean;
  readonly label: string;
}

export function connectionDotTone(uiState: WsConnectionUiState): ConnectionDotTone {
  switch (uiState) {
    case "connected":
      return { colorClass: "bg-emerald-500", pulse: false, label: "Connected" };
    case "connecting":
      return { colorClass: "bg-amber-500", pulse: true, label: "Connecting" };
    case "reconnecting":
      return { colorClass: "bg-amber-500", pulse: true, label: "Reconnecting" };
    case "offline":
      return { colorClass: "bg-red-500", pulse: false, label: "Offline" };
    case "error":
      return { colorClass: "bg-red-500", pulse: false, label: "Disconnected" };
  }
}

/** Extract the `host[:port]` from a ws/wss socket URL, or null if absent/unparseable. */
export function connectionHost(socketUrl: string | null): string | null {
  if (!socketUrl) {
    return null;
  }
  try {
    return new URL(socketUrl).host || null;
  } catch {
    return null;
  }
}

/**
 * A human-friendly endpoint name for the active connection: the explicit
 * connection label when set, otherwise the socket host (useful over Tailscale
 * for confirming *which* server you reached).
 */
export function connectionEndpointLabel(
  connectionLabel: string | null,
  socketUrl: string | null,
): string | null {
  const label = connectionLabel?.trim();
  if (label) {
    return label;
  }
  return connectionHost(socketUrl);
}

/**
 * The secondary "additional data" line shown under the connection label in the
 * sidebar footer. Pure — the component pre-formats the timestamp/countdown
 * strings (via the shared connection formatters) and passes them in.
 */
export function connectionDetailLine(input: {
  readonly uiState: WsConnectionUiState;
  readonly endpoint: string | null;
  readonly sinceLabel: string | null;
  readonly retryCountdown: string | null;
  readonly closeReason: string | null;
}): string | null {
  switch (input.uiState) {
    case "connected":
      if (input.endpoint) {
        return input.endpoint;
      }
      return input.sinceLabel ? `Since ${input.sinceLabel}` : null;
    case "connecting":
      return input.endpoint ? `Connecting to ${input.endpoint}…` : "Connecting…";
    case "reconnecting":
      return input.retryCountdown ? `Retry in ${input.retryCountdown}` : "Reconnecting…";
    case "offline":
      return "Check your network";
    case "error": {
      const reason = input.closeReason?.trim();
      return reason ? reason : "Disconnected";
    }
  }
}
