/**
 * Ordered-write websocket RPC server protocol.
 *
 * A drop-in for {@link RpcServer.toHttpEffectWebsocket} that serializes each
 * connection's OUTBOUND encode+write under a single permit, so response frames
 * reach the wire in the exact order they were encoded.
 *
 * ## Why this exists
 *
 * The context-takeover stream codec ({@link WIRE_FORMAT_MSGPACK_DEFLATE_STREAM})
 * carries ONE persistent DEFLATE window per connection, so a response frame that
 * reaches the wire out of *encode* order desyncs the window for the rest of the
 * stream (the client's inflate then produces garbage). Effect's stock websocket
 * protocol encodes eagerly — `parser.encode(response)` runs at send-call time —
 * and defers only the socket write, while the RPC server runs its handlers
 * concurrently (`concurrency: "unbounded"` by default). So two responses can
 * encode in one order and write in another, which is silent corruption on a
 * stateful codec.
 *
 * The fix mirrors the client's `sendMutex`: wrap the protocol's `send` so the
 * eager encode is deferred (via `Effect.suspend`) INTO a single-permit critical
 * section that also holds the write. Encode + write then happen atomically and in
 * permit-acquisition order, so encode-order == wire-order for every frame.
 *
 * This is built entirely from Effect's PUBLIC rpc surface
 * ({@link RpcServer.makeProtocolWithHttpEffectWebsocket}, {@link RpcServer.make},
 * {@link RpcServer.Protocol}) — it does not fork any private transport internals.
 * `toHttpEffectWebsocket` is invoked once per websocket upgrade, so one instance =
 * one connection = one parser, and a single per-connection permit suffices.
 *
 * Only the stateful stream format needs this; JSON / per-frame connections keep
 * using the stock transport (their frames are order-independent), so this changes
 * nothing for the load-bearing JSON compatibility fallback.
 */

import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import { Rpc, RpcGroup, RpcServer } from "effect/unstable/rpc";

/**
 * Wraps a server RPC protocol so a connection's OUTBOUND frames encode and write
 * as one indivisible, ordered step under a single permit.
 *
 * The load-bearing detail is `Effect.suspend`: `protocol.send` runs its eager
 * `parser.encode` at CALL time (mutating the connection's deflate window), so the
 * encode must be deferred INTO the permit — otherwise many concurrent handler
 * fibers would encode up front (advancing the shared window out of order) and only
 * the writes would be serialized, which still desyncs the window. Suspending makes
 * `protocol.send` — encode included — run inside the critical section, so
 * encode-order == write-order == permit-acquisition-order for every frame.
 *
 * Exported for direct unit testing of that ordering guarantee.
 */
export const withOrderedSend = (
  protocol: RpcServer.Protocol["Service"],
): RpcServer.Protocol["Service"] => {
  const sendMutex = Semaphore.makeUnsafe(1);
  return {
    ...protocol,
    send: (clientId, response, transferables) =>
      sendMutex.withPermits(1)(
        Effect.suspend(() => protocol.send(clientId, response, transferables)),
      ),
  };
};

export const toHttpEffectWebsocketOrdered: typeof RpcServer.toHttpEffectWebsocket =
  Effect.fnUntraced(function* <Rpcs extends Rpc.Any>(
    group: RpcGroup.RpcGroup<Rpcs>,
    options?: {
      readonly disableTracing?: boolean | undefined;
      readonly spanPrefix?: string | undefined;
      readonly spanAttributes?: Record<string, unknown> | undefined;
      readonly disableFatalDefects?: boolean | undefined;
    },
  ) {
    const { httpEffect, protocol } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
    // One permit per connection (toHttpEffectWebsocket runs once per upgrade), so
    // response frames encode+write in wire order and the deflate window stays in sync.
    yield* RpcServer.make(group, options).pipe(
      Effect.provideService(RpcServer.Protocol, withOrderedSend(protocol)),
      Effect.forkScoped,
    );
    // @effect-diagnostics-next-line returnEffectInGen:off
    return httpEffect;
  }) as typeof RpcServer.toHttpEffectWebsocket;
