/**
 * Opt-in, stateless timeline logger for WebSocket reconnects.
 *
 * OFF by default; flip on via `localStorage["t3.wsReconnect"] = "1"` in the
 * browser console. When on, each connection-lifecycle event emits one
 * `console.info` line carrying an ABSOLUTE `performance.now()` timestamp, the
 * connection label, and event detail. Deltas are computed by the reader
 * (subtraction), and multiple connections are de-interleaved by label — so this
 * module holds NO shared "previous timestamp" state that could cross-contaminate
 * two sockets reconnecting at once (the mobile Tailscale drop takes every
 * connection down together). See the 2026-07-11 ws-reconnect-latency design.
 *
 * Reading a repro: `open`→`close` gap ≈ dead-socket detection latency; each
 * `attempt`→previous gap ≈ backoff gap; last `attempt`→`open` gap ≈ connect time
 * (tunnel wait + capability probe).
 */

const RECONNECT_LOG_STORAGE_KEY = "t3.wsReconnect";

export type WsReconnectEvent = "attempt" | "open" | "error" | "close";

export function wsReconnectLoggingEnabled(): boolean {
  try {
    const withStorage = globalThis as {
      localStorage?: { getItem(key: string): string | null };
    };
    return withStorage.localStorage?.getItem(RECONNECT_LOG_STORAGE_KEY) === "1";
  } catch {
    // Accessing localStorage can throw in sandboxed/partitioned/SSR contexts.
    return false;
  }
}

function nowMs(): number {
  const withPerformance = globalThis as { performance?: { now?: () => number } };
  const now = withPerformance.performance?.now;
  return typeof now === "function" ? now.call(withPerformance.performance) : 0;
}

export function logWsReconnectEvent(
  event: WsReconnectEvent,
  label: string | null,
  detail?: Record<string, string | number | null | undefined>,
): void {
  if (!wsReconnectLoggingEnabled()) {
    return;
  }
  console.info(
    `[ws-reconnect] ${event} t=${nowMs().toFixed(1)}ms label=${label ?? "?"}`,
    detail ?? {},
  );
}
