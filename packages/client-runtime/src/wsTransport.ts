import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { RpcClient } from "effect/unstable/rpc";

import { isTransportConnectionErrorMessage } from "./transportError.ts";
import {
  createWsRpcProtocolLayer,
  makeWsRpcProtocolClient,
  negotiateWireFormat,
  type WsProtocolLifecycleHandlers,
  type WsRpcProtocolClient,
  type WsRpcProtocolSocketUrlProvider,
  type WsWireFormat,
} from "./wsRpcProtocol.ts";

export interface WsTransportOptions {
  /**
   * Merged into the transport `ManagedRuntime` alongside the RPC protocol layer
   * (for example a `Tracer` layer for OTLP).
   */
  readonly tracingLayer?: Layer.Layer<never, never, never>;
  /**
   * Override protocol construction (defaults to {@link createWsRpcProtocolLayer}).
   * The web app supplies its instrumented layer factory. `wireFormat` is the
   * format the transport negotiated for this connection; the factory must build
   * its serialization codec from it.
   */
  readonly createProtocolLayer?: (
    url: WsRpcProtocolSocketUrlProvider,
    lifecycleHandlers?: WsProtocolLifecycleHandlers,
    wireFormat?: WsWireFormat,
  ) => Layer.Layer<RpcClient.Protocol, never, never>;
  readonly logWarning?: (message: string, metadata: { readonly error: string }) => void;
}

interface SubscribeOptions {
  readonly retryDelay?: Duration.Input;
  readonly onResubscribe?: () => void;
  readonly tag?: string;
}

const DEFAULT_SUBSCRIPTION_RETRY_DELAY = Duration.millis(250);
const NOOP: () => void = () => undefined;

interface TransportSession {
  readonly clientPromise: Promise<WsRpcProtocolClient>;
  readonly clientScope: Scope.Closeable;
  readonly runtime: ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never>;
  /** Identifies this session against {@link WsTransport}'s `activeSessionId`. */
  readonly sessionId: number;
}

/**
 * Render an arbitrary thrown/failed value into a diagnostic string for logging.
 *
 * `Error` instances keep their `message` (transport-connection detection keys off it).
 * Non-`Error` values — e.g. an Effect failure squashed from a `Cause`, or a structured RPC
 * error — used to collapse to a useless `"[object Object]"` via `String(value)`. Instead we
 * surface a tagged error's `_tag`/`message`, then fall back to JSON, then to `String`, so a
 * protocol mismatch logs something actionable rather than an opaque blob.
 */
export function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message.trim().length > 0 ? error.message : String(error);
  }

  if (error !== null && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const tag = typeof record._tag === "string" ? record._tag : undefined;
    const message = typeof record.message === "string" ? record.message : undefined;
    if (tag !== undefined || message !== undefined) {
      return [tag, message].filter((part) => part !== undefined && part.length > 0).join(": ");
    }

    try {
      const json = JSON.stringify(error);
      if (typeof json === "string" && json.length > 0) {
        return json;
      }
    } catch {
      // Unserializable (circular refs, BigInt, …) — fall through to String().
    }
  }

  return String(error);
}

export class WsTransport {
  private readonly url: WsRpcProtocolSocketUrlProvider;
  private readonly lifecycleHandlers: WsProtocolLifecycleHandlers | undefined;
  private readonly options: WsTransportOptions | undefined;
  private disposed = false;
  private hasReportedTransportDisconnect = false;
  private intentionalCloseDepth = 0;
  private nextSessionId = 0;
  private activeSessionId = 0;
  private lastHeartbeatPongAt: number | null = null;
  private readonly streamRequestStartListeners = new Set<
    (info: { readonly tag: string }) => void
  >();
  private reconnectChain: Promise<void> = Promise.resolve();
  // The session is created lazily: the wire format must be negotiated with the
  // server (an async capability probe) BEFORE the runtime — and thus the
  // serialization codec — is built synchronously. `sessionInit` de-dupes
  // concurrent first-connect attempts.
  private session: TransportSession | null = null;
  private sessionInit: Promise<TransportSession> | null = null;

  constructor(
    url: WsRpcProtocolSocketUrlProvider,
    lifecycleHandlers?: WsProtocolLifecycleHandlers,
    options?: WsTransportOptions,
  ) {
    this.url = url;
    this.lifecycleHandlers = lifecycleHandlers;
    this.options = options;
    // Start connecting eagerly (negotiate + open), matching the previous
    // constructor-time behavior. Errors surface when a request/subscribe awaits.
    void this.ensureSession().catch(() => undefined);
  }

  /**
   * Return the current session, negotiating the wire format and creating the
   * first session on demand. Concurrent callers share one in-flight init.
   */
  private async ensureSession(): Promise<TransportSession> {
    if (this.disposed) {
      throw new Error("Transport disposed");
    }
    if (this.session) {
      return this.session;
    }
    if (!this.sessionInit) {
      this.sessionInit = this.negotiateAndCreateSession().finally(() => {
        this.sessionInit = null;
      });
    }
    await this.sessionInit;
    if (this.disposed) {
      throw new Error("Transport disposed");
    }
    if (!this.session) {
      throw new Error("Failed to establish transport session");
    }
    return this.session;
  }

