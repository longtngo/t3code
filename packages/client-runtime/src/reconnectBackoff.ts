/**
 * Configuration for exponential reconnect backoff.
 */
export interface ReconnectBackoffConfig {
  /** Base delay in milliseconds before the first retry. */
  readonly initialDelayMs: number;
  /** Multiplier applied per retry (exponential factor). */
  readonly backoffFactor: number;
  /** Hard upper bound on delay in milliseconds. */
  readonly maxDelayMs: number;
  /** Maximum number of retries (0-based). `null` means unlimited. */
  readonly maxRetries: number | null;
}

/**
 * Sensible defaults for WebSocket reconnect backoff.
 *
 * - 1 s initial delay, doubling each retry, capped at 3 s, retries forever at the capped delay
 *   (curve: 1 s, 2 s, 3 s, 3 s …).
 *
 * The cap is deliberately low: the worst-case idle time *after* connectivity is
 * restored equals the backoff gap you have escalated to, so a low cap bounds how
 * long a reconnect sits waiting once the link (e.g. a re-establishing Tailscale
 * tunnel) is back. t3code reaches a single self-hosted server, so the usual reason
 * for a large cap — sparing a *shared* server from a thundering herd — does not
 * apply; a failed WebSocket open is a cheap handshake. See the 2026-07-11
 * ws-reconnect-latency design.
 */
export const DEFAULT_RECONNECT_BACKOFF: ReconnectBackoffConfig = {
  initialDelayMs: 1_000,
  backoffFactor: 2,
  maxDelayMs: 3_000,
  maxRetries: null,
};

/**
 * Calculate the reconnect delay for a given retry index using exponential
 * backoff. Returns `null` when `retryIndex` exceeds the configured maximum.
 */
export function getReconnectDelayMs(
  retryIndex: number,
  config: ReconnectBackoffConfig = DEFAULT_RECONNECT_BACKOFF,
): number | null {
  if (!Number.isInteger(retryIndex) || retryIndex < 0) {
    return null;
  }

  if (config.maxRetries !== null && retryIndex >= config.maxRetries) {
    return null;
  }

  return Math.min(
    Math.round(config.initialDelayMs * config.backoffFactor ** retryIndex),
    config.maxDelayMs,
  );
}
