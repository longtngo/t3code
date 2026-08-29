import * as NodeNet from "node:net";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as NetService from "./Net.ts";

const closeServer = (server: NodeNet.Server) =>
  Effect.sync(() => {
    try {
      server.close();
    } catch {
      // Ignore cleanup failures in tests.
    }
  });

const getPort = (server: NodeNet.Server): number => {
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : 0;
};

const openServer = (host?: string): Effect.Effect<NodeNet.Server, NetService.NetError> =>
  Effect.callback<NodeNet.Server, NetService.NetError>((resume) => {
    const server = NodeNet.createServer();
    let settled = false;

    const settle = (effect: Effect.Effect<NodeNet.Server, NetService.NetError>) => {
      if (settled) return;
      settled = true;
      resume(effect);
    };

    server.once("error", (cause) => {
      settle(
        Effect.fail(new NetService.NetError({ message: "Failed to open test server", cause })),
      );
    });

    if (host) {
      server.listen(0, host, () => settle(Effect.succeed(server)));
    } else {
      server.listen(0, () => settle(Effect.succeed(server)));
    }

    return closeServer(server);
  });

/**
 * Listen on one explicit {port, host}, or `null` when it is already taken.
 * Unlike {@link openServer} the port is chosen by the caller, which is what
 * lets a test park a listener on ONE address family.
 */
const openServerOn = (port: number, host: string): Effect.Effect<NodeNet.Server | null> =>
  Effect.callback<NodeNet.Server | null>((resume) => {
    const server = NodeNet.createServer();
    let settled = false;
    const settle = (value: NodeNet.Server | null) => {
      if (settled) return;
      settled = true;
      resume(Effect.succeed(value));
    };
    server.once("error", () => settle(null));
    server.listen(port, host, () => settle(server));
    return closeServer(server);
  });

it.layer(NetService.layer)("NetService", (it) => {
  describe("Net helpers", () => {
    it.effect("reserveLoopbackPort returns a positive loopback port", () =>
      Effect.gen(function* () {
        const net = yield* NetService.NetService;
        const port = yield* net.reserveLoopbackPort();

        assert.ok(port > 0);
      }),
    );

    it.effect("isPortAvailableOnLoopback reports false for an occupied port", () =>
      Effect.acquireUseRelease(
        openServer("127.0.0.1"),
        (server) =>
          Effect.gen(function* () {
            const net = yield* NetService.NetService;
            const port = getPort(server);

            const available = yield* net.isPortAvailableOnLoopback(port);
            assert.equal(available, false);
          }),
        closeServer,
      ),
    );

    it.effect("reserveLoopbackPort returns a port both loopback families accept", () =>
      Effect.gen(function* () {
        const net = yield* NetService.NetService;
        // The two helpers used to disagree about the same number: the reserve
        // binds ONE family, `isPortAvailableOnLoopback` demands both, and the
        // kernel keeps a separate ephemeral space per family. Arm that by
        // parking IPv6-only listeners on the ports the v4 allocator is about to
        // walk through, so a single-family reserve lands on one of them.
        const probe = yield* net.reserveLoopbackPort("127.0.0.1");
        const held = yield* Effect.forEach(
          [1, 2, 3, 4, 5].map((offset) => probe + offset),
          (port) => openServerOn(port, "::1"),
          { concurrency: "unbounded" },
        );
        const parked = held.filter((server) => server !== null);
        const parkedPorts = new Set([1, 2, 3, 4, 5].map((offset) => probe + offset));

        const port = yield* net.reserveLoopbackPort();
        yield* Effect.forEach(parked, closeServer, { discard: true });

        assert.equal(parkedPorts.has(port), false);
        assert.equal(yield* net.isPortAvailableOnLoopback(port), true);
      }),
    );

    it.effect("findAvailablePort returns preferred when it is free", () =>
      Effect.gen(function* () {
        const net = yield* NetService.NetService;
        const preferred = yield* net.reserveLoopbackPort();

        const resolved = yield* net.findAvailablePort(preferred);
        assert.equal(resolved, preferred);
      }),
    );

    it.effect("findAvailablePort falls back when a wildcard listener occupies IPv4", () =>
      Effect.acquireUseRelease(
        openServer("0.0.0.0"),
        (server) =>
          Effect.gen(function* () {
            const net = yield* NetService.NetService;
            const preferred = getPort(server);

            const resolved = yield* net.findAvailablePort(preferred);
            assert.ok(resolved > 0);
            assert.notEqual(resolved, preferred);
          }),
        closeServer,
      ),
    );
  });
});