  private async negotiateAndCreateSession(): Promise<TransportSession> {
    const wireFormat = await this.resolveWireFormat();
    return this.adoptSession(this.createSession(wireFormat));
  }

  /**
   * Install `session` as the current one — but only if it hasn't already been
   * superseded (by a reconnect that ran during the async negotiation) or the
   * transport disposed. A stale or post-dispose session is torn down instead of
   * being kept, which is what prevents a leaked open socket + runtime.
   */
  private async adoptSession(session: TransportSession): Promise<TransportSession> {
    if (this.disposed || session.sessionId !== this.activeSessionId) {
      await this.closeSession(session);
      return session;
    }
    const previous = this.session;
    this.session = session;
    if (previous && previous !== session) {
      await this.closeSession(previous);
    }
    return session;
  }

  /**
   * Resolve the connection URL and negotiate its server's wire format. Any
   * failure (bad URL, probe error) resolves to JSON — the safe fallback — so a
   * client never sends binary frames a server hasn't confirmed it can decode.
   * The negotiation is memoized per origin, so reconnects don't re-probe a
   * server whose format is already known.
   */
  private async resolveWireFormat(): Promise<WsWireFormat> {
    try {
      const rawUrl = typeof this.url === "function" ? await this.url() : this.url;
      return await negotiateWireFormat(rawUrl);
    } catch {
      return "json";
    }
  }

  async request<TSuccess>(
    execute: (client: WsRpcProtocolClient) => Effect.Effect<TSuccess, Error, never>,
  ): Promise<TSuccess> {
    if (this.disposed) {
      throw new Error("Transport disposed");
    }

    const session = await this.ensureSession();
    const client = await session.clientPromise;
    return await session.runtime.runPromise(Effect.suspend(() => execute(client)));
  }

  async requestStream<TValue>(
    connect: (client: WsRpcProtocolClient) => Stream.Stream<TValue, Error, never>,
    listener: (value: TValue) => void,
  ): Promise<void> {
    if (this.disposed) {
      throw new Error("Transport disposed");
    }

    const session = await this.ensureSession();
    const client = await session.clientPromise;
    await session.runtime.runPromise(
      Stream.runForEach(connect(client), (value) =>
        Effect.sync(() => {
          try {
            listener(value);
          } catch {
            // Ignore listener errors so the stream can finish cleanly.
          }
        }),
      ),
    );
  }

  subscribe<TValue>(
    connect: (client: WsRpcProtocolClient) => Stream.Stream<TValue, Error, never>,
    listener: (value: TValue) => void,
    options?: SubscribeOptions,
  ): () => void {
    if (this.disposed) {
      return NOOP;
    }

    let active = true;
    let hasReceivedValue = false;
    const retryDelayMs = Duration.toMillis(
      Duration.fromInputUnsafe(options?.retryDelay ?? DEFAULT_SUBSCRIPTION_RETRY_DELAY),
    );
    let cancelCurrentStream: () => void = NOOP;
    const onStreamRequestStart = (info: { readonly tag: string }) => {
      if (
        !hasReceivedValue ||
        !active ||
        (options?.tag !== undefined && info.tag !== options.tag)
      ) {
        return;
      }

      try {
        options?.onResubscribe?.();
      } catch {
        // Ignore reconnect hook failures so the stream can recover.
      }
    };
    this.streamRequestStartListeners.add(onStreamRequestStart);

    void (async () => {
      for (;;) {
        if (!active || this.disposed) {
          return;
        }

        let session: TransportSession;
        try {
          session = await this.ensureSession();
        } catch {
          // First-connect negotiation failed; retry after the backoff below.
          if (!active || this.disposed) {
            return;
          }
          await sleep(retryDelayMs);
          continue;
        }
        if (!active || this.disposed) {
          return;
        }
        try {
          if (hasReceivedValue) {
            try {
              options?.onResubscribe?.();
            } catch {
              // Ignore reconnect hook failures so the stream can recover.
            }
          }
          const runningStream = this.runStreamOnSession(
            session,
            connect,
            listener,
            () => active,
            () => {
              this.hasReportedTransportDisconnect = false;
              hasReceivedValue = true;
            },
          );
          cancelCurrentStream = runningStream.cancel;
          await runningStream.completed;
          cancelCurrentStream = NOOP;
        } catch (error) {
          cancelCurrentStream = NOOP;
          if (!active || this.disposed) {
            return;
          }

          // Skip retry if the session has already been replaced by a reconnect.
          if (session !== this.session) {
            continue;
          }

          const formattedError = formatErrorMessage(error);
          if (!isTransportConnectionErrorMessage(formattedError)) {
            this.logWarning("WebSocket RPC subscription failed", { error: formattedError });
            return;
          }

          if (!this.hasReportedTransportDisconnect) {
            this.logWarning("WebSocket RPC subscription disconnected", {
              error: formattedError,
            });
          }
          this.hasReportedTransportDisconnect = true;
          await sleep(retryDelayMs);
        }
      }
    })();

    return () => {
      active = false;
      this.streamRequestStartListeners.delete(onStreamRequestStart);
      cancelCurrentStream();
    };
  }

