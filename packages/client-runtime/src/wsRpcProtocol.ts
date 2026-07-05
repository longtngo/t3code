import { WsRpcGroup } from "@t3tools/contracts";
import {
  layerCompressedMsgPack,
  WIRE_FORMAT_MSGPACK_DEFLATE,
  WIRE_FORMAT_QUERY_PARAM,
} from "@t3tools/shared/rpcSerialization";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
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

export type WsWireFormat = "msgpack-deflate" | "json";

// The client advertises compressed MessagePack at the handshake by default. Test
// harnesses whose mock socket can't carry binary frames (msw's WebSocket) force
// "json"; production always uses msgpack. This is also a usable kill-switch if
// msgpack ever needs to be disabled without shipping a new client.
let advertisedWireFormat: WsWireFormat = "msgpack-deflate";

export function setAdvertisedWireFormat(format: WsWireFormat): void {
  advertisedWireFormat = format;
}

function resolveWsRpcSocketUrl(rawUrl: string): string {
  const resolved = new URL(rawUrl);
  if (resolved.protocol !== "ws:" && resolved.protocol !== "wss:") {
    throw new Error(`Unsupported websocket transport URL protocol: ${resolved.protocol}`);
  }

  resolved.pathname = "/ws";
  // Advertise the wire format at the handshake. A server that understands the
  // param replies in kind; one that doesn't ignores it and stays on JSON. Only
  // msgpack needs advertising — JSON is the server's default fallback.
  if (advertisedWireFormat === "msgpack-deflate") {
    resolved.searchParams.set(WIRE_FORMAT_QUERY_PARAM, WIRE_FORMAT_MSGPACK_DEFLATE);
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
  const resolvedUrl =
    typeof url === "function"
      ? Effect.promise(() => url()).pipe(
          Effect.map((rawUrl) => resolveWsRpcSocketUrl(rawUrl)),
          Effect.tapError((error) =>
            Effect.sync(() => {
              lifecycle.onError(formatSocketErrorMessage(error));
            }),
          ),
          Effect.orDie,
        )
      : resolveWsRpcSocketUrl(url);

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
          return protocol.send(clientId, request, transferables);
        },
      }),
    ),
  );
  const connectionHooksLayer = Layer.succeed(
    RpcClient.ConnectionHooks,
    RpcClient.ConnectionHooks.of({
      onConnect: Effect.void,
      onDisconnect: Effect.void,
    }),
  );

  const serializationLayer =
    advertisedWireFormat === "msgpack-deflate"
      ? layerCompressedMsgPack
      : RpcSerialization.layerJson;
  return protocolLayer.pipe(
    Layer.provide(Layer.mergeAll(socketLayer, serializationLayer, connectionHooksLayer)),
  );
}
