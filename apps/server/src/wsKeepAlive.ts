import type * as HttpServerRequest from "effect/http/HttpServerRequest";

/**
 * Idle time before the first TCP keepalive probe. A peer that vanishes without FIN/RST looks quiet,
 * so its scope (session, subscriptions, drain pumps) would be held forever; unanswered probes make
 * the OS close it through the normal release path. Interval and count are OS defaults (darwin: 75s,
 * 8 probes), so a dead peer is reclaimed in roughly ten minutes.
 */
export const WEBSOCKET_KEEPALIVE_IDLE_MS = 30_000;

/** The subset of `net.Socket` this needs, so tests need no real socket. */
export interface KeepAliveCapableSocket {
  readonly setKeepAlive?: (enable: boolean, initialDelay: number) => unknown;
}

/**
 * Enable TCP keepalive on the socket behind `request.source`. Must run in the route handler before
 * the upgrade, after which `ws` owns the socket. Returns whether it was enabled, so a platform
 * exposing no socket is visible rather than silently unprotected.
 */
export function enableWebSocketKeepAlive(
  request: HttpServerRequest.HttpServerRequest,
  idleMs: number = WEBSOCKET_KEEPALIVE_IDLE_MS,
): boolean {
  const source = request.source as
    | {
        readonly socket?: KeepAliveCapableSocket | null;
      }
    | null
    | undefined;
  const socket = source?.socket;
  if (!socket || typeof socket.setKeepAlive !== "function") return false;
  socket.setKeepAlive(true, idleMs);
  return true;
}
