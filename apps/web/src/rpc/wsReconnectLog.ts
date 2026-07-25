/**
 * Opt-in, stateless timeline logger for connection reconnects.
 *
 * OFF by default; flip on via `localStorage["t3.wsReconnect"] = "1"` in the
 * browser console. When on, each connection-phase transition emits one
 * `console.info` line carrying an ABSOLUTE `performance.now()` timestamp, the
 * connection label, and the observed phase. Deltas are computed by the reader
 * (subtraction), and multiple connections are de-interleaved by label — so this
 * module holds NO shared "previous timestamp" state that could cross-contaminate
 * two connections reconnecting at once (a mobile Tailscale drop takes every
 * connection down together). See the 2026-07-11 ws-reconnect-latency design.
 *
 * The phases are the presentation phases surfaced by the connection supervisor
 * (`@t3tools/client-runtime/connection` `EnvironmentConnectionPhase`), replacing
 * the fork's raw socket-lifecycle events. The mapping from the fork's names is:
 *   attempt → connecting / reconnecting
 *   open    → connected
 *   error   → error
 *   close   → offline / available
 *
 * Reading a repro: `connected`→`reconnecting` gap ≈ dead-connection detection
 * latency; each `reconnecting`→previous gap ≈ backoff gap; last
 * `reconnecting`→`connected` gap ≈ connect time (tunnel wait + capability probe).
 *
 * This logger is diagnostic and observation-only: it never changes reconnect
 * behavior. It is fed by `useWsReconnectTimelineLog` (see
 * `../connection/wsReconnectTimeline`), which passively observes the supervisor's
 * presentation-phase changes without modifying the supervisor.
 */

const RECONNECT_LOG_STORAGE_KEY = "t3.wsReconnect";

export type WsReconnectPhase =
  | "available"
  | "offline"
  | "connecting"
  | "reconnecting"
  | "connected"
  | "error";

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

export function logWsReconnectPhase(
  phase: WsReconnectPhase,
  label: string | null,
  detail?: Record<string, string | number | null | undefined>,
): void {
  if (!wsReconnectLoggingEnabled()) {
    return;
  }
  console.info(
    `[ws-reconnect] ${phase} t=${nowMs().toFixed(1)}ms label=${label ?? "?"}`,
    detail ?? {},
  );
}
