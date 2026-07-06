import { WsRpcGroup } from "@t3tools/contracts";
import {
  serializationLayerForWireFormat,
  WIRE_FORMAT_JSON,
  WIRE_FORMAT_MSGPACK_DEFLATE,
  WIRE_FORMAT_MSGPACK_DEFLATE_STREAM,
  WIRE_FORMAT_QUERY_PARAM,
  WS_CAPABILITIES_PATH,
} from "@t3tools/shared/rpcSerialization";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import { RpcClient, RpcClientError } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

import {
  frameByteLength,
  getSharedWireMeter,
  wireMeterLoggingEnabled,
} from "./observability/wireMeter.ts";
import {
  DEFAULT_RECONNECT_BACKOFF,
  getReconnectDelayMs,
  type ReconnectBackoffConfig,
} from "./reconnectBackoff.ts";

export interface WsProtocolLifecycleHandlers {
  readonly getConnectionLabel?: () => string | null;
  readonly getVersionMismatchHint?: () => string | null;
  readonly isCloseIntentional?: () => boolean;
  readonly isActive?: () => boolean;
  readonly onAttempt?: (socketUrl: string) => void;
  readonly onOpen?: () => void;
  readonly onHeartbeatPing?: () => void;
  readonly onHeartbeatPong?: () => void;
  readonly onHeartbeatTimeout?: () => void;
  readonly onRequestStart?: (info: {
    readonly id: string;
    readonly tag: string;
    readonly stream: boolean;
  }) => void;
  readonly onRequestChunk?: (info: {
    readonly id: string;
    readonly tag: string;
    readonly chunkCount: number;
  }) => void;
  readonly onRequestExit?: (info: {
    readonly id: string;
    readonly tag: string;
    readonly stream: boolean;
  }) => void;
  readonly onRequestInterrupt?: (info: { readonly id: string; readonly tag?: string }) => void;
  readonly onError?: (message: string) => void;
  readonly onClose?: (
    details: { readonly code: number; readonly reason: string },
    context: { readonly intentional: boolean },
  ) => void;
}

export interface WsRpcProtocolOptions {
  /** Backoff configuration for reconnect retries. */
  readonly backoff?: ReconnectBackoffConfig;
  /**
   * Invoked before user {@link WsProtocolLifecycleHandlers} for each socket lifecycle event.
   * Use for additive telemetry (connection state, clearing request trackers on disconnect).
   */
  readonly telemetryLifecycle?: WsProtocolLifecycleHandlers;
  /**
   * The wire format for this connection. The serialization codec must be chosen
   * synchronously (the transport builds its runtime with `runSync`), so the caller
   * negotiates the format up front (see {@link negotiateWireFormat}) and passes the
   * result here. Defaults to JSON — the always-safe format — when omitted.
   */
  readonly wireFormat?: WsWireFormat;
}

/**
 * Races a send against socket disconnect. If `disconnectLatch` opens (a disconnect)
 * before the send resolves, the send is interrupted and this fails — so a frame
 * already encoded against the dying connection's deflate window can never be flushed
 * to the NEXT socket (whose window is fresh), which would desync the server's inflate.
 *
 * The latch is opened by `ConnectionHooks.onDisconnect`, which Effect runs during the
 * socket's failure unwind BEFORE the retry re-opens the write latch on a new socket,
 * so this race is won deterministically for a truly in-flight send. Exported for unit
 * testing of that abandon behavior.
 */
export function abandonSendOnDisconnect<A, R>(
  send: Effect.Effect<A, RpcClientError.RpcClientError, R>,
  disconnectLatch: Latch.Latch,
): Effect.Effect<A, RpcClientError.RpcClientError, R> {
  return Effect.raceFirst(
    send,
    Effect.flatMap(disconnectLatch.await, () =>
      Effect.fail(
        new RpcClientError.RpcClientError({
          reason: new RpcClientError.RpcClientDefect({
            message: "send abandoned: socket disconnected before the frame was written",
            cause: undefined,
          }),
        }),
      ),
    ),
  );
}