  async reconnect() {
    if (this.disposed) {
      throw new Error("Transport disposed");
    }

    const reconnectOperation = this.reconnectChain.then(async () => {
      if (this.disposed) {
        throw new Error("Transport disposed");
      }

      this.lastHeartbeatPongAt = null;
      // Re-resolve the format (memoized per origin, so a confirmed server does
      // not re-probe; a server that only briefly failed the first probe can now
      // upgrade). adoptSession closes the session this replaces.
      const wireFormat = await this.resolveWireFormat();
      await this.adoptSession(this.createSession(wireFormat));
    });

    this.reconnectChain = reconnectOperation.catch(() => undefined);
    await reconnectOperation;
  }

  isHeartbeatFresh(maxAgeMs = 15_000): boolean {
    return (
      this.lastHeartbeatPongAt !== null && performance.now() - this.lastHeartbeatPongAt <= maxAgeMs
    );
  }

  async dispose() {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    // Let any in-flight first-connect finish so adoptSession tears down the
    // session it builds (adoptSession sees `disposed` and closes it) instead of
    // leaking an open socket created after dispose.
    const pendingInit = this.sessionInit;
    if (pendingInit) {
      await pendingInit.catch(() => undefined);
    }
    if (this.session) {
      await this.closeSession(this.session);
    }
  }

  private closeSession(session: TransportSession) {
    this.intentionalCloseDepth += 1;
    return session.runtime.runPromise(Scope.close(session.clientScope, Exit.void)).finally(() => {
      this.intentionalCloseDepth = Math.max(0, this.intentionalCloseDepth - 1);
      session.runtime.dispose();
    });
  }

  private createSession(wireFormat: WsWireFormat): TransportSession {
    const protocolFactory =
      this.options?.createProtocolLayer ??
      ((url, handlers, format) =>
        createWsRpcProtocolLayer(url, handlers, { wireFormat: format ?? "json" }));
    const sessionId = this.nextSessionId + 1;
    this.nextSessionId = sessionId;
    this.activeSessionId = sessionId;
    const lifecycleHandlers = this.lifecycleHandlers;
    const protocolLayer = protocolFactory(
      this.url,
      {
        ...lifecycleHandlers,
        isActive: () =>
          !this.disposed &&
          this.activeSessionId === sessionId &&
          (lifecycleHandlers?.isActive?.() ?? true),
        isCloseIntentional: () =>
          this.disposed ||
          this.intentionalCloseDepth > 0 ||
          lifecycleHandlers?.isCloseIntentional?.() === true,
        onHeartbeatPong: () => {
          this.lastHeartbeatPongAt = performance.now();
          lifecycleHandlers?.onHeartbeatPong?.();
        },
        onRequestStart: (info) => {
          lifecycleHandlers?.onRequestStart?.(info);
          if (!info.stream) {
            return;
          }
          for (const listener of this.streamRequestStartListeners) {
            listener({ tag: info.tag });
          }
        },
      },
      wireFormat,
    );
    const rootLayer = this.options?.tracingLayer
      ? Layer.mergeAll(protocolLayer, this.options.tracingLayer)
      : protocolLayer;
    const runtime = ManagedRuntime.make(rootLayer);
    const clientScope = runtime.runSync(Scope.make());
    return {
      runtime,
      clientScope,
      clientPromise: runtime.runPromise(Scope.provide(clientScope)(makeWsRpcProtocolClient)),
      sessionId,
    };
  }

  private logWarning(message: string, metadata: { readonly error: string }) {
    const logWarning = this.options?.logWarning;
    if (logWarning) {
      logWarning(message, metadata);
    } else {
      Effect.runSync(Effect.logWarning(message, metadata));
    }
  }

  private runStreamOnSession<TValue>(
    session: TransportSession,
    connect: (client: WsRpcProtocolClient) => Stream.Stream<TValue, Error, never>,
    listener: (value: TValue) => void,
    isActive: () => boolean,
    markValueReceived: () => void,
  ): {
    readonly cancel: () => void;
    readonly completed: Promise<void>;
  } {
    let resolveCompleted!: () => void;
    let rejectCompleted!: (error: unknown) => void;
    const completed = new Promise<void>((resolve, reject) => {
      resolveCompleted = resolve;
      rejectCompleted = reject;
    });
    const cancel = session.runtime.runCallback(
      Effect.promise(() => session.clientPromise).pipe(
        Effect.flatMap((client) =>
          Stream.runForEach(connect(client), (value) =>
            Effect.sync(() => {
              if (!isActive()) {
                return;
              }

              markValueReceived();
              try {
                listener(value);
              } catch {
                // Ignore listener errors so the stream stays live.
              }
            }),
          ),
        ),
      ),
      {
        onExit: (exit) => {
          if (Exit.isSuccess(exit)) {
            resolveCompleted();
            return;
          }

          rejectCompleted(Cause.squash(exit.cause));
        },
      },
    );

    return {
      cancel,
      completed,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return Effect.runPromise(Effect.sleep(Duration.millis(ms)));
}
