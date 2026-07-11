const TRANSPORT_ERROR_PATTERNS = [
  /\bSocketCloseError\b/i,
  /\bSocketOpenError\b/i,
  /\bSocket is not connected\b/i,
  /Unable to connect to the T3 server WebSocket\./i,
  /\bping timeout\b/i,
  // A re-subscribe issued while the socket is mid-reconnect is abandoned by the
  // stream codec's disconnect latch (`abandonSendOnDisconnect`). This is a transient
  // connection condition — the subscribe loop must keep retrying until the socket
  // reopens, not treat it as a fatal subscription error and exit (which would
  // re-orphan the subscription; see the 2026-07-11 transient-reconnect design).
  /\bsend abandoned\b/i,
] as const;

/**
 * Test whether an error message originates from a transport-level connection
 * failure (socket close, socket open, ping timeout, etc.) rather than a
 * business-logic error.
 */
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

/**
 * Strip transport connection errors from user-facing error messages.
 * Returns `null` for transport errors so the UI can distinguish between
 * real errors and transient connection issues.
 */
export function sanitizeThreadErrorMessage(message: string | null | undefined): string | null {
  return isTransportConnectionErrorMessage(message) ? null : (message ?? null);
}
