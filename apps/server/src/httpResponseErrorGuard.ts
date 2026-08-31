// @effect-diagnostics nodeBuiltinImport:off
import type * as NodeHttp from "node:http";

/**
 * Node surfaces late socket write failures (EPIPE, ECONNRESET,
 * ERR_STREAM_DESTROYED) as "error" events. An "error" event without a
 * listener escalates into an uncaught exception and terminates the whole
 * server process, taking every other client and all in-flight provider
 * work with it.
 *
 * Two emitters need coverage:
 *
 * - Upgrade sockets. Once a connection upgrades (the websocket RPC path,
 *   including its auth rejection responses), Node's http server detaches
 *   its own socket error handling, so the raw socket has no listener at
 *   all until the websocket server adopts it.
 * - Server responses. Response streams have no default error listener
 *   either.
 *
 * A disconnected client only affects its own request: the request fiber is
 * already interrupted through the response "close" event, so the write
 * failure needs no handling beyond being observed.
 */
/**
 * Statuses and methods that carry no body, so a zero-length write against a
 * declared `Content-Length` is correct rather than truncated.
 */
const BODILESS_STATUSES = new Set([204, 304]);

/**
 * Destroy the connection when a response delivers fewer bytes than it declared.
 *
 * A body can end short without the response failing: a file that shrinks while it
 * is being streamed stops at EOF, and the server considers the response complete.
 * Node then returns the connection to the keep-alive pool, and the NEXT response
 * on it is written into what the client is still counting as the previous body —
 * measured directly, a second response's bytes appearing inside body #1. The
 * client is left parsing a response it never asked for.
 *
 * Destroying the connection is the whole fix. It cannot make the declared length
 * honest — the file really did shrink, and by then the headers are long gone —
 * but it converts a silent cross-response desync into the transport error this
 * actually is, and the client retries. Measured: a 6-second stall (the keep-alive
 * reaper, not an infinite hang as first assumed) becomes 6 milliseconds, and the
 * desync disappears.
 *
 * Deliberately NOT fixed by re-stat: the race window is the entire body-streaming
 * duration, not the gap between two stats, so a late re-stat measures identically
 * to doing nothing (73.3% vs 73.7% under-delivery under a 1.5 ms flap). Buffering
 * the range instead is the only way to never lie, and costs 8 MB of heap per
 * in-flight response in a server with a documented OOM history.
 */
function guardShortResponseBody(
  request: NodeHttp.IncomingMessage,
  response: NodeHttp.ServerResponse,
  onError?: (error: unknown) => void,
): void {
  if (request.method === "HEAD") return;
  let written = 0;
  // Headers passed to `writeHead(status, headers)` never reach the header map,
  // so `getHeader("content-length")` is undefined for them — a guard that only
  // consulted `getHeader` was measurably inert. Both paths are captured.
  let declaredViaWriteHead: number | undefined;
  const writeHead = response.writeHead.bind(response);
  response.writeHead = ((...args: Parameters<typeof writeHead>) => {
    for (const argument of args) {
      if (typeof argument !== "object" || argument === null || Array.isArray(argument)) continue;
      for (const [name, value] of Object.entries(argument as Record<string, unknown>)) {
        if (name.toLowerCase() === "content-length") declaredViaWriteHead = Number(value);
      }
    }
    return writeHead(...args);
  }) as typeof response.writeHead;
  const countChunk = (chunk: unknown, encoding: unknown): void => {
    if (typeof chunk === "string") {
      written +=
        typeof encoding === "string"
          ? Buffer.byteLength(chunk, encoding as BufferEncoding)
          : Buffer.byteLength(chunk);
    } else if (chunk instanceof Uint8Array) {
      written += chunk.byteLength;
    }
  };
  const write = response.write.bind(response) as (...args: unknown[]) => boolean;
  response.write = ((...args: unknown[]) => {
    countChunk(args[0], args[1]);
    return write(...args);
  }) as typeof response.write;
  const end = response.end.bind(response) as (...args: unknown[]) => unknown;
  response.end = ((...args: unknown[]) => {
    // A callback in the first slot means "no body chunk", so it must not be
    // counted as one.
    if (typeof args[0] !== "function") countChunk(args[0], args[1]);
    end(...args);
    return response;
  }) as typeof response.end;

  response.on("finish", () => {
    if (BODILESS_STATUSES.has(response.statusCode)) return;
    const declared = declaredViaWriteHead ?? Number(response.getHeader("content-length"));
    // No declared length means a chunked body, whose framing already says where
    // it ends. Only an under-delivery desyncs the connection; over-delivery is
    // rejected by Node itself.
    if (!Number.isFinite(declared) || written >= declared) return;
    onError?.(
      new Error(
        `HTTP response body ended ${declared - written} bytes short of its declared Content-Length; destroying the connection to avoid a keep-alive desync.`,
      ),
    );
    response.socket?.destroy();
  });
}

export function guardHttpResponseWriteErrors<T extends NodeHttp.Server>(
  server: T,
  onError?: (error: unknown) => void,
): T {
  server.on("request", (request, response) => {
    response.on("error", (error) => {
      onError?.(error);
    });
    guardShortResponseBody(request, response, onError);
  });
  server.on("upgrade", (_request, socket) => {
    socket.on("error", (error) => {
      onError?.(error);
    });
  });
  return server;
}
