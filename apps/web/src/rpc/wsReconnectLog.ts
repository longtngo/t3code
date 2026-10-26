/**
 * Opt-in reconnect timeline (`localStorage["t3.wsReconnect"] = "1"`): one `console.info` per
 * supervisor phase change with an ABSOLUTE `performance.now()` and the connection label. No shared
 * "previous timestamp" state, since every connection drops together on mobile; the reader computes
 * deltas. Observation-only: it never changes reconnect behavior.
 */

const RECONNECT_LOG_STORAGE_KEY = "t3.wsReconnect";

export type WsReconnectPhase =
  | "available"
  | "offline"
  | "connecting"
  | "reconnecting"
  | "connected"
  | "error"
  | "unsupported";

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
