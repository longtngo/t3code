import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

/**
 * Idle time before the OS sends its first TCP keepalive probe on a websocket
 * connection.
 *
 * A websocket peer can vanish without ever sending a FIN or RST — a phone
 * sleeping, wifi dropping, a NAT or relay hop forgetting the mapping. From the
 * server's side that is indistinguishable from a peer that is simply quiet, so
 * nothing at the application layer ever closes the connection and its scope
 * (session marked connected, live subscriptions and their drain pumps) is held
 * forever. Reconnects then stack new scopes on top of the dead ones.
 *
 * TCP keepalive is what makes the two cases distinguishable: probes to a peer
 * that is really gone go unanswered, and the OS tears the connection down,
 * which surfaces as a normal socket close and releases the scope through the
 * existing release path.
 *
 * Only the idle delay is settable from Node; the probe interval and count are
 * OS defaults (darwin: 75s apart, 8 probes), so a dead peer is reclaimed in
 * roughly ten minutes rather than never.
 */
export const WEBSOCKET_KEEPALIVE_IDLE_MS = 30_000;

/** The subset of `net.Socket` this needs, so tests need no real socket. */
export interface KeepAliveCapableSocket {
  readonly setKeepAlive?: (enable: boolean, initialDelay: number) => unknown;
}

/**
 * Enable TCP keepalive on the connection behind `request`.
 *
 * Reads the raw socket off the Node request the same way `isLocalLoopbackRequest`
 * does. This has to happen in the route handler, before the upgrade: afterwards
 * the socket belongs to the `ws` library inside the platform layer and is no
 * longer reachable from application code without patching it.
 *
 * Returns whether keepalive was actually enabled, so a platform that does not
 * expose a socket is visible rather than silently unprotected.
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
