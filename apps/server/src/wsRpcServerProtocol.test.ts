import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import type { RpcServer } from "effect/unstable/rpc";

import { withOrderedSend } from "./wsRpcServerProtocol.ts";

/**
 * A fake server protocol whose `send` models the real hazard: it "encodes" the
 * response SYNCHRONOUSLY at call time (as `parser.encode` mutates the deflate
 * window), then returns an effect that "writes" it after a yield point. So encode
 * order is decided when `send` is invoked and write order when its effect runs —
 * the two can diverge unless something holds them together.
 */
function makeRecordingProtocol(order: string[]): RpcServer.Protocol["Service"] {
  return {
    send: (_clientId: number, response: unknown) => {
      const n = (response as { readonly n: number }).n;
      order.push(`enc:${n}`);
      return Effect.andThen(Effect.yieldNow, Effect.sync(() => order.push(`wr:${n}`)));
    },
  } as unknown as RpcServer.Protocol["Service"];
}

const sendAll = (protocol: RpcServer.Protocol["Service"]) =>
  Effect.all(
    Array.from({ length: 8 }, (_u, i) =>
      protocol.send(0, { n: i } as unknown as Parameters<typeof protocol.send>[1]),
    ),
    { concurrency: "unbounded" },
  );

/** Assert every `enc:N` is immediately followed by its own `wr:N` — no interleaving. */
function expectAtomicPairs(order: string[]) {
  expect(order.length).toBe(16);
  for (let i = 0; i < order.length; i += 2) {
    const enc = order[i]!;
    expect(enc.startsWith("enc:")).toBe(true);
    expect(order[i + 1]).toBe(`wr:${enc.slice("enc:".length)}`);
  }
}

it.effect(
  "withOrderedSend serializes concurrent sends so each encode+write is atomic and ordered",
  () =>
    Effect.gen(function* () {
      const order: string[] = [];
      const ordered = withOrderedSend(makeRecordingProtocol(order));
      yield* sendAll(ordered);
      // The context-takeover deflate window advances at encode time, so this
      // adjacency is exactly what keeps the window in wire order (Finding 9).
      expectAtomicPairs(order);
    }),
);

it.effect(
  "control: a mutex WITHOUT the deferring suspend still interleaves encode vs write",
  () =>
    // Documents why `Effect.suspend` in withOrderedSend is load-bearing: serializing
    // only the write effect lets every eager encode run up front (all `enc:*` before
    // any `wr:*`), which advances the shared deflate window out of wire order.
    Effect.gen(function* () {
      const order: string[] = [];
      const protocol = makeRecordingProtocol(order);
      const sendMutex = Semaphore.makeUnsafe(1);
      const broken: RpcServer.Protocol["Service"] = {
        ...protocol,
        // No `Effect.suspend`: protocol.send (and its eager encode) runs when this
        // wrapper is INVOKED, before the permit is ever acquired.
        send: (clientId, response, transferables) =>
          sendMutex.withPermits(1)(protocol.send(clientId, response, transferables)),
      };
      yield* sendAll(broken);
      const firstWriteIndex = order.findIndex((entry) => entry.startsWith("wr:"));
      // All eight encodes landed before the first write → not atomic pairs.
      expect(order.slice(0, firstWriteIndex).every((entry) => entry.startsWith("enc:"))).toBe(true);
      expect(firstWriteIndex).toBe(8);
    }),
);
