import { NETWORK_BLOCKING_HINT, UNRESPONSIVE_HOST_HINT } from "./network.ts";

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const TRANSPORT_ERROR_PATTERNS = [
  /\bSocketCloseError\b/i,
  /\bSocketOpenError\b/i,
  /\bSocket is not connected\b/i,
  /Unable to connect to the T3 server WebSocket\./i,
  // The RPC session appends the network hint for relay connections. Any other
  // trailing text means a different error that the user should still see.
  new RegExp(
    `\\b(?:is not connected|disconnected|stopped responding|could not establish a WebSocket connection)\\.(?: ${escapeRegExp(NETWORK_BLOCKING_HINT)})?$`,
    "i",
  ),
  new RegExp(`\\bstopped responding for \\d+s\\. ${escapeRegExp(UNRESPONSIVE_HOST_HINT)}$`, "i"),
  /\bClientProtocolError\b/i,
  /\bRpcClientError\b/i,
  /\bping timeout\b/i,
  // A re-subscribe issued while the socket is mid-reconnect is abandoned by the
  // stream codec's disconnect latch (`abandonSendOnDisconnect`). This is a transient
  // connection condition — the subscribe loop must keep retrying until the socket
  // reopens, not treat it as a fatal subscription error and exit (which would
  // re-orphan the subscription; see the 2026-07-11 transient-reconnect design).
  /\bsend abandoned\b/i,
] as const;

export function isTransportConnectionErrorMessage(message: string | null | undefined): boolean {
  if (typeof message !== "string") {
    return false;
  }

  const normalizedMessage = message.trim();
  if (normalizedMessage.length === 0) {
    return false;
  }

  return TRANSPORT_ERROR_PATTERNS.some((pattern) => pattern.test(normalizedMessage));
}

export function sanitizeThreadErrorMessage(message: string | null | undefined): string | null {
  return isTransportConnectionErrorMessage(message) ? null : (message ?? null);
}
