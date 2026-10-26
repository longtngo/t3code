// These guards run on the raw Node HTTP server before Effect handles requests.
// @effect-diagnostics nodeBuiltinImport:off
import type * as NodeHttp from "node:http";
import type * as NodeStream from "node:stream";

/**
 * Statuses and methods that carry no body, so a zero-length write against a
 * declared `Content-Length` is correct rather than truncated.
 */
const BODILESS_STATUSES = new Set([204, 304]);

/**
 * Destroy the connection when a body ends short of its declared length (a file shrank mid-stream):
 * keep-alive would write the NEXT response into what the client still counts as this body. Not
 * fixed by re-stat (the race spans the whole stream) or by buffering (8 MB heap per response).
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

/**
 * NodeHttpServer listens before serve() attaches its handlers, so requests in
 * between would hang. Install this after the write-error guards so only the
 * serving handlers trigger the handoff.
 */
export function rejectRequestsUntilServing<T extends NodeHttp.Server>(server: T): T {
  const rejectRequest = (_request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => {
    response.writeHead(503, { "retry-after": "1", connection: "close" }).end();
  };
  const rejectUpgrade = (_request: NodeHttp.IncomingMessage, socket: NodeStream.Duplex) => {
    socket.end(
      "HTTP/1.1 503 Service Unavailable\r\nRetry-After: 1\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    );
  };
  server.on("request", rejectRequest);
  server.on("upgrade", rejectUpgrade);
  // Node emits newListener before adding the handler, making the handoff synchronous.
  server.on("newListener", function onNewListener(event) {
    if (event === "request") server.off("request", rejectRequest);
    if (event === "upgrade") server.off("upgrade", rejectUpgrade);
    if (
      !server.listeners("request").includes(rejectRequest) &&
      !server.listeners("upgrade").includes(rejectUpgrade)
    ) {
      server.off("newListener", onNewListener);
    }
  });
  return server;
}