export const makeWsRpcProtocolClient = RpcClient.make(WsRpcGroup);
type RpcClientFactory = typeof makeWsRpcProtocolClient;
export type WsRpcProtocolClient =
  RpcClientFactory extends Effect.Effect<infer Client, any, any> ? Client : never;
export type WsRpcProtocolSocketUrlProvider = string | (() => Promise<string>);

function formatSocketErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return String(error);
}

export type WsWireFormat = "msgpack-deflate-stream" | "msgpack-deflate" | "json";

// Client preference order — the negotiator picks the FIRST of these the server ALSO
// advertises (capped at `advertisedWireFormat`). Highest-compression first; JSON, the
// always-safe floor, last.
const CLIENT_WIRE_FORMAT_PREFERENCE: readonly WsWireFormat[] = [
  WIRE_FORMAT_MSGPACK_DEFLATE_STREAM,
  WIRE_FORMAT_MSGPACK_DEFLATE,
  WIRE_FORMAT_JSON,
];

// The format the client PREFERS (the ceiling of its precedence). It is not sent
// blindly: the client only speaks a binary format after a capability probe confirms
// the server understands it (see `negotiateWireFormat`), so a newer client can't
// wedge an older, separately-deployed server by shipping frames it can't decode.
// Setting this to "json" is a hard kill-switch — it forces JSON and skips the probe
// entirely, which is also how test harnesses whose mock socket can't carry binary
// frames (msw's WebSocket) pin the transport to JSON.
let advertisedWireFormat: WsWireFormat = WIRE_FORMAT_MSGPACK_DEFLATE_STREAM;

export function setAdvertisedWireFormat(format: WsWireFormat): void {
  advertisedWireFormat = format;
  // The preference changed, so any prior per-origin negotiation is stale.
  wireFormatByOrigin.clear();
}

/** Test seam: forget every cached capability-probe result. */
export function resetWireFormatNegotiation(): void {
  wireFormatByOrigin.clear();
}

// A capability probe must not stall a connection indefinitely if the endpoint
// black-holes (vs. a clean 404). Bound it; on timeout we fall back to JSON.
const WIRE_FORMAT_PROBE_TIMEOUT_MS = 3000;

// Memoized per HTTP origin so a reconnect storm probes at most once per server.
const wireFormatByOrigin = new Map<string, Promise<WsWireFormat>>();

function httpOriginForWsUrl(wsUrl: string): string | null {
  try {
    const parsed = new URL(wsUrl);
    parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
    return parsed.origin;
  } catch {
    return null;
  }
}

// A probe either learns the server's format definitively (`msgpack-deflate` or
// `json`) or fails to reach a verdict (`unavailable`). The distinction matters:
// a definitive verdict is memoized for the process, but an `unavailable` result
// (network error, timeout, CORS) is NOT — so a client that probed while briefly
// offline at startup re-probes on its next connection instead of being pinned to
// JSON for its whole lifetime.
type WireFormatProbeOutcome = WsWireFormat | "unavailable";

function withProbeTimeout(
  probe: Promise<WireFormatProbeOutcome>,
): Promise<WireFormatProbeOutcome> {
  return new Promise<WireFormatProbeOutcome>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (value: WireFormatProbeOutcome) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    // @effect-diagnostics-next-line globalTimers:off - transport-setup probe bound; no Effect runtime in this path.
    timer = setTimeout(() => settle("unavailable"), WIRE_FORMAT_PROBE_TIMEOUT_MS);
    probe.then(settle, () => settle("unavailable"));
  });
}

