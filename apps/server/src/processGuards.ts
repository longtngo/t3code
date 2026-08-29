// @effect-diagnostics nodeBuiltinImport:off - these install before any Effect runtime exists.
import * as NodeNet from "node:net";

/**
 * Two process-level guards, installed once at startup, for failures that reach
 * the process before any Effect error channel exists.
 *
 * Both address the same incident: `com.t3code.server` died five times with an
 * uncaught `setTypeOfService EINVAL`, taking every in-flight turn on every
 * connected client with it, and left no record beyond Node's stderr.
 */

const ALREADY_GUARDED = Symbol.for("t3code.setTypeOfServiceGuarded");

type TypeOfServiceSetter = (this: unknown, tos: number) => unknown;

const isTypeOfServiceError = (error: unknown): error is NodeJS.ErrnoException =>
  typeof error === "object" &&
  error !== null &&
  (error as NodeJS.ErrnoException).syscall === "setTypeOfService";

/**
 * Makes `net.Socket#setTypeOfService` non-fatal, and only that call.
 *
 * On macOS a TCP socket whose connection was aborted at the protocol layer -
 * the peer sent RST, or the connect was refused - keeps an open fd and still
 * reports `AF_INET` from `getsockname`, but `setsockopt(IP_TOS)` returns
 * EINVAL. Node's synchronous `setTypeOfService` throws on any non-zero libuv
 * return (`net.js`), while its own deferred path in `afterConnect` only *emits*
 * for the identical failure. The bundled undici (8.5.0 in Node 26.3.1) calls it
 * unconditionally on the first HTTP/1.1 write to every plain-HTTP socket, from
 * inside the socket's `connect` event - so the throw lands in an EventEmitter
 * callback with no undici promise and no application frame on the stack, and
 * nothing can catch it. HTTPS is unaffected: `TLSWrap` has no such method.
 *
 * This is upstream's bug, and upstream has already fixed it: nodejs/undici#5544,
 * fixed by #5547 in undici 8.8.0, first shipped in **Node v26.5.1**, which both
 * wraps the call and stops defaulting the value. `lib/net.js` still throws
 * there, so this guard stays useful for any other caller - but the reason it
 * exists is the undici one.
 *
 * **Delete this once the minimum supported Node is >= 26.5.1.**
 *
 * Deliberately narrow: anything whose `syscall` is not `setTypeOfService`
 * rethrows untouched. Suppressing here is safe because the socket is already
 * dead - the pending request still fails as `ECONNRESET`, through the normal
 * error path, and only the process death is removed.
 */
export function guardSocketTypeOfServiceErrors(
  socketPrototype: Record<PropertyKey, unknown> = NodeNet.Socket.prototype as unknown as Record<
    PropertyKey,
    unknown
  >,
  onSuppressed?: (error: NodeJS.ErrnoException) => void,
): boolean {
  const original = socketPrototype["setTypeOfService"];
  if (typeof original !== "function") return false;
  if (socketPrototype[ALREADY_GUARDED] === true) return false;

  const guarded: TypeOfServiceSetter = function (this: unknown, tos: number) {
    try {
      return (original as TypeOfServiceSetter).call(this, tos);
    } catch (error) {
      if (!isTypeOfServiceError(error)) throw error;
      onSuppressed?.(error);
      return this;
    }
  };

  socketPrototype["setTypeOfService"] = guarded;
  socketPrototype[ALREADY_GUARDED] = true;
  return true;
}

/**
 * Records a fatal exception on the way out. **Does not stop the exit.**
 *
 * `uncaughtExceptionMonitor` fires for every uncaught exception and, unlike an
 * `uncaughtException` listener, does not suppress Node's default handling - the
 * process still prints and exits. That distinction is the whole point here: this
 * server is event-sourced, so resuming after an *unknown* fatal would restart a
 * process whose decider or projector may be mid-transition, trading a visible
 * restart for silent state corruption in the one system that cannot tolerate it.
 * A crash we can see is better than a crash we survive wrongly.
 *
 * The write is synchronous because the process is about to exit and a buffered
 * write may never flush.
 */
export function monitorFatalExceptions(
  target: Pick<NodeJS.Process, "on"> = process,
  write: (line: string) => void = (line) => {
    process.stderr.write(line);
  },
): void {
  target.on("uncaughtExceptionMonitor", (error: unknown, origin: unknown) => {
    const detail =
      error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);
    write(`[fatal] uncaughtExceptionMonitor origin=${String(origin)} ${detail}\n`);
  });
}

/** Installs both guards. Call once, as early in startup as possible. */
export function installProcessGuards(): void {
  guardSocketTypeOfServiceErrors(
    NodeNet.Socket.prototype as unknown as Record<PropertyKey, unknown>,
    (error) => {
      // Not fatal, and not rare enough to log per occurrence at info level - but
      // silence here is what made the original outages undiagnosable.
      process.emitWarning(
        `suppressed non-fatal ${error.syscall} ${error.code} on a reset socket`,
        "T3SocketTypeOfServiceGuard",
      );
    },
  );
  monitorFatalExceptions();
}
