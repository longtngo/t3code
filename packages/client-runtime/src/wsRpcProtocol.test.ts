import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";

import { abandonSendOnDisconnect } from "./wsRpcProtocol.ts";

describe("abandonSendOnDisconnect (stale-window flush prevention)", () => {
  it.effect("returns the send result while the socket stays connected", () =>
    Effect.gen(function* () {
      // Closed latch = connected: the send resolves normally, the disconnect side never fires.
      const disconnectLatch = Latch.makeUnsafe(false);
      const result = yield* abandonSendOnDisconnect(Effect.succeed("sent"), disconnectLatch);
      expect(result).toBe("sent");
    }),
  );

  it.effect("abandons an in-flight send with a retryable error once the socket disconnects", () =>
    Effect.gen(function* () {
      const disconnectLatch = Latch.makeUnsafe(false);
      // `Effect.never` models a write blocked on the socket's open-latch — exactly the
      // frame that would otherwise flush to the NEXT socket after a reconnect. It can
      // only resolve via the disconnect, so the outcome is deterministic.
      const failure = yield* Effect.raceFirst(
        abandonSendOnDisconnect(Effect.never, disconnectLatch).pipe(Effect.flip),
        // Concurrently open the latch (onDisconnect), then block so this arm can never
        // win the race — the abandoned send is what resolves.
        Effect.sync(() => {
          disconnectLatch.openUnsafe();
        }).pipe(Effect.andThen(Effect.never)),
      );
      // The flipped effect types `failure` as the RpcClientError. A typed RpcClientDefect
      // (not a die) means the RPC layer surfaces it as a normal, retryable send failure
      // rather than a crash.
      expect(failure._tag).toBe("RpcClientError");
      expect(failure.reason._tag).toBe("RpcClientDefect");
      expect(failure.message).toContain("abandoned");
    }),
  );
});