async function probeServerWireFormat(
  httpOrigin: string,
  preference: readonly WsWireFormat[],
): Promise<WireFormatProbeOutcome> {
  if (typeof fetch !== "function") {
    return "unavailable"; // No fetch (some RN/test envs) → can't reach a verdict; retry later.
  }
  try {
    // @effect-diagnostics-next-line globalFetch:off - one-shot capability probe run as a plain Promise during transport setup, before any Effect/HttpClient context exists.
    const response = await fetch(new URL(WS_CAPABILITIES_PATH, httpOrigin).toString(), {
      method: "GET",
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      // An older server has no such route and 404s — a definitive "JSON only".
      return WIRE_FORMAT_JSON;
    }
    const body: unknown = await response.json();
    const serverFormats =
      typeof body === "object" &&
      body !== null &&
      Array.isArray((body as { wireFormats?: unknown }).wireFormats)
        ? (body as { wireFormats: unknown[] }).wireFormats
        : [];
    // Pick by CLIENT precedence (not server list order), and ONLY a format the server
    // actually advertised — so the client never sends `?fmt=X` for an X the server
    // can't decode. An old server without the stream format downgrades to per-frame
    // or JSON here.
    return preference.find((format) => serverFormats.includes(format)) ?? WIRE_FORMAT_JSON;
  } catch {
    return "unavailable"; // Network error / CORS / malformed JSON → retry on a later connection.
  }
}

/**
 * The client's precedence list capped at {@link advertisedWireFormat}: the ceiling.
 * So `setAdvertisedWireFormat(WIRE_FORMAT_MSGPACK_DEFLATE)` yields `[per-frame, json]`
 * (never upgrades to stream), and the default (stream) yields the full list.
 */
function effectiveClientPreference(): readonly WsWireFormat[] {
  const ceiling = CLIENT_WIRE_FORMAT_PREFERENCE.indexOf(advertisedWireFormat);
  return ceiling > 0 ? CLIENT_WIRE_FORMAT_PREFERENCE.slice(ceiling) : CLIENT_WIRE_FORMAT_PREFERENCE;
}

/**
 * Resolve the wire format to use for `wsUrl`'s server. Returns JSON immediately
 * when JSON is the forced preference; otherwise probes the server's capability
 * endpoint once per origin and upgrades to msgpack only on confirmed support.
 * The transport awaits this BEFORE building a session, so the (synchronously
 * chosen) serialization codec matches what the socket URL advertises. A probe
 * that can't reach the server resolves to JSON but is NOT cached, so a later
 * connection re-probes once the network recovers.
 */
export function negotiateWireFormat(wsUrl: string): Promise<WsWireFormat> {
  if (advertisedWireFormat === WIRE_FORMAT_JSON) {
    return Promise.resolve(WIRE_FORMAT_JSON); // Kill-switch — force JSON, skip the probe.
  }
  const httpOrigin = httpOriginForWsUrl(wsUrl);
  if (httpOrigin === null) {
    return Promise.resolve(WIRE_FORMAT_JSON);
  }
  const preference = effectiveClientPreference();
  let pending = wireFormatByOrigin.get(httpOrigin);
  if (pending === undefined) {
    pending = withProbeTimeout(probeServerWireFormat(httpOrigin, preference)).then((outcome) => {
      if (outcome === "unavailable") {
        // Don't pin a transient failure — allow the next connection to re-probe.
        wireFormatByOrigin.delete(httpOrigin);
        return WIRE_FORMAT_JSON;
      }
      return outcome;
    });
    wireFormatByOrigin.set(httpOrigin, pending);
  }
  return pending;
}

function resolveWsRpcSocketUrl(rawUrl: string, format: WsWireFormat): string {
  const resolved = new URL(rawUrl);
  if (resolved.protocol !== "ws:" && resolved.protocol !== "wss:") {
    throw new Error(`Unsupported websocket transport URL protocol: ${resolved.protocol}`);
  }

  resolved.pathname = "/ws";
  // Advertise the negotiated format at the handshake so the server selects the
  // matching decoder. Any non-JSON format is advertised verbatim; JSON is the
  // server default and needs no query param.
  if (format !== WIRE_FORMAT_JSON) {
    resolved.searchParams.set(WIRE_FORMAT_QUERY_PARAM, format);
  }
  return resolved.toString();
}

type ResolvedLifecycleHandlers = Required<
  Pick<
    WsProtocolLifecycleHandlers,
    | "getConnectionLabel"
    | "getVersionMismatchHint"
    | "isCloseIntentional"
    | "isActive"
    | "onAttempt"
    | "onOpen"
    | "onHeartbeatPing"
    | "onHeartbeatPong"
    | "onHeartbeatTimeout"
    | "onError"
    | "onClose"
  >
>;

function defaultLifecycleHandlers(): ResolvedLifecycleHandlers {
  return {
    onAttempt: () => undefined,
    onOpen: () => undefined,
    onHeartbeatPing: () => undefined,
    onHeartbeatPong: () => undefined,
    onHeartbeatTimeout: () => undefined,
    onError: () => undefined,
    onClose: () => undefined,
    getConnectionLabel: () => null,
    getVersionMismatchHint: () => null,
    isCloseIntentional: () => false,
    isActive: () => true,
  };
}

function resolveLifecycleHandlers(
  handlers: WsProtocolLifecycleHandlers | undefined,
  telemetryLifecycle: WsProtocolLifecycleHandlers | undefined,
): ResolvedLifecycleHandlers {
  const defaults = defaultLifecycleHandlers();
  const isActive = handlers?.isActive ?? telemetryLifecycle?.isActive ?? defaults.isActive;
  const isCloseIntentional =
    handlers?.isCloseIntentional ??
    telemetryLifecycle?.isCloseIntentional ??
    defaults.isCloseIntentional;

  return {
    getConnectionLabel: () =>
      handlers?.getConnectionLabel?.() ?? telemetryLifecycle?.getConnectionLabel?.() ?? null,
    getVersionMismatchHint: () =>
      handlers?.getVersionMismatchHint?.() ??
      telemetryLifecycle?.getVersionMismatchHint?.() ??
      null,
    isActive,
    isCloseIntentional,
    onAttempt: (socketUrl) => {
      if (!isActive()) {
        return;
      }
      telemetryLifecycle?.onAttempt?.(socketUrl);
      handlers?.onAttempt?.(socketUrl);
    },
    onOpen: () => {
      if (!isActive()) {
        return;
      }
      telemetryLifecycle?.onOpen?.();
      handlers?.onOpen?.();
    },
    onHeartbeatPing: () => {
      if (!isActive()) {
        return;
      }
      telemetryLifecycle?.onHeartbeatPing?.();
      handlers?.onHeartbeatPing?.();
    },
    onHeartbeatPong: () => {
      if (!isActive()) {
        return;
      }
      telemetryLifecycle?.onHeartbeatPong?.();
      handlers?.onHeartbeatPong?.();
    },
    onHeartbeatTimeout: () => {
      if (!isActive()) {
        return;
      }
      telemetryLifecycle?.onHeartbeatTimeout?.();
      handlers?.onHeartbeatTimeout?.();
    },
    onError: (message) => {
      if (!isActive()) {
        return;
      }
      telemetryLifecycle?.onError?.(message);
      handlers?.onError?.(message);
    },
    onClose: (details, context) => {
      if (!isActive()) {
        return;
      }
      telemetryLifecycle?.onClose?.(details, context);
      handlers?.onClose?.(details, context);
    },
  };
}

export function createWsRpcProtocolLayer(
  url: WsRpcProtocolSocketUrlProvider,
  handlers?: WsProtocolLifecycleHandlers,
  options?: WsRpcProtocolOptions,
) {
  const lifecycle = resolveLifecycleHandlers(handlers, options?.telemetryLifecycle);
  const backoff = options?.backoff ?? DEFAULT_RECONNECT_BACKOFF;
  // The format is negotiated by the caller (the transport) BEFORE this layer is
  // built, because the serialization codec must be chosen synchronously. Both the
  // socket URL's `?fmt` and the serialization layer below read this one value, so
  // they can never disagree. Absent → JSON, the always-safe format.
  const wireFormat = options?.wireFormat ?? WIRE_FORMAT_JSON;
  // Only the context-takeover stream codec carries per-connection deflate state that
  // ordering/teardown must protect; JSON and per-frame msgpack are order-independent.
  const isStreamFormat = wireFormat === WIRE_FORMAT_MSGPACK_DEFLATE_STREAM;
  // The currently-OPEN socket, so the codec's inbound-desync callback can tear it
  // down (only `close` is needed, kept structural to avoid a DOM `lib` dependency).
  const activeSocket: { current: { close(code?: number, reason?: string): void } | null } = {
    current: null,
  };
  // Two latches gate the stream codec's stateful send against the socket lifecycle:
  //
  // - `connectedLatch` (open only while connected) gates the ENCODE. Effect's
  //   makeProtocolSocket builds a throwaway parser at setup and REASSIGNS a fresh one
  //   on every (re)connect, so a request encoded before the connect would use the
  //   pre-connect window — putting a SECOND deflate stream on the wire that the
  //   server's single inflate can't follow. Waiting for connect makes every encode
  //   use the live post-connect parser (onConnect fires after that reassignment).
  // - `disconnectLatch` (open only while disconnected) ABANDONS an in-flight send: a
  //   frame already encoded when the socket drops must not flush to the next socket
  //   (fresh window) — Effect's writer would otherwise block and replay it there.
  const connectedLatch = isStreamFormat ? Latch.makeUnsafe(false) : undefined;
  const disconnectLatch = isStreamFormat ? Latch.makeUnsafe(false) : undefined;
  const resolvedUrl =
    typeof url === "function"
      ? Effect.promise(() => url()).pipe(
          Effect.map((rawUrl) => resolveWsRpcSocketUrl(rawUrl, wireFormat)),
          Effect.tapError((error) =>
            Effect.sync(() => {
              lifecycle.onError(formatSocketErrorMessage(error));
            }),
          ),
          Effect.orDie,
        )
      : resolveWsRpcSocketUrl(url, wireFormat);

  const trackingWebSocketConstructorLayer = Layer.succeed(
    Socket.WebSocketConstructor,
    (socketUrl, protocols) => {
      lifecycle.onAttempt(socketUrl);
      const socket = new globalThis.WebSocket(socketUrl, protocols);

      // Phase 0 low-bandwidth measurement: count raw on-wire bytes in/out. The
      // meter is always on (a byte-length + add per frame) and readable from the
      // console via `globalThis.__t3WireMeter`; it only *logs* when enabled.
      const wireMeter = getSharedWireMeter();
      const originalSend = socket.send.bind(socket);
      socket.send = (data) => {
        wireMeter.record("sent", frameByteLength(data));
        // `data` is contextually the union across WebSocket.send's overloads, which is
        // wider than the single bound signature under some DOM libs (SharedArrayBuffer
        // skew). It is exactly what the original send expected, so pass it straight on.
        originalSend(data as Parameters<typeof originalSend>[0]);
      };

      socket.addEventListener(
        "open",
        () => {
          activeSocket.current = socket;
          lifecycle.onOpen();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          lifecycle.onError("Unable to connect to the T3 server WebSocket.");
        },
        { once: true },
      );
      socket.addEventListener("message", (event) => {
        wireMeter.record("recv", frameByteLength(event.data));
        // Any inbound frame proves the link is alive, so it refreshes heartbeat
        // liveness. The previous JSON `_tag === "Pong"` sniff can't read the binary
        // MessagePack frames this client now uses; during idle the only traffic is
        // ping/pong anyway, so "any frame" is an equivalent, format-agnostic signal.
        lifecycle.onHeartbeatPong();
      });
      socket.addEventListener(
        "close",
        (event) => {
          if (activeSocket.current === socket) {
            activeSocket.current = null;
          }
          if (wireMeterLoggingEnabled()) {
            // @effect-diagnostics-next-line globalConsole:off - dev-only bandwidth instrument, no Effect runtime in this DOM/RN close callback.
            console.info(`[wire-meter] socket closed — ${wireMeter.format()}`);
          }
          lifecycle.onClose(
            {
              code: event.code,
              reason: event.reason,
            },
            {
              intentional: lifecycle.isCloseIntentional(),
            },
          );
        },
        { once: true },
      );

      return socket;
    },
  );
  const socketLayer = Socket.layerWebSocket(resolvedUrl).pipe(
    Layer.provide(trackingWebSocketConstructorLayer),
  );

  const baseSchedule =
    backoff.maxRetries === null ? Schedule.forever : Schedule.recurs(backoff.maxRetries);
  const retryPolicy = Schedule.addDelay(baseSchedule, (retryCount) =>
    Effect.succeed(Duration.millis(getReconnectDelayMs(retryCount, backoff) ?? 0)),
  );
  // For the context-takeover stream codec, outbound frames must reach the wire in
  // ENCODE order — a reordered frame desyncs the shared deflate window. `protocol.send`
  // encodes eagerly and defers the write, so two concurrent sends could interleave
  // (encode A, encode B, write B, write A → desync). Serialize the whole encode+write
  // under one permit so each frame is atomic and ordered. Stateless formats (json /
  // per-frame) are order-independent and skip this.
  const sendMutex = isStreamFormat ? Semaphore.makeUnsafe(1) : undefined;
  const protocolLayer = Layer.effect(
    RpcClient.Protocol,
    Effect.map(
      RpcClient.makeProtocolSocket({
        retryPolicy,
        retryTransientErrors: true,
      }),
      (protocol) => ({
        ...protocol,
        send: (clientId, request, transferables) => {
          if (request._tag === "Request" && lifecycle.isActive()) {
            handlers?.onRequestStart?.({
              id: request.id,
              tag: request.tag,
              stream: false,
            });
          }
          if (
            sendMutex === undefined ||
            disconnectLatch === undefined ||
            connectedLatch === undefined
          ) {
            return protocol.send(clientId, request, transferables);
          }
          return sendMutex.withPermits(1)(
            abandonSendOnDisconnect(
              // `whenOpen` waits for connect so the encode uses the live post-connect
              // parser (never the throwaway pre-connect one); `Effect.suspend` then
              // defers the eager encode into the permit so encode+write are atomic and
              // ordered. `abandonSendOnDisconnect` drops the frame if the socket drops
              // mid-send (prevents a stale-window flush — see its doc).
              connectedLatch.whenOpen(
                Effect.suspend(() => protocol.send(clientId, request, transferables)),
              ),
              disconnectLatch,
            ),
          );
        },
      }),
    ),
  );
  const connectionHooksLayer = Layer.succeed(
    RpcClient.ConnectionHooks,
    RpcClient.ConnectionHooks.of({
      // Toggle both latches together so the send wrapper (above) gates the encode on
      // connect and abandons an in-flight frame on disconnect. No-ops for the
      // stateless formats, which have no per-connection window to protect.
      onConnect:
        connectedLatch && disconnectLatch
          ? Effect.sync(() => {
              connectedLatch.openUnsafe(); // sends may now encode against the live parser
              disconnectLatch.closeUnsafe();
            })
          : Effect.void,
      onDisconnect:
        connectedLatch && disconnectLatch
          ? Effect.sync(() => {
              connectedLatch.closeUnsafe(); // hold new sends until the next connect
              disconnectLatch.openUnsafe(); // abandon any in-flight send
            })
          : Effect.void,
    }),
  );

  // Same negotiated format the socket URL advertises (single source of truth), so the
  // client never encodes a frame in a format the server hasn't confirmed it can decode.
  // For the stream codec, a failed inbound decode means the persistent inflate window
  // has desynced; close the live socket so the transport reconnects with a fresh
  // window rather than limping on a permanently-broken decode. With ordered server
  // sends + TCP in-order delivery this is a latent-bug backstop, but it keeps a
  // desync from silently wedging the stream.
  const serializationLayer = serializationLayerForWireFormat(
    wireFormat,
    isStreamFormat
      ? () => {
          activeSocket.current?.close(4000, "stream-decode-desync");
        }
      : undefined,
  );
  return protocolLayer.pipe(
    Layer.provide(Layer.mergeAll(socketLayer, serializationLayer, connectionHooksLayer)),
  );
}
