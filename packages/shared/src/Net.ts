import * as NodeNet from "node:net";

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import * as Predicate from "effect/Predicate";

export class NetError extends Data.TaggedError("NetError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const isErrnoExceptionWithCode = (
  cause: unknown,
): cause is {
  readonly code: string;
} =>
  Predicate.isObject(cause) &&
  Predicate.hasProperty(cause, "code") &&
  Predicate.isString(cause.code);

const closeServer = (server: NodeNet.Server) => {
  try {
    server.close();
  } catch {
    // Ignore close failures during cleanup.
  }
};

export interface NetServiceShape {
  /**
   * Returns true when a TCP server can bind to {host, port}.
   */
  readonly canListenOnHost: (port: number, host: string) => Effect.Effect<boolean>;

  /**
   * Checks loopback availability on both IPv4 and IPv6 localhost addresses.
   */
  readonly isPortAvailableOnLoopback: (port: number) => Effect.Effect<boolean>;

  /**
   * Returns true when something accepts TCP connections on {host, port}.
   * Unlike the bind-side checks this works for privileged ports (<1024).
   */
  readonly hasListenerOnHost: (port: number, host: string) => Effect.Effect<boolean>;

  /**
   * Reserve an ephemeral loopback port and release it immediately.
   */
  readonly reserveLoopbackPort: (host?: string) => Effect.Effect<number, NetError>;

  /**
   * Resolve an available listening port, preferring the provided port first.
   */
  readonly findAvailablePort: (preferred: number) => Effect.Effect<number, NetError>;
}

/**
 * NetService - Service tag for startup networking helpers.
 */
export class NetService extends Context.Service<NetService, NetServiceShape>()(
  "@t3tools/shared/Net/NetService",
) {}

export const make = () => {
  /**
   * Returns true when a TCP server can bind to {host, port}.
   * `EADDRNOTAVAIL` is treated as available so IPv6-absent hosts don't fail
   * loopback availability checks.
   */
  const canListenOnHost = (port: number, host: string): Effect.Effect<boolean> =>
    Effect.callback<boolean>((resume) => {
      const server = NodeNet.createServer();
      let settled = false;

      const settle = (value: boolean) => {
        if (settled) return;
        settled = true;
        resume(Effect.succeed(value));
      };

      server.unref();

      server.once("error", (cause) => {
        if (isErrnoExceptionWithCode(cause) && cause.code === "EADDRNOTAVAIL") {
          settle(true);
          return;
        }
        settle(false);
      });

      server.once("listening", () => {
        server.close(() => {
          settle(true);
        });
      });

      server.listen({ host, port });

      return Effect.sync(() => {
        closeServer(server);
      });
    });

  const hasListenerOnHost = (port: number, host: string): Effect.Effect<boolean> =>
    Effect.callback<boolean>((resume) => {
      const socket = NodeNet.createConnection({ host, port });
      let settled = false;

      const settle = (value: boolean) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resume(Effect.succeed(value));
      };

      socket.unref();
      socket.setTimeout(250);
      socket.once("connect", () => {
        settle(true);
      });
      socket.once("error", () => {
        settle(false);
      });
      socket.once("timeout", () => {
        settle(false);
      });

      return Effect.sync(() => {
        socket.destroy();
      });
    });

  const isPortAvailableOnLoopback = (port: number): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      const hasListener = yield* Effect.zipWith(
        hasListenerOnHost(port, "127.0.0.1"),
        hasListenerOnHost(port, "::1"),
        (ipv4, ipv6) => ipv4 || ipv6,
      );
      if (hasListener) {
        return false;
      }

      return yield* Effect.zipWith(
        canListenOnHost(port, "127.0.0.1"),
        canListenOnHost(port, "::1"),
        (ipv4, ipv6) => ipv4 && ipv6,
      );
    });

  /**
   * Bind an ephemeral port on ONE host and release it. Single-family, so the
   * port it returns is only known to be free on `host`.
   */
  const reserveEphemeralPortOnHost = (host: string): Effect.Effect<number, NetError> =>
    Effect.callback<number, NetError>((resume) => {
      const probe = NodeNet.createServer();
      let settled = false;

      const settle = (effect: Effect.Effect<number, NetError>) => {
        if (settled) return;
        settled = true;
        resume(effect);
      };

      probe.once("error", (cause) => {
        settle(Effect.fail(new NetError({ message: "Failed to reserve loopback port", cause })));
      });

      probe.listen(0, host, () => {
        const address = probe.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        probe.close(() => {
          if (port > 0) {
            settle(Effect.succeed(port));
            return;
          }
          settle(Effect.fail(new NetError({ message: "Failed to reserve loopback port" })));
        });
      });

      return Effect.sync(() => {
        closeServer(probe);
      });
    });

  /**
   * Reserve an ephemeral loopback port and release it immediately.
   *
   * The bind is single-family, but {@link isPortAvailableOnLoopback} - which
   * every consumer of this port ends up going through - requires the port to be
   * free on BOTH 127.0.0.1 and ::1. The kernel keeps a separate ephemeral space
   * per family, so a v4 bind will hand out a port that already has an IPv6-only
   * listener, and the two helpers then disagree about the very same number.
   * Measured on this machine: port 58153 was free on 127.0.0.1 and occupied on
   * ::1 by a `tcp6 *.58153` listener, which is exactly how `findAvailablePort`
   * came to reject the port `reserveLoopbackPort` had just handed it.
   *
   * So re-draw until both families agree. An explicit `host` means the caller
   * wants that family specifically and is left alone.
   */
  const reserveLoopbackPort = (host?: string): Effect.Effect<number, NetError> =>
    host !== undefined
      ? reserveEphemeralPortOnHost(host)
      : Effect.gen(function* () {
          let port = yield* reserveEphemeralPortOnHost("127.0.0.1");
          // Bounded: a host with no usable IPv6 answers EADDRNOTAVAIL, which
          // canListenOnHost already counts as available, so exhausting these
          // means real contention rather than a missing stack. Returning the
          // last draw then leaves the caller no worse off than before.
          for (let attempt = 0; attempt < 8; attempt += 1) {
            if (yield* isPortAvailableOnLoopback(port)) return port;
            port = yield* reserveEphemeralPortOnHost("127.0.0.1");
          }
          return port;
        });

  return {
    canListenOnHost,
    isPortAvailableOnLoopback,
    hasListenerOnHost,
    reserveLoopbackPort,
    findAvailablePort: (preferred) =>
      Effect.gen(function* () {
        if (preferred > 0 && (yield* isPortAvailableOnLoopback(preferred))) {
          return preferred;
        }
        return yield* reserveLoopbackPort();
      }),
  } satisfies NetServiceShape;
};

export const layer = Layer.sync(NetService, make);
