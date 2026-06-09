import { ORCHESTRATION_WS_METHODS, WS_METHODS, WsRpcGroup } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import type * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { RpcMessage, RpcSchema, RpcSerialization, RpcServer } from "effect/unstable/rpc";

type RpcServerInstance = RpcServer.RpcServer<any>;

type BrowserWsClient = {
  send: (data: string) => void;
};

export type NormalizedWsRpcRequestBody = {
  _tag: string;
  [key: string]: unknown;
};

type UnaryResolverResult = unknown | Promise<unknown>;

interface BrowserWsRpcHarnessOptions {
  readonly resolveUnary?: (request: NormalizedWsRpcRequestBody) => UnaryResolverResult;
  readonly getInitialStreamValues?: (
    request: NormalizedWsRpcRequestBody,
  ) => ReadonlyArray<unknown> | undefined;
}

const ALL_RPC_METHODS = Array.from(WsRpcGroup.requests.keys());

/**
 * Stream RPCs, derived directly from the contract so this never drifts as new streaming
 * methods are added. A method whose success schema is an `RpcSchema.Stream` must be answered
 * with a stream; answering it as a unary call sends a malformed response that corrupts the
 * shared WS session and tears down every concurrent subscription. (Hardcoding this set
 * previously let `subscribeHostMetrics` slip through and break all streams.)
 */
const STREAM_METHODS = new Set<string>(
  Array.from(WsRpcGroup.requests.values())
    .filter((rpc) =>
      RpcSchema.isStreamSchema((rpc as { readonly successSchema: Schema.Top }).successSchema),
    )
    .map((rpc) => (rpc as { readonly _tag: string })._tag),
);

// Fail loud, not silent. The derivation above leans on `RpcSchema.isStreamSchema`, an unstable
// effect API. If a future effect bump changes the stream marker, the filter would silently
// match nothing, every stream RPC would be answered as a unary call, and *every* browser test
// would corrupt its WS session with the same opaque timeout we hunted down once already. Anchor
// the derivation to a couple of methods we know are streams so that regression trips here, at
// import, with a clear message — instead of as mass test flakes.
for (const requiredStreamMethod of [
  ORCHESTRATION_WS_METHODS.subscribeShell,
  WS_METHODS.subscribeServerConfig,
]) {
  if (!STREAM_METHODS.has(requiredStreamMethod)) {
    throw new Error(
      `wsRpcHarness: stream-method derivation is broken — expected '${requiredStreamMethod}' to ` +
        `be detected as a streaming RPC. Did effect's RpcSchema.isStreamSchema change shape?`,
    );
  }
}

function normalizeRequest(tag: string, payload: unknown): NormalizedWsRpcRequestBody {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return {
      _tag: tag,
      ...(payload as Record<string, unknown>),
    };
  }
  return { _tag: tag, payload };
}

function asEffect(result: UnaryResolverResult): Effect.Effect<unknown> {
  if (result instanceof Promise) {
    return Effect.promise(() => result);
  }
  return Effect.succeed(result);
}

export class BrowserWsRpcHarness {
  readonly requests: Array<NormalizedWsRpcRequestBody> = [];

  private readonly parser = RpcSerialization.json.makeUnsafe();
  private client: BrowserWsClient | null = null;
  private scope: Scope.Closeable | null = null;
  private serverReady: Promise<RpcServerInstance> | null = null;
  private resolveUnary: NonNullable<BrowserWsRpcHarnessOptions["resolveUnary"]> = () => ({});
  private getInitialStreamValues: NonNullable<
    BrowserWsRpcHarnessOptions["getInitialStreamValues"]
  > = () => [];
  private streamPubSubs = new Map<string, PubSub.PubSub<unknown>>();

  async reset(options?: BrowserWsRpcHarnessOptions): Promise<void> {
    await this.disconnect();
    this.requests.length = 0;
    this.resolveUnary = options?.resolveUnary ?? (() => ({}));
    this.getInitialStreamValues = options?.getInitialStreamValues ?? (() => []);
    this.initializeStreamPubSubs();
  }

  connect(client: BrowserWsClient): void {
    if (this.scope) {
      void Effect.runPromise(Scope.close(this.scope, Exit.void)).catch(() => undefined);
    }
    if (this.streamPubSubs.size === 0) {
      this.initializeStreamPubSubs();
    }
    this.client = client;
    this.scope = Effect.runSync(Scope.make());
    this.serverReady = Effect.runPromise(
      Scope.provide(this.scope)(
        RpcServer.makeNoSerialization(WsRpcGroup, this.makeServerOptions()),
      ).pipe(Effect.provide(this.makeLayer())),
    ) as Promise<RpcServerInstance>;
  }

  async disconnect(): Promise<void> {
    if (this.scope) {
      await Effect.runPromise(Scope.close(this.scope, Exit.void)).catch(() => undefined);
      this.scope = null;
    }
    for (const pubsub of this.streamPubSubs.values()) {
      Effect.runSync(PubSub.shutdown(pubsub));
    }
    this.streamPubSubs.clear();
    this.serverReady = null;
    this.client = null;
  }

  private initializeStreamPubSubs(): void {
    this.streamPubSubs = new Map(
      Array.from(STREAM_METHODS, (method) => [method, Effect.runSync(PubSub.unbounded<unknown>())]),
    );
  }

  async onMessage(rawData: string): Promise<void> {
    const server = await this.serverReady;
    if (!server) {
      return;
    }
    const messages = this.parser.decode(rawData);
    for (const message of messages) {
      if (message && typeof message === "object" && "_tag" in message && message._tag === "Ping") {
        const encoded = this.parser.encode(RpcMessage.constPong);
        if (typeof encoded === "string") {
          this.client?.send(encoded);
        }
        continue;
      }
      await Effect.runPromise(server.write(0, message as never));
    }
  }

  emitStreamValue(method: string, value: unknown): void {
    const pubsub = this.streamPubSubs.get(method);
    if (!pubsub) {
      throw new Error(`No stream registered for ${method}`);
    }
    Effect.runSync(PubSub.publish(pubsub, value));
  }

  private makeLayer() {
    const handlers: Record<string, (payload: unknown) => unknown> = {};
    for (const method of ALL_RPC_METHODS) {
      handlers[method] = STREAM_METHODS.has(method)
        ? (payload) => this.handleStream(method, payload)
        : (payload) => this.handleUnary(method, payload);
    }
    return WsRpcGroup.toLayer(handlers as never);
  }

  private makeServerOptions() {
    return {
      onFromServer: (response: unknown) =>
        Effect.sync(() => {
          if (!this.client) {
            return;
          }
          const encoded = this.parser.encode(response);
          if (typeof encoded === "string") {
            this.client.send(encoded);
          }
        }),
    };
  }

  private handleUnary(method: string, payload: unknown) {
    const request = normalizeRequest(method, payload);
    this.requests.push(request);
    return asEffect(this.resolveUnary(request));
  }

  private handleStream(method: string, payload: unknown) {
    const request = normalizeRequest(method, payload);
    this.requests.push(request);
    const pubsub = this.streamPubSubs.get(method);
    if (!pubsub) {
      throw new Error(`No stream registered for ${method}`);
    }
    return Stream.fromIterable(this.getInitialStreamValues(request) ?? []).pipe(
      Stream.concat(Stream.fromPubSub(pubsub)),
    );
  }
}
